import { stat } from 'node:fs/promises';
import { appError, err, ok, type CommandSpec, type Result } from '@lnwjud/domain';
import { CommandPolicy, DefaultPermissionEngine, permissionProfiles, type PermissionEngine, type PermissionProfile } from '@lnwjud/permissions';
import { ProcessManager, type LogQuery, type ManagedProcess, type ManagedProcessStart, type ProcessLogResult } from '@lnwjud/process';
import { JsCommandDetector, ProjectDetector, type ProjectCommandKind } from '@lnwjud/project';
import { WorkspacePathGuard, type Workspace, type WorkspaceRepository } from '@lnwjud/workspace';
import type { FileActor } from './file-service.js';
import { ProjectService } from './project-service.js';

export interface ProcessStartRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface ProcessManagerPort {
  start(spec: ManagedProcessStart): Promise<Result<ManagedProcess>>;
  list?(): readonly ManagedProcess[];
  status(processId: string): Result<ManagedProcess>;
  logs(processId: string, query: LogQuery): Result<ProcessLogResult>;
  stop(processId: string): Promise<Result<void>>;
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
}

interface ProcessOwner {
  readonly actorId: string;
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
    this.commandPolicy = dependencies.commandPolicy ?? new CommandPolicy();
    this.profileProvider = dependencies.profileProvider ?? ((): PermissionProfile => dependencies.profile ?? permissionProfiles.balanced);
  }

  public start(actor: FileActor, workspaceId: string, request: ProcessStartRequest): Promise<Result<ManagedProcess>> {
    return this.startInternal(actor, workspaceId, request, 'client');
  }

  public async startProjectCommand(actor: FileActor, workspaceId: string, kind: ProjectCommandKind): Promise<Result<ManagedProcess>> {
    const command = await this.projectService.getCommand(workspaceId, kind);
    if (!command.ok) return command;
    return this.startInternal(actor, workspaceId, { executable: command.value.executable, args: command.value.args }, 'project');
  }

  public async status(actor: FileActor, workspaceId: string, processId: string): Promise<Result<ManagedProcess>> {
    const ownership = this.authorizeHandle(actor, workspaceId, processId);
    if (!ownership.ok) return ownership;
    return this.processManager.status(processId);
  }

  public async list(actor: FileActor, workspaceId: string): Promise<Result<readonly ManagedProcess[]>> {
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace.ok) return workspace;
    const processes = this.processManager.list?.() ?? [];
    return ok(processes.filter((process) => {
      const owner = this.owners.get(process.processId);
      return owner?.actorId === actor.clientId && owner.workspaceId === workspace.value.id;
    }));
  }

  public async logs(actor: FileActor, workspaceId: string, processId: string, query: LogQuery): Promise<Result<ProcessLogResult>> {
    const ownership = this.authorizeHandle(actor, workspaceId, processId);
    if (!ownership.ok) return ownership;
    return this.processManager.logs(processId, query);
  }

  public async stop(actor: FileActor, workspaceId: string, processId: string): Promise<Result<void>> {
    const ownership = this.authorizeHandle(actor, workspaceId, processId);
    if (!ownership.ok) return ownership;
    return this.processManager.stop(processId);
  }

  private async startInternal(actor: FileActor, workspaceId: string, request: ProcessStartRequest, source: CommandSource): Promise<Result<ManagedProcess>> {
    const validation = this.validateRequest(request);
    if (!validation.ok) return validation;
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace.ok) return workspace;
    const cwd = await this.resolveCwd(workspace.value, request.cwd);
    if (!cwd.ok) return cwd;

    const profile = this.profileProvider();
    const commandDecision = this.commandPolicy.decide(profile, request.executable, source, request.args);
    if (commandDecision === 'DENY') return err(appError('PERMISSION_DENIED', 'Executable is not permitted'));
    const permissionDecision = this.permissionEngine.decide(profile, {
      action: 'process_start',
      level: 'EXECUTE',
      workspaceId,
      target: request.cwd ?? '.',
      executable: request.executable,
      destructive: false,
    });
    if (permissionDecision === 'DENY') return err(appError('PERMISSION_DENIED', 'Process execution is denied'));
    if (commandDecision === 'ASK' || permissionDecision === 'ASK') return err(appError('PERMISSION_REQUIRED', 'Process execution requires permission'));

    const started = await this.processManager.start({
      executable: request.executable,
      args: [...request.args],
      cwd: cwd.value,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    if (started.ok) this.owners.set(started.value.processId, { actorId: actor.clientId, workspaceId });
    return started;
  }

  private async resolveCwd(workspace: Workspace, requestedCwd: string | undefined): Promise<Result<string>> {
    const resolved = await this.guard.resolveForRead(workspace, requestedCwd ?? '.');
    if (!resolved.ok) return resolved;
    const cwd = resolved.value.realPath ?? resolved.value.absolutePath;
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
    if (owner.actorId !== actor.clientId || owner.workspaceId !== workspaceId) {
      return err(appError('PERMISSION_DENIED', 'Process handle is not owned by this client and workspace'));
    }
    return ok(undefined);
  }

  private async getWorkspace(workspaceId: string): Promise<Result<Workspace>> {
    const workspace = await this.workspaces.get(workspaceId);
    return workspace === null ? err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found')) : ok(workspace);
  }
}
