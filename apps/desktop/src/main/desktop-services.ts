import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  JsonWorkspaceIndexStore,
  WorkspaceIndexService,
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
  parseExtensionsSettings,
  type ExtensionsService,
  type ExtensionsSettings,
} from '@lnwjud/extensions';
import {
  ActivityTracker,
  composeActivitySinks,
  createFileActivitySink,
  mcpActivityLogPath,
  type ActivitySinkEvent,
  type McpApplicationServices,
  type McpHttpServerOptions,
} from '@lnwjud/mcp-server';
import { permissionProfiles, type PermissionProfile, type PermissionProfileName } from '@lnwjud/permissions';
import type { ManagedProcess } from '@lnwjud/process';
import { PathExecutableResolver } from '@lnwjud/search';
import {
  ALLOW_AI_DELETE_SETTING_KEY,
  DESTRUCTIVE_AUTO_APPROVAL_SETTING_KEY,
  APP_NAME,
  APP_VERSION,
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  DEFAULT_MCP_IDLE_TIMEOUT_MS,
  DEFAULT_PROCESS_TIMEOUT_MS,
  DEFAULT_MCP_POLL_WAIT_SECONDS,
  DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS,
  MIN_CONFIGURABLE_WAIT_SECONDS,
  MAX_CONFIGURABLE_WAIT_SECONDS,
  DEFAULT_CODEX_TOOLS_ENABLED,
  DEFAULT_TUNNEL_MAX_AUTO_RESTARTS,
  DEFAULT_UPDATE_INTERVAL_MINUTES,
  STDIO_ALLOWED_ROOTS_SETTING_KEY,
  STDIO_PERMISSION_PROFILE_SETTING_KEY,
  STDIO_STRICT_ROOTS_SETTING_KEY,
  UNRESTRICTED_SETTING_KEY,
  USER_SETTING_KEYS,
  isUnrestricted,
  parseCloseBehavior,
  parseCustomPermissionSettings,
  parseIntegerSetting,
  parsePathList,
  parseStringRecordSetting,
  parseAllowedRoots,
  parseBooleanSetting,
  parseDestructiveAutoApprovalPolicy,
  parseStdioPermissionProfile,
  serializeAllowedRoots,
  serializeCustomPermissionSettings,
  serializeDestructiveAutoApprovalPolicy,
  serializePathList,
  serializeStringRecordSetting,
  loadCheckpointEncryptionKey,
  type DestructiveAutoApprovalPolicy,
} from '@lnwjud/shared';
import { AesGcmCheckpointCipher, SqliteAuditRepository, SqliteBackupService, SqliteCheckpointRepository, SqliteDatabase, SqliteSettingsRepository, SqliteWorkspaceRepository, type BackupReason, type BackupSummary } from '@lnwjud/storage';
import type { Workspace } from '@lnwjud/workspace';
import { isDriveRoot, machineRootPath, SecretPolicy, WorkspacePathGuard, WorkspaceService } from '@lnwjud/workspace';
import {
  type AddWorkspaceRequest,
  type BackupSummary as IpcBackupSummary,
  type AgentState,
  type AuditEventSummary,
  type ClearLogBufferRequest,
  type ClearWorkLogRequest,
  type ConfigureTunnelProfileRequest,
  type DeleteWorkspaceRequest,
  type ConnectionModes,
  type DashboardSnapshot,
  type DoctorReport,
  type InFlightWorkItem,
  type LogSnapshot,
  type ManagedBrowserStatus,
  type McpConnectionStatus,
  type PermissionProfileName as IpcPermissionProfileName,
  type ProcessSummary,
  type SaveTunnelApiKeyRequest,
  type ScheduleRestoreBackupRequest,
  type SelectWorkspaceRequest,
  type SetWorkspaceArchivedRequest,
  type SetAiDeletePolicyRequest,
  type SetLocaleRequest,
  type SetPermissionProfileRequest,
  type SetStdioPolicyRequest,
  type SetTunnelClientPathRequest,
  type SetUnrestrictedModeRequest,
  type SetUserSettingsRequest,
  type StartMcpRequest,
  type StartProcessRequest,
  type StopProcessRequest,
  type TunnelStatus,
  type UserSettings,
  type UiLocale,
  type WorkLogEntry,
  type WorkspaceSummary,
} from '@lnwjud/ipc-contracts';
import type { DesktopIpcServices } from './main.js';
import { buildCapabilitySummary, createLocalCapabilityRuntime } from './capability-runtime.js';
import { LogHub } from './log-hub.js';
import { buildIncidentReport, collectRelevantListeners, collectRelevantProcessTree, type IncidentReport } from './incident-report.js';
import { DesktopMcpLifecycle } from './mcp-lifecycle.js';
import { WorkLogViewState } from './work-log-view-state.js';
import { CLIENT_PATH_SETTING, TunnelController } from './tunnel-controller.js';
import { packagedStdioLauncherCandidates, preferredTunnelMcpCommand, resolveStdioLauncherPath } from './tunnel-profile.js';

const actor: FileActor = { clientId: 'desktop-renderer', clientName: `${APP_NAME} desktop` };
const mcpActor: FileActor = { clientId: 'desktop-mcp-http', clientName: `${APP_NAME} desktop MCP` };
const permissionSettingKey = 'permission_profile';
const selectedWorkspaceSettingKey = 'selected_workspace_id';
const workLogClearedSettingKey = 'work_log_cleared_at';
const localeSettingKey = 'ui_locale';

export interface DesktopRuntime {
  readonly services: DesktopIpcServices;
  readonly mcpServices: McpApplicationServices;
  readonly mcpActor: FileActor;
  readonly activityTracker: ActivityTracker;
  readonly logHub: LogHub;
  getLocale(): UiLocale;
  getUserSettings(): UserSettings;
  getDestructivePolicy(): DestructiveAutoApprovalPolicy;
  createBackup(reason?: BackupReason): Promise<BackupSummary>;
  ensureDefaultWorkspace(rootPath: string): Promise<string>;
  autoStartMcp(): Promise<McpConnectionStatus>;
  close(): Promise<void>;
}

