import { createServer } from 'node:net';
import path from 'node:path';
import {
  DoctorService,
  CheckpointService,
  CodexService,
  FileService,
  GitService,
  ProjectService,
  ProjectSnapshotService,
  ProcessService,
  SearchService,
  WorkspaceInfoService,
  WorkspaceQueryService,
  type FileActor,
  type DoctorProbeResult,
} from '@lnwjud/application';
import { AuditService, type AuditEventRepository } from '@lnwjud/audit';
import { CodexDiscovery, formatCodexDiscoveryError } from '@lnwjud/codex';
import type { Result } from '@lnwjud/domain';
import type { McpApplicationServices, McpHttpServerOptions } from '@lnwjud/mcp-server';
import { permissionProfiles, type PermissionProfileName } from '@lnwjud/permissions';
import type { ManagedProcess } from '@lnwjud/process';
import { PathExecutableResolver } from '@lnwjud/search';
import { SqliteAuditRepository, SqliteCheckpointRepository, SqliteDatabase, SqliteSettingsRepository, SqliteWorkspaceRepository } from '@lnwjud/storage';
import type { Workspace } from '@lnwjud/workspace';
import { WorkspaceService } from '@lnwjud/workspace';
import {
  type AddWorkspaceRequest,
  type AuditEventSummary,
  type DashboardSnapshot,
  type DoctorReport,
  type McpConnectionStatus,
  type PermissionProfileName as IpcPermissionProfileName,
  type ProcessSummary,
  type SetPermissionProfileRequest,
  type StartMcpRequest,
  type StartProcessRequest,
  type StopProcessRequest,
  type WorkspaceSummary,
} from '@lnwjud/ipc-contracts';
import type { DesktopIpcServices } from './main.js';
import { buildCapabilitySummary, createLocalCapabilityRuntime } from './capability-runtime.js';
import { DesktopMcpLifecycle } from './mcp-lifecycle.js';

const actor: FileActor = { clientId: 'desktop-renderer', clientName: 'lnwjud desktop' };
const mcpActor: FileActor = { clientId: 'desktop-mcp-http', clientName: 'lnwjud desktop MCP' };
const permissionSettingKey = 'permission_profile';

export interface DesktopRuntime {
  readonly services: DesktopIpcServices;
  close(): Promise<void>;
}

