import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  appError,
  err,
  isApplicationAuthorized,
  isFullBypassAuthorization,
  ok,
  type GoalTaskCancellationObservation,
  type CommandSpec,
  type InvocationAuthorization,
  type Result,
} from '@lnwjud/domain';
import { CommandPolicy, DefaultPermissionEngine, permissionProfiles, type PermissionEngine, type PermissionProfile } from '@lnwjud/permissions';
import { ProcessManager, type LogQuery, type ManagedProcess, type ManagedProcessStart, type ProcessLogResult } from '@lnwjud/process';
import { JsCommandDetector, ProjectDetector, type ProjectCommandKind } from '@lnwjud/project';
import { prohibitedAgentCommandReason, riskyAgentCommandReason } from '@lnwjud/shared';
import { WorkspacePathGuard, type Workspace, type WorkspaceRepository } from '@lnwjud/workspace';
import type { FileActor } from './file-service.js';
import { ProjectService } from './project-service.js';

export interface ProcessStartRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly userConfirmed?: boolean;
}

export interface ProcessManagerPort {
  start(spec: ManagedProcessStart, signal?: AbortSignal, onCreated?: (process: ManagedProcess) => void): Promise<Result<ManagedProcess>>;
  list?(): readonly ManagedProcess[];
  status(processId: string): Result<ManagedProcess>;
  logs(processId: string, query: LogQuery): Result<ProcessLogResult>;
  stop(processId: string, autoRetry?: boolean): Promise<Result<void>>;
}

export interface ProjectCommandSource {
  getCommand(workspaceId: string, kind: ProjectCommandKind): Promise<Result<CommandSpec>>;
}

export interface ProcessServiceDependencies {
  readonly processManager?: ProcessManagerPort;
  readonly projectService?: ProjectCommandSource;
  readonly guard?: WorkspacePathGuard;
  readonly permissionEngine?: PermissionEngine;
  readonly commandPolicy?: CommandPolicy;
  readonly profile?: PermissionProfile;
  readonly profileProvider?: () => PermissionProfile;
  readonly defaultTimeoutMsProvider?: () => number;
  /** Full-access mode can broaden executable policy and allow an explicitly absolute cwd outside the selected workspace. */
  readonly unrestricted?: boolean;
  /** Full-profile Bypass All skips lnwjud command/profile authorization while retaining exact process ownership. */
  readonly authorizationBypassProvider?: () => boolean;
}

interface ProcessOwner {
  readonly actorId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
}

type CommandSource = 'client' | 'project';

export class ProcessService {
  private readonly processManager: ProcessManagerPort;
  private readonly projectService: ProjectCommandSource;
  private readonly guard: WorkspacePathGuard;
  private readonly permissionEngine: PermissionEngine;
  private readonly commandPolicy: CommandPolicy;
  private readonly profileProvider: () => PermissionProfile;
  private readonly defaultTimeoutMsProvider: (() => number) | undefined;
  private readonly unrestricted: boolean;
  private readonly authorizationBypassProvider: () => boolean;
  private readonly owners = new Map<string, ProcessOwner>();

  public constructor(
    private readonly workspaces: WorkspaceRepository,
    dependencies: ProcessServiceDependencies = {},
  ) {
    this.processManager = dependencies.processManager ?? new ProcessManager();
    this.projectService = dependencies.projectService ?? new ProjectService(
      workspaces,
      new ProjectDetector(),
      new JsCommandDetector(),
    );
    this.guard = dependencies.guard ?? new WorkspacePathGuard();
    this.permissionEngine = dependencies.permissionEngine ?? new DefaultPermissionEngine();
    this.unrestricted = dependencies.unrestricted === true;
    this.commandPolicy = dependencies.commandPolicy ?? new CommandPolicy({ unrestricted: this.unrestricted });
    this.profileProvider = dependencies.profileProvider ?? ((): PermissionProfile => dependencies.profile ?? permissionProfiles.balanced);
    this.defaultTimeoutMsProvider = dependencies.defaultTimeoutMsProvider;
    this.authorizationBypassProvider = dependencies.authorizationBypassProvider ?? ((): boolean => false);
  }

