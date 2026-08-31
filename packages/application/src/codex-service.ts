import { randomUUID } from 'node:crypto';
import { appError, err, isApplicationAuthorized, ok, type GoalTaskCancellationObservation, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import { CodexAdapter, type CodexStatus } from '@lnwjud/codex';
import type { CodexRunAuditInput } from '@lnwjud/audit';
import { DefaultPermissionEngine, permissionProfiles, type PermissionEngine, type PermissionProfile } from '@lnwjud/permissions';
import type { LogQuery, ManagedProcess, ProcessLogResult } from '@lnwjud/process';
import { WorkspacePathGuard, type Workspace, type WorkspaceRepository } from '@lnwjud/workspace';
import type { FileActor } from './file-service.js';

export const MAX_CODEX_INSTRUCTION_BYTES = 256 * 1024;

export interface CodexAdapterPort {
  status(): Promise<Result<CodexStatus>>;
  start(cwd: string, instruction: string, signal?: AbortSignal, onCreated?: (process: ManagedProcess) => void): Promise<Result<ManagedProcess>>;
  statusProcess(processId: string): Result<ManagedProcess>;
  logs(processId: string, query: LogQuery): Result<ProcessLogResult>;
  stop(processId: string, autoRetry?: boolean): Promise<Result<void>>;
}

export interface CodexAuditPort {
  recordCodexRun(input: CodexRunAuditInput): Promise<void>;
}

export interface CodexServiceDependencies {
  readonly adapter?: CodexAdapterPort;
  readonly guard?: WorkspacePathGuard;
  readonly permissionEngine?: PermissionEngine;
  readonly profile?: PermissionProfile;
  readonly profileProvider?: () => PermissionProfile;
  readonly auditService?: CodexAuditPort;
  readonly taskIdFactory?: () => string;
  readonly diagnostic?: (message: string) => void;
}

interface CodexTaskOwner {
  readonly actorId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly processId: string;
}

export interface CodexRunResult {
  readonly codexTaskId: string;
  readonly processId: string;
}

export interface CodexTaskListItem {
  readonly codexTaskId: string;
  readonly process: ManagedProcess;
}

export class CodexService {
  private readonly adapter: CodexAdapterPort;
  private readonly guard: WorkspacePathGuard;
  private readonly permissionEngine: PermissionEngine;
  private readonly profileProvider: () => PermissionProfile;
  private readonly auditService: CodexAuditPort | undefined;
  private readonly taskIdFactory: () => string;
  private readonly diagnostic: (message: string) => void;
  private readonly owners = new Map<string, CodexTaskOwner>();

  public constructor(
    private readonly workspaces: WorkspaceRepository,
    dependencies: CodexServiceDependencies = {},
  ) {
    this.adapter = dependencies.adapter ?? new CodexAdapter();
    this.guard = dependencies.guard ?? new WorkspacePathGuard();
    this.permissionEngine = dependencies.permissionEngine ?? new DefaultPermissionEngine();
    this.profileProvider = dependencies.profileProvider ?? ((): PermissionProfile => dependencies.profile ?? permissionProfiles.balanced);
    this.auditService = dependencies.auditService;
    this.taskIdFactory = dependencies.taskIdFactory ?? randomUUID;
    this.diagnostic = dependencies.diagnostic ?? ((message: string): void => { console.error(message); });
  }

  public async status(actor: FileActor): Promise<Result<CodexStatus>> {
    void actor;
    const permission = this.permissionEngine.decide(this.profileProvider(), { action: 'codex_status', level: 'READ', workspaceId: 'system', destructive: false });
    if (permission === 'DENY') return err(appError('PERMISSION_DENIED', 'Codex status is denied'));
    if (permission === 'ASK') return err(appError('PERMISSION_REQUIRED', 'Codex status requires permission'));
    return this.adapter.status();
  }

  public async run(
    actor: FileActor,
    workspaceId: string,
    instruction: string,
    signal?: AbortSignal,
    userConfirmed = false,
    authorization?: InvocationAuthorization,
  ): Promise<Result<CodexRunResult>> {
    if (typeof instruction !== 'string' || instruction.trim().length === 0) return err(appError('INVALID_INPUT', 'Codex instruction is required'));
    if (Buffer.byteLength(instruction, 'utf8') > MAX_CODEX_INSTRUCTION_BYTES) return err(appError('FILE_TOO_LARGE', 'Codex instruction is too large'));
    if (isAborted(signal)) return cancelledCodexRun();
    const workspace = await this.getWorkspace(workspaceId);
    if (isAborted(signal)) return cancelledCodexRun();
    if (!workspace.ok) return workspace;
    const root = await this.guard.resolveForRead(workspace.value, '.');
    if (isAborted(signal)) return cancelledCodexRun();
    if (!root.ok) return root;
    if (!isApplicationAuthorized(authorization, userConfirmed)) return err(appError('PERMISSION_REQUIRED', 'Starting Codex requires explicit user confirmation'));
    if (authorization?.applicationApproved !== true) {
      const permission = this.permissionEngine.decide(this.profileProvider(), { action: 'codex_run', level: 'EXECUTE', workspaceId, target: '.', destructive: false });
      if (permission === 'DENY') return err(appError('PERMISSION_DENIED', 'Codex execution is denied'));
    }

    if (isAborted(signal)) return cancelledCodexRun();
    const codexTaskId = this.taskIdFactory();
    const registerOwner = (process: ManagedProcess): void => {
      this.owners.set(codexTaskId, { actorId: actor.clientId, sessionId: actorSessionId(actor), workspaceId, processId: process.processId });
    };
    const started = await this.adapter.start(root.value.realPath ?? root.value.absolutePath, instruction, signal, registerOwner);
    if (!started.ok) return started;
    if (isAborted(signal)) {
      await this.adapter.stop(started.value.processId, true);
      return cancelledCodexRun();
    }
    registerOwner(started.value);
    await this.recordAudit(actor, workspaceId, codexTaskId, instruction);
    return ok({ codexTaskId, processId: started.value.processId });
  }

  public async taskStatus(actor: FileActor, workspaceId: string, codexTaskId: string): Promise<Result<ManagedProcess>> {
    const owner = this.authorize(actor, workspaceId, codexTaskId);
    if (!owner.ok) return owner;
    return this.adapter.statusProcess(owner.value.processId);
  }

  /** Trusted read-only host probe used only by durable-goal orphan detection. */
  public statusForGoalLiveness(workspaceId: string, codexTaskId: string): Result<ManagedProcess> {
    const owner = this.owners.get(codexTaskId);
    if (owner === undefined) return err(appError('PROCESS_NOT_FOUND', 'Codex task was not found'));
    if (owner.workspaceId !== workspaceId) return err(appError('PERMISSION_DENIED', 'Codex task belongs to another workspace'));
    return this.adapter.statusProcess(owner.processId);
  }

  /** Trusted cancellation path used by durable goals; it deliberately ignores the transient MCP session. */
  public async cancelForGoal(
    ownerClientId: string,
    workspaceId: string,
    codexTaskId: string,
  ): Promise<Result<GoalTaskCancellationObservation>> {
    const owner = this.owners.get(codexTaskId);
    if (owner === undefined) return ok({ matched: false, state: 'not_found' });
    if (owner.actorId !== ownerClientId || owner.workspaceId !== workspaceId) {
      return err(appError('PERMISSION_DENIED', 'Codex task belongs to another client or workspace'));
    }

    const before = this.adapter.statusProcess(owner.processId);
    if (!before.ok) {
      return before.error.code === 'PROCESS_NOT_FOUND'
        ? ok({ matched: false, state: 'not_found' })
        : before;
    }
    if (isVerifiedTerminalProcess(before.value.state)) {
      return ok({ matched: true, state: 'already_terminal', detail: before.value.state });
    }

    const stopped = await this.adapter.stop(owner.processId, true);
    if (!stopped.ok) return stopped;
    const after = this.adapter.statusProcess(owner.processId);
    if (!after.ok) return ok({ matched: true, state: 'termination_unverified', detail: 'Codex process status could not be re-read after cancellation' });
    if (isVerifiedTerminalProcess(after.value.state)) {
      return ok({ matched: true, state: 'cancelled', detail: after.value.state });
    }
    return ok({ matched: true, state: 'termination_unverified', detail: after.value.state });
  }

  public async list(actor: FileActor, workspaceId: string): Promise<Result<readonly CodexTaskListItem[]>> {
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace.ok) return workspace;
    const tasks: CodexTaskListItem[] = [];
    for (const [codexTaskId, owner] of this.owners) {
      if (owner.actorId !== actor.clientId || owner.sessionId !== actorSessionId(actor) || owner.workspaceId !== workspaceId) continue;
      const process = this.adapter.statusProcess(owner.processId);
      if (process.ok) tasks.push({ codexTaskId, process: process.value });
    }
    return ok(tasks);
  }

  public async taskLogs(actor: FileActor, workspaceId: string, codexTaskId: string, query: LogQuery): Promise<Result<ProcessLogResult>> {
    const owner = this.authorize(actor, workspaceId, codexTaskId);
    if (!owner.ok) return owner;
    return this.adapter.logs(owner.value.processId, query);
  }

  public async stop(
    actor: FileActor,
    workspaceId: string,
    codexTaskId: string,
    userConfirmed = false,
    authorization?: InvocationAuthorization,
  ): Promise<Result<void>> {
    const owner = this.authorize(actor, workspaceId, codexTaskId);
    if (!owner.ok) return owner;
    if (!isApplicationAuthorized(authorization, userConfirmed)) return err(appError('PERMISSION_REQUIRED', 'Stopping Codex requires explicit user confirmation'));
    return this.adapter.stop(owner.value.processId);
  }

  private async recordAudit(actor: FileActor, workspaceId: string, codexTaskId: string, instruction: string): Promise<void> {
    if (this.auditService === undefined) return;
    const input: CodexRunAuditInput = { actorId: actor.clientId, actorName: actor.clientName, workspaceId, codexTaskId, instruction, resultCode: 'STARTED', durationMs: 0 };
    try {
      await this.auditService.recordCodexRun(input);
    } catch {
      this.diagnostic(`Codex audit recording failed for task ${codexTaskId}`);
    }
  }

  private authorize(actor: FileActor, workspaceId: string, codexTaskId: string): Result<CodexTaskOwner> {
    const owner = this.owners.get(codexTaskId);
    if (owner === undefined) return err(appError('PROCESS_NOT_FOUND', 'Codex task was not found'));
    if (owner.actorId !== actor.clientId || owner.sessionId !== actorSessionId(actor) || owner.workspaceId !== workspaceId) return err(appError('PERMISSION_DENIED', 'Codex task is not owned by this client session and workspace'));
    return ok(owner);
  }

  private async getWorkspace(workspaceId: string): Promise<Result<Workspace>> {
    const workspace = await this.workspaces.get(workspaceId);
    return workspace === null ? err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found')) : ok(workspace);
  }
}

function actorSessionId(actor: FileActor): string {
  return actor.sessionId?.trim() || actor.clientId;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function cancelledCodexRun(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Codex run was cancelled before launch completed', true));
}

function isVerifiedTerminalProcess(state: ManagedProcess['state']): boolean {
  return state === 'exited' || state === 'failed' || state === 'stopped' || state === 'timed_out';
}