export function createDesktopRuntime(dataPath: string): DesktopRuntime {
  const database = new SqliteDatabase(path.join(dataPath, 'lnwjud.sqlite'));
  const workspaceRepository = new SqliteWorkspaceRepository(database);
  const settingsRepository = new SqliteSettingsRepository(database);
  const auditRepository: AuditEventRepository = new SqliteAuditRepository(database);
  const auditService = new AuditService(auditRepository);
  const checkpointRepository = new SqliteCheckpointRepository(database);
  const workspaceService = new WorkspaceService(workspaceRepository);
  const gitService = new GitService(workspaceRepository);
  const codexDiscovery = new CodexDiscovery();
  const executableResolver = new PathExecutableResolver();
  let profileName = readPermissionProfile(settingsRepository.get(permissionSettingKey));
  const projectService = new ProjectService(workspaceRepository);
  const processService = new ProcessService(workspaceRepository, {
    projectService,
    profileProvider: (): typeof permissionProfiles[PermissionProfileName] => permissionProfiles[profileName],
  });
  const checkpointService = new CheckpointService(workspaceRepository, checkpointRepository, {
    profile: permissionProfiles[profileName],
  });
  const fileService = new FileService(workspaceRepository, undefined, undefined, {
    checkpointService,
    profileProvider: (): typeof permissionProfiles[PermissionProfileName] => permissionProfiles[profileName],
  });
  const workspaceInfoService = new WorkspaceInfoService(workspaceRepository);
  const workspaceQueryService = new WorkspaceQueryService(workspaceRepository);
  const searchService = new SearchService(workspaceRepository);
  const projectSnapshotService = new ProjectSnapshotService(workspaceRepository, {
    projectService,
    gitService,
    workspaceQuery: workspaceQueryService,
    processService,
  });
  const codexService = new CodexService(workspaceRepository, {
    auditService,
    profileProvider: (): typeof permissionProfiles[PermissionProfileName] => permissionProfiles[profileName],
  });
  const capabilityRuntime = createLocalCapabilityRuntime(dataPath, async (): Promise<readonly string[]> => (
    (await workspaceRepository.list()).map((workspace) => workspace.realRootPath)
  ));
  const mcpServices: McpApplicationServices = {
    capabilities: capabilityRuntime.service,
    workspaceInfo: workspaceInfoService,
    workspaceQuery: workspaceQueryService,
    projectSnapshot: projectSnapshotService,
    project: projectService,
    file: fileService,
    search: searchService,
    git: gitService,
    process: processService,
    codex: codexService,
  };
  const mcpPort = readMcpPort(process.env.LNWJUD_MCP_PORT);
  const mcpLifecycle = new DesktopMcpLifecycle({
    workspaceExists: async (workspaceId: string): Promise<boolean> => (await workspaceRepository.get(workspaceId)) !== null,
    createServerOptions: (): McpHttpServerOptions => ({ port: mcpPort, services: mcpServices, actor: mcpActor }),
  });
  const trackedProcesses = new Map<string, string>();
  const doctorService = new DoctorService({
    os: async (): Promise<DoctorProbeResult> => ({ status: process.platform === 'win32' ? 'pass' : 'warn', message: `${process.platform} ${process.arch}` }),
    database: async (): Promise<DoctorProbeResult> => ({ status: 'pass', message: 'SQLite database ready' }),
    git: async (): Promise<DoctorProbeResult> => checkExecutable(executableResolver, 'git'),
    ripgrep: async (): Promise<DoctorProbeResult> => checkExecutable(executableResolver, 'rg'),
    workspaces: async (): Promise<DoctorProbeResult> => ({ status: 'pass', message: `${(await workspaceService.list()).length} workspace(s) registered` }),
    mcpPort: checkLocalPort,
    codex: async (): Promise<DoctorProbeResult> => checkCodex(codexDiscovery),
  });

  const services: DesktopIpcServices = {
    listWorkspaces: async (): Promise<readonly WorkspaceSummary[]> => (await workspaceService.list()).map(toWorkspaceSummary),
    addWorkspace: async (request: AddWorkspaceRequest): Promise<WorkspaceSummary> => {
      const displayName = path.basename(path.resolve(request.rootPath)) || 'Workspace';
      return unwrap(await workspaceService.add(displayName, request.rootPath), 'Workspace could not be added');
    },
    getDashboard: async (): Promise<DashboardSnapshot> => {
      const workspaces = await workspaceService.list();
      const selectedWorkspace = workspaces[0];
      const gitSummary = selectedWorkspace === undefined
        ? { branch: null, changedFiles: 0, stagedFiles: 0, message: 'No workspace selected' }
        : await buildGitSummary(selectedWorkspace, gitService, actor);
      const codex = await buildCodexSummary(codexDiscovery);
      const recentAuditEvents = await buildAuditSummary(auditRepository);
      const processSummaries = await listTrackedProcesses(processService, trackedProcesses);
      const capabilities = await buildCapabilitySummary(capabilityRuntime.health);
      const mcp = mcpLifecycle.status();
      return {
        selectedWorkspace: selectedWorkspace === undefined ? null : toWorkspaceSummary(selectedWorkspace),
        gitSummary,
        mcp,
        codex,
        managedProcessCount: processSummaries.length,
        auditEventCount: recentAuditEvents.length,
        recentAuditEvents,
        permissionProfile: profileName,
        capabilities,
      };
    },
    setPermissionProfile: async (request: SetPermissionProfileRequest): Promise<{ readonly profile: IpcPermissionProfileName }> => {
      profileName = request.profile;
      settingsRepository.set(permissionSettingKey, profileName);
      return { profile: profileName };
    },
    listProcesses: async (): Promise<readonly ProcessSummary[]> => listTrackedProcesses(processService, trackedProcesses),
    startProcess: async (request: StartProcessRequest): Promise<ProcessSummary> => {
      if (request.mode === 'fixture' && process.env.LNWJUD_E2E_FIXTURE !== '1') {
        throw new Error('Fixture process is only available in the desktop test harness');
      }
      const started = request.mode === 'fixture'
        ? await processService.start(actor, request.workspaceId, {
          executable: fixtureNodeExecutable(),
          args: ['-e', "process.stdout.write('fixture-ready\\n'); setTimeout(() => {}, 30000);"],
          timeoutMs: 60_000,
        })
        : await processService.startProjectCommand(actor, request.workspaceId, 'dev');
      const processValue = unwrap(started, 'Process could not be started');
      trackedProcesses.set(processValue.processId, request.workspaceId);
      return toProcessSummary(processValue, request.workspaceId, '');
    },
    stopProcess: async (request: StopProcessRequest): Promise<{ readonly stopped: boolean }> => {
      const workspaceId = trackedProcesses.get(request.processId);
      if (workspaceId === undefined) return { stopped: false };
      unwrap(await processService.stop(actor, workspaceId, request.processId), 'Process could not be stopped');
      return { stopped: true };
    },
    startMcp: async (request: StartMcpRequest): Promise<McpConnectionStatus> => mcpLifecycle.start(request.workspaceId),
    stopMcp: (): Promise<McpConnectionStatus> => mcpLifecycle.stop(),
    runDoctor: (): Promise<DoctorReport> => doctorService.run(),
  };

  return {
    services,
    close: async (): Promise<void> => {
      try {
        await mcpLifecycle.close();
      } finally {
        database.close();
      }
    },
  };
}