export interface DesktopRuntimeOptions {
  readonly permissionProfile?: PermissionProfileName;
}

export function createDesktopRuntime(dataPath: string, options: DesktopRuntimeOptions = {}): DesktopRuntime {
  const databaseFilename = path.join(dataPath, 'lnwjud.sqlite');
  const backupDirectory = path.join(dataPath, 'backups');
  const database = new SqliteDatabase(databaseFilename, { backupDirectory });
  const workspaceRepository = new SqliteWorkspaceRepository(database);
  const workspaceIndex = new WorkspaceIndexService(workspaceRepository, new JsonWorkspaceIndexStore(path.join(dataPath, 'workspace-index')));
  const settingsRepository = new SqliteSettingsRepository(database);
  const workLogViewState = new WorkLogViewState(settingsRepository);
  const auditRepository: AuditEventRepository = new SqliteAuditRepository(database);
  const auditService = new AuditService(auditRepository);
  const checkpointCipher = new AesGcmCheckpointCipher(loadCheckpointEncryptionKey(dataPath));
  const checkpointRepository = new SqliteCheckpointRepository(database, checkpointCipher);
  const backupService = new SqliteBackupService(database, { backupDirectory, databaseFilename });
  void backupService.ensureRecent().catch((error: unknown) => {
    console.error(`Automatic database backup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  });
  const workspaceService = new WorkspaceService(workspaceRepository);
  const gitService = new GitService(workspaceRepository);
  const codexDiscovery = new CodexDiscovery();
  const executableResolver = new PathExecutableResolver();
  const storedProfile = settingsRepository.get(permissionSettingKey);
  let profileName: PermissionProfileName = options.permissionProfile ?? readPermissionProfile(storedProfile);
  if (options.permissionProfile === undefined && storedProfile === null) settingsRepository.set(permissionSettingKey, profileName);
  const readSettings = (): UserSettings => readUserSettings(settingsRepository, process.env);
  const activePermissionProfile = (): PermissionProfile => profileName === 'custom'
    ? customPermissionProfile(settingsRepository)
    : permissionProfiles[profileName];
  const unrestricted = isUnrestricted(process.env, settingsRepository.get(UNRESTRICTED_SETTING_KEY));
  const destructivePolicyProvider = (): DestructiveAutoApprovalPolicy => parseDestructiveAutoApprovalPolicy(
    settingsRepository.get(DESTRUCTIVE_AUTO_APPROVAL_SETTING_KEY),
    parseBooleanSetting(settingsRepository.get(ALLOW_AI_DELETE_SETTING_KEY), false),
  );
  const allowAiDeleteProvider = (): boolean => destructivePolicyProvider().approvals.delete_file;
  const projectService = new ProjectService(workspaceRepository);
  const processService = new ProcessService(workspaceRepository, {
    projectService,
    profileProvider: activePermissionProfile,
    defaultTimeoutMsProvider: (): number => readSettings().processTimeoutMs,
    unrestricted,
  });
  const checkpointService = new CheckpointService(workspaceRepository, checkpointRepository, {
    profileProvider: activePermissionProfile,
  });
  const pathGuard = new WorkspacePathGuard(new SecretPolicy(), { unrestricted, trustedWorkspaceAccess: true });
  const fileService = new FileService(workspaceRepository, pathGuard, undefined, {
    checkpointService,
    profileProvider: activePermissionProfile,
    unrestricted,
    trustedWorkspaceAccess: true,
    allowDeleteWithoutConfirmation: allowAiDeleteProvider,
    protectCriticalFiles: (): boolean => destructivePolicyProvider().protectCriticalFiles,
    recoverableDelete: (): boolean => destructivePolicyProvider().recoverableDelete,
    recoveryTrashRoot: path.join(dataPath, 'recovery-trash'),
  });
  const workspaceInfoService = new WorkspaceInfoService(workspaceRepository, workspaceService, unrestricted);
  const workspaceQueryService = new WorkspaceQueryService(workspaceRepository, pathGuard);
  const searchService = new SearchService(workspaceRepository);
  const projectSnapshotService = new ProjectSnapshotService(workspaceRepository, {
    projectService,
    gitService,
    workspaceQuery: workspaceQueryService,
    processService,
  });
  const codexService = new CodexService(workspaceRepository, {
    auditService,
    profileProvider: activePermissionProfile,
  });
  const capabilityRuntime = createLocalCapabilityRuntime(dataPath, async (): Promise<readonly string[]> => (
    (await workspaceRepository.list()).map((workspace) => workspace.realRootPath)
  ), unrestricted, () => readSettings().capabilityRoots, () => readSettings().shellSynchronousWaitSeconds);
  // Start machine-root synchronization lazily so runtime construction cannot race
  // with the first workspace/database operation on slower Windows runners.
  const machineRootsReady = new Map<string, Promise<Workspace | null>>();
  const ensureMachineRoots = (preferredPath?: string): Promise<Workspace | null> => {
    const key = unrestricted ? '*' : machineRootPath(preferredPath).toLowerCase();
    const existing = machineRootsReady.get(key);
    if (existing !== undefined) return existing;
    const pending = syncMachineRoots(workspaceService, unrestricted, preferredPath);
    machineRootsReady.set(key, pending);
    return pending;
  };
  const extensionsService: ExtensionsService = createLocalExtensionsService({
    settingsJson: settingsRepository.get(EXTENSIONS_SETTINGS_KEY),
    workspaceRootProvider: async (): Promise<string | undefined> => {
      const selected = await resolveSelectedWorkspace(workspaceService, settingsRepository);
      return selected?.realRootPath;
    },
    callTimeoutMs: readSettings().mcpCallTimeoutMs,
    idleTimeoutMs: readSettings().mcpIdleTimeoutMs,
  });
  const mcpServices: McpApplicationServices = {
    runtimeStatePath: path.join(dataPath, 'upgrade-runtime.json'),
    runtimeTiming: () => ({ mcpPollWaitSeconds: readSettings().mcpPollWaitSeconds }),
    localProviders: () => {
      const settings = readSettings();
      return {
        ...(settings.pdfProviderPath.trim().length === 0 ? {} : { pdfProvider: settings.pdfProviderPath }),
        lspCommands: settings.lspCommands,
      };
    },
    capabilities: capabilityRuntime.service,
    extensions: extensionsService,
    workspaceInfo: workspaceInfoService,
    workspaceQuery: workspaceQueryService,
    projectSnapshot: projectSnapshotService,
    project: projectService,
    file: fileService,
    search: searchService,
    workspaceIndex,
    git: gitService,
    process: processService,
    codex: codexService,
  };
  const activityLogPath = mcpActivityLogPath(dataPath);
  let activityLogDiagnostic: ((key: string, message: string) => void) | null = null;
  const activityTracker = new ActivityTracker(composeActivitySinks([
    createFileActivitySink(activityLogPath),
    {
      async record(event: ActivitySinkEvent): Promise<void> {
        await auditService.recordMcpTool({
          actorId: mcpActor.clientId,
          actorName: mcpActor.clientName,
          ...(event.workspaceId === undefined ? {} : { workspaceId: event.workspaceId }),
          ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
          toolName: event.toolName,
          callId: event.callId,
          phase: event.phase,
          ...(event.targetSummary === undefined ? {} : { targetSummary: event.targetSummary }),
          resultCode: event.resultCode,
          ...(event.resultMessage === undefined ? {} : { resultMessage: event.resultMessage }),
          ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
          ...(event.traceParent === undefined ? {} : { traceParent: event.traceParent }),
          durationMs: event.durationMs,
          timestamp: event.timestamp,
        });
      },
    },
  ]), (error, event) => {
    const message = error instanceof Error ? error.message : String(error);
    activityLogDiagnostic?.(
      'activity-sink:' + event.callId + ':' + event.phase + ':' + message,
      '[ERROR] MCP activity logging failed — ' + message,
    );
  });
  const mcpPort = readMcpPort(process.env.LNWJUD_MCP_PORT ?? settingsRepository.get(USER_SETTING_KEYS.mcpHttpPort) ?? undefined);
  const mcpLifecycle = new DesktopMcpLifecycle({
    createServerOptions: (): McpHttpServerOptions => ({
      // Prefer a dedicated loopback port so we never collide with common app ports (e.g. 5000).
      // startMcpHttp falls back to an ephemeral port when the preferred bind is busy.
      port: mcpPort,
      services: mcpServices,
      actor: mcpActor,
      activityTracker,
      profileProvider: activePermissionProfile,
      allowAiDeleteProvider,
      destructivePolicyProvider,

      codexToolsEnabled: readSettings().codexToolsEnabled,
    }),
  });
  const tunnelController = new TunnelController({
    getClientPath: (): string | null => settingsRepository.get(CLIENT_PATH_SETTING),
    setClientPath: (value: string): void => { settingsRepository.set(CLIENT_PATH_SETTING, value); },
    getDataPath: (): string => dataPath,
    getStdioLauncherPath: (): string | null => {
      const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
      const cmdPath = resolveStdioLauncherPath([
        ...(typeof resourcesPath === 'string'
          ? packagedStdioLauncherCandidates(process.execPath, resourcesPath)
          : packagedStdioLauncherCandidates(process.execPath)),
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'build', process.platform === 'win32' ? 'lnwjud-mcp-stdio.cmd' : 'lnwjud-mcp-stdio'),
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'build', 'lnwjud-mcp-stdio.cmd'),
      ]);
      return preferredTunnelMcpCommand(process.execPath, cmdPath);
    },
    autoReconnect: (): boolean => readSettings().tunnelAutoReconnect,
    maxAutoRestarts: (): number => readSettings().tunnelMaxAutoRestarts,
  });
  const logHub = new LogHub({
    tunnelLogPath: tunnelController.logPath(),
    mcpActivityLogPath: activityLogPath,
  });
  activityLogDiagnostic = (key, message): void => {
    logHub.feedIfNew('mcp', key, 'error', message);
  };
  const trackedProcesses = new Map<string, string>();

  async function resolveManageableWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = await workspaceRepository.getAny(workspaceId);
    if (workspace === null) throw new Error('Workspace was not found');
    if (isDriveRoot(workspace.realRootPath) || isDriveRoot(workspace.rootPath)) {
      throw new Error('Machine-root workspaces are managed automatically and cannot be archived or deleted');
    }
    return workspace;
  }

  async function assertWorkspaceIdle(workspaceId: string): Promise<void> {
    if (activityTracker.listInFlight().some((entry) => entry.workspaceId === workspaceId)) {
      throw new Error('Workspace has MCP work in progress; wait for it to finish before archiving or deleting it');
    }
    for (const [processId, ownerWorkspaceId] of trackedProcesses) {
      if (ownerWorkspaceId !== workspaceId) continue;
      const status = await processService.status(actor, workspaceId, processId);
      if (!status.ok) continue;
      if (status.value.state === 'starting' || status.value.state === 'running' || status.value.state === 'termination_unverified') {
        throw new Error('Workspace has a managed process running; stop it before archiving or deleting it');
      }
    }
  }

  async function repairSelectedWorkspace(removedWorkspaceId: string): Promise<void> {
    if (settingsRepository.get(selectedWorkspaceSettingKey) !== removedWorkspaceId) return;
    const next = (await workspaceService.list())[0];
    if (next === undefined) settingsRepository.delete(selectedWorkspaceSettingKey);
    else settingsRepository.set(selectedWorkspaceSettingKey, next.id);
  }
  const doctorService = new DoctorService({
    os: async (): Promise<DoctorProbeResult> => ({ status: (process.platform === 'win32' || process.platform === 'darwin') ? 'pass' : 'warn', message: `${process.platform} ${process.arch}` }),
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

  async function selectWorkspaceOnly(workspaceId: string): Promise<WorkspaceSummary> {
    const workspace = await resolveWorkspaceOrThrow(workspaceId);
    await ensureMachineRoots(workspace.realRootPath);
    settingsRepository.set(selectedWorkspaceSettingKey, workspaceId);
    return toWorkspaceSummary(workspace);
  }

  const services: DesktopIpcServices = {
    listWorkspaces: async (): Promise<readonly WorkspaceSummary[]> => {
      await ensureMachineRoots();
      return (await workspaceRepository.listAll()).map(toWorkspaceSummary);
    },
    addWorkspace: async (request: AddWorkspaceRequest): Promise<WorkspaceSummary> => {
      await ensureMachineRoots(request.rootPath);
      const requestedRoot = path.resolve(request.rootPath).toLowerCase();
      const existing = (await workspaceRepository.listAll()).find((entry) => path.resolve(entry.rootPath).toLowerCase() === requestedRoot);
      if (existing !== undefined) {
        if (existing.archivedAt !== undefined && existing.archivedAt !== null) await workspaceRepository.restore(existing.id);
        settingsRepository.set(selectedWorkspaceSettingKey, existing.id);
        if (!mcpLifecycle.status().running) await mcpLifecycle.start().catch(() => undefined);
        const restored = await workspaceRepository.getAny(existing.id);
        if (restored === null) throw new Error('Workspace could not be restored');
        return toWorkspaceSummary(restored);
      }
      const displayName = path.basename(path.resolve(request.rootPath)) || 'Workspace';
      const workspace = unwrap(await workspaceService.add(displayName, request.rootPath), 'Workspace could not be added');
      settingsRepository.set(selectedWorkspaceSettingKey, workspace.id);
      if (!mcpLifecycle.status().running) {
        await mcpLifecycle.start().catch(() => undefined);
      }
      return toWorkspaceSummary(workspace);
    },
    selectWorkspace: async (request: SelectWorkspaceRequest): Promise<WorkspaceSummary> => {
      await ensureMachineRoots();
      return selectWorkspaceOnly(request.workspaceId);
    },
    setWorkspaceArchived: async (request: SetWorkspaceArchivedRequest): Promise<WorkspaceSummary> => {
      await ensureMachineRoots();
      const workspace = await resolveManageableWorkspace(request.workspaceId);
      if (request.archived) {
        if (workspace.archivedAt !== undefined && workspace.archivedAt !== null) return toWorkspaceSummary(workspace);
        await assertWorkspaceIdle(workspace.id);
        await workspaceIndex.stopWatch(workspace.id);
        await workspaceRepository.archive(workspace.id);
        await repairSelectedWorkspace(workspace.id);
      } else if (workspace.archivedAt !== undefined && workspace.archivedAt !== null) {
        await workspaceRepository.restore(workspace.id);
      }
      const updated = await workspaceRepository.getAny(workspace.id);
      if (updated === null) throw new Error('Workspace was not found');
      return toWorkspaceSummary(updated);
    },
    deleteWorkspace: async (request: DeleteWorkspaceRequest): Promise<{ readonly deleted: boolean; readonly workspaceId: string; readonly rootPath: string }> => {
      await ensureMachineRoots();
      const workspace = await resolveManageableWorkspace(request.workspaceId);
      await assertWorkspaceIdle(workspace.id);
      await workspaceIndex.forgetWorkspace(workspace.id);
      await workspaceRepository.delete(workspace.id);
      await repairSelectedWorkspace(workspace.id);
      return { deleted: true, workspaceId: workspace.id, rootPath: workspace.realRootPath };
    },
    getDashboard: async (): Promise<DashboardSnapshot> => {
      await ensureMachineRoots();
      const selectedWorkspace = await resolveSelectedWorkspace(workspaceService, settingsRepository);
      const gitSummary = selectedWorkspace === null
        ? { branch: null, changedFiles: 0, stagedFiles: 0, message: 'No workspace selected' }
        : await buildGitSummary(selectedWorkspace, gitService, actor);
      const codex = await buildCodexSummary(codexDiscovery);
      const recentAuditEvents = await buildAuditSummary(auditRepository, settingsRepository);
      const processSummaries = await listTrackedProcesses(processService, trackedProcesses);
      const capabilities = await buildCapabilitySummary(capabilityRuntime.health);
      const mcp = mcpLifecycle.status();
      const workLog = await buildWorkLog(auditRepository, workLogViewState);
      const inFlight = activityTracker.listInFlight().map(toInFlightItem);
      const tunnel = await tunnelController.status();
      const backups = await backupService.list();
      logHub.syncWorkLog(workLog, inFlight.map((item) => ({ callId: item.callId, toolName: item.toolName, targetSummary: item.targetSummary, startedAt: item.startedAt, workspaceId: item.workspaceId, sessionId: item.sessionId })));
      logHub.syncProcesses(processSummaries.map((summary) => ({
        id: summary.id,
        workspaceId: summary.workspaceId,
        sessionId: summary.sessionId,
        executable: summary.executable,
        args: summary.args,
        state: summary.state,
        logSummary: summary.logSummary,
      })));
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
        allowAiDelete: allowAiDeleteProvider(),
        destructiveDeletePolicy: destructivePolicyProvider(),
        stdioPermissionProfile: parseStdioPermissionProfile(settingsRepository.get(STDIO_PERMISSION_PROFILE_SETTING_KEY), 'full'),
        stdioStrictRoots: parseBooleanSetting(settingsRepository.get(STDIO_STRICT_ROOTS_SETTING_KEY), false),
        stdioAllowedRoots: parseAllowedRoots(settingsRepository.get(STDIO_ALLOWED_ROOTS_SETTING_KEY)),
        backups: backups.map(toIpcBackupSummary),
        connectionModes: buildConnectionModes(mcp.url),
        workLog,
        inFlight,
        tunnel,
        settings: readSettings(),
        appVersion: APP_VERSION,
      };
    },
    setPermissionProfile: async (request: SetPermissionProfileRequest): Promise<{ readonly profile: IpcPermissionProfileName }> => {
      profileName = request.profile;
      settingsRepository.set(permissionSettingKey, profileName);
      return { profile: profileName };
    },
    setUnrestrictedMode: async (request: SetUnrestrictedModeRequest): Promise<{ readonly unrestricted: boolean; readonly restartRequired: boolean }> => {
      settingsRepository.set(UNRESTRICTED_SETTING_KEY, request.enabled ? 'true' : 'false');
      const applied = isUnrestricted(process.env, settingsRepository.get(UNRESTRICTED_SETTING_KEY));
      return { unrestricted: applied, restartRequired: applied !== unrestricted };
    },
    setAiDeletePolicy: async (request: SetAiDeletePolicyRequest): Promise<{ readonly enabled: boolean; readonly policy: DestructiveAutoApprovalPolicy }> => {
      const current = destructivePolicyProvider();
      const policy = request.policy ?? { ...current, approvals: { ...current.approvals, delete_file: request.enabled ?? current.approvals.delete_file } };
      settingsRepository.set(DESTRUCTIVE_AUTO_APPROVAL_SETTING_KEY, serializeDestructiveAutoApprovalPolicy(policy));
      settingsRepository.set(ALLOW_AI_DELETE_SETTING_KEY, policy.approvals.delete_file ? 'true' : 'false');
      return { enabled: policy.approvals.delete_file, policy: destructivePolicyProvider() };
    },
    setStdioPolicy: async (request: SetStdioPolicyRequest): Promise<{ readonly profile: IpcPermissionProfileName; readonly strictRoots: boolean; readonly allowedRoots: readonly string[]; readonly restartRequired: boolean }> => {
      const allowedRoots = parseAllowedRoots(request.allowedRoots.join(';'));
      if (request.strictRoots && allowedRoots.length === 0) throw new Error('Strict root mode requires at least one allowed root');
      settingsRepository.set(STDIO_PERMISSION_PROFILE_SETTING_KEY, request.profile);
      settingsRepository.set(STDIO_STRICT_ROOTS_SETTING_KEY, request.strictRoots ? 'true' : 'false');
      settingsRepository.set(STDIO_ALLOWED_ROOTS_SETTING_KEY, serializeAllowedRoots(allowedRoots));
      const tunnelStatus = await tunnelController.status();
      return { profile: request.profile, strictRoots: request.strictRoots, allowedRoots, restartRequired: tunnelStatus.state === 'running' };
    },
    createBackup: async (): Promise<IpcBackupSummary> => toIpcBackupSummary(await backupService.create('manual')),
    scheduleRestoreBackup: async (request: ScheduleRestoreBackupRequest): Promise<{ readonly scheduled: boolean; readonly restartRequired: boolean }> => {
      const tunnelStatus = await tunnelController.status();
      if (tunnelStatus.state === 'running') throw new Error('Stop Secure MCP Tunnel before scheduling a database restore');
      if (mcpLifecycle.status().running) throw new Error('Stop local MCP before scheduling a database restore');
      await backupService.scheduleRestore(request.backupId);
      return { scheduled: true, restartRequired: true };
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
    startMcp: async (request: StartMcpRequest): Promise<McpConnectionStatus> => {
      const workspace = await resolveWorkspaceOrThrow(request.workspaceId);
      await ensureMachineRoots(workspace.realRootPath);
      return mcpLifecycle.start();
    },
    stopMcp: (): Promise<McpConnectionStatus> => mcpLifecycle.stop(),
    restartMcp: async (): Promise<McpConnectionStatus> => {
      await ensureMachineRoots();
      return mcpLifecycle.restart();
    },
    clearWorkLog: async (request: ClearWorkLogRequest = {}): Promise<{ readonly cleared: boolean }> => {
      workLogViewState.clear(request);
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
    setUserSettings: async (request: SetUserSettingsRequest): Promise<{ readonly settings: UserSettings; readonly restartRequired: boolean }> => {
      const previous = readSettings();
      persistUserSettings(settingsRepository, request.settings);
      const next = readSettings();
      return { settings: next, restartRequired: runtimeRestartRequired(previous, next) };
    },
    configureTunnelProfile: async (request: ConfigureTunnelProfileRequest): Promise<{ readonly configured: boolean; readonly profilePath: string }> => ({
      configured: true,
      profilePath: await tunnelController.configureProfile(request.tunnelId),
    }),
    launchManagedBrowser: async (): Promise<ManagedBrowserStatus> => {
      const result = await capabilityRuntime.service.execute('dom_cdp', { action: 'launch' });
      return toManagedBrowserStatus(unwrap(result, 'Managed Chrome could not be started'));
    },
    runDoctor: async (): Promise<DoctorReport> => {
      await ensureMachineRoots();
      return doctorService.run();
    },
    getLogSnapshot: async (): Promise<LogSnapshot> => {
      await ensureMachineRoots();
      const workLog = await buildWorkLog(auditRepository, workLogViewState);
      const inFlight = activityTracker.listInFlight().map(toInFlightItem);
      const processSummaries = await listTrackedProcesses(processService, trackedProcesses);
      logHub.syncWorkLog(workLog, inFlight.map((item) => ({ callId: item.callId, toolName: item.toolName, targetSummary: item.targetSummary, startedAt: item.startedAt, workspaceId: item.workspaceId, sessionId: item.sessionId })));
      logHub.syncProcesses(processSummaries.map((summary) => ({
        id: summary.id,
        workspaceId: summary.workspaceId,
        sessionId: summary.sessionId,
        executable: summary.executable,
        args: summary.args,
        state: summary.state,
        logSummary: summary.logSummary,
      })));
      return logHub.snapshot();
    },
    clearLogBuffer: async (request: ClearLogBufferRequest): Promise<{ readonly cleared: boolean }> => {
      logHub.clear(request.source, request);
      return { cleared: true };
    },
    captureIncident: async (updaterEvents: readonly string[] = []): Promise<IncidentReport> => {
      const tunnel = await tunnelController.status();
      const tunnelClientVersion = await tunnelController.clientVersion();
      const relevantPids = await tunnelController.incidentRelevantPids();
      return buildIncidentReport({
        triggeredByUser: true,
        appVersion: APP_VERSION,
        tunnelClientVersion: tunnelClientVersion.value,
        tunnelClientVersionReason: tunnelClientVersion.reason,
        tunnel: { state: tunnel.state, source: tunnel.source, health: await tunnelController.incidentHealth() },
        updaterEvents,
        logLines: logHub.snapshot().lines,
        relevantPids: relevantPids.pids,
        ...(relevantPids.unavailableReason === null ? {} : { relevantPidUnavailableReason: relevantPids.unavailableReason }),
        collectProcessTree: collectRelevantProcessTree,
        collectListeners: collectRelevantListeners,
      });
    },
  };

  return {
    services,
    mcpServices,
    mcpActor,
    activityTracker,
    logHub,
    getLocale: (): UiLocale => readLocale(settingsRepository),
    getUserSettings: (): UserSettings => readSettings(),
    getDestructivePolicy: (): DestructiveAutoApprovalPolicy => destructivePolicyProvider(),
    createBackup: (reason: BackupReason = 'manual'): Promise<BackupSummary> => backupService.create(reason),
    ensureDefaultWorkspace: async (rootPath: string): Promise<string> => {
      await ensureMachineRoots(rootPath);
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
      await ensureMachineRoots();
      const envWorkspacePath = process.env.LNWJUD_WORKSPACE?.trim();
      if (envWorkspacePath !== undefined && envWorkspacePath.length > 0) {
        await ensureMachineRoots(envWorkspacePath);
        const resolvedPath = path.resolve(envWorkspacePath);
        const existing = await workspaceService.list();
        const matched = existing.find((workspace) => workspace.realRootPath.toLowerCase() === resolvedPath.toLowerCase());
        const workspaceId = matched === undefined
          ? unwrap(await workspaceService.add(path.basename(resolvedPath) || 'Workspace', resolvedPath), 'Workspace could not be added').id
          : matched.id;
        settingsRepository.set(selectedWorkspaceSettingKey, workspaceId);
        return mcpLifecycle.start();
      }
      const selected = await resolveSelectedWorkspace(workspaceService, settingsRepository);
      if (selected === null) {
        const workspacePath = process.cwd();
        await ensureMachineRoots(workspacePath);
        const workspaceId = await (async (): Promise<string> => {
          const existing = await workspaceService.list();
          const matched = existing.find((workspace) => workspace.realRootPath.toLowerCase() === path.resolve(workspacePath).toLowerCase());
          if (matched !== undefined) return matched.id;
          const displayName = path.basename(path.resolve(workspacePath)) || 'Workspace';
          const added = unwrap(await workspaceService.add(displayName, workspacePath), 'Workspace could not be added');
          return added.id;
        })();
        settingsRepository.set(selectedWorkspaceSettingKey, workspaceId);
        return mcpLifecycle.start();
      }
      return mcpLifecycle.start();
    },
    close: async (): Promise<void> => {
      // Keep the rest of the runtime usable when the owned tunnel cannot be
      // proven stopped. The caller may surface the failure and retry safely.
      await tunnelController.stopOwned();
      logHub.stop();
      await mcpLifecycle.close();
      await extensionsService.close().catch(() => undefined);
      await workspaceIndex.close().catch(() => undefined);
      database.close();
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
    summaries.push(toProcessSummary(status.value, workspaceId, logs.ok ? summarizeLogs([...logs.value.entries].reverse().map((entry) => entry.text)) : ''));
  }
  return summaries;
}

function toProcessSummary(processValue: ManagedProcess, workspaceId: string, logSummary: string): ProcessSummary {
  return {
    id: processValue.processId,
    workspaceId,
    sessionId: null,
    executable: redactDisplayText(processValue.executable),
    args: processValue.args.map(redactDisplayText),
    state: processValue.state,
    logSummary,
  };
}

function toIpcBackupSummary(value: BackupSummary): IpcBackupSummary {
  return { id: value.id, createdAt: value.createdAt, reason: value.reason, sizeBytes: value.sizeBytes };
}

function toWorkspaceSummary(workspace: Workspace): WorkspaceSummary {
  return {
    id: workspace.id,
    displayName: workspace.displayName,
    rootPath: workspace.rootPath,
    realRootPath: workspace.realRootPath,
    createdAt: workspace.createdAt,
    archivedAt: workspace.archivedAt ?? null,
    kind: isDriveRoot(workspace.realRootPath) || isDriveRoot(workspace.rootPath) ? 'machine_root' : 'project',
  };
}

async function buildGitSummary(
  workspace: Workspace,
  gitService: GitService,
  fileActor: FileActor,
): Promise<DashboardSnapshot['gitSummary']> {
  const result = await gitService.status(fileActor, workspace.id);
  if (!result.ok) {
    return {
      branch: null,
      changedFiles: 0,
      stagedFiles: 0,
      message: result.error.code === 'GIT_NOT_REPOSITORY' ? 'Not a Git repository' : 'Git status unavailable',
      repositoryPath: workspace.realRootPath,
      isRepo: false,
      entries: [],
    };
  }
  const branchResult = await gitService.branch(fileActor, workspace.id);
  const branch = branchResult.ok ? branchResult.value : null;
  const stagedFiles = result.value.entries.filter((entry) => entry.indexStatus !== ' ').length;
  return {
    branch,
    changedFiles: result.value.entries.length,
    stagedFiles,
    message: result.value.entries.length === 0 ? 'Clean working tree' : `${result.value.entries.length} changed file(s)`,
    repositoryPath: workspace.realRootPath,
    isRepo: true,
    entries: result.value.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      indexStatus: entry.indexStatus,
      worktreeStatus: entry.worktreeStatus,
    })),
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
  viewState: WorkLogViewState,
): Promise<readonly WorkLogEntry[]> {
  const events = await listVisibleMcpEvents(repository, viewState, 100);
  return events.map((event) => {
    const toolName = typeof event.metadata.toolName === 'string' ? event.metadata.toolName : event.action.replace(/^mcp_tool:/, '');
    const phase = event.metadata.phase === 'started' ? 'started' : 'completed';
    const kind = phase === 'started'
      ? 'task'
      : event.resultCode === 'SUCCESS' || event.resultCode === 'STARTED'
        ? 'result'
        : 'error';
    const callId = typeof event.metadata.callId === 'string' ? event.metadata.callId : undefined;
    return {
      id: event.id,
      timestamp: event.timestamp,
      kind,
      toolName,
      resultCode: event.resultCode,
      errorMessage: typeof event.metadata.errorMessage === 'string' ? event.metadata.errorMessage : null,
      targetSummary: event.targetSummary ?? null,
      durationMs: event.durationMs,
      workspaceId: event.workspaceId ?? null,
      sessionId: event.sessionId ?? null,
      ...(callId === undefined ? {} : { callId }),
    } satisfies WorkLogEntry;
  });
}

async function listVisibleMcpEvents(
  repository: AuditEventRepository,
  viewState: WorkLogViewState,
  limit: number,
): Promise<readonly AuditEvent[]> {
  const events = await repository.listScoped({ actionPrefix: 'mcp_tool:' }, 500);
  return events.filter((event) => viewState.isVisible(event)).slice(0, limit);
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

function toInFlightItem(entry: { callId: string; toolName: string; startedAt: string; targetSummary?: string; workspaceId?: string; sessionId?: string }): InFlightWorkItem {
  return {
    callId: entry.callId,
    toolName: entry.toolName,
    startedAt: entry.startedAt,
    targetSummary: entry.targetSummary ?? null,
    workspaceId: entry.workspaceId ?? null,
    sessionId: entry.sessionId ?? null,
  };
}

function deriveAgentState(running: boolean, inFlightCount: number): AgentState {
  if (!running) return 'stopped';
  return inFlightCount > 0 ? 'busy' : 'idle';
}

function buildConnectionModes(httpUrl: string | null): ConnectionModes {
  const packaged = process.env.LNWJUD_PACKAGED_EXECUTABLE?.trim();
  const defaultExecutable = process.platform === 'win32' ? 'lnwjud.exe' : 'lnwjud';
  const stdioCommand = packaged && packaged.length > 0
    ? `${packaged} --mcp-stdio`
    : `${defaultExecutable} --mcp-stdio`;
  return { httpUrl, stdioCommand };
}

function readUserSettings(settingsRepository: SqliteSettingsRepository, env: NodeJS.ProcessEnv): UserSettings {
  const extensions = parseExtensionsSettings(settingsRepository.get(EXTENSIONS_SETTINGS_KEY));
  return {
    customPermission: parseCustomPermissionSettings(settingsRepository.get(USER_SETTING_KEYS.customPermissionProfile)),
    mcpCallTimeoutMs: parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.mcpCallTimeoutMs), DEFAULT_MCP_CALL_TIMEOUT_MS, 1_000, 60 * 60_000),
    mcpIdleTimeoutMs: parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.mcpIdleTimeoutMs), DEFAULT_MCP_IDLE_TIMEOUT_MS, 30_000, 24 * 60 * 60_000),
    processTimeoutMs: parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.processTimeoutMs), DEFAULT_PROCESS_TIMEOUT_MS, 1_000, 4 * 60 * 60_000),
    mcpPollWaitSeconds: parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.mcpPollWaitSeconds), DEFAULT_MCP_POLL_WAIT_SECONDS, MIN_CONFIGURABLE_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS),
    shellSynchronousWaitSeconds: parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.shellSynchronousWaitSeconds), DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS, MIN_CONFIGURABLE_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS),
    capabilityRoots: parsePathList(settingsRepository.get(USER_SETTING_KEYS.capabilityRoots)),
    pdfProviderPath: settingsRepository.get(USER_SETTING_KEYS.pdfProviderPath)?.trim() ?? '',
    lspCommands: parseStringRecordSetting(settingsRepository.get(USER_SETTING_KEYS.lspCommands)),
    mcpHttpPort: readMcpPort(env.LNWJUD_MCP_PORT ?? settingsRepository.get(USER_SETTING_KEYS.mcpHttpPort) ?? undefined),
    codexToolsEnabled: parseBooleanSetting(settingsRepository.get(USER_SETTING_KEYS.codexToolsEnabled), DEFAULT_CODEX_TOOLS_ENABLED),
    updateAutoCheck: parseBooleanSetting(settingsRepository.get(USER_SETTING_KEYS.updateAutoCheck), true),
    updateCheckOnStartup: parseBooleanSetting(settingsRepository.get(USER_SETTING_KEYS.updateCheckOnStartup), true),
    updateIntervalMinutes: parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.updateIntervalMinutes), DEFAULT_UPDATE_INTERVAL_MINUTES, 5, 24 * 60),
    updateAutoDownload: parseBooleanSetting(settingsRepository.get(USER_SETTING_KEYS.updateAutoDownload), true),
    closeBehavior: parseCloseBehavior(settingsRepository.get(USER_SETTING_KEYS.closeBehavior)),
    launchAtStartup: parseBooleanSetting(settingsRepository.get(USER_SETTING_KEYS.launchAtStartup), false),
    startMinimized: parseBooleanSetting(settingsRepository.get(USER_SETTING_KEYS.startMinimized), false),
    tunnelAutoReconnect: parseBooleanSetting(settingsRepository.get(USER_SETTING_KEYS.tunnelAutoReconnect), true),
    tunnelMaxAutoRestarts: parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.tunnelMaxAutoRestarts), DEFAULT_TUNNEL_MAX_AUTO_RESTARTS, 0, 50),
    extensions: toIpcExtensionsSettings(extensions),
  };
}

function persistUserSettings(settingsRepository: SqliteSettingsRepository, settings: UserSettings): void {
  settingsRepository.set(USER_SETTING_KEYS.customPermissionProfile, serializeCustomPermissionSettings(settings.customPermission));
  settingsRepository.set(USER_SETTING_KEYS.mcpCallTimeoutMs, String(settings.mcpCallTimeoutMs));
  settingsRepository.set(USER_SETTING_KEYS.mcpIdleTimeoutMs, String(settings.mcpIdleTimeoutMs));
  settingsRepository.set(USER_SETTING_KEYS.processTimeoutMs, String(settings.processTimeoutMs));
  settingsRepository.set(USER_SETTING_KEYS.mcpPollWaitSeconds, String(settings.mcpPollWaitSeconds));
  settingsRepository.set(USER_SETTING_KEYS.shellSynchronousWaitSeconds, String(settings.shellSynchronousWaitSeconds));
  settingsRepository.set(USER_SETTING_KEYS.capabilityRoots, serializePathList(settings.capabilityRoots));
  settingsRepository.set(USER_SETTING_KEYS.pdfProviderPath, settings.pdfProviderPath.trim());
  settingsRepository.set(USER_SETTING_KEYS.lspCommands, serializeStringRecordSetting(settings.lspCommands));
  settingsRepository.set(USER_SETTING_KEYS.mcpHttpPort, String(settings.mcpHttpPort));
  settingsRepository.set(USER_SETTING_KEYS.codexToolsEnabled, settings.codexToolsEnabled ? 'true' : 'false');
  settingsRepository.set(USER_SETTING_KEYS.updateAutoCheck, settings.updateAutoCheck ? 'true' : 'false');
  settingsRepository.set(USER_SETTING_KEYS.updateCheckOnStartup, settings.updateCheckOnStartup ? 'true' : 'false');
  settingsRepository.set(USER_SETTING_KEYS.updateIntervalMinutes, String(settings.updateIntervalMinutes));
  settingsRepository.set(USER_SETTING_KEYS.updateAutoDownload, settings.updateAutoDownload ? 'true' : 'false');
  settingsRepository.set(USER_SETTING_KEYS.closeBehavior, settings.closeBehavior);
  settingsRepository.set(USER_SETTING_KEYS.launchAtStartup, settings.launchAtStartup ? 'true' : 'false');
  settingsRepository.set(USER_SETTING_KEYS.startMinimized, settings.startMinimized ? 'true' : 'false');
  settingsRepository.set(USER_SETTING_KEYS.tunnelAutoReconnect, settings.tunnelAutoReconnect ? 'true' : 'false');
  settingsRepository.set(USER_SETTING_KEYS.tunnelMaxAutoRestarts, String(settings.tunnelMaxAutoRestarts));
  const extraMcpServers = Object.fromEntries(settings.extensions.extraMcpServers.map((server) => [server.name, {
    command: server.command,
    ...(server.args.length === 0 ? {} : { args: [...server.args] }),
    ...(server.cwd.trim().length === 0 ? {} : { cwd: server.cwd.trim() }),
    ...(server.type.trim().length === 0 ? {} : { type: server.type.trim() }),
    ...(Object.keys(server.env).length === 0 ? {} : { env: { ...server.env } }),
  }]));
  settingsRepository.set(EXTENSIONS_SETTINGS_KEY, JSON.stringify({
    mode: settings.extensions.mode,
    disabledServers: [...settings.extensions.disabledServers],
    enabledServers: [...settings.extensions.enabledServers],
    disabledSkillRoots: [...settings.extensions.disabledSkillRoots],
    extraSkillRoots: [...settings.extensions.extraSkillRoots],
    extraMcpServers,
  }));
}

function toIpcExtensionsSettings(settings: ExtensionsSettings): UserSettings['extensions'] {
  return {
    mode: settings.mode,
    disabledServers: [...settings.disabledServers],
    enabledServers: [...settings.enabledServers],
    disabledSkillRoots: [...settings.disabledSkillRoots],
    extraSkillRoots: [...settings.extraSkillRoots],
    extraMcpServers: Object.entries(settings.extraMcpServers).map(([name, config]) => ({
      name,
      command: config.command,
      args: [...(config.args ?? [])],
      cwd: config.cwd ?? '',
      type: config.type ?? '',
      env: { ...(config.env ?? {}) },
    })),
  };
}

function customPermissionProfile(settingsRepository: SqliteSettingsRepository): PermissionProfile {
  const custom = parseCustomPermissionSettings(settingsRepository.get(USER_SETTING_KEYS.customPermissionProfile));
  return {
    name: 'custom',
    defaults: { READ: custom.read, WRITE: custom.write, EXECUTE: custom.execute, DANGEROUS: custom.dangerous },
    allowedProjectExecutables: [...new Set([...permissionProfiles.custom.allowedProjectExecutables, ...custom.allowedExecutables])],
  };
}

function runtimeRestartRequired(previous: UserSettings, next: UserSettings): boolean {
  return previous.mcpCallTimeoutMs !== next.mcpCallTimeoutMs
    || previous.mcpIdleTimeoutMs !== next.mcpIdleTimeoutMs
    || previous.mcpHttpPort !== next.mcpHttpPort
    || previous.codexToolsEnabled !== next.codexToolsEnabled
    || previous.pdfProviderPath !== next.pdfProviderPath
    || JSON.stringify(previous.lspCommands) !== JSON.stringify(next.lspCommands)
    || JSON.stringify(previous.customPermission) !== JSON.stringify(next.customPermission)
    || JSON.stringify(previous.extensions) !== JSON.stringify(next.extensions);
}

function readPermissionProfile(value: string | null): PermissionProfileName {
  return value === 'safe' || value === 'balanced' || value === 'full' || value === 'custom' ? value : 'full';
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
