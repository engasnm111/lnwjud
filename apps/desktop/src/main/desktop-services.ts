import { release as nodeRelease } from 'node:os';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  CheckpointService,
  CodexService,
  FileService,
  GitService,
  GoalContinuationService,
  GoalRequestCancellationService,
  GoalTaskCancellationService,
  GoalMutationFenceService,
  ScheduledContinuationService,
  ProjectService,
  ProjectSnapshotService,
  ProcessService,
  SearchService,
  JsonWorkspaceIndexStore,
  WorkspaceIndexService,
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
  LNWJUD_MCP_IDENTITY_PATH,
  RuntimeGoalManagedTaskStateReader,
  composeActivitySinks,
  createFileActivitySink,
  mcpActivityLogPath,
  type ActivitySinkEvent,
  type HostMutationApprovalRequest,
  type McpApplicationServices,
  type McpHttpServerOptions,
  type WorkspaceScope,

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
  DEFAULT_RECOVERY_RETENTION_DAYS,

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
import { SqliteGoalRepository } from '@lnwjud/storage';

import type { Workspace } from '@lnwjud/workspace';
import { isDriveRoot, SecretPolicy, WorkspacePathGuard, WorkspaceService } from '@lnwjud/workspace';
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
  type DoctorCheck,
  type DoctorReport,
  type ToolCatalogSnapshot,
  type GetToolCatalogRequest,
  type RecheckToolCatalogRequest,
  type ToolCatalogItem,
  type ToolProfileDecision,
  type InFlightWorkItem,
  type LogSnapshot,
  type ManagedBrowserStatus,
  type PdfProviderInstallResult,
  type McpConnectionStatus,
  type PermissionProfileName as IpcPermissionProfileName,
  type ProcessSummary,
  type RestoreCheckpointRequest,
  type RestoreRecoveryItemRequest,

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
import { windowsCompatibilityProfile } from './windows-compatibility.js';
import { buildCapabilitySummary, createLocalCapabilityRuntime } from './capability-runtime.js';
import { RequirementRegistry, type RequirementDefinition, type RequirementProbeResult } from './tool-catalog/requirement-registry.js';
import { RemediationRegistry } from './tool-catalog/remediation-registry.js';
import { ToolCatalogService, type ToolCatalogServiceOptions } from './tool-catalog/tool-catalog-service.js';
import { projectExternalMcpTools } from './tool-catalog/external-tool-catalog-adapter.js';
import { LogHub, classifyMcpWorkLogKind } from './log-hub.js';

import { buildIncidentReport, collectRelevantListeners, collectRelevantProcessTree, type IncidentReport } from './incident-report.js';
import { DesktopMcpLifecycle } from './mcp-lifecycle.js';
import { WorkLogViewState } from './work-log-view-state.js';
import { installPdfProvider, type InstalledPdfProvider } from './pdf-provider-installer.js';
import { CLIENT_PATH_SETTING, TunnelController } from './tunnel-controller.js';


const actor: FileActor = { clientId: 'desktop-renderer', clientName: `${APP_NAME} desktop` };
const mcpActor: FileActor = { clientId: 'desktop-mcp-http', clientName: `${APP_NAME} desktop MCP` };
const permissionSettingKey = 'permission_profile';
const selectedWorkspaceSettingKey = 'selected_workspace_id';
const activeWorkspaceIdsSettingKey = 'active_workspace_ids';
const workLogClearedSettingKey = 'work_log_cleared_at';
const localeSettingKey = 'ui_locale';
const tunnelIdentitySettingKey = 'tunnel_identity_id';


export interface DesktopRuntime {
  readonly services: DesktopIpcServices;
  readonly mcpServices: McpApplicationServices;
  readonly mcpActor: FileActor;
  readonly activityTracker: ActivityTracker;
  readonly logHub: LogHub;
  getLocale(): UiLocale;
  getUserSettings(): UserSettings;
  getDestructivePolicy(): DestructiveAutoApprovalPolicy;
  getActiveWorkspaceScope(): Promise<WorkspaceScope | null>;
  getActiveWorkspaceScopes(): Promise<readonly WorkspaceScope[]>;
  createBackup(reason?: BackupReason): Promise<BackupSummary>;
  ensureDefaultWorkspace(rootPath: string): Promise<string>;
  autoStartMcp(): Promise<McpConnectionStatus>;
  autoStartTunnel(): Promise<TunnelStatus | null>;

  close(): Promise<void>;
}

export interface DesktopRuntimeOptions {
  readonly permissionProfile?: PermissionProfileName;
  readonly hostMutationApprovalProvider?: (request: HostMutationApprovalRequest) => boolean | Promise<boolean>;
  readonly encryptTunnelSecret?: (plain: string) => Promise<string>;
  readonly decryptTunnelSecret?: (encrypted: string) => Promise<string>;
  readonly pdfProviderInstaller?: (dataPath: string) => Promise<InstalledPdfProvider>;
}

interface StartupTunnelController {
  status(): Promise<TunnelStatus>;
  startAutomatically(): Promise<TunnelStatus>;
}

/**
 * Desktop startup is recovery-only: it may start/reconcile the saved tunnel,
 * but it must never stop a surviving persistent runtime merely because a local
 * prerequisite is temporarily unavailable during an update or reinstall.
 */
export async function autoStartPersistentTunnel(
  tunnelController: StartupTunnelController,
  autoReconnect: boolean,
): Promise<TunnelStatus> {
  const status = await tunnelController.status();
  if (!autoReconnect || !status.profileExists || !status.hasApiKey || status.clientPath === null) return status;
  return tunnelController.startAutomatically();
}