function fixtureNodeExecutable(): string {
  const executable = process.env.LNWJUD_E2E_NODE_PATH;
  if (typeof executable !== 'string' || executable.trim().length === 0) {
    throw new Error('Fixture Node executable is not configured');
  }
  return executable;
}

async function listTrackedProcesses(
  processService: ProcessService,
  trackedProcesses: ReadonlyMap<string, string>,
): Promise<readonly ProcessSummary[]> {
  const summaries: ProcessSummary[] = [];
  for (const [processId, workspaceId] of trackedProcesses) {
    const status = await processService.status(actor, workspaceId, processId);
    if (!status.ok) continue;
    const logs = await processService.logs(actor, workspaceId, processId, { tailLines: 20 });
    summaries.push(toProcessSummary(status.value, workspaceId, logs.ok ? summarizeLogs(logs.value.entries.map((entry) => entry.text)) : ''));
  }
  return summaries;
}

function toProcessSummary(processValue: ManagedProcess, workspaceId: string, logSummary: string): ProcessSummary {
  return {
    id: processValue.processId,
    workspaceId,
    executable: redactDisplayText(processValue.executable),
    args: processValue.args.map(redactDisplayText),
    state: processValue.state,
    logSummary,
  };
}

function toWorkspaceSummary(workspace: Workspace): WorkspaceSummary {
  return {
    id: workspace.id,
    displayName: workspace.displayName,
    rootPath: workspace.rootPath,
    realRootPath: workspace.realRootPath,
    createdAt: workspace.createdAt,
  };
}

async function buildGitSummary(
  workspace: Workspace,
  gitService: GitService,
  fileActor: FileActor,
): Promise<DashboardSnapshot['gitSummary']> {
  const result = await gitService.status(fileActor, workspace.id);
  if (!result.ok) return { branch: null, changedFiles: 0, stagedFiles: 0, message: result.error.code === 'GIT_NOT_REPOSITORY' ? 'Not a Git repository' : 'Git status unavailable' };
  const stagedFiles = result.value.entries.filter((entry) => entry.indexStatus !== ' ').length;
  return {
    branch: null,
    changedFiles: result.value.entries.length,
    stagedFiles,
    message: result.value.entries.length === 0 ? 'Clean working tree' : `${result.value.entries.length} changed file(s)`,
  };
}

async function buildCodexSummary(codexDiscovery: CodexDiscovery): Promise<DashboardSnapshot['codex']> {
  const result = await codexDiscovery.discover();
  if (!result.ok) return { installed: false, version: null };
  return { installed: result.value.status.installed, version: result.value.status.version ?? null };
}

async function buildAuditSummary(repository: AuditEventRepository): Promise<readonly AuditEventSummary[]> {
  const events = await repository.list(10);
  return events.map((event) => ({ id: event.id, timestamp: event.timestamp, action: event.action, resultCode: event.resultCode }));
}

function readPermissionProfile(value: string | null): PermissionProfileName {
  return value === 'safe' || value === 'balanced' || value === 'full' || value === 'custom' ? value : 'safe';
}

function readMcpPort(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('LNWJUD_MCP_PORT must be an integer from 0 to 65535');
  return port;
}

function unwrap<T>(result: Result<T>, fallback: string): T {
  if (result.ok) return result.value;
  throw new Error(result.error.message || fallback);
}

async function checkExecutable(resolver: PathExecutableResolver, executable: string): Promise<{ readonly status: 'pass' | 'warn'; readonly message: string }> {
  const result = await resolver.resolve(executable);
  return result.ok ? { status: 'pass', message: `${executable} is available` } : { status: 'warn', message: `${executable} is not available` };
}

async function checkCodex(discovery: CodexDiscovery): Promise<{ readonly status: 'pass' | 'warn'; readonly message: string }> {
  const result = await discovery.discover();
  if (!result.ok) return { status: 'warn', message: formatCodexDiscoveryError(result.error) };
  return result.value.status.installed ? { status: 'pass', message: `Codex ${result.value.status.version ?? 'installed'}` } : { status: 'warn', message: 'Codex is not installed' };
}

async function checkLocalPort(): Promise<{ readonly status: 'pass' | 'fail'; readonly message: string }> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
    });
    return { status: 'pass', message: '127.0.0.1 is available' };
  } catch {
    return { status: 'fail', message: '127.0.0.1 is unavailable' };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function summarizeLogs(entries: readonly string[]): string {
  return entries.map(redactDisplayText).join('').trim().slice(-2_000);
}

function redactDisplayText(value: string): string {
  return value
    .replace(/(\bauthorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]');
}
