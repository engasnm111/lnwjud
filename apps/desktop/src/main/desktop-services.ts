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
  syncMachineRoots,
  WorkspaceInfoService,
  WorkspaceQueryService,
  type FileActor,
  type DoctorProbeResult,
} from '@lnwjud/application';
import { AuditService, type AuditEvent, type AuditEventRepository } from '@lnwjud/audit';
import { CodexDiscovery, formatCodexDiscoveryError } from '@lnwjud/codex';
import type { Result } from '@lnwjud/domain';
import {
  EXTENSIONS_SETTINGS_KEY,
  createLocalExtensionsService,
  type ExtensionsService,
} from '@lnwjud/extensions';
import {
  ActivityTracker,
  type ActivitySinkEvent,
  type McpApplicationServices,
  type McpHttpServerOptions,
} from '@lnwjud/mcp-server';
import { permissionProfiles, type PermissionProfileName } from '@lnwjud/permissions';
import type { ManagedProcess } from '@lnwjud/process';
import { PathExecutableResolver } from '@lnwjud/search';
import { isUnrestricted, UNRESTRICTED_SETTING_KEY } from '@lnwjud/shared';
import { SqliteAuditRepository, SqliteCheckpointRepository, SqliteDatabase, SqliteSettingsRepository, SqliteWorkspaceRepository } from '@lnwjud/storage';
import type { Workspace } from '@lnwjud/workspace';
import { isUnderEDrive, SecretPolicy, WorkspacePathGuard, WorkspaceService } from '@lnwjud/workspace';
import {
  type AddWorkspaceRequest,
  type AgentState,
  type AuditEventSummary,
  type ConnectionModes,
  type DashboardSnapshot,
  type DoctorReport,
  type InFlightWorkItem,
  type ManagedBrowserStatus,
  type McpConnectionStatus,
  type PermissionProfileName as IpcPermissionProfileName,
  type ProcessSummary,
  type SaveTunnelApiKeyRequest,
  type SelectWorkspaceRequest,
  type SetLocaleRequest,
  type SetPermissionProfileRequest,
  type SetTunnelClientPathRequest,
  type SetUnrestrictedModeRequest,
  type StartMcpRequest,
  type StartProcessRequest,
  type StopProcessRequest,
  type TunnelStatus,
  type UiLocale,
  type WorkLogEntry,
  type WorkspaceSummary,
} from '@lnwjud/ipc-contracts';
import type { DesktopIpcServices } from './main.js';
import { buildCapabilitySummary, createLocalCapabilityRuntime } from './capability-runtime.js';
import { DesktopMcpLifecycle } from './mcp-lifecycle.js';
import { CLIENT_PATH_SETTING, TunnelController } from './tunnel-controller.js';

const actor: FileActor = { clientId: 'desktop-renderer', clientName: 'lnwjud desktop' };
const mcpActor: FileActor = { clientId: 'desktop-mcp-http', clientName: 'lnwjud desktop MCP' };
const permissionSettingKey = 'permission_profile';
const selectedWorkspaceSettingKey = 'selected_workspace_id';
const workLogClearedSettingKey = 'work_log_cleared_at';
const localeSettingKey = 'ui_locale';
const APP_VERSION = '0.1.0';