export function createDesktopRuntime(dataPath: string, options: DesktopRuntimeOptions = {}): DesktopRuntime {
  const databaseFilename = path.join(dataPath, 'lnwjud.sqlite');
  const backupDirectory = path.join(dataPath, 'backups');
  const database = new SqliteDatabase(databaseFilename, { backupDirectory });
  const workspaceRepository = new SqliteWorkspaceRepository(database);
  const goalRepository = new SqliteGoalRepository(database);
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
  const desktopFullBypassEnabled = (): boolean => profileName === 'full' && readSettings().desktopFullBypassAll;
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
    authorizationBypassProvider: desktopFullBypassEnabled,
  });
  const checkpointService = new CheckpointService(workspaceRepository, checkpointRepository, {
    profileProvider: activePermissionProfile,
  });
  const recoveryTrashRoot = path.join(dataPath, 'recovery-trash');

  const pathGuard = new WorkspacePathGuard(new SecretPolicy(), { unrestricted, trustedWorkspaceAccess: true });
  const fileService = new FileService(workspaceRepository, pathGuard, undefined, {
    checkpointService,
    profileProvider: activePermissionProfile,
    unrestricted,
    trustedWorkspaceAccess: true,
    allowDeleteWithoutConfirmation: (): boolean => desktopFullBypassEnabled() || allowAiDeleteProvider(),
    protectCriticalFiles: (): boolean => !desktopFullBypassEnabled() && destructivePolicyProvider().protectCriticalFiles,
    recoverableDelete: (): boolean => destructivePolicyProvider().recoverableDelete,
    recoveryTrashRoot,

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
    (await workspaceRepository.list())
      .filter((workspace) => !isDriveRoot(workspace.realRootPath) && !isDriveRoot(workspace.rootPath))
      .map((workspace) => workspace.realRootPath)
  ), unrestricted, () => readSettings().capabilityRoots, () => readSettings().shellSynchronousWaitSeconds);
  const taskCancellation = new GoalTaskCancellationService([
    { provider: 'process', cancelForGoal: processService.cancelForGoal.bind(processService) },
    { provider: 'codex', cancelForGoal: codexService.cancelForGoal.bind(codexService) },
    { provider: 'shell', cancelForGoal: capabilityRuntime.shell.cancelForGoal.bind(capabilityRuntime.shell) },
  ]);
  const requestCancellation = new GoalRequestCancellationService();
  const goalService = new GoalContinuationService(workspaceRepository, goalRepository, {
    scheduledContinuations: goalRepository,
    taskCancellation,
    requestCancellation,
  });
  const goalMutationFence = new GoalMutationFenceService(goalRepository, {
    taskStateReader: new RuntimeGoalManagedTaskStateReader({
      process: processService,
      codex: codexService,
      shell: capabilityRuntime.shell,
    }),
  });
  const scheduledContinuationService = new ScheduledContinuationService(goalRepository, { workerLiveness: goalMutationFence });
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
    checkpoint: checkpointService,
    goals: goalService,
    goalRequestCancellation: requestCancellation,
    scheduledContinuations: scheduledContinuationService,
    goalMutationFence,
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
          ...(event.authorizationMode === undefined ? {} : { authorizationMode: event.authorizationMode }),
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
      authorizationModeProvider: (): 'standard' | 'full_bypass' => desktopFullBypassEnabled() ? 'full_bypass' : 'standard',
      allowAiDeleteProvider,
      destructivePolicyProvider,
      activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope | null> => {
        const selected = await resolveSelectedWorkspace(workspaceService, settingsRepository);
      return selected === null ? null : { workspaceId: selected.id, rootPath: selected.realRootPath };
      },
      activeWorkspaceScopesProvider: async (): Promise<readonly WorkspaceScope[]> => (
        (await resolveActiveProjectWorkspaces()).map((workspace) => ({ workspaceId: workspace.id, rootPath: workspace.realRootPath }))
      ),
      ...(options.hostMutationApprovalProvider === undefined ? {} : { hostMutationApprovalProvider: options.hostMutationApprovalProvider }),

      codexToolsEnabled: readSettings().codexToolsEnabled,
    }),
  });
  const tunnelController = new TunnelController({
    getClientPath: (): string | null => settingsRepository.get(CLIENT_PATH_SETTING),
    getBundledClientPath: bundledTunnelClientPath,
    setClientPath: (value: string): void => { settingsRepository.set(CLIENT_PATH_SETTING, value); },
    getDataPath: (): string => dataPath,
    getMcpServerUrl: async (): Promise<string | null> => {
      const status = await mcpLifecycle.start();
      return status.url;
    },
    ...(process.env.LNWJUD_E2E_FIXTURE === '1'
      ? { isExternalTunnelRunning: async (): Promise<boolean> => false }
      : {}),
    autoReconnect: (): boolean => readSettings().tunnelAutoReconnect,
    maxAutoRestarts: (): number => readSettings().tunnelMaxAutoRestarts,
    getTunnelId: (): string | null => settingsRepository.get(tunnelIdentitySettingKey),
    setTunnelId: (value: string): void => { settingsRepository.set(tunnelIdentitySettingKey, value.trim()); },
    ...(options.encryptTunnelSecret === undefined || options.decryptTunnelSecret === undefined
      ? {}
      : { encryptSecret: options.encryptTunnelSecret, decryptSecret: options.decryptTunnelSecret }),

  });
  const logHub = new LogHub({
    tunnelLogPath: tunnelController.logPath(),
    mcpActivityLogPath: activityLogPath,
  });
  activityLogDiagnostic = (key, message): void => {
    logHub.feedIfNew('mcp', key, 'error', message);
  };
  const trackedProcesses = new Map<string, string>();
  let lastRecoveryRetentionSweepAt = 0;
  const recoveryRetentionSweepIntervalMs = 6 * 60 * 60 * 1000;

  async function sweepRecoveryRetention(force = false): Promise<void> {
    const retentionDays = readSettings().recoveryRetentionDays;
    if (retentionDays <= 0) return;
    const now = Date.now();
    if (!force && now - lastRecoveryRetentionSweepAt < recoveryRetentionSweepIntervalMs) return;
    const cutoffIso = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const [trashDeleted, checkpointsDeleted] = await Promise.all([
      fileService.purgeRecoveryItemsOlderThan(cutoffIso),
      checkpointRepository.deleteOlderThan(cutoffIso),
    ]);
    lastRecoveryRetentionSweepAt = now;
    if (trashDeleted > 0 || checkpointsDeleted > 0) {
      console.log('[Recovery] retention=' + retentionDays + 'd purged trash=' + trashDeleted + ' checkpoints=' + checkpointsDeleted);
    }
  }

  function recordPersistentTunnelStatus(status: TunnelStatus): void {
    const persistent = status.persistent;
    if (persistent === null) return;
    const stateKey = [persistent.mode, persistent.state, persistent.healthy, persistent.ready, persistent.pollHealthy, persistent.reconnectCount, persistent.lastErrorCode].join(':');
    const level = persistent.state === 'error' || persistent.state === 'auth-required' ? 'error'
      : persistent.state === 'reconnecting' || persistent.healthy === false || persistent.ready === false || persistent.pollHealthy === false ? 'warn'
        : 'info';
    const detail = [
      '[persistent-runtime]',
      'alias=' + persistent.runtimeAlias,
      'tunnel=' + (persistent.tunnelIdMasked ?? 'unconfigured'),
      'mode=' + persistent.mode,
      'state=' + persistent.state,
      'health=' + triStateLabel(persistent.healthy),
      'ready=' + triStateLabel(persistent.ready),
      'poll=' + triStateLabel(persistent.pollHealthy),
      'reconnects=' + persistent.reconnectCount,
      ...(persistent.lastErrorCode === null ? [] : ['error=' + persistent.lastErrorCode]),
    ].join(' ');
    logHub.feedIfNew('tunnel', 'persistent-runtime:' + stateKey, level, detail);
  }

  async function observedTunnelStatus(): Promise<TunnelStatus> {
    const status = await tunnelController.status();
    recordPersistentTunnelStatus(status);
    return status;
  }


  async function resolveManageableWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = await workspaceRepository.getAny(workspaceId);
    if (workspace === null) throw new Error('Workspace was not found');
    if (isDriveRoot(workspace.realRootPath) || isDriveRoot(workspace.rootPath)) {
      throw new Error('Machine-root workspaces are managed automatically and cannot be archived or deleted');
    }
    return workspace;
  }

  async function resolveActiveProjectWorkspaces(): Promise<readonly Workspace[]> {
    const workspaces = (await workspaceService.list()).filter((workspace) => !isDriveRoot(workspace.realRootPath) && !isDriveRoot(workspace.rootPath));
    if (workspaces.length === 0) {
      settingsRepository.delete(activeWorkspaceIdsSettingKey);
      settingsRepository.delete(selectedWorkspaceSettingKey);
      return [];
    }
    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const storedIds = parseStoredWorkspaceIds(settingsRepository.get(activeWorkspaceIdsSettingKey));
    const ids = storedIds.filter((id) => byId.has(id));
    const storedSelectedId = settingsRepository.get(selectedWorkspaceSettingKey);
    let selectedId = storedSelectedId !== null && byId.has(storedSelectedId) ? storedSelectedId : null;
    if (selectedId === null) {
      selectedId = ids[0] ?? workspaces[0]!.id;
      settingsRepository.set(selectedWorkspaceSettingKey, selectedId);
    }
    if (!ids.includes(selectedId)) ids.unshift(selectedId);
    const orderedIds = [selectedId, ...ids.filter((id) => id !== selectedId)];
    persistStoredWorkspaceIds(settingsRepository, activeWorkspaceIdsSettingKey, orderedIds);
    return orderedIds.map((id) => byId.get(id)!).filter(Boolean);
  }

  async function activateWorkspace(workspaceId: string): Promise<void> {
    const workspace = await resolveManageableWorkspace(workspaceId);
    if (workspace.archivedAt !== undefined && workspace.archivedAt !== null) throw new Error('Archived workspace cannot be activated');
    const ids = [...parseStoredWorkspaceIds(settingsRepository.get(activeWorkspaceIdsSettingKey))];
    if (!ids.includes(workspace.id)) ids.push(workspace.id);
    persistStoredWorkspaceIds(settingsRepository, activeWorkspaceIdsSettingKey, ids);
  }

  async function deactivateWorkspace(workspaceId: string): Promise<void> {
    await resolveManageableWorkspace(workspaceId);
    const active = [...await resolveActiveProjectWorkspaces()];
    if (!active.some((workspace) => workspace.id === workspaceId)) return;
    if (active.length <= 1) throw new Error('At least one Active Project is required');
    const nextIds = active.filter((workspace) => workspace.id !== workspaceId).map((workspace) => workspace.id);
    persistStoredWorkspaceIds(settingsRepository, activeWorkspaceIdsSettingKey, nextIds);
    if (settingsRepository.get(selectedWorkspaceSettingKey) === workspaceId) settingsRepository.set(selectedWorkspaceSettingKey, nextIds[0]!);
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
    const remainingIds = parseStoredWorkspaceIds(settingsRepository.get(activeWorkspaceIdsSettingKey)).filter((id) => id !== removedWorkspaceId);
    persistStoredWorkspaceIds(settingsRepository, activeWorkspaceIdsSettingKey, remainingIds);
    if (settingsRepository.get(selectedWorkspaceSettingKey) !== removedWorkspaceId) return;
    const nextActive = (await resolveActiveProjectWorkspaces())[0];
    if (nextActive === undefined) settingsRepository.delete(selectedWorkspaceSettingKey);
    else settingsRepository.set(selectedWorkspaceSettingKey, nextActive.id);
  }

  async function requireNativeAdministrativeApproval(request: HostMutationApprovalRequest): Promise<void> {
    const provider = options.hostMutationApprovalProvider;
    if (provider === undefined) throw new Error('Native host approval is unavailable for this administrative mutation');
    let approved = false;
    try {
      approved = await provider(request);
    } catch {
      approved = false;
    }
    if (!approved) throw new Error('Native host approval was denied for this administrative mutation');
  }

  const requirementProbeFromDoctor = async (probe: () => Promise<DoctorProbeResult>): Promise<RequirementProbeResult> => {
    const result = await probe();
    return { status: result.status, detail: result.message };
  };
  const capabilityRequirement = async (name: string): Promise<RequirementProbeResult> => {
    const result = await capabilityRuntime.health.execute({ operation: 'check_tool', tool: name });
    if (!result.ok) return { status: 'unknown', detail: result.error.message };
    if (!isRecord(result.value)) return { status: 'unknown', detail: `${name} capability health response was invalid` };
    const available = result.value.available !== false;
    const ready = result.value.ready !== false;
    const reason = typeof result.value.reason === 'string' ? result.value.reason : undefined;
    if (ready) return { status: 'pass', detail: reason ?? `${name} is ready` };
    return {
      status: available ? 'fail' : 'unknown',
      detail: reason ?? (available ? `${name} needs setup` : `${name} is unavailable`),
    };
  };
  const resolveConfiguredExecutable = async (raw: string): Promise<boolean> => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return false;
    let executable = trimmed;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && typeof parsed[0] === 'string') executable = parsed[0];
    } catch {
      const quoted = /^"([^"]+)"/.exec(trimmed);
      executable = quoted?.[1] ?? trimmed.split(/\s+/, 1)[0] ?? trimmed;
    }
    return (await executableResolver.resolve(executable)).ok;
  };
  const localPdfProviderRequirement = async (): Promise<RequirementProbeResult> => {
    const configured = readSettings().pdfProviderPath.trim();
    if (configured.length > 0) {
      const available = await resolveConfiguredExecutable(configured);
      return { status: available ? 'pass' : 'warn', detail: available ? 'Configured local PDF provider is available' : 'Configured local PDF provider could not be resolved' };
    }
    for (const candidate of ['pdftotext.exe', 'pdftotext']) {
      if ((await executableResolver.resolve(candidate)).ok) return { status: 'pass', detail: `${candidate} is available on PATH` };
    }
    return { status: 'warn', detail: 'No local PDF text provider is configured or available on PATH' };
  };
  const configuredLspRequirement = async (): Promise<RequirementProbeResult> => {
    const commands = Object.values(readSettings().lspCommands).map((value) => value.trim()).filter(Boolean);
    if (commands.length === 0) return { status: 'warn', detail: 'No local language-server command is configured' };
    const availability = await Promise.all(commands.map(resolveConfiguredExecutable));
    return availability.some(Boolean)
      ? { status: 'pass', detail: `${availability.filter(Boolean).length} configured language-server command(s) resolved` }
      : { status: 'warn', detail: 'Configured language-server commands could not be resolved' };
  };
  const windowsSandboxRequirement = async (): Promise<RequirementProbeResult> => {
    if (process.platform !== 'win32') return { status: 'fail', detail: 'Windows Sandbox is supported only on Windows' };
    const root = process.env.SystemRoot ?? process.env.WINDIR;
    const executable = root === undefined ? '' : path.join(root, 'System32', 'WindowsSandbox.exe');
    return executable.length > 0 && existsSync(executable)
      ? { status: 'pass', detail: 'WindowsSandbox.exe is available' }
      : { status: 'warn', detail: 'Windows Sandbox feature is not installed or enabled' };
  };
  const requirementDefinitions: readonly RequirementDefinition[] = [
    { id: 'os', required: true, summaryKey: 'requirement.os', probe: async () => ({ status: windowsCompatibilityProfile(process.platform, nodeRelease(), process.arch).supportedReleaseTarget ? 'pass' : 'fail', detail: `${process.platform} ${process.arch}` }) },
    { id: 'database', required: true, summaryKey: 'requirement.database', probe: async () => ({ status: 'pass', detail: 'SQLite database ready' }) },
    { id: 'mcp-port', required: true, summaryKey: 'requirement.mcp_port', probe: () => requirementProbeFromDoctor(() => checkConfiguredMcpPort(mcpLifecycle.status(), mcpPort)) },
    { id: 'platform_windows', required: false, summaryKey: 'requirement.platform_windows', probe: async () => ({ status: process.platform === 'win32' ? 'pass' : 'fail', detail: `${process.platform} ${process.arch}` }) },
    { id: 'registered_workspace', required: false, summaryKey: 'requirement.registered_workspace', remediationId: 'add_project', probe: async () => ({ status: (await workspaceService.list()).some((workspace) => !isDriveRoot(workspace.realRootPath) && !isDriveRoot(workspace.rootPath)) ? 'pass' : 'fail' }) },
    { id: 'active_project', required: false, summaryKey: 'requirement.active_project', remediationId: 'add_project', probe: async () => ({ status: (await resolveActiveProjectWorkspaces()).length > 0 ? 'pass' : 'fail' }) },
    { id: 'executable_git', required: false, summaryKey: 'requirement.executable_git', remediationId: 'install_git', probe: () => requirementProbeFromDoctor(() => checkExecutable(executableResolver, 'git', 'warn')) },
    { id: 'executable_ripgrep', required: true, summaryKey: 'requirement.executable_ripgrep', remediationId: 'install_ripgrep', probe: () => requirementProbeFromDoctor(() => checkExecutable(executableResolver, 'rg', 'fail')) },
    { id: 'codex_runtime', required: false, summaryKey: 'requirement.codex_runtime', remediationId: 'configure_codex', probe: () => requirementProbeFromDoctor(() => checkCodex(codexDiscovery)) },
    { id: 'wsl_runtime', required: false, summaryKey: 'requirement.wsl_runtime', remediationId: 'configure_wsl', probe: () => capabilityRequirement('wsl_exec') },
    { id: 'local_mcp_listener', required: true, summaryKey: 'requirement.local_mcp_listener', probe: async () => ({ status: mcpLifecycle.status().running ? 'pass' : 'fail', detail: mcpLifecycle.status().url ?? 'Desktop MCP listener is stopped' }) },
    { id: 'browser_cdp', required: false, summaryKey: 'requirement.browser_cdp', remediationId: 'configure_browser_cdp', probe: () => capabilityRequirement('dom_cdp') },
    { id: 'windows_ui_automation', required: false, summaryKey: 'requirement.windows_ui_automation', probe: () => capabilityRequirement('accessibility') },
    { id: 'windows_input', required: false, summaryKey: 'requirement.windows_input', probe: () => capabilityRequirement('input_event') },
    { id: 'windows_window', required: false, summaryKey: 'requirement.windows_window', probe: () => capabilityRequirement('window') },
    { id: 'windows_ocr', required: false, summaryKey: 'requirement.windows_ocr', probe: () => capabilityRequirement('vision') },
    { id: 'office_desktop', required: false, summaryKey: 'requirement.office_desktop', probe: () => capabilityRequirement('office') },
    { id: 'network_access', required: false, summaryKey: 'requirement.network_access', probe: () => capabilityRequirement('web_fetch') },
    { id: 'scheduler_runtime', required: false, summaryKey: 'requirement.scheduler_runtime', probe: () => capabilityRequirement('scheduler') },
    { id: 'tunnel_runtime', required: false, summaryKey: 'requirement.tunnel_runtime', remediationId: 'configure_tunnel', probe: async (): Promise<{ status: 'pass' | 'fail'; detail: string }> => { const status = await tunnelController.diagnosticStatus(); return { status: status.state === 'running' ? 'pass' : 'fail', detail: status.message ?? `Tunnel is ${status.state}` }; } },
    { id: 'external_mcp_connection', required: false, summaryKey: 'requirement.external_mcp_connection', remediationId: 'connect_external_mcp', probe: async (): Promise<{ status: 'pass' | 'warn' | 'unknown'; detail: string }> => { const listed = await extensionsService.listMcpServers(); return !listed.ok ? { status: 'unknown', detail: listed.error.message } : { status: listed.value.servers.some((server) => server.enabled && server.connected) ? 'pass' : 'warn', detail: `${listed.value.servers.length} external MCP server(s) discovered` }; } },
    { id: 'local_pdf_provider', required: false, summaryKey: 'requirement.local_pdf_provider', remediationId: 'configure_pdf_provider', probe: localPdfProviderRequirement },
    { id: 'configured_lsp', required: false, summaryKey: 'requirement.configured_lsp', remediationId: 'configure_lsp', probe: configuredLspRequirement },
    { id: 'database_target', required: false, summaryKey: 'requirement.database_target', remediationId: 'configure_database_target', probe: async () => ({ status: 'pass', detail: 'Input-dependent: provide a read-only SQLite target inside a registered workspace for each call' }) },
    { id: 'windows_sandbox', required: false, summaryKey: 'requirement.windows_sandbox', remediationId: 'configure_windows_sandbox', probe: windowsSandboxRequirement },
    { id: 'browser_event_stream', required: false, summaryKey: 'requirement.browser_event_stream', remediationId: 'configure_browser_events', probe: async () => ({ status: 'pass', detail: 'Input-dependent: console/network event retention is established for the selected live CDP tab at call time' }) },
    { id: 'feature_delivery', required: false, summaryKey: 'requirement.feature_delivery', probe: async () => ({ status: 'pass', detail: 'Delivery state comes from the canonical upgrade catalog' }) },
  ];
  const requirementRegistry = new RequirementRegistry(requirementDefinitions, { ttlMs: 30_000, timeoutMs: 2_000 });
  const remediationRegistry = new RemediationRegistry();
  const toolCatalogOptions: ToolCatalogServiceOptions = {
    profileDecision: (permission): ToolProfileDecision => permission === 'UNKNOWN' ? 'UNKNOWN' : activePermissionProfile().defaults[permission],
    codexEnabled: (): boolean => readSettings().codexToolsEnabled,
    externalItems: (locale): Promise<readonly ToolCatalogItem[]> => projectExternalMcpTools(extensionsService, locale),
  };
  const toolCatalogService = new ToolCatalogService(requirementRegistry, remediationRegistry, toolCatalogOptions);
  const tunnelDoctorCheckIds = new Set([
    'persistent_tunnel_identity', 'runtime_alias_state', 'runtime_process_running', 'tunnel_health', 'tunnel_ready',
    'control_plane_poll_health', 'local_mcp_binding', 'local_mcp_reachable', 'tunnel_id_matches_saved_identity', 'runtime_key_available',
  ]);
  const requirementIdSet = new Set(requirementRegistry.ids());
  const buildFullDoctorReport = async (locale: UiLocale): Promise<DoctorReport> => {
    const base = await toolCatalogService.runDoctor(undefined, locale);
    const tunnel = await tunnelController.diagnosticStatus();
    recordPersistentTunnelStatus(tunnel);
    const mcp = mcpLifecycle.status();
    const tunnelHealth = await tunnelController.incidentHealth();
    const checks = [...base.checks, ...buildPersistentTunnelDoctorChecks({ tunnel, mcp, tunnelHealth, persistentEnabled: readSettings().tunnelAutoReconnect })];
    return { checks, exitCode: checks.some((check) => check.required && (check.status === 'fail' || check.status === 'unknown')) ? 1 : 0 };
  };
  const recheckCatalogAndDoctor = async (request: RecheckToolCatalogRequest): Promise<{ readonly catalog: ToolCatalogSnapshot; readonly doctor: DoctorReport }> => {
    const unknown = request.requirementIds.filter((id) => !requirementIdSet.has(id) && !tunnelDoctorCheckIds.has(id));
    if (unknown.length > 0) throw new Error(`Unknown Doctor check id: ${unknown.join(', ')}`);
    const canonicalIds = request.requirementIds.filter((id) => requirementIdSet.has(id));
    const catalog = canonicalIds.length > 0
      ? (await toolCatalogService.recheck(canonicalIds, request.locale)).catalog
      : await toolCatalogService.getSnapshot(request.locale);
    return { catalog, doctor: await buildFullDoctorReport(request.locale) };
  };

  async function resolveWorkspaceOrThrow(workspaceId: string): Promise<Workspace> {
    const workspace = await workspaceRepository.get(workspaceId);
    if (workspace === null) throw new Error('Workspace was not found');
    return workspace;
  }

  async function selectWorkspaceOnly(workspaceId: string): Promise<WorkspaceSummary> {
    const workspace = await resolveWorkspaceOrThrow(workspaceId);
    if (isDriveRoot(workspace.realRootPath) || isDriveRoot(workspace.rootPath)) throw new Error('Machine-root workspace cannot be the Primary Project');
    await activateWorkspace(workspaceId);
    settingsRepository.set(selectedWorkspaceSettingKey, workspaceId);
    await resolveActiveProjectWorkspaces();

    return toWorkspaceSummary(workspace);
  }

  const services: DesktopIpcServices = {
    listWorkspaces: async (): Promise<readonly WorkspaceSummary[]> => {
      return (await workspaceRepository.listAll())
        .filter((workspace) => !isGeneratedAutoMachineRoot(workspace))
        .map(toWorkspaceSummary);
    },
    addWorkspace: async (request: AddWorkspaceRequest): Promise<WorkspaceSummary> => {
      const requestedRoot = path.resolve(request.rootPath).toLowerCase();
      const existing = (await workspaceRepository.listAll()).find((entry) => path.resolve(entry.rootPath).toLowerCase() === requestedRoot);
      if (existing !== undefined) {
        if (existing.archivedAt !== undefined && existing.archivedAt !== null) await workspaceRepository.restore(existing.id);
        settingsRepository.set(selectedWorkspaceSettingKey, existing.id);
        await activateWorkspace(existing.id);
        if (!mcpLifecycle.status().running) await mcpLifecycle.start();
        const restored = await workspaceRepository.getAny(existing.id);
        if (restored === null) throw new Error('Workspace could not be restored');
        return toWorkspaceSummary(restored);
      }
      const displayName = path.basename(path.resolve(request.rootPath)) || 'Workspace';
      const workspace = unwrap(await workspaceService.add(displayName, request.rootPath), 'Workspace could not be added');
      settingsRepository.set(selectedWorkspaceSettingKey, workspace.id);
      await activateWorkspace(workspace.id);

      if (!mcpLifecycle.status().running) {
        await mcpLifecycle.start();
      }
      return toWorkspaceSummary(workspace);
    },
    selectWorkspace: async (request: SelectWorkspaceRequest): Promise<WorkspaceSummary> => {
      return selectWorkspaceOnly(request.workspaceId);
    },
    setWorkspaceActive: async (request): Promise<{ readonly workspace: WorkspaceSummary; readonly active: boolean }> => {
      if (request.active) await activateWorkspace(request.workspaceId);
      else await deactivateWorkspace(request.workspaceId);
      const workspace = await resolveManageableWorkspace(request.workspaceId);
      return { workspace: toWorkspaceSummary(workspace), active: request.active };
    },

    setWorkspaceArchived: async (request: SetWorkspaceArchivedRequest): Promise<WorkspaceSummary> => {
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
    deleteWorkspace: async (request: DeleteWorkspaceRequest): Promise<{ readonly deleted: boolean; readonly workspaceId: string; readonly rootPath: string; readonly backupId: string }> => {
      if (request.userConfirmed !== true) throw new Error('Deleting a workspace registration requires explicit confirmation');
      const workspace = await resolveManageableWorkspace(request.workspaceId);
      await assertWorkspaceIdle(workspace.id);
      await requireNativeAdministrativeApproval({
        toolName: 'workspace_registration_delete',
        mutationKind: 'delete',
        reason: 'Deleting a persisted workspace registration changes application database state',
        summary: `Delete workspace registration "${workspace.displayName}" (${workspace.id}). The project folder at ${workspace.realRootPath} will not be deleted. A SQLite backup will be created before the registration is removed.`,
        workspaceId: workspace.id,
        workspaceRoot: workspace.realRootPath,
      });
      const backup = await backupService.create('manual');
      await workspaceIndex.forgetWorkspace(workspace.id);
      await workspaceRepository.delete(workspace.id);
      await repairSelectedWorkspace(workspace.id);
      return { deleted: true, workspaceId: workspace.id, rootPath: workspace.realRootPath, backupId: backup.id };
    },
    getDashboard: async (): Promise<DashboardSnapshot> => {
      await sweepRecoveryRetention().catch((error: unknown) => {
        console.error(`Recovery retention sweep failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      });
      const selectedWorkspace = await resolveSelectedWorkspace(workspaceService, settingsRepository);
      const activeWorkspaces = await resolveActiveProjectWorkspaces();

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
      const tunnel = await observedTunnelStatus();
      const backups = await backupService.list();
      let recovery: DashboardSnapshot['recovery'];
      if (selectedWorkspace === null) {
        recovery = { trashRoot: recoveryTrashRoot, trashItems: [], checkpoints: [] };
      } else {
        const trash = unwrap(await fileService.listRecoveryItems(selectedWorkspace.id), 'Recovery Trash could not be listed');
        recovery = {
          trashRoot: trash.recoveryTrashRoot,
          trashItems: trash.items,
          checkpoints: unwrap(await checkpointService.list(selectedWorkspace.id), 'Checkpoints could not be listed'),
        };
      }

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
        activeWorkspaces: activeWorkspaces.map(toWorkspaceSummary),

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
        recovery,
        connectionModes: buildConnectionModes({
          httpUrl: mcp.url,
          ...(selectedWorkspace === null ? {} : { workspaceRoot: selectedWorkspace.realRootPath }),
          profile: parseStdioPermissionProfile(settingsRepository.get(STDIO_PERMISSION_PROFILE_SETTING_KEY), 'full'),
          strictRoots: parseBooleanSetting(settingsRepository.get(STDIO_STRICT_ROOTS_SETTING_KEY), false),
          allowedRoots: parseAllowedRoots(settingsRepository.get(STDIO_ALLOWED_ROOTS_SETTING_KEY)),
          fullBypassAll: readSettings().stdioFullBypassAll,
        }),
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
      await requireNativeAdministrativeApproval({
        toolName: 'database_restore',
        mutationKind: 'replace',
        reason: 'Scheduling a database restore will replace persisted application database state on the next restart',
        summary: `Schedule application database restore from backup ${request.backupId}. The restore runtime will create an emergency SQLite pre-image before replacing the active database.`,
      });
      await backupService.scheduleRestore(request.backupId);
      return { scheduled: true, restartRequired: true };
    },
    restoreRecoveryItem: async (request: RestoreRecoveryItemRequest): Promise<{ readonly restored: boolean; readonly path: string; readonly rollbackRecoveryId: string | null }> => {
      const selected = await resolveSelectedWorkspace(workspaceService, settingsRepository);
      if (selected === null || selected.id !== request.workspaceId) throw new Error('Recovery target must match the selected workspace');
      const restored = unwrap(await fileService.restoreDeletedFile(actor, selected.id, {
        recoveryId: request.recoveryId,
        userConfirmed: true,
      }), 'Recovery item could not be restored');
      return { restored: true, path: restored.path, rollbackRecoveryId: restored.rollbackRecoveryId ?? null };
    },
    restoreCheckpoint: async (request: RestoreCheckpointRequest): Promise<{ readonly restored: boolean; readonly paths: readonly string[]; readonly rollbackCheckpointId: string | null }> => {
      const selected = await resolveSelectedWorkspace(workspaceService, settingsRepository);
      if (selected === null || selected.id !== request.workspaceId) throw new Error('Checkpoint target must match the selected workspace');
      const restored = unwrap(await checkpointService.restore(actor, selected.id, request.checkpointId, { userConfirmed: true }), 'Checkpoint could not be restored');
      return { restored: true, paths: restored.restoredPaths, rollbackCheckpointId: restored.rollbackCheckpointId ?? null };
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
          userConfirmed: true,
        })
        : await processService.startProjectCommand(actor, request.workspaceId, 'dev', undefined, true);
      const processValue = unwrap(started, 'Process could not be started');
      trackedProcesses.set(processValue.processId, request.workspaceId);
      return toProcessSummary(processValue, request.workspaceId, '');
    },
    stopProcess: async (request: StopProcessRequest): Promise<{ readonly stopped: boolean }> => {
      const workspaceId = trackedProcesses.get(request.processId);
      if (workspaceId === undefined) return { stopped: false };
      unwrap(await processService.stop(actor, workspaceId, request.processId, true), 'Process could not be stopped');
      return { stopped: true };
    },
    startMcp: async (request: StartMcpRequest): Promise<McpConnectionStatus> => {
      await resolveWorkspaceOrThrow(request.workspaceId);
      return mcpLifecycle.start();
    },
    stopMcp: (): Promise<McpConnectionStatus> => mcpLifecycle.stop(),
    restartMcp: (): Promise<McpConnectionStatus> => mcpLifecycle.restart(),
    clearWorkLog: async (request: ClearWorkLogRequest = {}): Promise<{ readonly cleared: boolean }> => {
      workLogViewState.clear(request);
      return { cleared: true };
    },
    saveTunnelApiKey: async (request: SaveTunnelApiKeyRequest): Promise<{ readonly saved: boolean }> => {
      await tunnelController.saveApiKey(request.apiKey);
      if (readSettings().tunnelAutoReconnect) {
        const status = await tunnelController.status();
        if (status.profileExists && status.clientPath !== null) await tunnelController.start();
      }
      return { saved: true };
    },
    startTunnel: async (): Promise<TunnelStatus> => {
      const status = await tunnelController.start();
      recordPersistentTunnelStatus(status);
      return status;
    },
    stopTunnel: async (): Promise<TunnelStatus> => {
      const status = await tunnelController.stop();
      recordPersistentTunnelStatus(status);
      return status;
    },
    getTunnelStatus: (): Promise<TunnelStatus> => observedTunnelStatus(),
    setTunnelClientPath: async (request: SetTunnelClientPathRequest): Promise<{ readonly clientPath: string }> => {
      const clientPath = tunnelController.setClientPath(request.clientPath);
      if (readSettings().tunnelAutoReconnect) {
        const status = await tunnelController.status();
        if (status.profileExists && status.hasApiKey) await tunnelController.start();
      }
      return { clientPath };
    },

    setLocale: async (request: SetLocaleRequest): Promise<{ readonly locale: UiLocale }> => {
      settingsRepository.set(localeSettingKey, request.locale);
      return { locale: request.locale };
    },
    setUserSettings: async (request: SetUserSettingsRequest): Promise<{ readonly settings: UserSettings; readonly restartRequired: boolean }> => {
      const previous = readSettings();
      persistUserSettings(settingsRepository, request.settings);
      const next = readSettings();
      if (previous.recoveryRetentionDays !== next.recoveryRetentionDays) {
        lastRecoveryRetentionSweepAt = 0;
        await sweepRecoveryRetention(true).catch((error: unknown) => {
          console.error(`Recovery retention sweep failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        });
      }
      return { settings: next, restartRequired: runtimeRestartRequired(previous, next) };
    },
    configureTunnelProfile: async (request: ConfigureTunnelProfileRequest): Promise<{ readonly configured: boolean; readonly profilePath: string }> => {
      const profilePath = await tunnelController.configureProfile(request.tunnelId);
      if (readSettings().tunnelAutoReconnect) await tunnelController.start();
      return { configured: true, profilePath };
    },

    launchManagedBrowser: async (): Promise<ManagedBrowserStatus> => {
      // This path is invoked only by the user clicking the desktop UI action.
      // Preserve the normal MCP authorization boundary while carrying that explicit click
      // through to the capability backend so launch is not rejected as unconfirmed.
      const result = await capabilityRuntime.service.execute('dom_cdp', { action: 'launch', userConfirmed: true });
      return toManagedBrowserStatus(unwrap(result, 'Managed Chrome could not be started'));
    },
    installPdfProvider: async (): Promise<PdfProviderInstallResult> => {
      const installed = await (options.pdfProviderInstaller ?? installPdfProvider)(dataPath);
      // Defense in depth: never register a provider binary that cannot execute
      // on this platform, and never touch pdfProviderPath on refusal.
      if (process.platform !== 'win32' && installed.providerPath.toLowerCase().endsWith('.exe')) {
        throw new Error('The resolved PDF provider is a Windows (pdftotext.exe) binary that cannot run on this platform. Install Poppler natively (`brew install poppler`) so `pdftotext` is on PATH, then re-run the doctor check.');
      }
      const previous = readSettings();
      settingsRepository.set(USER_SETTING_KEYS.pdfProviderPath, installed.providerPath);
      const next = readSettings();
      return { ...installed, restartRequired: runtimeRestartRequired(previous, next) };
    },
    runDoctor: async (): Promise<DoctorReport> => buildFullDoctorReport(readLocale(settingsRepository)),
    getToolCatalog: async (request: GetToolCatalogRequest): Promise<ToolCatalogSnapshot> => toolCatalogService.getSnapshot(request.locale),
    recheckToolCatalog: recheckCatalogAndDoctor,
    getLogSnapshot: async (): Promise<LogSnapshot> => {
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
      const workspaceSummaries = (await workspaceRepository.listAll()).map(toWorkspaceSummary);
      logHub.clear(request.source, request, workspaceSummaries);
      return { cleared: true };
    },
    captureIncident: async (updaterEvents: readonly string[] = []): Promise<IncidentReport> => {
      const tunnel = await observedTunnelStatus();

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
    getActiveWorkspaceScope: async (): Promise<WorkspaceScope | null> => {
      const selected = await resolveSelectedWorkspace(workspaceService, settingsRepository);
      return selected === null ? null : { workspaceId: selected.id, rootPath: selected.realRootPath };
    },
    getActiveWorkspaceScopes: async (): Promise<readonly WorkspaceScope[]> => {
      const rows = await resolveActiveProjectWorkspaces();
      return rows.map((workspace) => ({ workspaceId: workspace.id, rootPath: workspace.realRootPath }));
    },

    createBackup: (reason: BackupReason = 'manual'): Promise<BackupSummary> => backupService.create(reason),
    ensureDefaultWorkspace: async (rootPath: string): Promise<string> => {
      const existing = await workspaceService.list();
      const resolvedRoot = path.resolve(rootPath);
      const matched = existing.find((workspace) => workspace.realRootPath.toLowerCase() === resolvedRoot.toLowerCase());
      if (matched !== undefined && !isDriveRoot(matched.realRootPath) && !isDriveRoot(matched.rootPath)) {
        settingsRepository.set(selectedWorkspaceSettingKey, matched.id);
        await activateWorkspace(matched.id);
        return matched.id;
      }
      const projects = existing.filter((workspace) => !isDriveRoot(workspace.realRootPath) && !isDriveRoot(workspace.rootPath));
      const selectedId = settingsRepository.get(selectedWorkspaceSettingKey);
      if (selectedId !== null) {
        const selected = projects.find((workspace) => workspace.id === selectedId);
        if (selected !== undefined) { await activateWorkspace(selected.id); return selected.id; }
      }
      if (!isDriveRoot(resolvedRoot)) {
        const displayName = path.basename(resolvedRoot) || 'Workspace';
        const added = unwrap(await workspaceService.add(displayName, resolvedRoot), 'Workspace could not be added');
        settingsRepository.set(selectedWorkspaceSettingKey, added.id);
        await activateWorkspace(added.id);
        return added.id;
      }
      if (projects[0] !== undefined) {
        settingsRepository.set(selectedWorkspaceSettingKey, projects[0].id);
        await activateWorkspace(projects[0].id);
        return projects[0].id;
      }
      throw new Error('No project workspace is available');

    },
    autoStartMcp: async (): Promise<McpConnectionStatus> => {
      const envWorkspacePath = process.env.LNWJUD_WORKSPACE?.trim();
      if (envWorkspacePath !== undefined && envWorkspacePath.length > 0) {
        const resolvedPath = path.resolve(envWorkspacePath);
        const existing = await workspaceService.list();
        const matched = existing.find((workspace) => workspace.realRootPath.toLowerCase() === resolvedPath.toLowerCase());
        const workspaceId = matched === undefined
          ? unwrap(await workspaceService.add(path.basename(resolvedPath) || 'Workspace', resolvedPath), 'Workspace could not be added').id
          : matched.id;
        settingsRepository.set(selectedWorkspaceSettingKey, workspaceId);
        await activateWorkspace(workspaceId);

        return mcpLifecycle.start();
      }
      const selected = await resolveSelectedWorkspace(workspaceService, settingsRepository);
      if (selected === null) {
        // First run: start MCP without scanning or registering drive letters.
        // The user can add an explicit project in the UI when ready.
        return mcpLifecycle.start();
      }
      await activateWorkspace(selected.id);
      return mcpLifecycle.start();
    },
    autoStartTunnel: async (): Promise<TunnelStatus | null> => autoStartPersistentTunnel(
      tunnelController,
      readSettings().tunnelAutoReconnect,
    ),
    close: async (): Promise<void> => {
      await tunnelController.shutdownForDesktopExit();

      logHub.stop();
      await mcpLifecycle.close();
      await extensionsService.close().catch(() => undefined);
      await workspaceIndex.close().catch(() => undefined);
      database.close();
    },
  };
}

function bundledTunnelClientPath(): string | null {
  const resourcesPath = (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath;
  if (typeof resourcesPath !== 'string' || resourcesPath.trim().length === 0) return null;
  const binaryName = process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client';
  return path.join(resourcesPath, 'tunnel-client', binaryName);
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
  const workspaces = (await workspaceService.list()).filter((workspace) => !isDriveRoot(workspace.realRootPath) && !isDriveRoot(workspace.rootPath));

  if (workspaces.length === 0) return null;
  const selectedId = settingsRepository.get(selectedWorkspaceSettingKey);
  const selected = selectedId === null ? undefined : workspaces.find((workspace) => workspace.id === selectedId);
  return selected ?? workspaces[0] ?? null;
}

function parseStoredWorkspaceIds(value: string | null): string[] {
  if (value === null || value.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim()))];
  } catch {
    return [...new Set(value.split(/[;,\r\n]+/).map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
  }
}

function persistStoredWorkspaceIds(settingsRepository: SqliteSettingsRepository, key: string, ids: readonly string[]): void {
  const unique = [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))];
  if (unique.length === 0) settingsRepository.delete(key);
  else settingsRepository.set(key, JSON.stringify(unique));
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