  public start(actor: FileActor, workspaceId: string, request: ProcessStartRequest, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<ManagedProcess>> {
    return this.startInternal(actor, workspaceId, request, 'client', signal, authorization);
  }

  public previewProjectCommand(workspaceId: string, kind: ProjectCommandKind): Promise<Result<CommandSpec>> {
    return this.projectService.getCommand(workspaceId, kind);
  }

  public async startProjectCommand(
    actor: FileActor,
    workspaceId: string,
    kind: ProjectCommandKind,
    signal?: AbortSignal,
    userConfirmed = false,
    approvedCommand?: CommandSpec,
    authorization?: InvocationAuthorization,
  ): Promise<Result<ManagedProcess>> {
    if (isAborted(signal)) return cancelledStart();
    const command = await this.projectService.getCommand(workspaceId, kind);
    if (isAborted(signal)) return cancelledStart();
    if (!command.ok) return command;
    if (approvedCommand !== undefined && !commandsEqual(approvedCommand, command.value)) {
      return err(appError('PERMISSION_DENIED', 'Detected project command changed after approval; fresh approval is required'));
    }
    return this.startInternal(actor, workspaceId, { executable: command.value.executable, args: command.value.args, userConfirmed }, 'project', signal, authorization);
  }

  public async status(actor: FileActor, workspaceId: string, processId: string): Promise<Result<ManagedProcess>> {
    const ownership = this.authorizeHandle(actor, workspaceId, processId);
    if (!ownership.ok) return ownership;
    return this.processManager.status(processId);
  }

  /** Trusted read-only host probe used only by durable-goal orphan detection. */
  public statusForGoalLiveness(workspaceId: string, processId: string): Result<ManagedProcess> {
    const owner = this.owners.get(processId);
    if (owner === undefined) return err(appError('PROCESS_NOT_FOUND', 'Process was not found'));
    if (owner.workspaceId !== workspaceId) return err(appError('PERMISSION_DENIED', 'Process belongs to another workspace'));
    return this.processManager.status(processId);
  }

  /** Trusted cancellation path used by durable goals; it deliberately ignores the transient MCP session. */
  public async cancelForGoal(
    ownerClientId: string,
    workspaceId: string,
    processId: string,
  ): Promise<Result<GoalTaskCancellationObservation>> {
    const owner = this.owners.get(processId);
    if (owner === undefined) return ok({ matched: false, state: 'not_found' });
    if (owner.actorId !== ownerClientId || owner.workspaceId !== workspaceId) {
      return err(appError('PERMISSION_DENIED', 'Process belongs to another client or workspace'));
    }

    const before = this.processManager.status(processId);
    if (!before.ok) {
      return before.error.code === 'PROCESS_NOT_FOUND'
        ? ok({ matched: false, state: 'not_found' })
        : before;
    }
    if (isVerifiedTerminalProcess(before.value.state)) {
      return ok({ matched: true, state: 'already_terminal', detail: before.value.state });
    }

    const stopped = await this.processManager.stop(processId, true);
    if (!stopped.ok) return stopped;
    const after = this.processManager.status(processId);
    if (!after.ok) return ok({ matched: true, state: 'termination_unverified', detail: 'Process status could not be re-read after cancellation' });
    if (isVerifiedTerminalProcess(after.value.state)) {
      return ok({ matched: true, state: 'cancelled', detail: after.value.state });
    }
    return ok({ matched: true, state: 'termination_unverified', detail: after.value.state });
  }

  public async list(actor: FileActor, workspaceId: string): Promise<Result<readonly ManagedProcess[]>> {
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace.ok) return workspace;
    const processes = this.processManager.list?.() ?? [];
    return ok(processes.filter((process) => {
      const owner = this.owners.get(process.processId);
      return owner?.actorId === actor.clientId && owner.sessionId === actorSessionId(actor) && owner.workspaceId === workspace.value.id;
    }));
  }