export interface DesktopRuntime {
  readonly services: DesktopIpcServices;
  readonly mcpServices: McpApplicationServices;
  readonly mcpActor: FileActor;
  readonly activityTracker: ActivityTracker;
  ensureDefaultWorkspace(rootPath: string): Promise<string>;
  autoStartMcp(): Promise<McpConnectionStatus>;
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
  let profileName: PermissionProfileName = 'full';
  settingsRepository.set(permissionSettingKey, 'full');
  const unrestricted = isUnrestricted(process.env, settingsRepository.get(UNRESTRICTED_SETTING_KEY));
  const fullProfile = permissionProfiles.full;
  const projectService = new ProjectService(workspaceRepository);
  const processService = new ProcessService(workspaceRepository, {
    projectService,
    profileProvider: (): typeof permissionProfiles.full => fullProfile,
    unrestricted,
  });
  const checkpointService = new CheckpointService(workspaceRepository, checkpointRepository, {
    profile: fullProfile,
  });
  const pathGuard = unrestricted ? new WorkspacePathGuard(new SecretPolicy(), { unrestricted: true }) : undefined;
  const fileService = new FileService(workspaceRepository, pathGuard, undefined, {
    checkpointService,
    profileProvider: (): typeof permissionProfiles.full => fullProfile,
    unrestricted,
  });
  const workspaceInfoService = new WorkspaceInfoService(workspaceRepository, workspaceService, unrestricted);
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
    profileProvider: (): typeof permissionProfiles.full => fullProfile,
  });
  const capabilityRuntime = createLocalCapabilityRuntime(dataPath, async (): Promise<readonly string[]> => (
    (await workspaceRepository.list()).map((workspace) => workspace.realRootPath)
  ), unrestricted);
  // Ensure machine roots exist (E:\ only by default; every fixed drive in unrestricted mode).
  const machineRootReady = syncMachineRoots(workspaceService, unrestricted);
  const extensionsService: ExtensionsService = createLocalExtensionsService({
    settingsJson: settingsRepository.get(EXTENSIONS_SETTINGS_KEY),
    workspaceRootProvider: async (): Promise<string | undefined> => {
      const selected = await resolveSelectedWorkspace(workspaceService, settingsRepository);
      return selected?.realRootPath;
    },
  });
  const mcpServices: McpApplicationServices = {
    capabilities: capabilityRuntime.service,
    extensions: extensionsService,
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
  const activityTracker = new ActivityTracker({
    async record(event: ActivitySinkEvent): Promise<void> {
      await auditService.recordMcpTool({
        actorId: mcpActor.clientId,
        actorName: mcpActor.clientName,
        ...(event.workspaceId === undefined ? {} : { workspaceId: event.workspaceId }),
        toolName: event.toolName,
        callId: event.callId,
        phase: event.phase,
        ...(event.targetSummary === undefined ? {} : { targetSummary: event.targetSummary }),
        resultCode: event.resultCode,
        durationMs: event.durationMs,
        timestamp: event.timestamp,
      });
    },
  });
  const mcpPort = readMcpPort(process.env.LNWJUD_MCP_PORT);
  const mcpLifecycle = new DesktopMcpLifecycle({
    workspaceExists: async (workspaceId: string): Promise<boolean> => (await workspaceRepository.get(workspaceId)) !== null,
    createServerOptions: (): McpHttpServerOptions => ({
      // Prefer a dedicated loopback port so we never collide with common app ports (e.g. 5000).
      // startMcpHttp falls back to an ephemeral port when the preferred bind is busy.
      port: mcpPort,
      services: mcpServices,
      actor: mcpActor,
      activityTracker,
    }),
  });
  const tunnelController = new TunnelController({
    getClientPath: (): string | null => settingsRepository.get(CLIENT_PATH_SETTING),
    setClientPath: (value: string): void => { settingsRepository.set(CLIENT_PATH_SETTING, value); },
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

  async function resolveWorkspaceOrThrow(workspaceId: string): Promise<Workspace> {
    const workspace = await workspaceRepository.get(workspaceId);
    if (workspace === null) throw new Error('Workspace was not found');
    return workspace;
  }

  async function selectAndMaybeRestart(workspaceId: string): Promise<WorkspaceSummary> {
    const workspace = await resolveWorkspaceOrThrow(workspaceId);
    settingsRepository.set(selectedWorkspaceSettingKey, workspaceId);
    if (mcpLifecycle.status().running) {
      await mcpLifecycle.restart(workspaceId);
    }
    return toWorkspaceSummary(workspace);
  }

  const services: DesktopIpcServices = {
    listWorkspaces: async (): Promise<readonly WorkspaceSummary[]> => (await workspaceService.list()).map(toWorkspaceSummary),
    addWorkspace: async (request: AddWorkspaceRequest): Promise<WorkspaceSummary> => {
      if (!unrestricted && !isUnderEDrive(request.rootPath)) {
        throw new Error('Workspace path must be under E:\\ (enable Unrestricted mode in Settings to add other drives)');
      }
      const displayName = path.basename(path.resolve(request.rootPath)) || 'Workspace';
      const workspace = unwrap(await workspaceService.add(displayName, request.rootPath), 'Workspace could not be added');
      settingsRepository.set(selectedWorkspaceSettingKey, workspace.id);
      if (!mcpLifecycle.status().running) {
        await mcpLifecycle.start(workspace.id).catch(() => undefined);
      } else {
        await mcpLifecycle.restart(workspace.id).catch(() => undefined);
      }
      return toWorkspaceSummary(workspace);
    },
    selectWorkspace: async (request: SelectWorkspaceRequest): Promise<WorkspaceSummary> => selectAndMaybeRestart(request.workspaceId),
    getDashboard: async (): Promise<DashboardSnapshot> => {
      const selectedWorkspace = await resolveSelectedWorkspace(workspaceService, settingsRepository);
      const gitSummary = selectedWorkspace === null
        ? { branch: null, changedFiles: 0, stagedFiles: 0, message: 'No workspace selected' }
        : await buildGitSummary(selectedWorkspace, gitService, actor);
      const codex = await buildCodexSummary(codexDiscovery);
      const recentAuditEvents = await buildAuditSummary(auditRepository, settingsRepository);
      const processSummaries = await listTrackedProcesses(processService, trackedProcesses);
      const capabilities = await buildCapabilitySummary(capabilityRuntime.health);
      const mcp = mcpLifecycle.status();
      const workLog = await buildWorkLog(auditRepository, settingsRepository);
      const inFlight = activityTracker.listInFlight().map(toInFlightItem);
      const tunnel = await tunnelController.status();
      return {
        selectedWorkspace: selectedWorkspace === null ? null : toWorkspaceSummary(selectedWorkspace),
        gitSummary,
        mcp,
        codex,
        managedProcessCount: processSummaries.length,
        auditEventCount: recentAuditEvents.length,
        recentAuditEvents,
        permissionProfile: profileName,
        capabilities,
        agentState: deriveAgentState(mcp.running, inFlight.length),
        mode: 'WORK',
        locale: readLocale(settingsRepository),
        unrestricted,
        connectionModes: buildConnectionModes(mcp.url),
        workLog,
        inFlight,
        tunnel,
        appVersion: APP_VERSION,
      };
    },
    setPermissionProfile: async (request: SetPermissionProfileRequest): Promise<{ readonly profile: IpcPermissionProfileName }> => {
      void request;
      profileName = 'full';
      settingsRepository.set(permissionSettingKey, profileName);
      return { profile: profileName };
    },
    setUnrestrictedMode: async (request: SetUnrestrictedModeRequest): Promise<{ readonly unrestricted: boolean; readonly restartRequired: boolean }> => {
      settingsRepository.set(UNRESTRICTED_SETTING_KEY, request.enabled ? 'true' : 'false');
      const applied = isUnrestricted(process.env, settingsRepository.get(UNRESTRICTED_SETTING_KEY));
      return { unrestricted: applied, restartRequired: applied !== unrestricted };
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
    restartMcp: async (): Promise<McpConnectionStatus> => {
      const selected = await resolveSelectedWorkspace(workspaceService, settingsRepository);
      if (selected === null) throw new Error('A workspace is required to restart MCP');
      return mcpLifecycle.restart(selected.id);
    },
    clearWorkLog: async (): Promise<{ readonly cleared: boolean }> => {
      settingsRepository.set(workLogClearedSettingKey, new Date().toISOString());
      return { cleared: true };
    },
    saveTunnelApiKey: async (request: SaveTunnelApiKeyRequest): Promise<{ readonly saved: boolean }> => {
      await tunnelController.saveApiKey(request.apiKey);
      return { saved: true };
    },
    startTunnel: (): Promise<TunnelStatus> => tunnelController.start(),
    stopTunnel: (): Promise<TunnelStatus> => tunnelController.stop(),
    getTunnelStatus: (): Promise<TunnelStatus> => tunnelController.status(),
    setTunnelClientPath: async (request: SetTunnelClientPathRequest): Promise<{ readonly clientPath: string }> => ({
      clientPath: tunnelController.setClientPath(request.clientPath),
    }),
    setLocale: async (request: SetLocaleRequest): Promise<{ readonly locale: UiLocale }> => {
      settingsRepository.set(localeSettingKey, request.locale);
      return { locale: request.locale };
    },
    launchManagedBrowser: async (): Promise<ManagedBrowserStatus> => {
      const result = await capabilityRuntime.service.execute('dom_cdp', { action: 'launch' });
      return toManagedBrowserStatus(unwrap(result, 'Managed Chrome could not be started'));
    },
    runDoctor: (): Promise<DoctorReport> => doctorService.run(),
  };

  return {
    services,
    mcpServices,
    mcpActor,
    activityTracker,
    ensureDefaultWorkspace: async (rootPath: string): Promise<string> => {
      await machineRootReady;
      if (!unrestricted && !isUnderEDrive(rootPath)) {
        throw new Error('Workspace path must be under E:\\');
      }
      const existing = await workspaceService.list();
      const matched = existing.find((workspace) => workspace.realRootPath.toLowerCase() === path.resolve(rootPath).toLowerCase());
      if (matched !== undefined) {
        settingsRepository.set(selectedWorkspaceSettingKey, matched.id);
        return matched.id;
      }
      const selectedId = settingsRepository.get(selectedWorkspaceSettingKey);
      if (selectedId !== null) {
        const selected = existing.find((workspace) => workspace.id === selectedId);
        if (selected !== undefined) return selected.id;
      }
      if (existing[0] !== undefined) {
        settingsRepository.set(selectedWorkspaceSettingKey, existing[0].id);
        return existing[0].id;
      }
      const displayName = path.basename(path.resolve(rootPath)) || 'Workspace';
      const added = unwrap(await workspaceService.add(displayName, rootPath), 'Workspace could not be added');
      settingsRepository.set(selectedWorkspaceSettingKey, added.id);
      return added.id;
    },
    autoStartMcp: async (): Promise<McpConnectionStatus> => {
      await machineRootReady;
      const selected = await resolveSelectedWorkspace(workspaceService, settingsRepository);
      if (selected === null) {
        const workspacePath = process.env.LNWJUD_WORKSPACE?.trim() || process.cwd();
        if (!unrestricted && !isUnderEDrive(workspacePath)) {
          throw new Error('Workspace path must be under E:\\');
        }
        const workspaceId = await (async (): Promise<string> => {
          const existing = await workspaceService.list();
          const matched = existing.find((workspace) => workspace.realRootPath.toLowerCase() === path.resolve(workspacePath).toLowerCase());
          if (matched !== undefined) return matched.id;
          const displayName = path.basename(path.resolve(workspacePath)) || 'Workspace';
          const added = unwrap(await workspaceService.add(displayName, workspacePath), 'Workspace could not be added');
          return added.id;
        })();
        settingsRepository.set(selectedWorkspaceSettingKey, workspaceId);
        return mcpLifecycle.start(workspaceId);
      }
      return mcpLifecycle.start(selected.id);
    },
    close: async (): Promise<void> => {
      try {
        await mcpLifecycle.close();
        await tunnelController.stop().catch(() => undefined);
      } finally {
        await extensionsService.close().catch(() => undefined);
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

async function resolveSelectedWorkspace(
  workspaceService: WorkspaceService,
  settingsRepository: SqliteSettingsRepository,
): Promise<Workspace | null> {
  const workspaces = await workspaceService.list();
  if (workspaces.length === 0) return null;
  const selectedId = settingsRepository.get(selectedWorkspaceSettingKey);
  const selected = selectedId === null ? undefined : workspaces.find((workspace) => workspace.id === selectedId);
  return selected ?? workspaces[0] ?? null;
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

async function buildAuditSummary(
  repository: AuditEventRepository,
  settingsRepository: SqliteSettingsRepository,
): Promise<readonly AuditEventSummary[]> {
  const events = await listVisibleAuditEvents(repository, settingsRepository, 10);
  return events.map((event) => ({ id: event.id, timestamp: event.timestamp, action: event.action, resultCode: event.resultCode }));
}

async function buildWorkLog(
  repository: AuditEventRepository,
  settingsRepository: SqliteSettingsRepository,
): Promise<readonly WorkLogEntry[]> {
  const events = await listVisibleAuditEvents(repository, settingsRepository, 100);
  return events
    .filter((event) => event.action.startsWith('mcp_tool:'))
    .map((event) => {
      const toolName = typeof event.metadata.toolName === 'string' ? event.metadata.toolName : event.action.replace(/^mcp_tool:/, '');
      const phase = event.metadata.phase === 'started' ? 'started' : 'completed';
      const kind = phase === 'started'
        ? 'task'
        : event.resultCode === 'SUCCESS' || event.resultCode === 'STARTED'
          ? 'result'
          : 'error';
      return {
        id: event.id,
        timestamp: event.timestamp,
        kind,
        toolName,
        resultCode: event.resultCode,
        targetSummary: event.targetSummary ?? null,
        durationMs: event.durationMs,
        workspaceId: event.workspaceId ?? null,
      } satisfies WorkLogEntry;
    });
}

async function listVisibleAuditEvents(
  repository: AuditEventRepository,
  settingsRepository: SqliteSettingsRepository,
  limit: number,
): Promise<readonly AuditEvent[]> {
  const clearedAt = settingsRepository.get(workLogClearedSettingKey);
  const events = await repository.list(limit);
  if (clearedAt === null) return events;
  return events.filter((event) => event.timestamp > clearedAt);
}

function toInFlightItem(entry: { callId: string; toolName: string; startedAt: string; targetSummary?: string; workspaceId?: string }): InFlightWorkItem {
  return {
    callId: entry.callId,
    toolName: entry.toolName,
    startedAt: entry.startedAt,
    targetSummary: entry.targetSummary ?? null,
    workspaceId: entry.workspaceId ?? null,
  };
}

function deriveAgentState(running: boolean, inFlightCount: number): AgentState {
  if (!running) return 'stopped';
  return inFlightCount > 0 ? 'busy' : 'idle';
}

function buildConnectionModes(httpUrl: string | null): ConnectionModes {
  const packaged = process.env.LNWJUD_PACKAGED_EXECUTABLE?.trim();
  const stdioCommand = packaged && packaged.length > 0
    ? `${packaged} --mcp-stdio`
    : 'lnwjud.exe --mcp-stdio';
  return { httpUrl, stdioCommand };
}

function readLocale(settingsRepository: SqliteSettingsRepository): UiLocale {
  const value = settingsRepository.get(localeSettingKey);
  return value === 'en' ? 'en' : 'th';
}

/** Dedicated lnwjud MCP HTTP port — keeps clear of common app ports like 5000/3000/8080. */
export const DEFAULT_MCP_HTTP_PORT = 18_765;

function readMcpPort(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return DEFAULT_MCP_HTTP_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('LNWJUD_MCP_PORT must be an integer from 0 to 65535');
  // Never bind the user's typical app port by accident.
  if (port === 5_000) return DEFAULT_MCP_HTTP_PORT;
  return port;
}

function unwrap<T>(result: Result<T>, fallback: string): T {
  if (result.ok) return result.value;
  throw new Error(result.error.message || fallback);
}

function toManagedBrowserStatus(value: unknown): ManagedBrowserStatus {
  if (!isRecord(value) || typeof value.ready !== 'boolean' || typeof value.port !== 'number' || !Number.isInteger(value.port)
    || typeof value.launched !== 'boolean') {
    throw new Error('Managed Chrome returned an invalid status');
  }
  return { ready: value.ready, port: value.port, launched: value.launched };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