function isGeneratedAutoMachineRoot(workspace: Workspace): boolean {
  return isDriveRoot(workspace.rootPath) && /^Local Disk [A-Z]:$/i.test(workspace.displayName.trim());
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
  const events = await listVisibleMcpEvents(repository, viewState, 500);
  return events.map((event) => {
    const toolName = typeof event.metadata.toolName === 'string' ? event.metadata.toolName : event.action.replace(/^mcp_tool:/, '');
    const phase = event.metadata.phase === 'started' ? 'started' : 'completed';
    const kind = classifyMcpWorkLogKind(toolName, phase, event.resultCode);

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

function buildConnectionModes(input: {
  readonly httpUrl: string | null;
  readonly workspaceRoot?: string;
  readonly profile: PermissionProfileName;
  readonly strictRoots: boolean;
  readonly allowedRoots: readonly string[];
  readonly fullBypassAll: boolean;
}): ConnectionModes {
  // Platform-scoped stdio launcher: Windows ships the .cmd shim next to
  // lnwjud.exe; macOS ships the sh launcher `lnwjud-mcp-stdio` next to the
  // app binary in Contents/MacOS. Dev falls back to PATH lookup.
  const launcher = process.platform === 'win32'
    ? (path.win32.basename(process.execPath).toLowerCase() === 'lnwjud.exe'
      ? path.join(path.dirname(process.execPath), 'lnwjud-mcp-stdio.cmd')
      : 'lnwjud-mcp-stdio.cmd')
    : (path.basename(process.execPath).toLowerCase() === 'lnwjud'
      ? path.join(path.dirname(process.execPath), 'lnwjud-mcp-stdio')
      : 'lnwjud-mcp-stdio');
  const args = [quoteCommandArgument(launcher)];
  if (input.workspaceRoot !== undefined) args.push('--workspace', quoteCommandArgument(input.workspaceRoot));
  args.push('--profile', input.profile);
  if (input.fullBypassAll && input.profile === 'full') args.push('--full-bypass-all');
  if (input.strictRoots && !(input.fullBypassAll && input.profile === 'full')) {
    args.push('--strict-roots');
    for (const root of input.allowedRoots) args.push('--allowed-root', quoteCommandArgument(root));
  }
  return { httpUrl: input.httpUrl, stdioCommand: args.join(' ') };
}

function quoteCommandArgument(value: string): string {
  return /[\s&()[\]{}^=;!'+,`~]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function readUserSettings(settingsRepository: SqliteSettingsRepository, env: NodeJS.ProcessEnv): UserSettings {
  const extensions = parseExtensionsSettings(settingsRepository.get(EXTENSIONS_SETTINGS_KEY));
  return {
    customPermission: parseCustomPermissionSettings(settingsRepository.get(USER_SETTING_KEYS.customPermissionProfile)),
    desktopFullBypassAll: parseBooleanSetting(settingsRepository.get(USER_SETTING_KEYS.desktopFullBypassAll), false),
    stdioFullBypassAll: parseBooleanSetting(settingsRepository.get(USER_SETTING_KEYS.stdioFullBypassAll), false),
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
    recoveryRetentionDays: parseIntegerSetting(settingsRepository.get(USER_SETTING_KEYS.recoveryRetentionDays), DEFAULT_RECOVERY_RETENTION_DAYS, 0, 3650),

    extensions: toIpcExtensionsSettings(extensions),
  };
}

function persistUserSettings(settingsRepository: SqliteSettingsRepository, settings: UserSettings): void {
  settingsRepository.set(USER_SETTING_KEYS.customPermissionProfile, serializeCustomPermissionSettings(settings.customPermission));
  settingsRepository.set(USER_SETTING_KEYS.desktopFullBypassAll, settings.desktopFullBypassAll ? 'true' : 'false');
  settingsRepository.set(USER_SETTING_KEYS.stdioFullBypassAll, settings.stdioFullBypassAll ? 'true' : 'false');
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
  settingsRepository.set(USER_SETTING_KEYS.recoveryRetentionDays, String(settings.recoveryRetentionDays));

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
  return previous.desktopFullBypassAll !== next.desktopFullBypassAll
    || previous.stdioFullBypassAll !== next.stdioFullBypassAll
    || previous.mcpCallTimeoutMs !== next.mcpCallTimeoutMs
    || previous.mcpIdleTimeoutMs !== next.mcpIdleTimeoutMs
    || previous.mcpHttpPort !== next.mcpHttpPort
    || previous.codexToolsEnabled !== next.codexToolsEnabled
    || JSON.stringify(previous.lspCommands) !== JSON.stringify(next.lspCommands)
    || JSON.stringify(previous.customPermission) !== JSON.stringify(next.customPermission)
    || JSON.stringify(previous.extensions) !== JSON.stringify(next.extensions);
}

function readPermissionProfile(value: string | null): PermissionProfileName {
  return value === 'safe' || value === 'balanced' || value === 'full' || value === 'custom' ? value : 'balanced';
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

async function checkExecutable(resolver: PathExecutableResolver, executable: string, missingStatus: 'warn' | 'fail'): Promise<{ readonly status: 'pass' | 'warn' | 'fail'; readonly message: string }> {

  const result = await resolver.resolve(executable);
  return result.ok ? { status: 'pass', message: `${executable} is available` } : { status: missingStatus, message: `${executable} is not available` };
}

function triStateLabel(value: boolean | null): string {
  return value === null ? 'unknown' : value ? 'ok' : 'failed';
}

function toStructuredDoctorCheck(id: string, required: boolean, status: DoctorCheck['status'], message: string): DoctorCheck {
  return {
    id,
    required,
    status,
    title: id.replaceAll('_', ' ').replaceAll('-', ' '),
    summary: message,
    affectedToolNames: [],
    checkedAt: new Date().toISOString(),
    durationMs: 0,
    message,
  };
}

export function buildPersistentTunnelDoctorChecks(input: {
  readonly tunnel: TunnelStatus;
  readonly mcp: McpConnectionStatus;
  readonly tunnelHealth: { readonly state: 'live' | 'unhealthy' | 'unavailable' | 'unknown'; readonly message: string | null };
  readonly persistentEnabled: boolean;
}): readonly DoctorCheck[] {
  const persistent = input.tunnel.persistent;
  const required = input.persistentEnabled;
  const identityPresent = persistent?.tunnelIdMasked !== null && persistent?.tunnelIdMasked !== undefined;
  const nativeRuntime = persistent?.mode === 'native-managed' || persistent?.runtimeAliasActive === true;
  const runtimeRunning = input.tunnel.state === 'running' && (persistent === null || persistent.state === 'running');
  const localBindingMatches = persistent?.localMcpUrl !== null && persistent?.localMcpUrl !== undefined
    && input.mcp.url !== null && sameLocalMcpEndpoint(persistent.localMcpUrl, input.mcp.url);
  const mismatch = persistent?.lastErrorCode === 'TUNNEL_ID_MISMATCH';
  const controlPlaneHealthy = persistent?.pollHealthy;
  const health = persistent?.healthy ?? (input.tunnelHealth.state === 'live' ? true : input.tunnelHealth.state === 'unhealthy' ? false : null);
  const ready = persistent?.ready ?? null;

  const check = (id: string, status: DoctorCheck['status'], message: string, isRequired = required): DoctorCheck => toStructuredDoctorCheck(id, isRequired, status, message);
  return [
    check('persistent_tunnel_identity', identityPresent ? 'pass' : required ? 'fail' : 'warn', identityPresent ? 'Saved tunnel identity is configured' : 'TUNNEL_ID_MISMATCH: persistent tunnel identity is not configured'),
    check('runtime_alias_state', nativeRuntime ? 'pass' : persistent === null ? 'warn' : 'warn', nativeRuntime ? 'Native runtime alias lnwjud is active' : 'TUNNEL_RUNTIME_DOWN: native runtime alias is not active', false),
    check('runtime_process_running', runtimeRunning ? 'pass' : required ? 'fail' : 'warn', runtimeRunning ? 'Tunnel runtime is running' : 'TUNNEL_RUNTIME_DOWN: tunnel runtime is not running'),
    check('tunnel_health', health === true ? 'pass' : health === false ? 'fail' : 'warn', health === true ? 'Tunnel health is OK' : health === false ? 'TUNNEL_RUNTIME_DOWN: tunnel health probe failed' : 'Tunnel health is not currently observable'),
    check('tunnel_ready', ready === true ? 'pass' : ready === false ? 'fail' : 'warn', ready === true ? 'Tunnel readiness is OK' : ready === false ? 'TUNNEL_RUNTIME_DOWN: tunnel is not ready' : 'Tunnel readiness is not currently observable'),
    check('control_plane_poll_health', controlPlaneHealthy === true ? 'pass' : controlPlaneHealthy === false ? 'fail' : 'warn', controlPlaneHealthy === true ? 'Control-plane poll is healthy' : controlPlaneHealthy === false ? 'CONTROL_PLANE_OFFLINE: control-plane polling is unhealthy' : 'Control-plane poll health is not currently observable'),
    check('local_mcp_binding', localBindingMatches ? 'pass' : required ? 'fail' : 'warn', localBindingMatches ? 'Tunnel is bound to the current Desktop MCP endpoint' : 'LOCAL_BINDING_STALE: tunnel local MCP binding does not match the active Desktop MCP endpoint'),
    check('local_mcp_reachable', input.mcp.running && input.mcp.url !== null ? 'pass' : required ? 'fail' : 'warn', input.mcp.running && input.mcp.url !== null ? 'Desktop MCP listener is reachable locally' : 'LOCAL_MCP_DOWN: Desktop MCP listener is not running'),
    check('tunnel_id_matches_saved_identity', mismatch ? 'fail' : identityPresent ? 'pass' : 'warn', mismatch ? 'TUNNEL_ID_MISMATCH: runtime alias reports a different tunnel identity' : identityPresent ? 'Runtime has not reported a tunnel identity mismatch' : 'Saved tunnel identity is unavailable'),
    check('runtime_key_available', input.tunnel.hasApiKey ? 'pass' : required ? 'fail' : 'warn', input.tunnel.hasApiKey ? 'Runtime API key is available in secure storage' : 'AUTH_REQUIRED: runtime API key is not available'),
  ];
}

function sameLocalMcpEndpoint(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    const normalizeHost = (host: string): string => host === 'localhost' || host === '::1' || host === '[::1]' ? '127.0.0.1' : host.toLowerCase();
    return a.protocol === b.protocol && normalizeHost(a.hostname) === normalizeHost(b.hostname) && a.port === b.port && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '');
  } catch {
    return left.trim() === right.trim();
  }
}

async function checkCodex(discovery: CodexDiscovery): Promise<{ readonly status: 'pass' | 'warn'; readonly message: string }> {
  const result = await discovery.discover();
  if (!result.ok) return { status: 'warn', message: formatCodexDiscoveryError(result.error) };
  return result.value.status.installed ? { status: 'pass', message: `Codex ${result.value.status.version ?? 'installed'}` } : { status: 'warn', message: 'Codex is not installed' };
}

export type McpIdentityProbe = (endpoint: URL) => Promise<boolean>;

export async function checkConfiguredMcpPort(
  status: McpConnectionStatus,
  configuredPort: number,
  identityProbe: McpIdentityProbe = probeLnwjudMcpIdentity,
): Promise<DoctorProbeResult> {
  if (status.running && status.url !== null) {
    try {
      const endpoint = new URL(status.url);
      const livePort = Number(endpoint.port);
      if (!(await identityProbe(endpoint))) {
        return { status: 'fail', message: `Desktop MCP endpoint failed the lnwjud identity check at ${endpoint.origin}` };
      }
      if (configuredPort === 0 || livePort === configuredPort) {
        return { status: 'pass', message: `lnwjud Desktop MCP identity verified at ${endpoint.origin}${endpoint.pathname}` };
      }
      return {
        status: 'warn',
        message: `lnwjud Desktop MCP identity verified at fallback port ${livePort}; configured port ${configuredPort} was unavailable`,
      };
    } catch {
      return { status: 'fail', message: `Desktop MCP reported an invalid endpoint: ${status.url}` };
    }
  }
  if (status.lastStartError !== null && status.lastStartError !== undefined) {
    return { status: 'fail', message: `Desktop MCP failed to start on configured port ${configuredPort}: ${status.lastStartError}` };
  }

  const server = createServer();
  let listening = false;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: configuredPort }, () => {
        listening = true;
        resolve();
      });
    });
    return { status: 'fail', message: `Desktop MCP is not running; configured port ${configuredPort} is available` };
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown';
    const endpoint = new URL(`http://127.0.0.1:${configuredPort}/mcp`);
    const isLnwjud = await identityProbe(endpoint);
    return isLnwjud
      ? { status: 'fail', message: `Configured MCP port ${configuredPort} is owned by an lnwjud listener that this Desktop instance is not managing (${code})` }
      : { status: 'fail', message: `Configured MCP port ${configuredPort} is occupied by a listener that is not an lnwjud Desktop MCP (${code})` };
  } finally {
    if (listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function probeLnwjudMcpIdentity(endpoint: URL): Promise<boolean> {
  const identityUrl = new URL(LNWJUD_MCP_IDENTITY_PATH, endpoint.origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 750);
  try {
    const response = await fetch(identityUrl, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok || response.headers.get('x-lnwjud-service') !== 'desktop-mcp') return false;
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null
      && 'product' in body && body.product === 'lnwjud'
      && 'service' in body && body.service === 'desktop-mcp'
      && 'protocol' in body && body.protocol === 1;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
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