  public async logs(actor: FileActor, workspaceId: string, processId: string, query: LogQuery): Promise<Result<ProcessLogResult>> {
    const ownership = this.authorizeHandle(actor, workspaceId, processId);
    if (!ownership.ok) return ownership;
    return this.processManager.logs(processId, query);
  }

  public async stop(actor: FileActor, workspaceId: string, processId: string, userConfirmed = false, authorization?: InvocationAuthorization): Promise<Result<void>> {
    const ownership = this.authorizeHandle(actor, workspaceId, processId);
    if (!ownership.ok) return ownership;
    if (this.authorizationBypassProvider() || isFullBypassAuthorization(authorization)) return this.processManager.stop(processId);
    const permissionDecision = this.permissionEngine.decide(this.profileProvider(), {
      action: 'process_stop',
      level: 'EXECUTE',
      workspaceId,
      target: processId,
      destructive: false,
    });
    if (permissionDecision === 'DENY') return err(appError('PERMISSION_DENIED', 'Stopping this owned process is denied'));
    if (permissionDecision === 'ASK' && !isApplicationAuthorized(authorization, userConfirmed)) return err(appError('PERMISSION_REQUIRED', 'Stopping this owned process requires permission'));
    return this.processManager.stop(processId);
  }

  private async startInternal(actor: FileActor, workspaceId: string, request: ProcessStartRequest, source: CommandSource, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<ManagedProcess>> {
    const validation = this.validateRequest(request);
    if (!validation.ok) return validation;
    if (isAborted(signal)) return cancelledStart();
    const workspace = await this.getWorkspace(workspaceId);
    if (isAborted(signal)) return cancelledStart();
    if (!workspace.ok) return workspace;
    const bypassAuthorization = this.authorizationBypassProvider() || isFullBypassAuthorization(authorization);
    const cwd = await this.resolveCwd(workspace.value, request.cwd, bypassAuthorization);
    if (isAborted(signal)) return cancelledStart();
    if (!cwd.ok) return cwd;

    const applicationApproved = isApplicationAuthorized(authorization, request.userConfirmed === true);
    if (!bypassAuthorization) {
      const prohibitedReason = prohibitedAgentCommandReason(request.executable, request.args);
      if (prohibitedReason !== undefined) return err(appError('PERMISSION_DENIED', prohibitedReason));
      const riskyReason = riskyAgentCommandReason(request.executable, request.args);
      if (riskyReason !== undefined && !applicationApproved) return err(appError('PERMISSION_REQUIRED', riskyReason));
      if (this.unrestricted && request.cwd !== undefined && path.isAbsolute(request.cwd) && !isWithinWorkspace(workspace.value.realRootPath, cwd.value) && !applicationApproved) {
        return err(appError('PERMISSION_REQUIRED', 'Running outside the selected workspace requires explicit user confirmation'));
      }
    }

    const profile = this.profileProvider();
    const commandDecision = bypassAuthorization ? 'ALLOW' : this.commandPolicy.decide(profile, request.executable, source, request.args);
    if (commandDecision === 'DENY') return err(appError('PERMISSION_DENIED', 'Executable is not permitted'));
    const permissionDecision = bypassAuthorization ? 'ALLOW' : this.permissionEngine.decide(profile, {
      action: 'process_start',
      level: 'EXECUTE',
      workspaceId,
      target: request.cwd ?? '.',
      executable: request.executable,
      destructive: false,
    });
    if (permissionDecision === 'DENY') return err(appError('PERMISSION_DENIED', 'Process execution is denied'));
    if ((commandDecision === 'ASK' || permissionDecision === 'ASK') && !applicationApproved) return err(appError('PERMISSION_REQUIRED', 'Process execution requires permission'));

    if (isAborted(signal)) return cancelledStart();
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMsProvider?.();
    const started = await this.processManager.start({
      executable: request.executable,
      args: [...request.args],
      cwd: cwd.value,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }, signal, (process) => {
      this.owners.set(process.processId, { actorId: actor.clientId, sessionId: actorSessionId(actor), workspaceId });
    });
    if (started.ok && isAborted(signal)) {
      // A process can be spawned just before goal cancellation aborts the
      // request. Stop that provisional child before returning so it cannot
      // escape tracking as an unowned background worker.
      await this.processManager.stop(started.value.processId, true).catch(() => undefined);
      return cancelledStart();
    }
    if (started.ok) this.owners.set(started.value.processId, { actorId: actor.clientId, sessionId: actorSessionId(actor), workspaceId });
    return started;
  }

  private async resolveCwd(workspace: Workspace, requestedCwd: string | undefined, bypassAuthorization: boolean): Promise<Result<string>> {
    if ((this.unrestricted || bypassAuthorization) && requestedCwd !== undefined && path.isAbsolute(requestedCwd) && !pathStaysWithinWorkspace(workspace.realRootPath, requestedCwd)) {
      try {
        const canonical = await realpath(requestedCwd);
        if (!(await stat(canonical)).isDirectory()) return err(appError('INVALID_INPUT', 'Process cwd must be a directory'));
        return ok(canonical);
      } catch {
        return err(appError('FILE_NOT_FOUND', 'Process cwd was not found'));
      }
    }
    const resolved = await this.guard.resolveForRead(workspace, requestedCwd ?? '.');
    if (!resolved.ok) return resolved;
    const cwd = resolved.value.realPath;
    if (cwd === undefined) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Process cwd could not be canonically verified'));
    try {
      if (!(await stat(cwd)).isDirectory()) return err(appError('INVALID_INPUT', 'Process cwd must be a directory'));
    } catch {
      return err(appError('FILE_NOT_FOUND', 'Process cwd was not found'));
    }
    return ok(cwd);
  }

  private validateRequest(request: ProcessStartRequest): Result<void> {
    if (typeof request.executable !== 'string' || request.executable.trim().length === 0 || !Array.isArray(request.args) || !request.args.every((arg) => typeof arg === 'string')) {
      return err(appError('INVALID_INPUT', 'Executable and args are required'));
    }
    if (request.cwd !== undefined && typeof request.cwd !== 'string') {
      return err(appError('INVALID_INPUT', 'Process cwd must be a path string'));
    }
    if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1)) {
      return err(appError('INVALID_INPUT', 'Process timeout is invalid'));
    }
    return ok(undefined);
  }

  private authorizeHandle(actor: FileActor, workspaceId: string, processId: string): Result<void> {
    const owner = this.owners.get(processId);
    if (owner === undefined) return err(appError('PROCESS_NOT_FOUND', 'Process was not found'));
    if (owner.actorId !== actor.clientId || owner.sessionId !== actorSessionId(actor) || owner.workspaceId !== workspaceId) {
      return err(appError('PERMISSION_DENIED', 'Process handle is not owned by this client and workspace'));
    }
    return ok(undefined);
  }

  private async getWorkspace(workspaceId: string): Promise<Result<Workspace>> {
    const workspace = await this.workspaces.get(workspaceId);
    return workspace === null ? err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found')) : ok(workspace);
  }
}

function commandsEqual(left: CommandSpec, right: CommandSpec): boolean {
  return left.executable === right.executable
    && left.args.length === right.args.length
    && left.args.every((arg, index) => arg === right.args[index]);
}

function actorSessionId(actor: FileActor): string {
  return actor.sessionId?.trim() || actor.clientId;
}

function cancelledStart(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Process start was cancelled before launch completed', true));
}

function pathStaysWithinWorkspace(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  const [firstSegment] = relative.split(path.sep);
  return firstSegment !== '..';
}

function isWithinWorkspace(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..');
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isVerifiedTerminalProcess(state: ManagedProcess['state']): boolean {
  return state === 'exited' || state === 'failed' || state === 'stopped' || state === 'timed_out';
}
