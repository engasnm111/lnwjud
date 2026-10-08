import { app, BrowserWindow, clipboard, ClipboardItem, crashReporter, desktopCapturer, dialog, ipcMain, Menu, nativeImage, net, Notification, safeStorage, screen, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { access, lstat, readFile } from 'node:fs/promises';
import { autoUpdater } from 'electron-updater';
import {
  APP_NAME,
  APP_VERSION,
  EMPTY_REMOTE_MCP_STATUS,
  EMPTY_TUNNEL_STATUS,
  ipcChannels,
  pushChannels,
  type AddWorkspaceRequest,
  type BackupSummary,
  type ClearLogBufferRequest,
  type ClearWorkLogRequest,
  type ActivityTargetDetail,
  type ActivityTargetSearchCandidate,
  type ConfigureTunnelProfileRequest,
  type DeleteWorkspaceRequest,
  type DashboardSnapshot,
  type DestructiveDeletePolicy,
  type DoctorReport,
  type ToolCatalogSnapshot,
  type WorkflowPrepareRequest,
  type WorkflowTemplate,
  type WorkflowDraft,
  type CallHistoryRequest,
  type CallHistoryPage,
  type DoctorGoalOption,
  type TaskResultSummary,
  type RestoreTaskCheckpointRequest,
  type RestoreTaskCheckpointResult,
  type CancelOwnedGoalTaskRequest,
  type CancelOwnedGoalTaskResult,
  type ResourceSnapshotRequest,
  type ResourceSnapshot,
  type GetToolCatalogRequest,
  type GetGitDiffRequest,
  type GetGitDiffResponse,
  type RecheckToolCatalogRequest,
  type SetToolAvailabilityRequest,
  type ResetToolAvailabilityRequest,
  type SetToolAvailabilityResult,
  type OpenToolSetupTargetRequest,
  type CopyToolCommandRequest,
  type ExportLogsRequest,
  type ExportWorkLogRequest,
  type IpcResponseMap,
  type LoadLogSessionHistoryRequest,
  type LoadLogSessionHistoryResult,
  type LogSnapshot,
  type ManagedBrowserStatus,
  type MutationApprovalPrompt,
  type PdfProviderInstallResult,
  type McpConnectionStatus,
  type ProcessSummary,
  type PurgeRecoveryDataRequest,
  type RestoreCheckpointRequest,
  type RestoreRecoveryItemRequest,
  type PermissionProfileName,
  type SaveTunnelApiKeyRequest,
  type SaveRemoteMcpAuthtokenRequest,
  type SetRemoteMcpPublicOriginRequest,
  type SetRemoteMcpTransportRequest,
  type RemoteMcpStatus,
  type ScheduleRestoreBackupRequest,
  type SelectWorkspaceRequest,
  type SetWorkspaceActiveRequest,
  type SetWorkspaceArchivedRequest,
  type SetAiDeletePolicyRequest,
  type SetLocaleRequest,
  type SetPermissionProfileRequest,
  type SetStdioPolicyRequest,
  type SetTunnelClientPathRequest,
  type SetUnrestrictedModeRequest,
  type SetUserSettingsRequest,
  type GetPonytailPolicyContextRequest,
  type SetWorkspacePonytailModeRequest,
  type SetGoalPonytailModeRequest,
  type PonytailPolicyContext,
  type StartMcpRequest,
  type StartProcessRequest,
  type StopProcessRequest,
  type TunnelOAuthLoginStatus,
  type TunnelStatus,
  type UiLocale,
  type UserSettings,
  type UpdateStatus,
  type WorkspaceSummary,
} from '@lnwjud/ipc-contracts';
import { readSharedActivitySnapshot, startMcpStdio, type EccRuntimeOptions, type HostMutationApprovalRequest } from '@lnwjud/mcp-server';
import { createExplicitKeySecretProtector, DEFAULT_DISPLAY_TIME_ZONE, DEFAULT_MCP_POLL_WAIT_SECONDS, DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS, MIN_CONFIGURABLE_WAIT_SECONDS, formatDisplayDateTime, formatOffsetIsoTimestamp, normalizeMcpAllowedHostname, resolveLnwjudDataPath, type SecretProtector } from '@lnwjud/shared';
import { applyPendingSqliteRestoreSync, CheckpointKeyStore, type CheckpointPayloadCipher } from '@lnwjud/storage';
import { createDesktopRuntime, formatCompleteTargetDetail, formatIncompleteLegacyHistory, writeSerializedLogRows, type DesktopRuntime } from './desktop-services.js';
import { resolveTunnelProfileDirectory, TUNNEL_SECRET_FILE_NAME } from './tunnel-controller.js';
import { migrateLegacyWindowsSecrets } from './legacy-secret-migration.js';
import { installPdfProvider } from './pdf-provider-installer.js';
import { DesktopShutdownCoordinator } from './desktop-shutdown.js';
import { DesktopIpcDrainBarrier } from './desktop-ipc-drain.js';
import { parseOpenExternalSetupPageRequest, resolveExternalSetupUrl } from './external-setup-links.js';
import { shouldHoldSingleInstanceLock, wantsMcpStdio } from './instance-lock.js';
import { createLogViewerWindow, createMainWindow, createMutationApprovalWindow, getRendererEntryPath, isAllowedRendererUrl } from './window.js';
import { createTrayMenuTemplate, createTrayToolTip, createTrayUpdateLabel, getTrayIconPath, shouldHideMainWindowOnClose } from './tray.js';
import { confirmTunnelStopForUpdate, UpdateInstallCoordinator, updateInstallNeedsTunnelStopConfirmation, type UpdateSharedActivitySnapshot } from './update-install.js';
import { UpdateCheckScheduler } from './update-check-scheduler.js';
import {
  configureUpdaterForDistribution,
  configureUpdaterForPlatform,
  currentPortableExecutablePath,
  detectWindowsDistribution,
  detectUpdaterDistribution,
  launchPortableReplacement,
  preparePortableReplacement,
  usesElectronUpdaterInstall,
} from './portable-update.js';
import { platformCompatibilityProfile, supportedHostPlatform } from './platform-compatibility.js';
import { atomicWrite, type IncidentDesktopMemory, type IncidentReport } from './incident-report.js';
import { IncidentSaveCoordinator } from './incident-save.js';
import { localizedUpdateStatusMessage, nativeMessages } from './native-i18n.js';
import { CrashDiagnosticsRecorder, RendererRecoveryBarrier, RendererRecoveryPolicy } from './crash-recovery.js';
import { DesktopSessionDiagnostics } from './desktop-session-diagnostics.js';
import { configureNativeCrashDiagnostics, pruneNativeCrashDumpsForDataPath } from './native-crash-diagnostics.js';
import { RuntimeDiagnosticsHistoryRecorder, type RuntimeDiagnosticsSample } from './runtime-diagnostics-history.js';
import { FACTORY_RESET_APPLY_ARG, applyPendingFactoryResetSync, clearFactoryResetBootstrapSync, clearFactoryResetStageSync, factoryResetBootstrapUserDataPath, stageFactoryResetSync } from './factory-reset.js';
import { decryptV3WindowsSafeStorageSecretIfPresent } from './checkpoint-key-compat.js';
import { mutationApprovalDialogOptions } from './mutation-approval.js';
import { prependBundledRuntimeToolsToPath } from './runtime-tools.js';
import { parseWorkflowWorkspace, parseWorkflowPrepare, parseCallHistory, parseDoctorGoalsRequest, parseWorkflowGoal, parseResourceSnapshot, parseRestoreTaskCheckpoint, parseCancelOwnedGoalTask } from './workflow-ipc-parser.js';
import { COPY_COMMANDS, OFFICIAL_URL_TARGETS } from './tool-catalog/remediation-registry.js';
import { SafeStorageSecretProtector } from './safe-storage-secret-protector.js';
import { createUnavailableCheckpointCipher, shouldDegradeUnavailableSecureStorage, shouldUseMacos26E2eSecrets, waitForMacosAsyncSafeStorageStartup } from './safe-storage-startup.js';
import type { ElectronNativeCapabilityApi, NativeDesktopCaptureRequest, NativeDesktopCaptureResult, NativeDialogOptions, NativeDialogResult, NativeDisplayMetadata } from './electron-native-capability-backend.js';
import { configureLinuxAutostart } from './linux-autostart.js';
import { InstallActivityCoordinator } from './install-activity.js';

const ECC_UPSTREAM_VERSION = '2.2.1';

function resolveDesktopEccRuntimeOptions(): EccRuntimeOptions {
  const appRoot = app.getAppPath();
  return {
    rootPath: app.isPackaged
      ? path.join(process.resourcesPath, 'ecc-runtime')
      : path.join(appRoot, 'node_modules', 'ecc-universal'),
    expectedVersion: ECC_UPSTREAM_VERSION,
    agentShieldBundlePath: app.isPackaged
      ? path.join(process.resourcesPath, 'ecc-runtime', '.lnwjud-agentshield.cjs')
      : path.join(appRoot, 'node_modules', 'ecc-agentshield', 'dist', 'index.js'),
  };
}

export interface DesktopIpcServices {
  listWorkspaces(): Promise<IpcResponseMap[typeof ipcChannels.listWorkspaces]>;
  addWorkspace(request: AddWorkspaceRequest): Promise<WorkspaceSummary>;
  selectWorkspace(request: SelectWorkspaceRequest): Promise<WorkspaceSummary>;
  setWorkspaceActive(request: SetWorkspaceActiveRequest): Promise<{ readonly workspace: WorkspaceSummary; readonly active: boolean }>;
  setWorkspaceArchived(request: SetWorkspaceArchivedRequest): Promise<WorkspaceSummary>;
  deleteWorkspace(request: DeleteWorkspaceRequest): Promise<{ readonly deleted: boolean; readonly workspaceId: string; readonly rootPath: string }>;
  getDashboard(): Promise<DashboardSnapshot>;
  setPermissionProfile(request: SetPermissionProfileRequest): Promise<{ readonly profile: PermissionProfileName }>;
  setUnrestrictedMode(request: SetUnrestrictedModeRequest): Promise<{ readonly unrestricted: boolean; readonly restartRequired: boolean }>;
  setAiDeletePolicy(request: SetAiDeletePolicyRequest): Promise<{ readonly enabled: boolean; readonly policy: DestructiveDeletePolicy }>;
  setStdioPolicy(request: SetStdioPolicyRequest): Promise<{ readonly profile: PermissionProfileName; readonly strictRoots: boolean; readonly allowedRoots: readonly string[]; readonly restartRequired: boolean }>;
  createBackup(): Promise<BackupSummary>;
  purgeRecoveryData(request: PurgeRecoveryDataRequest): Promise<{ readonly category: PurgeRecoveryDataRequest['category']; readonly deleted: number }>;
  scheduleRestoreBackup(request: ScheduleRestoreBackupRequest): Promise<{ readonly scheduled: boolean; readonly restartRequired: boolean }>;
  restoreRecoveryItem(request: RestoreRecoveryItemRequest): Promise<{ readonly restored: boolean; readonly path: string; readonly rollbackRecoveryId: string | null }>;
  restoreCheckpoint(request: RestoreCheckpointRequest): Promise<{ readonly restored: boolean; readonly paths: readonly string[]; readonly rollbackCheckpointId: string | null }>;
  listProcesses(): Promise<IpcResponseMap[typeof ipcChannels.listProcesses]>;
  startProcess(request: StartProcessRequest): Promise<IpcResponseMap[typeof ipcChannels.startProcess]>;
  stopProcess(request: StopProcessRequest): Promise<{ readonly stopped: boolean }>;
  startMcp(request: StartMcpRequest): Promise<McpConnectionStatus>;
  stopMcp(): Promise<McpConnectionStatus>;
  restartMcp(): Promise<McpConnectionStatus>;
  clearWorkLog(request?: ClearWorkLogRequest): Promise<{ readonly cleared: boolean }>;
  saveTunnelApiKey(request: SaveTunnelApiKeyRequest): Promise<{ readonly saved: boolean }>;
  startTunnel(): Promise<TunnelStatus>;
  stopTunnel(): Promise<TunnelStatus>;
  getTunnelStatus(): Promise<TunnelStatus>;
  beginTunnelOAuthLogin(): Promise<TunnelOAuthLoginStatus>;
  getTunnelOAuthLoginStatus(): Promise<TunnelOAuthLoginStatus>;
  cancelTunnelOAuthLogin(): Promise<TunnelOAuthLoginStatus>;
  switchTunnelAuthToLegacy(): Promise<TunnelStatus>;
  logoutTunnelOAuth(): Promise<TunnelStatus>;
  getRemoteMcpStatus(): Promise<RemoteMcpStatus>;
  installRemoteMcpProvider(): Promise<RemoteMcpStatus>;
  saveRemoteMcpAuthtoken(request: SaveRemoteMcpAuthtokenRequest): Promise<RemoteMcpStatus>;
  setRemoteMcpPublicOrigin(request: SetRemoteMcpPublicOriginRequest): Promise<RemoteMcpStatus>;
  setRemoteMcpTransport(request: SetRemoteMcpTransportRequest): Promise<RemoteMcpStatus>;
  startRemoteMcp(): Promise<RemoteMcpStatus>;
  stopRemoteMcp(): Promise<RemoteMcpStatus>;
  resetRemoteMcpOAuth(): Promise<RemoteMcpStatus>;
  setTunnelClientPath(request: SetTunnelClientPathRequest): Promise<{ readonly clientPath: string }>;
  setLocale(request: SetLocaleRequest): Promise<{ readonly locale: UiLocale }>;
  setUserSettings(request: SetUserSettingsRequest): Promise<{ readonly settings: UserSettings; readonly restartRequired: boolean }>;
  getPonytailPolicyContext(request: GetPonytailPolicyContextRequest): Promise<PonytailPolicyContext>;
  setWorkspacePonytailMode(request: SetWorkspacePonytailModeRequest): Promise<PonytailPolicyContext>;
  setGoalPonytailMode(request: SetGoalPonytailModeRequest): Promise<PonytailPolicyContext>;
  configureTunnelProfile(request: ConfigureTunnelProfileRequest): Promise<{ readonly configured: boolean; readonly profilePath: string }>;
  launchManagedBrowser(): Promise<ManagedBrowserStatus>;
  installPdfProvider(): Promise<PdfProviderInstallResult>;
  runDoctor(): Promise<DoctorReport>;
  listWorkflowTemplates(request: { readonly workspaceId: string }): Promise<readonly WorkflowTemplate[]>;
  prepareWorkflow(request: WorkflowPrepareRequest): Promise<WorkflowDraft>;
  getCallHistory(request: CallHistoryRequest): Promise<CallHistoryPage>;
  getDoctorGoals(request: { readonly workspaceId: string; readonly view?: 'calls' | 'results' }): Promise<readonly DoctorGoalOption[]>;
  getTaskResult(request: { readonly workspaceId: string; readonly goalId: string }): Promise<TaskResultSummary>;
  restoreTaskCheckpoint(request: RestoreTaskCheckpointRequest): Promise<RestoreTaskCheckpointResult>;
  cancelOwnedGoalTask(request: CancelOwnedGoalTaskRequest): Promise<CancelOwnedGoalTaskResult>;
  getResourceSnapshot(request: ResourceSnapshotRequest): Promise<ResourceSnapshot>;
  getToolCatalog(request: GetToolCatalogRequest): Promise<ToolCatalogSnapshot>;
  recheckToolCatalog(request: RecheckToolCatalogRequest): Promise<{ readonly catalog: ToolCatalogSnapshot; readonly doctor: DoctorReport }>;
  setToolAvailability(request: SetToolAvailabilityRequest): Promise<SetToolAvailabilityResult>;
  resetToolAvailability(request: ResetToolAvailabilityRequest): Promise<SetToolAvailabilityResult>;
  getLogSnapshot(): Promise<LogSnapshot>;
  loadLogSessionHistory(request: LoadLogSessionHistoryRequest): Promise<LoadLogSessionHistoryResult>;
  clearLogBuffer(request: ClearLogBufferRequest): Promise<{ readonly cleared: boolean }>;
  resolveActivityTargetDetail(detailRef: string): Promise<{ readonly status: 'complete' | 'unavailable'; readonly detail: ActivityTargetDetail | null }>;
  searchActivityTargetDetails(candidates: readonly ActivityTargetSearchCandidate[], query: string): Promise<readonly string[]>;
  streamWorkLogExportRows(rowIds: readonly string[], locale?: UiLocale): AsyncIterable<string>;
  captureIncident(updaterEvents?: readonly string[]): Promise<IncidentReport>;
  getGitDiff(request: GetGitDiffRequest): Promise<GetGitDiffResponse>;
}

export type MainWindowProvider = () => BrowserWindow | null;

export interface DesktopIpcHooks {
  readonly onLocaleChanged?: (locale: UiLocale) => void;
  readonly onUserSettingsChanged?: (settings: UserSettings) => void;
  readonly onFactoryReset?: () => Promise<{ readonly accepted: boolean }>;
  readonly ipcDrainBarrier?: DesktopIpcDrainBarrier;
}

const defaultDestructiveDeletePolicy: DestructiveDeletePolicy = {
  protectCriticalFiles: true,
  recoverableDelete: true,
  approvals: { delete_file: false, git_rm: false, git_clean: false, git_reset_restore: false, shell_rm_unlink: false, shell_rmdir: false, shell_del_erase: false, wsl_rm_unlink: false, wsl_rmdir: false },
};

const emptyTunnel: TunnelStatus = EMPTY_TUNNEL_STATUS;
const emptyRemoteMcp: RemoteMcpStatus = EMPTY_REMOTE_MCP_STATUS;
const defaultUserSettings: UserSettings = {
  customPermission: { read: 'ALLOW', write: 'ASK', execute: 'ASK', dangerous: 'DENY', allowedExecutables: [] },
  desktopFullBypassAll: false,
  stdioFullBypassAll: false,
  mcpCallTimeoutMs: 60_000,
  mcpIdleTimeoutMs: 5 * 60_000,
  processTimeoutMs: 60 * 60_000,
  mcpPollWaitSeconds: DEFAULT_MCP_POLL_WAIT_SECONDS,
  shellSynchronousWaitSeconds: DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS,
  capabilityRoots: [],
  pdfProviderPath: '',
  lspCommands: {},
  mcpHttpPort: 0,
  mcpAllowedHostnames: [],
  codexToolsEnabled: false,
  eccEnabled: false,
  ponytailMode: 'off',
  engineeringHarness: { schemaVersion: 1, enabled: false, profile: 'senior', applyTo: 'coding_projects', autoProjectAssessment: true },
  engineeringHarnessWorkspaceOverrides: {},
  engineeringHarnessDiagnostic: null,
  updateAutoCheck: true,
  updateCheckOnStartup: true,
  updateIntervalMinutes: 30,
  updateAutoDownload: true,
  closeBehavior: 'tray',
  launchAtStartup: false,
  startMinimized: false,
  tunnelAutoReconnect: false,
  tunnelMaxAutoRestarts: 5,
  recoveryRetentionDays: 30,
  extensions: { mode: 'enable_all', disabledServers: [], enabledServers: [], disabledSkillRoots: [], extraSkillRoots: [], extraMcpServers: [] },
};

const defaultDesktopServices: DesktopIpcServices = {
  listWorkspaces: async (): Promise<readonly WorkspaceSummary[]> => [],
  addWorkspace: async (): Promise<WorkspaceSummary> => {
    throw new Error('Workspace service is not configured');
  },
  selectWorkspace: async (): Promise<WorkspaceSummary> => {
    throw new Error('Workspace service is not configured');
  },
  setWorkspaceActive: async (): Promise<{ readonly workspace: WorkspaceSummary; readonly active: boolean }> => {
    throw new Error('Workspace service is not configured');
  },
  setWorkspaceArchived: async (): Promise<WorkspaceSummary> => {
    throw new Error('Workspace service is not configured');
  },
  deleteWorkspace: async (): Promise<{ readonly deleted: boolean; readonly workspaceId: string; readonly rootPath: string }> => {
    throw new Error('Workspace service is not configured');
  },
  getDashboard: async (): Promise<DashboardSnapshot> => ({
    selectedWorkspace: null,
    activeWorkspaces: [],
    gitSummary: { branch: null, changedFiles: 0, stagedFiles: 0, message: 'No workspace selected' },
    mcp: { running: false, url: null, lastStartError: null, workspaceId: null },
    codex: { installed: false, version: null },
    managedProcessCount: 0,
    auditEventCount: 0,
    recentAuditEvents: [],
    permissionProfile: 'safe',
    capabilities: [],
    agentState: 'stopped',
    mode: 'WORK',
    locale: 'th',
    unrestricted: false,
    allowAiDelete: false,
    destructiveDeletePolicy: {
      protectCriticalFiles: true,
      recoverableDelete: true,
      approvals: { delete_file: false, git_rm: false, git_clean: false, git_reset_restore: false, shell_rm_unlink: false, shell_rmdir: false, shell_del_erase: false, wsl_rm_unlink: false, wsl_rmdir: false },
    },
    stdioPermissionProfile: 'full',
    stdioStrictRoots: false,
    stdioAllowedRoots: [],
    backups: [],
    recovery: { trashRoot: null, trashItems: [], checkpoints: [] },
    connectionModes: { httpUrl: null, stdioCommand: defaultStdioCommand('full') },
    workLog: [],
    inFlight: [],
    tunnel: emptyTunnel,
    remoteMcp: emptyRemoteMcp,
    settings: defaultUserSettings,
    engineeringHarnessStatus: {
      workspaceId: null,
      enabled: false,
      source: 'unavailable',
      profile: 'senior',
      policyDigest: null,
      reasons: ['No workspace is selected.'],
      diagnostic: null,
      task: null,
    },
    hostPlatform: supportedHostPlatform(process.platform),
    hostArch: process.arch === 'arm64' ? 'arm64' : 'x64',
    appVersion: APP_VERSION,
  }),
  setPermissionProfile: async (request): Promise<{ readonly profile: PermissionProfileName }> => ({ profile: request.profile }),
  setUnrestrictedMode: async (request): Promise<{ readonly unrestricted: boolean; readonly restartRequired: boolean }> => ({
    unrestricted: request.enabled,
    restartRequired: false,
  }),
  setAiDeletePolicy: async (request): Promise<{ readonly enabled: boolean; readonly policy: DestructiveDeletePolicy }> => {
    const policy = request.policy ?? { ...defaultDestructiveDeletePolicy, approvals: { ...defaultDestructiveDeletePolicy.approvals, delete_file: request.enabled === true } };
    return { enabled: policy.approvals.delete_file, policy };
  },
  setStdioPolicy: async (request): Promise<{ readonly profile: PermissionProfileName; readonly strictRoots: boolean; readonly allowedRoots: readonly string[]; readonly restartRequired: boolean }> => ({
    profile: request.profile, strictRoots: request.strictRoots, allowedRoots: request.allowedRoots, restartRequired: false,
  }),
  createBackup: async (): Promise<BackupSummary> => ({ id: 'unavailable', createdAt: new Date(0).toISOString(), reason: 'manual', sizeBytes: 0 }),
  purgeRecoveryData: async (request: PurgeRecoveryDataRequest): Promise<{ readonly category: PurgeRecoveryDataRequest['category']; readonly deleted: number }> => ({ category: request.category, deleted: 0 }),
  scheduleRestoreBackup: async (): Promise<{ readonly scheduled: boolean; readonly restartRequired: boolean }> => ({ scheduled: false, restartRequired: false }),
  restoreRecoveryItem: async (): Promise<{ readonly restored: boolean; readonly path: string; readonly rollbackRecoveryId: string | null }> => ({ restored: false, path: '', rollbackRecoveryId: null }),
  restoreCheckpoint: async (): Promise<{ readonly restored: boolean; readonly paths: readonly string[]; readonly rollbackCheckpointId: string | null }> => ({ restored: false, paths: [], rollbackCheckpointId: null }),
  listProcesses: async (): Promise<readonly ProcessSummary[]> => [],
  startProcess: async (): Promise<IpcResponseMap[typeof ipcChannels.startProcess]> => {
    throw new Error('Desktop services are not configured');
  },
  stopProcess: async (): Promise<{ readonly stopped: boolean }> => ({ stopped: false }),
  startMcp: async (): Promise<McpConnectionStatus> => ({ running: false, url: null, workspaceId: null }),
  stopMcp: async (): Promise<McpConnectionStatus> => ({ running: false, url: null, workspaceId: null }),
  restartMcp: async (): Promise<McpConnectionStatus> => ({ running: false, url: null, workspaceId: null }),
  clearWorkLog: async (): Promise<{ readonly cleared: boolean }> => ({ cleared: false }),
  saveTunnelApiKey: async (): Promise<{ readonly saved: boolean }> => ({ saved: false }),
  startTunnel: async (): Promise<TunnelStatus> => emptyTunnel,
  stopTunnel: async (): Promise<TunnelStatus> => emptyTunnel,
  getTunnelStatus: async (): Promise<TunnelStatus> => emptyTunnel,
  beginTunnelOAuthLogin: async (): Promise<TunnelOAuthLoginStatus> => ({ state: 'idle', available: false, providerId: null, authorizationUrl: null, message: 'OAuth unavailable' }),
  getTunnelOAuthLoginStatus: async (): Promise<TunnelOAuthLoginStatus> => ({ state: 'idle', available: false, providerId: null, authorizationUrl: null, message: 'OAuth unavailable' }),
  cancelTunnelOAuthLogin: async (): Promise<TunnelOAuthLoginStatus> => ({ state: 'idle', available: false, providerId: null, authorizationUrl: null, message: 'OAuth unavailable' }),
  switchTunnelAuthToLegacy: async (): Promise<TunnelStatus> => emptyTunnel,
  logoutTunnelOAuth: async (): Promise<TunnelStatus> => emptyTunnel,
  getRemoteMcpStatus: async (): Promise<RemoteMcpStatus> => emptyRemoteMcp,
  installRemoteMcpProvider: async (): Promise<RemoteMcpStatus> => emptyRemoteMcp,
  saveRemoteMcpAuthtoken: async (): Promise<RemoteMcpStatus> => emptyRemoteMcp,
  setRemoteMcpPublicOrigin: async (): Promise<RemoteMcpStatus> => emptyRemoteMcp,
  setRemoteMcpTransport: async (): Promise<RemoteMcpStatus> => emptyRemoteMcp,
  startRemoteMcp: async (): Promise<RemoteMcpStatus> => emptyRemoteMcp,
  stopRemoteMcp: async (): Promise<RemoteMcpStatus> => emptyRemoteMcp,
  resetRemoteMcpOAuth: async (): Promise<RemoteMcpStatus> => emptyRemoteMcp,
  setTunnelClientPath: async (request): Promise<{ readonly clientPath: string }> => ({ clientPath: request.clientPath }),
  setLocale: async (request): Promise<{ readonly locale: UiLocale }> => ({ locale: request.locale }),
  setUserSettings: async (request): Promise<{ readonly settings: UserSettings; readonly restartRequired: boolean }> => ({ settings: request.settings, restartRequired: false }),
  getPonytailPolicyContext: async (request): Promise<PonytailPolicyContext> => ({ workspaceId: request.workspaceId, globalMode: 'off', workspaceMode: 'inherit', effectiveWorkspaceMode: 'off', effectiveWorkspaceSource: 'default', activeGoals: [] }),
  setWorkspacePonytailMode: async (request): Promise<PonytailPolicyContext> => ({ workspaceId: request.workspaceId, globalMode: 'off', workspaceMode: request.mode, effectiveWorkspaceMode: request.mode === 'inherit' ? 'off' : request.mode, effectiveWorkspaceSource: request.mode === 'inherit' ? 'default' : 'workspace', activeGoals: [] }),
  setGoalPonytailMode: async (request): Promise<PonytailPolicyContext> => ({ workspaceId: request.workspaceId, globalMode: 'off', workspaceMode: 'inherit', effectiveWorkspaceMode: 'off', effectiveWorkspaceSource: 'default', activeGoals: [] }),
  configureTunnelProfile: async (): Promise<{ readonly configured: boolean; readonly profilePath: string }> => ({ configured: false, profilePath: '' }),
  launchManagedBrowser: async (): Promise<ManagedBrowserStatus> => ({ ready: false, port: 9222, launched: false }),
  installPdfProvider: async (): Promise<PdfProviderInstallResult> => { throw new Error('PDF provider installer is not configured'); },
  listWorkflowTemplates: async () => [],
  prepareWorkflow: async () => { throw new Error('Workflow service not configured'); },
  getCallHistory: async () => { throw new Error('Call history service not configured'); },
  getDoctorGoals: async () => [],
  getTaskResult: async () => { throw new Error('Goal result service not configured'); },
  restoreTaskCheckpoint: async () => { throw new Error('Goal checkpoint restore not configured'); },
  cancelOwnedGoalTask: async () => { throw new Error('Owned Goal task cancellation not configured'); },
  getResourceSnapshot: async () => { throw new Error('Resource service not configured'); },
  runDoctor: async (): Promise<DoctorReport> => ({
    checks: [{ id: 'desktop', required: true, status: 'fail', title: 'Desktop services', summary: 'Desktop services are not configured', affectedToolNames: [], checkedAt: new Date(0).toISOString(), durationMs: 0, message: 'Desktop services are not configured' }],
    exitCode: 1,
  }),
  getToolCatalog: async (request): Promise<ToolCatalogSnapshot> => ({ generatedAt: new Date(0).toISOString(), locale: request.locale, items: [], remediations: [] }),
  recheckToolCatalog: async (request): Promise<{ readonly catalog: ToolCatalogSnapshot; readonly doctor: DoctorReport }> => ({
    catalog: { generatedAt: new Date(0).toISOString(), locale: request.locale, items: [], remediations: [] },
    doctor: { checks: [], exitCode: 1 },
  }),
  setToolAvailability: async (): Promise<SetToolAvailabilityResult> => { throw new Error('Tool availability service is not configured'); },
  resetToolAvailability: async (): Promise<SetToolAvailabilityResult> => { throw new Error('Tool availability service is not configured'); },
  getLogSnapshot: async (): Promise<LogSnapshot> => ({
    lines: [],
    tunnelLogPath: null,
    tunnelLogExists: false,
  }),
  loadLogSessionHistory: async (): Promise<LoadLogSessionHistoryResult> => ({
    workLog: [],
    logSnapshot: { lines: [], tunnelLogPath: null, tunnelLogExists: false },
  }),
  clearLogBuffer: async (): Promise<{ readonly cleared: boolean }> => ({ cleared: false }),
  resolveActivityTargetDetail: async (): Promise<{ readonly status: 'unavailable'; readonly detail: null }> => ({ status: 'unavailable', detail: null }),
  searchActivityTargetDetails: async (): Promise<readonly string[]> => [],
  streamWorkLogExportRows: (): AsyncIterable<string> => emptySerializedRows(),
  captureIncident: async (): Promise<IncidentReport> => ({
    schemaVersion: 3,
    capturedAt: formatOffsetIsoTimestamp(new Date(), DEFAULT_DISPLAY_TIME_ZONE),
    timeZone: DEFAULT_DISPLAY_TIME_ZONE,
    appVersion: APP_VERSION,
    tunnelClientVersion: null,
    tunnelClientVersionReason: 'desktop_services_unavailable',
    classification: 'healthy_or_inconclusive',
    classificationReasons: ['desktop_services_unavailable'],
    updaterEventTail: [],
    tunnel: { state: 'stopped', source: 'desktop', instanceIds: [], requestIds: [], health: { state: 'unavailable', message: 'unavailable' } },
    runtimeDiagnostics: null,
    transport: { webSocketCloseCode: null, httpStatus: null, networkError: null, lastDisconnectAt: null, evidenceSources: [] },
    mcpCalls: [],
    desktopCrashEventTail: [],
    tunnelLogTail: [],
    processTree: { available: false, entries: [], error: 'unavailable' },
    tcpListeners: { available: false, entries: [], error: 'unavailable' },
  }),
  getGitDiff: async (request: GetGitDiffRequest): Promise<GetGitDiffResponse> => ({ path: request.path, patch: '', truncated: false }),
};

const updaterEventTail: string[] = [];
function recordUpdaterEvent(message: string): void { updaterEventTail.push(message.slice(0, 512)); while (updaterEventTail.length > 100) updaterEventTail.shift(); }
const recordedUpdaterDownloads = new Set<string>();
function recordUpdaterDownload(version: string): void {
  if (recordedUpdaterDownloads.has(version)) return;
  recordedUpdaterDownloads.add(version);
  recordUpdaterEvent(`update-downloaded:${version}`);
}

export function isTrustedIpcSender(event: IpcMainInvokeEvent, window: BrowserWindow | null): boolean {
  void window;
  const senderFrame = event.senderFrame;
  return senderFrame !== null && isAllowedRendererUrl(senderFrame.url, getRendererEntryPath());
}

export function registerIpcHandlers(
  getMainWindow: MainWindowProvider,
  services: DesktopIpcServices = defaultDesktopServices,
  hooks: DesktopIpcHooks = {},
): void {
  const registerHandler = (
    channel: string,
    handler: (event: IpcMainInvokeEvent, payload: unknown) => unknown | Promise<unknown>,
  ): void => {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      const invoke = (): unknown | Promise<unknown> => handler(event, payload);
      return hooks.ipcDrainBarrier === undefined ? invoke() : hooks.ipcDrainBarrier.run(invoke);
    });
  };

  const incidentSaver = new IncidentSaveCoordinator({
    capture: (): Promise<IncidentReport> => services.captureIncident(updaterEventTail),
    choosePath: async (): Promise<string | null> => {
      const window = getMainWindow();
      if (window === null) return null;
      const result = await dialog.showSaveDialog(window, { title: 'Capture lnwjud incident evidence', defaultPath: 'lnwjud-incident.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      return result.canceled || result.filePath === undefined || result.filePath.length === 0 ? null : result.filePath;
    },
    write: atomicWrite,
  });
  registerHandler(ipcChannels.listWorkspaces, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.listWorkspaces();
  });
  registerHandler(ipcChannels.addWorkspace, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.addWorkspace(parseAddWorkspaceRequest(payload));
  });
  registerHandler(ipcChannels.selectWorkspace, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.selectWorkspace(parseSelectWorkspaceRequest(payload));
  });
  registerHandler(ipcChannels.setWorkspaceActive, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setWorkspaceActive(parseSetWorkspaceActiveRequest(payload));
  });
  registerHandler(ipcChannels.setWorkspaceArchived, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setWorkspaceArchived(parseSetWorkspaceArchivedRequest(payload));
  });
  registerHandler(ipcChannels.deleteWorkspace, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.deleteWorkspace(parseDeleteWorkspaceRequest(payload));
  });
  registerHandler(ipcChannels.getDashboard, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.getDashboard();
  });
  registerHandler(ipcChannels.setPermissionProfile, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setPermissionProfile(parseSetPermissionProfileRequest(payload));
  });
  registerHandler(ipcChannels.setUnrestrictedMode, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setUnrestrictedMode(parseSetUnrestrictedModeRequest(payload));
  });
  registerHandler(ipcChannels.setAiDeletePolicy, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setAiDeletePolicy(parseSetAiDeletePolicyRequest(payload));
  });
  registerHandler(ipcChannels.setStdioPolicy, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setStdioPolicy(parseSetStdioPolicyRequest(payload));
  });
  registerHandler(ipcChannels.createBackup, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.createBackup();
  });
  registerHandler(ipcChannels.purgeRecoveryData, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.purgeRecoveryData(parsePurgeRecoveryDataRequest(payload));
  });
  registerHandler(ipcChannels.scheduleRestoreBackup, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.scheduleRestoreBackup(parseScheduleRestoreBackupRequest(payload));
  });
  registerHandler(ipcChannels.restoreRecoveryItem, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.restoreRecoveryItem(parseRestoreRecoveryItemRequest(payload));
  });
  registerHandler(ipcChannels.restoreCheckpoint, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.restoreCheckpoint(parseRestoreCheckpointRequest(payload));
  });
  registerHandler(ipcChannels.listProcesses, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.listProcesses();
  });
  registerHandler(ipcChannels.startProcess, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.startProcess(parseStartProcessRequest(payload));
  });
  registerHandler(ipcChannels.stopProcess, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.stopProcess(parseStopProcessRequest(payload));
  });
  registerHandler(ipcChannels.startMcp, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.startMcp(parseStartMcpRequest(payload));
  });
  registerHandler(ipcChannels.stopMcp, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.stopMcp();
  });
  registerHandler(ipcChannels.restartMcp, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.restartMcp();
  });
  registerHandler(ipcChannels.clearWorkLog, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.clearWorkLog(parseClearWorkLogRequest(payload));
  });
  registerHandler(ipcChannels.saveTunnelApiKey, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.saveTunnelApiKey(parseSaveTunnelApiKeyRequest(payload));
  });
  registerHandler(ipcChannels.startTunnel, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.startTunnel();
  });
  registerHandler(ipcChannels.stopTunnel, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.stopTunnel();
  });
  registerHandler(ipcChannels.getTunnelStatus, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.getTunnelStatus();
  });
  registerHandler(ipcChannels.beginTunnelOAuthLogin, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    const status = await services.beginTunnelOAuthLogin();
    if (status.authorizationUrl !== null) {
      try {
        await shell.openExternal(status.authorizationUrl);
      } catch (error) {
        await services.cancelTunnelOAuthLogin();
        throw error;
      }
    }
    return status;
  });
  registerHandler(ipcChannels.getTunnelOAuthLoginStatus, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.getTunnelOAuthLoginStatus();
  });
  registerHandler(ipcChannels.cancelTunnelOAuthLogin, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.cancelTunnelOAuthLogin();
  });
  registerHandler(ipcChannels.switchTunnelAuthToLegacy, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.switchTunnelAuthToLegacy();
  });
  registerHandler(ipcChannels.logoutTunnelOAuth, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.logoutTunnelOAuth();
  });
  registerHandler(ipcChannels.getRemoteMcpStatus, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.getRemoteMcpStatus();
  });
  registerHandler(ipcChannels.installRemoteMcpProvider, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.installRemoteMcpProvider();
  });
  registerHandler(ipcChannels.saveRemoteMcpAuthtoken, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.saveRemoteMcpAuthtoken(parseSaveRemoteMcpAuthtokenRequest(payload));
  });
  registerHandler(ipcChannels.setRemoteMcpPublicOrigin, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setRemoteMcpPublicOrigin(parseSetRemoteMcpPublicOriginRequest(payload));
  });
  registerHandler(ipcChannels.setRemoteMcpTransport, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setRemoteMcpTransport(parseSetRemoteMcpTransportRequest(payload));
  });
  registerHandler(ipcChannels.startRemoteMcp, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.startRemoteMcp();
  });
  registerHandler(ipcChannels.stopRemoteMcp, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.stopRemoteMcp();
  });
  registerHandler(ipcChannels.resetRemoteMcpOAuth, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.resetRemoteMcpOAuth();
  });
  registerHandler(ipcChannels.setTunnelClientPath, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setTunnelClientPath(parseSetTunnelClientPathRequest(payload));
  });
  registerHandler(ipcChannels.setLocale, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    const result = await services.setLocale(parseSetLocaleRequest(payload));
    hooks.onLocaleChanged?.(result.locale);
    return result;
  });
  registerHandler(ipcChannels.setUserSettings, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    const result = await services.setUserSettings(parseSetUserSettingsRequest(payload));
    hooks.onUserSettingsChanged?.(result.settings);
    return result;
  });
  registerHandler(ipcChannels.getPonytailPolicyContext, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.getPonytailPolicyContext(parseGetPonytailPolicyContextRequest(payload));
  });
  registerHandler(ipcChannels.setWorkspacePonytailMode, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setWorkspacePonytailMode(parseSetWorkspacePonytailModeRequest(payload));
  });
  registerHandler(ipcChannels.setGoalPonytailMode, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setGoalPonytailMode(parseSetGoalPonytailModeRequest(payload));
  });
  registerHandler(ipcChannels.chooseWorkflowDataFile, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    const owner = getMainWindow();
    if (owner === null) return { filePath: null };
    const result = await dialog.showOpenDialog(owner, {
      title: 'Select Excel / CSV data file',
      properties: ['openFile'],
      filters: [{ name: 'Excel and CSV', extensions: ['xlsx', 'csv', 'tsv'] }, { name: 'All files', extensions: ['*'] }],
    });
    return { filePath: result.canceled ? null : (result.filePaths[0] ?? null) };
  });
  registerHandler(ipcChannels.chooseTunnelClientPath, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    const window = getMainWindow();
    if (window === null) return { clientPath: null };
    const isWindows = process.platform === 'win32';
    const result = await dialog.showOpenDialog(window, {
      title: isWindows ? 'Select tunnel-client.exe' : 'Select tunnel-client',
      properties: ['openFile'],
      ...(isWindows ? { filters: [{ name: 'OpenAI Secure MCP Tunnel client', extensions: ['exe'] }] } : {}),
    });
    return { clientPath: result.canceled ? null : (result.filePaths[0] ?? null) };
  });
  registerHandler(ipcChannels.configureTunnelProfile, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.configureTunnelProfile(parseConfigureTunnelProfileRequest(payload));
  });
  registerHandler(ipcChannels.openExternalSetupPage, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    const request = parseOpenExternalSetupPageRequest(payload);
    await shell.openExternal(resolveExternalSetupUrl(request.target));
    return { opened: true as const };
  });
  registerHandler(ipcChannels.launchManagedBrowser, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.launchManagedBrowser();
  });
  registerHandler(ipcChannels.installPdfProvider, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.installPdfProvider();
  });
  registerHandler(ipcChannels.listWorkflowTemplates, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.listWorkflowTemplates(parseWorkflowWorkspace(payload));
  });
  registerHandler(ipcChannels.prepareWorkflow, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.prepareWorkflow(parseWorkflowPrepare(payload));
  });
  registerHandler(ipcChannels.getCallHistory, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.getCallHistory(parseCallHistory(payload));
  });
  registerHandler(ipcChannels.getDoctorGoals, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.getDoctorGoals(parseDoctorGoalsRequest(payload));
  });
  registerHandler(ipcChannels.getTaskResult, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.getTaskResult(parseWorkflowGoal(payload));
  });
  registerHandler(ipcChannels.restoreTaskCheckpoint, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.restoreTaskCheckpoint(parseRestoreTaskCheckpoint(payload));
  });
  registerHandler(ipcChannels.cancelOwnedGoalTask, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.cancelOwnedGoalTask(parseCancelOwnedGoalTask(payload));
  });
  registerHandler(ipcChannels.getResourceSnapshot, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.getResourceSnapshot(parseResourceSnapshot(payload));
  });
  registerHandler(ipcChannels.runDoctor, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.runDoctor();
  });
  registerHandler(ipcChannels.getToolCatalog, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.getToolCatalog(parseGetToolCatalogRequest(payload));
  });
  registerHandler(ipcChannels.recheckToolCatalog, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.recheckToolCatalog(parseRecheckToolCatalogRequest(payload));
  });
  registerHandler(ipcChannels.setToolAvailability, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setToolAvailability(parseSetToolAvailabilityRequest(payload));
  });
  registerHandler(ipcChannels.resetToolAvailability, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.resetToolAvailability(parseResetToolAvailabilityRequest(payload));
  });
  registerHandler(ipcChannels.openToolSetupTarget, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    const request = parseOpenToolSetupTargetRequest(payload);
    if (request.target === 'windows_optional_features') {
      if (process.platform !== 'win32') throw new Error('Windows Optional Features are unavailable on this platform');
      const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
      const openError = await shell.openPath(path.join(windowsRoot, 'System32', 'OptionalFeatures.exe'));
      if (openError.length > 0) throw new Error(`Could not open Windows Optional Features: ${openError}`);
      return { opened: true as const };
    }
    const url = OFFICIAL_URL_TARGETS[request.target as keyof typeof OFFICIAL_URL_TARGETS];
    if (url === undefined) throw new Error('Unknown tool setup target');
    await shell.openExternal(url);
    return { opened: true as const };
  });
  registerHandler(ipcChannels.copyToolCommand, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    const request = parseCopyToolCommandRequest(payload);
    if (request.commandId === 'enable_windows_sandbox' && process.platform !== 'win32') {
      throw new Error('Windows Sandbox is unavailable on this platform');
    }
    const command = COPY_COMMANDS[request.commandId as keyof typeof COPY_COMMANDS];
    if (command === undefined) throw new Error('Unknown tool command id');
    clipboard.writeText(command);
    return { copied: true as const };
  });
  registerHandler(ipcChannels.getLogSnapshot, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.getLogSnapshot();
  });
  registerHandler(ipcChannels.loadLogSessionHistory, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.loadLogSessionHistory(parseLoadLogSessionHistoryRequest(payload));
  });
  registerHandler(ipcChannels.clearLogBuffer, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.clearLogBuffer(parseClearLogBufferRequest(payload));
  });
  registerHandler(ipcChannels.resolveActivityTargetDetail, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.resolveActivityTargetDetail(parseResolveActivityTargetDetailRequest(payload));
  });
  registerHandler(ipcChannels.searchActivityTargetDetails, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    const request = parseSearchActivityTargetDetailsRequest(payload);
    return { matchingIds: await services.searchActivityTargetDetails(request.candidates, request.query) };
  });
  registerHandler(ipcChannels.exportLogs, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return exportLogsToFile(getMainWindow(), services, parseExportLogsRequest(payload));
  });
  registerHandler(ipcChannels.exportWorkLog, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return exportWorkLogToFile(getMainWindow(), services, parseExportWorkLogRequest(payload));
  });
  registerHandler(ipcChannels.captureIncident, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return incidentSaver.captureAndSave();
  });
  registerHandler(ipcChannels.openLogViewer, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return { opened: openLogViewerWindow() !== null };
  });
  registerHandler(ipcChannels.getUpdateStatus, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return currentUpdateStatus;
  });
  registerHandler(ipcChannels.getInstallActivity, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return installActivity.snapshot();
  });
  registerHandler(ipcChannels.getMutationApprovalPrompt, (event, payload: unknown) => {
    if (!isTrustedIpcSender(event, getMainWindow())) throw new Error('IPC sender rejected');
    assertNoPayload(payload);
    return pendingMutationApprovals.get(event.sender.id)?.prompt ?? null;
  });
  registerHandler(ipcChannels.resolveMutationApprovalPrompt, (event, payload: unknown) => {
    if (!isTrustedIpcSender(event, getMainWindow())) throw new Error('IPC sender rejected');
    if (!isRecord(payload) || typeof payload.approved !== 'boolean') throw new Error('Invalid IPC payload');
    const pending = pendingMutationApprovals.get(event.sender.id);
    if (pending === undefined) return { accepted: false };
    pending.complete(payload.approved);
    return { accepted: true };
  });
  registerHandler(ipcChannels.factoryReset, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return hooks.onFactoryReset === undefined ? { accepted: false } : hooks.onFactoryReset();
  });
  registerHandler(ipcChannels.checkForUpdates, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return requestUpdateCheck('renderer');
  });
  registerHandler(ipcChannels.installUpdate, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return requestUpdateInstall();
  });
  registerHandler(ipcChannels.getGitDiff, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.getGitDiff(parseGetGitDiffRequest(payload));
  });
}

function parseGetGitDiffRequest(payload: unknown): GetGitDiffRequest {
  if (!isRecord(payload) || typeof payload.workspaceId !== 'string' || typeof payload.path !== 'string') {
    throw new Error('Invalid getGitDiff payload');
  }
  return {
    workspaceId: payload.workspaceId,
    path: payload.path,
    ...(typeof payload.staged === 'boolean' ? { staged: payload.staged } : {}),
  };
}

function assertTrustedSender(event: IpcMainInvokeEvent, mainWindow: BrowserWindow | null): void {
  if (mainWindow === null || !isTrustedIpcSender(event, mainWindow)) throw new Error('IPC sender rejected');
}

function assertNoPayload(payload: unknown): void {
  if (payload !== undefined) throw new Error('Invalid IPC payload');
}

function parseAddWorkspaceRequest(payload: unknown): AddWorkspaceRequest {
  if (!isRecord(payload)) throw new Error('Invalid IPC payload');
  return { rootPath: nonEmptyString(payload.rootPath, 'rootPath') };
}

function parseSelectWorkspaceRequest(payload: unknown): SelectWorkspaceRequest {
  if (!isRecord(payload)) throw new Error('Invalid IPC payload');
  return { workspaceId: nonEmptyString(payload.workspaceId, 'workspaceId') };
}

function parseSetWorkspaceActiveRequest(payload: unknown): SetWorkspaceActiveRequest {
  if (!isRecord(payload) || typeof payload.active !== 'boolean') throw new Error('Invalid IPC payload: active');
  return { workspaceId: nonEmptyString(payload.workspaceId, 'workspaceId'), active: payload.active };
}

function parseSetWorkspaceArchivedRequest(payload: unknown): SetWorkspaceArchivedRequest {
  if (!isRecord(payload) || typeof payload.archived !== 'boolean') throw new Error('Invalid IPC payload: archived');
  return { workspaceId: nonEmptyString(payload.workspaceId, 'workspaceId'), archived: payload.archived };
}

function parseDeleteWorkspaceRequest(payload: unknown): DeleteWorkspaceRequest {
  if (!isRecord(payload) || typeof payload.userConfirmed !== 'boolean') throw new Error('Invalid IPC payload');
  return { workspaceId: nonEmptyString(payload.workspaceId, 'workspaceId'), userConfirmed: payload.userConfirmed };
}

function parseSetPermissionProfileRequest(payload: unknown): SetPermissionProfileRequest {
  if (!isRecord(payload) || !isPermissionProfile(payload.profile)) throw new Error('Invalid IPC payload');
  return { profile: payload.profile };
}

function parseSetUnrestrictedModeRequest(payload: unknown): SetUnrestrictedModeRequest {
  if (!isRecord(payload) || typeof payload.enabled !== 'boolean') throw new Error('Invalid IPC payload: enabled');
  return { enabled: payload.enabled };
}

function parseSetAiDeletePolicyRequest(payload: unknown): SetAiDeletePolicyRequest {
  if (!isRecord(payload)) throw new Error('Invalid IPC payload: destructive delete policy');
  const enabled = typeof payload.enabled === 'boolean' ? payload.enabled : undefined;
  const policy = payload.policy === undefined ? undefined : parseDestructiveDeletePolicy(payload.policy);
  if (enabled === undefined && policy === undefined) throw new Error('Invalid IPC payload: destructive delete policy');
  return { ...(enabled === undefined ? {} : { enabled }), ...(policy === undefined ? {} : { policy }) };
}

function parseDestructiveDeletePolicy(value: unknown): DestructiveDeletePolicy {
  if (!isRecord(value) || typeof value.protectCriticalFiles !== 'boolean' || typeof value.recoverableDelete !== 'boolean') {
    throw new Error('Invalid destructive delete policy');
  }
  const approvalsRaw = value.approvals;
  if (!isRecord(approvalsRaw)) throw new Error('Invalid destructive delete policy');
  const keys = ['delete_file', 'git_rm', 'git_clean', 'git_reset_restore', 'shell_rm_unlink', 'shell_rmdir', 'shell_del_erase', 'wsl_rm_unlink', 'wsl_rmdir'] as const;
  const approvals = Object.fromEntries(keys.map((key) => {
    const enabled = approvalsRaw[key];
    if (typeof enabled !== 'boolean') throw new Error('Invalid destructive delete policy approval: ' + key);
    return [key, enabled];
  })) as Record<(typeof keys)[number], boolean>;
  return { protectCriticalFiles: value.protectCriticalFiles, recoverableDelete: value.recoverableDelete, approvals };
}

function parsePurgeRecoveryDataRequest(payload: unknown): PurgeRecoveryDataRequest {
  if (!isRecord(payload) || payload.userConfirmed !== true
    || (payload.category !== 'trash' && payload.category !== 'checkpoints' && payload.category !== 'backups')) {
    throw new Error('Invalid IPC payload: purge recovery data');
  }
  return { category: payload.category, userConfirmed: true };
}

function parseScheduleRestoreBackupRequest(payload: unknown): ScheduleRestoreBackupRequest {
  if (!isRecord(payload)) throw new Error('Invalid IPC payload');
  return { backupId: nonEmptyString(payload.backupId, 'backupId') };
}

function parseRestoreRecoveryItemRequest(payload: unknown): RestoreRecoveryItemRequest {
  if (!isRecord(payload)) throw new Error('Invalid IPC payload');
  return {
    workspaceId: nonEmptyString(payload.workspaceId, 'workspaceId'),
    recoveryId: nonEmptyString(payload.recoveryId, 'recoveryId'),
  };
}

function parseRestoreCheckpointRequest(payload: unknown): RestoreCheckpointRequest {
  if (!isRecord(payload)) throw new Error('Invalid IPC payload');
  return {
    workspaceId: nonEmptyString(payload.workspaceId, 'workspaceId'),
    checkpointId: nonEmptyString(payload.checkpointId, 'checkpointId'),
  };
}

function parseSetStdioPolicyRequest(payload: unknown): SetStdioPolicyRequest {
  if (!isRecord(payload) || !isPermissionProfile(payload.profile) || typeof payload.strictRoots !== 'boolean' || !Array.isArray(payload.allowedRoots)) {
    throw new Error('Invalid IPC payload: stdio policy');
  }
  const allowedRoots = payload.allowedRoots.map((root) => nonEmptyString(root, 'allowedRoot').trim());
  if (payload.strictRoots && allowedRoots.length === 0) throw new Error('Strict root mode requires at least one allowed root');
  return { profile: payload.profile, strictRoots: payload.strictRoots, allowedRoots };
}

function parseClearWorkLogRequest(payload: unknown): ClearWorkLogRequest {
  if (payload === undefined) return {};
  if (!isRecord(payload)) throw new Error('Invalid IPC payload');
  const workspaceId = optionalScopeId(payload.workspaceId, 'workspaceId');
  const sessionId = optionalScopeId(payload.sessionId, 'sessionId');
  return { ...(workspaceId === undefined ? {} : { workspaceId }), ...(sessionId === undefined ? {} : { sessionId }) };
}

function parseLoadLogSessionHistoryRequest(payload: unknown): LoadLogSessionHistoryRequest {
  if (!isRecord(payload)) throw new Error('Invalid IPC payload');
  const sessionId = boundedNonEmptyString(payload.sessionId, 'sessionId', 512).trim();
  const workspaceId = optionalScopeId(payload.workspaceId, 'workspaceId');
  const limit = payload.limit === undefined ? undefined : payload.limit;
  if (limit !== undefined && (!Number.isInteger(limit) || typeof limit !== 'number' || limit < 1 || limit > 500)) throw new Error('Invalid IPC payload: limit');
  return {
    sessionId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function parseClearLogBufferRequest(payload: unknown): ClearLogBufferRequest {
  if (!isRecord(payload) || !isLogSource(payload.source)) throw new Error('Invalid IPC payload: source');
  const workspaceId = optionalScopeId(payload.workspaceId, 'workspaceId');
  const sessionId = optionalScopeId(payload.sessionId, 'sessionId');
  return { source: payload.source, ...(workspaceId === undefined ? {} : { workspaceId }), ...(sessionId === undefined ? {} : { sessionId }) };
}

function parseResolveActivityTargetDetailRequest(payload: unknown): string {
  if (!isRecord(payload)) throw new Error('Invalid IPC payload');
  return boundedNonEmptyString(payload.detailRef, 'detailRef', 512);
}

function parseSearchActivityTargetDetailsRequest(payload: unknown): { readonly query: string; readonly candidates: readonly ActivityTargetSearchCandidate[] } {
  if (!isRecord(payload) || !Array.isArray(payload.candidates) || payload.candidates.length > 5_000) throw new Error('Invalid IPC payload');
  const query = boundedNonEmptyString(payload.query, 'query', 512).trim();
  const candidates = payload.candidates.map((candidate): ActivityTargetSearchCandidate => {
    if (!isRecord(candidate)) throw new Error('Invalid IPC payload: candidates');
    const detailRef = candidate.detailRef === null ? null : boundedNonEmptyString(candidate.detailRef, 'detailRef', 512);
    return { id: boundedNonEmptyString(candidate.id, 'id', 1_024), detailRef };
  });
  return { query, candidates };
}

function parseExportLogsRequest(payload: unknown): ExportLogsRequest {
  if (!isRecord(payload) || !isLogSource(payload.source)) {
    throw new Error('Invalid IPC payload');
  }
  const workspaceId = optionalScopeId(payload.workspaceId, 'workspaceId');
  const sessionId = optionalScopeId(payload.sessionId, 'sessionId');
  const locale = optionalUiLocale(payload.locale);
  if (!Array.isArray(payload.lines) || payload.lines.length > 5_000) throw new Error('Invalid IPC payload: lines');
  const lines = payload.lines.map((line) => {
    if (!isRecord(line) || !Number.isSafeInteger(line.lineId) || Number(line.lineId) <= 0) throw new Error('Invalid IPC payload: lines');
    const correlationRef = line.correlationRef === null ? null : boundedNonEmptyString(line.correlationRef, 'correlationRef', 512);
    return { lineId: Number(line.lineId), correlationRef };
  });
  return {
    source: payload.source,
    filePath: typeof payload.filePath === 'string' ? payload.filePath : '',
    ...(locale === undefined ? {} : { locale }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(typeof payload.query === 'string' && payload.query.trim().length > 0 ? { query: payload.query.trim().slice(0, 512) } : {}),
    lines,
  };
}

function parseExportWorkLogRequest(payload: unknown): ExportWorkLogRequest {
  if (!isRecord(payload) || !Array.isArray(payload.rowIds) || payload.rowIds.length > 5_000) {
    throw new Error('Invalid IPC payload: rowIds');
  }
  const locale = optionalUiLocale(payload.locale);
  const rowIds = payload.rowIds.map((rowId) => {
    const value = boundedNonEmptyString(rowId, 'rowId', 1_024);
    if (!/^(audit|inflight):.+$/s.test(value)) throw new Error('Invalid IPC payload: rowIds');
    return value;
  });
  return { rowIds, ...(locale === undefined ? {} : { locale }) };
}

function boundedNonEmptyString(value: unknown, key: string, maximumLength: number): string {
  const result = nonEmptyString(value, key);
  if (result.length > maximumLength) throw new Error(`Invalid IPC payload: ${key}`);
  return result;
}

function optionalScopeId(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(value, key).trim();
}

function optionalUiLocale(value: unknown): UiLocale | undefined {
  if (value === undefined) return undefined;
  if (value === 'th' || value === 'en') return value;
  throw new Error('Invalid IPC payload: locale');
}

function isLogSource(value: unknown): value is 'tunnel' | 'mcp' | 'process' {
  return value === 'tunnel' || value === 'mcp' || value === 'process';
}

async function exportLogsToFile(
  window: BrowserWindow | null,
  services: DesktopIpcServices,
  request: ExportLogsRequest,
): Promise<{ readonly exported: boolean }> {
  if (window === null) return { exported: false };
  const locale = request.locale ?? desktopLocale;
  const messages = nativeMessages(locale);
  const snapshot = await services.getLogSnapshot();
  const lineById = new Map(snapshot.lines.filter((line) => line.source === request.source).map((line) => [line.id, line] as const));
  const capturedRows = request.lines.map((reference) => ({ reference, line: lineById.get(reference.lineId) ?? null }));
  const result = await dialog.showSaveDialog(window, {
    title: 'Export lnwjud logs',
    defaultPath: `lnwjud-${request.source}-logs.log`,
    filters: [{ name: 'Log file', extensions: ['log'] }, { name: 'Text file', extensions: ['txt'] }],
  });
  if (result.canceled || result.filePath === undefined || result.filePath.length === 0) {
    return { exported: false };
  }
  async function* serializedRows(): AsyncIterable<string> {
    yield formatLogExportHeader(locale, 'Live Logs', request.source, capturedRows.length);
    for (const [index, captured] of capturedRows.entries()) {
      const { reference, line } = captured;
      if (line === null) {
        yield `${formatLogEntryHeading(index + 1)}\r\n${messages.logStatus}: ${messages.logCapturedRowUnavailable}\r\nlineId=${reference.lineId}`;
        continue;
      }
      const readable = [
        formatLogEntryHeading(index + 1),
        `${messages.logTime}: ${formatExportLogTimestamp(line.timestamp, locale)}`,
        `${messages.logLevel}: ${line.level.toUpperCase()}`,
        `${messages.logSource}: ${line.source}`,
        `${messages.logWorkspace}: ${line.workspaceId ?? '-'}`,
        `${messages.logSession}: ${line.sessionId ?? '-'}`,
        `${messages.logMessage}: ${line.text}`,
      ];
      const metadata = [
        `lineId=${line.id}`,
        `source=${line.source}`,
        `level=${line.level}`,
        `workspaceId=${line.workspaceId ?? '<none>'}`,
        `sessionId=${line.sessionId ?? '<none>'}`,
        ...(line.correlation?.kind === 'mcp' ? [
          `callId=${line.correlation.callId}`,
          `toolName=${line.correlation.toolName}`,
          `phase=${line.correlation.phase}`,
          `resultCode=${line.correlation.resultCode ?? '<none>'}`,
        ] : line.correlation?.kind === 'tunnel' ? [
          `lifecycle=${line.correlation.lifecycle ?? '<none>'}`,
          `instanceId=${line.correlation.instanceId ?? '<none>'}`,
          `requestId=${line.correlation.requestId ?? '<none>'}`,
          `pid=${line.correlation.pid ?? '<none>'}`,
        ] : []),
      ];
      const baseWithMetadata = `${readable.join('\r\n')}\r\n\r\n${messages.logTechnical}:\r\n${metadata.map((entry) => `  ${entry}`).join('\r\n')}`;
      const targetDetail = line.targetDetail;
      if (targetDetail?.legacyIncomplete === true && targetDetail.itemCount > targetDetail.preview.length) {
        yield formatIncompleteLegacyHistory(baseWithMetadata);
        continue;
      }
      const authoritativeRef = targetDetail?.detailRef ?? (line.correlation?.kind === 'mcp' ? line.correlation.callId : null);
      const requestedRef = reference.correlationRef === authoritativeRef ? reference.correlationRef : authoritativeRef;
      const detail = requestedRef === null ? null : (await services.resolveActivityTargetDetail(requestedRef)).detail;
      const detailExpected = targetDetail !== undefined && targetDetail.itemCount > targetDetail.preview.length;
      yield formatCompleteTargetDetail(baseWithMetadata, detail, detailExpected, locale);
    }
  }
  await writeSerializedLogRows(result.filePath, serializedRows());
  return { exported: true };
}

async function exportWorkLogToFile(window: BrowserWindow | null, services: DesktopIpcServices, request: ExportWorkLogRequest): Promise<{ readonly exported: boolean }> {
  if (window === null) return { exported: false };
  const locale = request.locale ?? desktopLocale;
  const messages = nativeMessages(locale);
  const result = await dialog.showSaveDialog(window, {
    title: 'Export lnwjud work log',
    defaultPath: 'lnwjud-work-log.log',
    filters: [{ name: 'Log file', extensions: ['log'] }, { name: 'Text file', extensions: ['txt'] }],
  });
  if (result.canceled || result.filePath === undefined || result.filePath.length === 0) return { exported: false };
  async function* serializedRows(): AsyncIterable<string> {
    yield formatLogExportHeader(locale, messages.logWorkLogTitle, 'mcp', request.rowIds.length);
    let index = 0;
    for await (const row of services.streamWorkLogExportRows(request.rowIds, locale)) {
      index += 1;
      yield `${formatLogEntryHeading(index)}\r\n${row}`;
    }
  }
  await writeSerializedLogRows(result.filePath, serializedRows());
  return { exported: true };
}

function formatLogExportHeader(locale: UiLocale, title: string, source: string, rows: number): string {
  const messages = nativeMessages(locale);
  return [
    '============================================================',
    `lnwjud - ${title}`,
    '============================================================',
    `${messages.logExported}: ${formatExportLogTimestamp(new Date().toISOString(), locale)}`,
    `${messages.logSource}: ${source}`,
    `${messages.logRows}: ${rows}`,
    '============================================================',
  ].join('\r\n');
}

function formatLogEntryHeading(index: number): string {
  return `\r\n-------------------- #${index} --------------------`;
}

function formatExportLogTimestamp(value: string, locale: UiLocale): string {
  return formatDisplayDateTime(value, locale, { fallback: value });
}

function broadcastToAllWindows(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

function parseStopProcessRequest(payload: unknown): StopProcessRequest {
  if (!isRecord(payload)) throw new Error('Invalid IPC payload');
  return { processId: nonEmptyString(payload.processId, 'processId') };
}

function parseStartProcessRequest(payload: unknown): StartProcessRequest {
  if (!isRecord(payload)) throw new Error('Invalid IPC payload');
  if (!isNonEmptyString(payload.workspaceId)) throw new Error('Invalid IPC payload: workspaceId');
  if (payload.mode !== 'fixture' && payload.mode !== 'project-dev') throw new Error('Invalid IPC payload: mode');
  return { workspaceId: payload.workspaceId, mode: payload.mode };
}

function parseStartMcpRequest(payload: unknown): StartMcpRequest {
  if (!isRecord(payload) || !isNonEmptyString(payload.workspaceId)) throw new Error('Invalid IPC payload: workspaceId');
  return { workspaceId: payload.workspaceId };
}

function parseSaveTunnelApiKeyRequest(payload: unknown): SaveTunnelApiKeyRequest {
  if (!isRecord(payload)) throw new Error('Invalid IPC payload');
  return { apiKey: nonEmptyString(payload.apiKey, 'apiKey') };
}

function parseSaveRemoteMcpAuthtokenRequest(payload: unknown): SaveRemoteMcpAuthtokenRequest {
  if (!isRecord(payload)) throw new Error('Invalid IPC payload');
  return { authtoken: nonEmptyString(payload.authtoken, 'authtoken') };
}

function parseSetRemoteMcpPublicOriginRequest(payload: unknown): SetRemoteMcpPublicOriginRequest {
  if (!isRecord(payload) || typeof payload.publicOrigin !== 'string' || payload.publicOrigin.length > 2_048) throw new Error('Invalid IPC payload: publicOrigin');
  return { publicOrigin: payload.publicOrigin };
}

function parseSetRemoteMcpTransportRequest(payload: unknown): SetRemoteMcpTransportRequest {
  if (!isRecord(payload) || (payload.transport !== 'ngrok' && payload.transport !== 'cloudflare' && payload.transport !== 'custom' && payload.transport !== 'local')) throw new Error('Invalid IPC payload: transport');
  return { transport: payload.transport };
}

function parseSetTunnelClientPathRequest(payload: unknown): SetTunnelClientPathRequest {
  if (!isRecord(payload) || typeof payload.clientPath !== 'string') throw new Error('Invalid IPC payload: clientPath');
  return { clientPath: payload.clientPath };
}

function parseGetToolCatalogRequest(payload: unknown): GetToolCatalogRequest {
  if (!isRecord(payload) || Object.keys(payload).some((key) => key !== 'locale') || (payload.locale !== 'th' && payload.locale !== 'en')) throw new Error('Invalid tool catalog request');
  return { locale: payload.locale };
}

async function* emptySerializedRows(): AsyncIterable<string> {
  // The fallback service intentionally has no export rows.
}
function parseRecheckToolCatalogRequest(payload: unknown): RecheckToolCatalogRequest {
  if (!isRecord(payload) || Object.keys(payload).some((key) => key !== 'locale' && key !== 'requirementIds') || (payload.locale !== 'th' && payload.locale !== 'en') || !Array.isArray(payload.requirementIds) || payload.requirementIds.length > 128 || payload.requirementIds.some((id: unknown) => typeof id !== 'string' || id.length === 0 || id.length > 128)) throw new Error('Invalid tool catalog recheck request');
  return { locale: payload.locale, requirementIds: payload.requirementIds as string[] };
}
function parseSetToolAvailabilityRequest(payload: unknown): SetToolAvailabilityRequest {
  if (!isRecord(payload) || Object.keys(payload).some((key) => key !== 'locale' && key !== 'name' && key !== 'enabled') || (payload.locale !== 'th' && payload.locale !== 'en') || typeof payload.name !== 'string' || payload.name.trim().length === 0 || payload.name.length > 256 || typeof payload.enabled !== 'boolean') throw new Error('Invalid tool availability request');
  return { locale: payload.locale, name: payload.name.trim(), enabled: payload.enabled };
}
function parseResetToolAvailabilityRequest(payload: unknown): ResetToolAvailabilityRequest {
  if (!isRecord(payload) || Object.keys(payload).some((key) => key !== 'locale' && key !== 'name') || (payload.locale !== 'th' && payload.locale !== 'en') || typeof payload.name !== 'string' || payload.name.trim().length === 0 || payload.name.length > 256) throw new Error('Invalid tool availability reset request');
  return { locale: payload.locale, name: payload.name.trim() };
}
function parseOpenToolSetupTargetRequest(payload: unknown): OpenToolSetupTargetRequest {
  if (!isRecord(payload) || Object.keys(payload).some((key) => key !== 'target') || typeof payload.target !== 'string' || payload.target.length === 0 || payload.target.length > 128) throw new Error('Invalid tool setup target request');
  return { target: payload.target };
}
function parseCopyToolCommandRequest(payload: unknown): CopyToolCommandRequest {
  if (!isRecord(payload) || Object.keys(payload).some((key) => key !== 'commandId') || typeof payload.commandId !== 'string' || payload.commandId.length === 0 || payload.commandId.length > 128) throw new Error('Invalid tool command request');
  return { commandId: payload.commandId };
}

function parseSetLocaleRequest(payload: unknown): SetLocaleRequest {
  if (!isRecord(payload) || (payload.locale !== 'th' && payload.locale !== 'en')) throw new Error('Invalid IPC payload: locale');
  return { locale: payload.locale };
}

function parseSetUserSettingsRequest(payload: unknown): SetUserSettingsRequest {
  if (!isRecord(payload) || !isRecord(payload.settings)) throw new Error('Invalid IPC payload: settings');
  return { settings: parseUserSettings(payload.settings) };
}

function parseGetPonytailPolicyContextRequest(payload: unknown): GetPonytailPolicyContextRequest {
  if (!isRecord(payload) || Object.keys(payload).some((key) => key !== 'workspaceId')) throw new Error('Invalid IPC payload: Ponytail policy context');
  return { workspaceId: nonEmptyString(payload.workspaceId, 'workspaceId').trim() };
}

function parseSetWorkspacePonytailModeRequest(payload: unknown): SetWorkspacePonytailModeRequest {
  if (!isRecord(payload) || Object.keys(payload).some((key) => key !== 'workspaceId' && key !== 'mode')) throw new Error('Invalid IPC payload: Workspace Ponytail mode');
  return { workspaceId: nonEmptyString(payload.workspaceId, 'workspaceId').trim(), mode: ponytailModeOverrideField(payload.mode) };
}

function parseSetGoalPonytailModeRequest(payload: unknown): SetGoalPonytailModeRequest {
  if (!isRecord(payload) || Object.keys(payload).some((key) => key !== 'workspaceId' && key !== 'goalId' && key !== 'expectedRevision' && key !== 'mode')) throw new Error('Invalid IPC payload: Goal Ponytail mode');
  return {
    workspaceId: nonEmptyString(payload.workspaceId, 'workspaceId').trim(),
    goalId: nonEmptyString(payload.goalId, 'goalId').trim(),
    expectedRevision: boundedInteger(payload.expectedRevision, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER),
    mode: ponytailModeOverrideField(payload.mode),
  };
}

function parseUserSettings(record: Record<string, unknown>): UserSettings {
  if (!isRecord(record.customPermission) || !isRecord(record.extensions)) throw new Error('Invalid IPC payload: settings');
  const customPermission = record.customPermission;
  const extensions = record.extensions;
  const extraRaw = extensions.extraMcpServers;
  if (!Array.isArray(extraRaw)) throw new Error('Invalid IPC payload: extraMcpServers');
  return {
    customPermission: {
      read: permissionDecision(customPermission.read, 'customPermission.read'),
      write: permissionDecision(customPermission.write, 'customPermission.write'),
      execute: permissionDecision(customPermission.execute, 'customPermission.execute'),
      dangerous: permissionDecision(customPermission.dangerous, 'customPermission.dangerous'),
      allowedExecutables: stringArray(customPermission.allowedExecutables, 'customPermission.allowedExecutables', 256),
    },
    desktopFullBypassAll: booleanField(record.desktopFullBypassAll, 'desktopFullBypassAll'),
    stdioFullBypassAll: booleanField(record.stdioFullBypassAll, 'stdioFullBypassAll'),
    mcpCallTimeoutMs: boundedInteger(record.mcpCallTimeoutMs, 'mcpCallTimeoutMs', 1_000, 60 * 60_000),
    mcpIdleTimeoutMs: boundedInteger(record.mcpIdleTimeoutMs, 'mcpIdleTimeoutMs', 30_000, 24 * 60 * 60_000),
    processTimeoutMs: boundedInteger(record.processTimeoutMs, 'processTimeoutMs', 1_000, 4 * 60 * 60_000),
    mcpPollWaitSeconds: boundedInteger(record.mcpPollWaitSeconds, 'mcpPollWaitSeconds', MIN_CONFIGURABLE_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS),
    shellSynchronousWaitSeconds: boundedInteger(record.shellSynchronousWaitSeconds, 'shellSynchronousWaitSeconds', MIN_CONFIGURABLE_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS),
    capabilityRoots: stringArray(record.capabilityRoots, 'capabilityRoots', 128),
    pdfProviderPath: typeof record.pdfProviderPath === 'string' ? record.pdfProviderPath.trim() : invalidField('pdfProviderPath'),
    lspCommands: stringRecord(record.lspCommands, 'lspCommands', 32),
    mcpHttpPort: boundedInteger(record.mcpHttpPort, 'mcpHttpPort', 0, 65_535),
    mcpAllowedHostnames: stringArray(record.mcpAllowedHostnames, 'mcpAllowedHostnames', 64).map((hostname, index) => normalizeMcpAllowedHostname(hostname) ?? invalidField(`mcpAllowedHostnames[${index}]`)),
    codexToolsEnabled: booleanField(record.codexToolsEnabled, 'codexToolsEnabled'),
    eccEnabled: record.eccEnabled === undefined ? false : booleanField(record.eccEnabled, 'eccEnabled'),
    ponytailMode: ponytailModeField(record.ponytailMode),
    ...(record.engineeringHarness === undefined ? {} : { engineeringHarness: engineeringHarnessSettingsField(record.engineeringHarness) }),
    ...(record.engineeringHarnessWorkspaceOverrides === undefined ? {} : { engineeringHarnessWorkspaceOverrides: engineeringHarnessWorkspaceOverridesField(record.engineeringHarnessWorkspaceOverrides) }),
    ...(record.engineeringHarnessDiagnostic === undefined ? {} : { engineeringHarnessDiagnostic: engineeringHarnessDiagnosticField(record.engineeringHarnessDiagnostic) }),
    updateAutoCheck: booleanField(record.updateAutoCheck, 'updateAutoCheck'),
    updateCheckOnStartup: booleanField(record.updateCheckOnStartup, 'updateCheckOnStartup'),
    updateIntervalMinutes: boundedInteger(record.updateIntervalMinutes, 'updateIntervalMinutes', 5, 24 * 60),
    updateAutoDownload: booleanField(record.updateAutoDownload, 'updateAutoDownload'),
    closeBehavior: record.closeBehavior === 'tray' || record.closeBehavior === 'quit' ? record.closeBehavior : invalidField('closeBehavior'),
    launchAtStartup: booleanField(record.launchAtStartup, 'launchAtStartup'),
    startMinimized: booleanField(record.startMinimized, 'startMinimized'),
    tunnelAutoReconnect: booleanField(record.tunnelAutoReconnect, 'tunnelAutoReconnect'),
    tunnelMaxAutoRestarts: boundedInteger(record.tunnelMaxAutoRestarts, 'tunnelMaxAutoRestarts', 0, 50),
    recoveryRetentionDays: boundedInteger(record.recoveryRetentionDays, 'recoveryRetentionDays', 0, 3650),
    extensions: {
      mode: extensions.mode === 'allowlist' || extensions.mode === 'enable_all' ? extensions.mode : invalidField('extensions.mode'),
      disabledServers: stringArray(extensions.disabledServers, 'extensions.disabledServers', 256),
      enabledServers: stringArray(extensions.enabledServers, 'extensions.enabledServers', 256),
      disabledSkillRoots: stringArray(extensions.disabledSkillRoots, 'extensions.disabledSkillRoots', 256),
      extraSkillRoots: stringArray(extensions.extraSkillRoots, 'extensions.extraSkillRoots', 256),
      extraMcpServers: extraRaw.map((entry, index) => {
        if (!isRecord(entry)) throw new Error(`Invalid IPC payload: extraMcpServers[${index}]`);
        return {
          name: nonEmptyString(entry.name, `extraMcpServers[${index}].name`).trim(),
          command: nonEmptyString(entry.command, `extraMcpServers[${index}].command`).trim(),
          args: stringArray(entry.args, `extraMcpServers[${index}].args`, 128),
          cwd: typeof entry.cwd === 'string' ? entry.cwd.trim() : invalidField(`extraMcpServers[${index}].cwd`),
          type: typeof entry.type === 'string' ? entry.type.trim().slice(0, 128) : invalidField(`extraMcpServers[${index}].type`),
          env: stringRecord(entry.env, `extraMcpServers[${index}].env`, 128),
        };
      }),
    },
  };
}

function parseConfigureTunnelProfileRequest(payload: unknown): ConfigureTunnelProfileRequest {
  if (!isRecord(payload)) throw new Error('Invalid IPC payload');
  return { tunnelId: nonEmptyString(payload.tunnelId, 'tunnelId').trim() };
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`Invalid IPC payload: ${field}`);
  return value as number;
}

function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid IPC payload: ${field}`);
  return value;
}

function permissionDecision(value: unknown, field: string): 'ALLOW' | 'ASK' | 'DENY' {
  if (value === 'ALLOW' || value === 'ASK' || value === 'DENY') return value;
  throw new Error(`Invalid IPC payload: ${field}`);
}

function ponytailModeField(value: unknown): 'off' | 'lite' | 'full' | 'ultra' {
  if (value === 'off' || value === 'lite' || value === 'full' || value === 'ultra') return value;
  throw new Error('Invalid IPC payload: ponytailMode');
}

function engineeringHarnessSettingsField(value: unknown): NonNullable<UserSettings['engineeringHarness']> {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !['schemaVersion', 'enabled', 'profile', 'applyTo', 'autoProjectAssessment', 'custom'].includes(key))
    || value.schemaVersion !== 1
    || typeof value.enabled !== 'boolean'
    || (value.profile !== 'standard' && value.profile !== 'senior' && value.profile !== 'strict' && value.profile !== 'custom')
    || (value.applyTo !== 'coding_projects' && value.applyTo !== 'all_workspaces')
    || typeof value.autoProjectAssessment !== 'boolean') throw new Error('Invalid IPC payload: engineeringHarness');
  const custom = value.custom;
  if (custom !== undefined && (!isRecord(custom)
    || Object.keys(custom).some((key) => !['analysis', 'review', 'validation', 'docsImpactCheck'].includes(key))
    || (custom.analysis !== 'focused' && custom.analysis !== 'cross_file')
    || (custom.review !== 'risk_based' && custom.review !== 'always')
    || (custom.validation !== 'risk_based' && custom.validation !== 'strict')
    || typeof custom.docsImpactCheck !== 'boolean')) throw new Error('Invalid IPC payload: engineeringHarness.custom');
  return {
    schemaVersion: 1,
    enabled: value.enabled,
    profile: value.profile,
    applyTo: value.applyTo,
    autoProjectAssessment: value.autoProjectAssessment,
    ...(custom === undefined ? {} : { custom: {
      analysis: custom.analysis as 'focused' | 'cross_file',
      review: custom.review as 'risk_based' | 'always',
      validation: custom.validation as 'risk_based' | 'strict',
      docsImpactCheck: custom.docsImpactCheck as boolean,
    } }),
  };
}

function engineeringHarnessWorkspaceOverridesField(value: unknown): NonNullable<UserSettings['engineeringHarnessWorkspaceOverrides']> {
  if (!isRecord(value) || Object.keys(value).length > 256) throw new Error('Invalid IPC payload: engineeringHarnessWorkspaceOverrides');
  const result: Record<string, { readonly mode: 'on' | 'off'; readonly profile?: 'standard' | 'senior' | 'strict' | 'custom' }> = {};
  for (const [workspaceId, entry] of Object.entries(value)) {
    if (workspaceId.trim().length === 0 || workspaceId.length > 128 || !isRecord(entry)
      || (entry.mode !== 'on' && entry.mode !== 'off')
      || Object.keys(entry).some((key) => key !== 'mode' && key !== 'profile')
      || (entry.profile !== undefined && entry.profile !== 'standard' && entry.profile !== 'senior' && entry.profile !== 'strict' && entry.profile !== 'custom')) {
      throw new Error('Invalid IPC payload: engineeringHarnessWorkspaceOverrides');
    }
    result[workspaceId] = { mode: entry.mode, ...(entry.profile === undefined ? {} : { profile: entry.profile }) };
  }
  return result;
}

function engineeringHarnessDiagnosticField(value: unknown): Exclude<UserSettings['engineeringHarnessDiagnostic'], undefined> {
  if (value === null) return null;
  if (value === 'invalid_json' || value === 'invalid_shape' || value === 'unsupported_schema_version') return value;
  throw new Error('Invalid IPC payload: engineeringHarnessDiagnostic');
}

function ponytailModeOverrideField(value: unknown): 'inherit' | 'off' | 'lite' | 'full' | 'ultra' {
  if (value === 'inherit' || value === 'off' || value === 'lite' || value === 'full' || value === 'ultra') return value;
  throw new Error('Invalid IPC payload: scoped Ponytail mode');
}

function stringArray(value: unknown, field: string, maxItems: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems || !value.every((entry) => typeof entry === 'string' && entry.length <= 4096)) {
    throw new Error(`Invalid IPC payload: ${field}`);
  }
  return [...new Set(value.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

function stringRecord(value: unknown, field: string, maxItems: number): Readonly<Record<string, string>> {
  if (!isRecord(value) || Object.keys(value).length > maxItems) throw new Error(`Invalid IPC payload: ${field}`);
  const entries: Array<[string, string]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (key.trim().length === 0 || key.length > 256 || typeof entry !== 'string' || entry.length > 16_384) throw new Error(`Invalid IPC payload: ${field}`);
    entries.push([key.trim(), entry]);
  }
  return Object.fromEntries(entries);
}

function invalidField(field: string): never {
  throw new Error(`Invalid IPC payload: ${field}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`Invalid IPC payload: ${field}`);
  return value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPermissionProfile(value: unknown): value is PermissionProfileName {
  return value === 'safe' || value === 'balanced' || value === 'full' || value === 'custom';
}

let mainWindow: BrowserWindow | null = null;
let logViewerWindow: BrowserWindow | null = null;
interface PendingMutationApproval {
  readonly prompt: MutationApprovalPrompt;
  readonly complete: (approved: boolean) => void;
}
const pendingMutationApprovals = new Map<number, PendingMutationApproval>();
let mutationApprovalQueue: Promise<void> = Promise.resolve();
let desktopRuntime: DesktopRuntime | null = null;
let tray: Tray | null = null;
let desktopLocale: UiLocale = 'th';
let desktopUserSettings: UserSettings = defaultUserSettings;
let autoUpdaterInitialized = false;
let quitRequested = false;
let factoryResetQueued = false;
const desktopIpcDrainBarrier = new DesktopIpcDrainBarrier();
let desktopShutdownCoordinator: DesktopShutdownCoordinator | null = null;
let updateInstallCoordinator: UpdateInstallCoordinator | null = null;
let updateInstallConfirmationPending = false;
let updateCheckScheduler: UpdateCheckScheduler | null = null;
let pendingUpdateCheckSource: 'automatic' | 'tray' | 'renderer' | null = null;
const windowsDistribution = detectWindowsDistribution(app.isPackaged);
const updaterDistribution = detectUpdaterDistribution(app.isPackaged, process.platform, process.env);
const platformCompatibility = platformCompatibilityProfile(process.platform, os.release(), process.arch);
let pendingPortableUpdate: { readonly version: string; readonly downloadedFile: string } | null = null;
let crashDiagnostics: CrashDiagnosticsRecorder | null = null;
let desktopSessionDiagnostics: DesktopSessionDiagnostics | null = null;
let runtimeDiagnosticsHistory: RuntimeDiagnosticsHistoryRecorder | null = null;
const rendererRecoveryPolicy = new RendererRecoveryPolicy();
const rendererRecoveryBarrier = new RendererRecoveryBarrier();
let crashRecoveryConfigured = false;
const installActivity = new InstallActivityCoordinator((snapshot) => broadcastToAllWindows(pushChannels.installActivity, snapshot));

let currentUpdateStatus: UpdateStatus = {
  phase: app.isPackaged ? 'idle' : 'unavailable',
  currentVersion: APP_VERSION,
  availableVersion: null,
  progressPercent: null,
  lastCheckedAt: null,
  message: app.isPackaged ? null : nativeMessages(desktopLocale).updaterUnavailablePackagedOnly,
  canInstall: false,
};

function requestMutationApproval(request: HostMutationApprovalRequest): Promise<boolean> {
  const queued = mutationApprovalQueue.then(() => showMutationApprovalPrompt(request));
  mutationApprovalQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

function showMutationApprovalPrompt(request: HostMutationApprovalRequest): Promise<boolean> {
  const options = mutationApprovalDialogOptions(desktopLocale, request);
  const parent = mainWindow !== null && !mainWindow.isDestroyed()
    ? mainWindow
    : logViewerWindow !== null && !logViewerWindow.isDestroyed()
      ? logViewerWindow
      : null;
  const promptWindow = createMutationApprovalWindow(parent, options.title);
  const senderId = promptWindow.webContents.id;
  const prompt: MutationApprovalPrompt = {
    title: options.title,
    message: options.message,
    detail: options.detail,
    buttons: options.buttons,
  };

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const complete = (approved: boolean, closeWindow = true): void => {
      if (settled) return;
      settled = true;
      pendingMutationApprovals.delete(senderId);
      resolve(approved);
      if (closeWindow && !promptWindow.isDestroyed()) promptWindow.close();
    };

    pendingMutationApprovals.set(senderId, { prompt, complete });
    promptWindow.once('closed', () => complete(false, false));
    promptWindow.webContents.once('did-fail-load', () => complete(false));
    void promptWindow.loadFile(getRendererEntryPath(), { hash: 'mutation-approval' }).catch(() => complete(false));
  });
}

function openLogViewerWindow(): BrowserWindow | null {
  if (logViewerWindow !== null && !logViewerWindow.isDestroyed()) {
    if (logViewerWindow.isMinimized()) logViewerWindow.restore();
    logViewerWindow.show();
    logViewerWindow.focus();
    return logViewerWindow;
  }
  const viewer = createLogViewerWindow();
  logViewerWindow = viewer;
  viewer.on('closed', () => {
    logViewerWindow = null;
  });
  return viewer;
}

function createDesktopWindow(forceShow = false): void {
  mainWindow = createMainWindow(forceShow || !desktopUserSettings.startMinimized);
  mainWindow.on('close', (event) => {
    const hideToTray = shouldHideMainWindowOnClose(quitRequested, desktopUserSettings.closeBehavior);
    crashDiagnostics?.record({
      type: 'desktop-lifecycle',
      processType: 'main',
      reason: `main-window:close:${hideToTray ? 'hide-to-tray' : quitRequested ? 'quit-requested' : 'window-close'}`,
    });
    if (!hideToTray) return;
    event.preventDefault();
    if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.hide();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function revealMainWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    createDesktopWindow(true);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function publishUpdateStatus(next: UpdateStatus): UpdateStatus {
  currentUpdateStatus = next;
  syncUpdateInstallActivity(next);
  broadcastToAllWindows(pushChannels.updateStatus, next);
  refreshDesktopTrayMenu();
  return next;
}

function syncUpdateInstallActivity(status: UpdateStatus): void {
  if (status.phase === 'downloading') {
    installActivity.set({ kind: 'app_update', phase: 'downloading', progressPercent: status.progressPercent, message: status.message });
    return;
  }
  if (status.phase === 'installing') {
    installActivity.set({ kind: 'app_update', phase: 'installing', progressPercent: null, message: status.message });
    return;
  }
  installActivity.clear('app_update');
}

function patchUpdateStatus(patch: Partial<UpdateStatus>): UpdateStatus {
  return publishUpdateStatus({ ...currentUpdateStatus, ...patch });
}

function refreshDesktopTrayMenu(): void {
  if (tray === null) return;
  tray.setContextMenu(Menu.buildFromTemplate(createTrayMenuTemplate({
    locale: desktopLocale,
    openMainWindow: revealMainWindow,
    checkForUpdates: checkForUpdatesFromTray,
    updateLabel: createTrayUpdateLabel(currentUpdateStatus, desktopLocale),
    quit: (): void => { app.quit(); },
  })));
}

async function requestFactoryReset(dataPath: string): Promise<{ readonly accepted: boolean }> {
  if (factoryResetQueued) return { accepted: true };
  const messages = nativeMessages(desktopLocale);
  const confirmation = await dialog.showMessageBox({
    type: 'warning',
    title: messages.factoryResetTitle,
    message: messages.factoryResetMessage,
    detail: messages.factoryResetDetail,
    buttons: [messages.factoryResetConfirm, messages.cancel],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (confirmation.response !== 0) return { accepted: false };

  stageFactoryResetSync(dataPath);
  factoryResetQueued = true;
  setTimeout(() => {
    const relaunch = (): void => {
      const bootstrapUserDataPath = factoryResetBootstrapUserDataPath(dataPath);
      const args = process.argv.slice(1).filter((argument) =>
        argument !== FACTORY_RESET_APPLY_ARG && !argument.startsWith('--user-data-dir='));
      app.relaunch({ args: [...args, `--user-data-dir=${bootstrapUserDataPath}`, FACTORY_RESET_APPLY_ARG] });
      app.exit(0);
    };
    const coordinator = desktopShutdownCoordinator;
    if (coordinator === null) {
      relaunch();
      return;
    }
    quitRequested = true;
    void coordinator.requestQuit(relaunch).then((result) => {
      if (result !== 'deferred') return;
      factoryResetQueued = false;
      try { clearFactoryResetStageSync(dataPath); } catch (error: unknown) {
        console.error(`Factory reset marker cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }).catch((error: unknown) => {
      factoryResetQueued = false;
      try { clearFactoryResetStageSync(dataPath); } catch { /* Keep the original reset error as the primary diagnostic. */ }
      console.error(`Factory reset shutdown failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    });
  }, 0);
  return { accepted: true };
}

function requestUpdateCheck(source: 'automatic' | 'tray' | 'renderer'): UpdateStatus {
  const messages = nativeMessages(desktopLocale);
  if (!app.isPackaged) {
    const status = patchUpdateStatus({ phase: 'unavailable', message: messages.updaterUnavailable, canInstall: false });
    if (source === 'tray') {
      void dialog.showMessageBox({ type: 'info', title: messages.updaterCheckTitle, message: boundedNativeDialogText(status.message ?? messages.updaterUnavailablePackagedOnly), buttons: [messages.ok] });
    }
    return status;
  }
  if (currentUpdateStatus.phase === 'available') {
    if (source !== 'automatic' && !desktopUserSettings.updateAutoDownload) {
      const status = patchUpdateStatus({
        phase: 'downloading',
        progressPercent: 0,
        message: nativeMessages(desktopLocale).updateDownloadingStatus(currentUpdateStatus.availableVersion, 0),
        canInstall: false,
      });
      void autoUpdater.downloadUpdate().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : nativeMessages(desktopLocale).updaterCheckFailed;
        patchUpdateStatus({ phase: 'error', message, canInstall: false });
        if (source === 'tray') {
          const currentMessages = nativeMessages(desktopLocale);
          void dialog.showMessageBox({ type: 'error', title: currentMessages.updaterCheckTitle, message: boundedNativeDialogText(message), buttons: [currentMessages.ok] });
        }
      });
      return status;
    }
    return currentUpdateStatus;
  }
  if (currentUpdateStatus.phase === 'downloading' || currentUpdateStatus.phase === 'ready' || currentUpdateStatus.phase === 'installing') return currentUpdateStatus;
  if (pendingUpdateCheckSource !== null || currentUpdateStatus.phase === 'checking') {
    if (source === 'tray') {
      void dialog.showMessageBox({ type: 'info', title: messages.updaterCheckTitle, message: messages.updaterAlreadyChecking, buttons: [messages.ok] });
    }
    return currentUpdateStatus;
  }
  pendingUpdateCheckSource = source;
  const status = patchUpdateStatus({ phase: 'checking', progressPercent: null, message: messages.updaterChecking, canInstall: false });
  void autoUpdater.checkForUpdates().catch((error: unknown) => {
    if (pendingUpdateCheckSource !== source) return;
    pendingUpdateCheckSource = null;
    const message = error instanceof Error ? error.message : nativeMessages(desktopLocale).updaterCheckFailed;
    console.error(`[AutoUpdater] ${source} check failed: ${message}`);
    patchUpdateStatus({ phase: 'error', lastCheckedAt: new Date().toISOString(), message, canInstall: false });
    if (source === 'tray') {
      const currentMessages = nativeMessages(desktopLocale);
      void dialog.showMessageBox({ type: 'error', title: currentMessages.updaterCheckTitle, message: boundedNativeDialogText(message), buttons: [currentMessages.ok] });
    }
  });
  return status;
}

const MAX_NATIVE_DIALOG_TEXT_LENGTH = 640;
const MAX_NATIVE_DIALOG_LINE_COUNT = 4;
const MAX_NATIVE_DIALOG_LINE_LENGTH = 120;

function boundedNativeDialogText(text: string): string {
  const lines = text.split(/\r\n?|\n|\u2028|\u2029/);
  const boundedLines = lines.slice(0, MAX_NATIVE_DIALOG_LINE_COUNT).map((line) => line.slice(0, MAX_NATIVE_DIALOG_LINE_LENGTH));
  let bounded = boundedLines.join('\n');
  const truncated = lines.length > MAX_NATIVE_DIALOG_LINE_COUNT
    || lines.some((line) => line.length > MAX_NATIVE_DIALOG_LINE_LENGTH)
    || bounded.length > MAX_NATIVE_DIALOG_TEXT_LENGTH;
  if (!truncated) return text;
  bounded = bounded.slice(0, MAX_NATIVE_DIALOG_TEXT_LENGTH - 1).trimEnd();
  return `${bounded}…`;
}

async function requestUpdateInstall(): Promise<{ readonly accepted: boolean; readonly status: UpdateStatus }> {
  if (!app.isPackaged || currentUpdateStatus.phase !== 'ready' || updateInstallCoordinator === null || updateInstallConfirmationPending) {
    return { accepted: false, status: currentUpdateStatus };
  }
  const runtime = desktopRuntime;
  if (runtime === null) return { accepted: false, status: currentUpdateStatus };

  updateInstallConfirmationPending = true;
  try {
    const approved = await confirmTunnelStopForUpdate({
      getTunnelStatus: () => runtime.services.getTunnelStatus(),
      confirmStop: async (): Promise<boolean> => {
        const messages = nativeMessages(desktopLocale);
        const options = {
          type: 'warning' as const,
          title: messages.updaterTunnelStopTitle,
          message: messages.updaterTunnelStopMessage,
          detail: messages.updaterTunnelStopDetail,
          buttons: [messages.updaterTunnelStopConfirm, messages.cancel],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        };
        const parent = mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : null;
        const result = parent === null
          ? await dialog.showMessageBox(options)
          : await dialog.showMessageBox(parent, options);
        return result.response === 0;
      },
    });
    if (!approved) return { accepted: false, status: currentUpdateStatus };

    const tunnelStopped = await stopTunnelForUpdateInstall(runtime);
    if (!tunnelStopped) return { accepted: false, status: currentUpdateStatus };

    const status = patchUpdateStatus({
      phase: 'installing',
      message: nativeMessages(desktopLocale).updaterInstallWaiting,
      canInstall: false,
    });
    updateInstallCoordinator.requestInstall();
    return { accepted: true, status };
  } finally {
    updateInstallConfirmationPending = false;
  }
}

async function stopTunnelForUpdateInstall(runtime: DesktopRuntime): Promise<boolean> {
  try {
    const status = await runtime.services.stopTunnel();
    if (status.state !== 'stopped' || updateInstallNeedsTunnelStopConfirmation(status)) {
      throw new Error(status.message ?? 'Secure Tunnel did not reach the stopped state');
    }
    return true;
  } catch (error: unknown) {
    const messages = nativeMessages(desktopLocale);
    const detail = error instanceof Error ? error.message : messages.updaterTunnelStopFailedMessage;
    patchUpdateStatus({
      phase: 'ready',
      message: messages.updaterTunnelStopFailedMessage,
      canInstall: true,
    });
    void dialog.showMessageBox({
      type: 'error',
      title: messages.updaterTunnelStopFailedTitle,
      message: messages.updaterTunnelStopFailedMessage,
      detail: boundedNativeDialogText(detail),
      buttons: [messages.ok],
    });
    return false;
  }
}

function checkForUpdatesFromTray(): void {
  if (currentUpdateStatus.phase === 'ready') {
    void requestUpdateInstall();
    revealMainWindow();
    return;
  }
  requestUpdateCheck('tray');
}

function setDesktopLocale(locale: UiLocale): void {
  desktopLocale = locale;
  if (tray !== null) tray.setToolTip(createTrayToolTip(locale));
  const localizedMessage = localizedUpdateStatusMessage(currentUpdateStatus, locale);
  if (localizedMessage !== currentUpdateStatus.message) {
    publishUpdateStatus({ ...currentUpdateStatus, message: localizedMessage });
  } else {
    refreshDesktopTrayMenu();
  }
}

function createDesktopTray(): void {
  const iconPath = getTrayIconPath();
  if (iconPath === undefined) {
    console.error('lnwjud tray icon was not found');
    return;
  }
  const sourceImage = nativeImage.createFromPath(iconPath);
  if (sourceImage.isEmpty()) {
    console.error(`lnwjud tray icon could not be loaded: ${iconPath}`);
    return;
  }
  const trayImage = process.platform === 'darwin'
    ? sourceImage.resize({ width: 18, height: 18, quality: 'best' })
    : sourceImage;
  if (process.platform === 'darwin') {
    // macOS menu-bar icons are template images: AppKit derives the correct
    // light/dark appearance from the alpha mask instead of rendering the
    // full-color application artwork directly.
    trayImage.setTemplateImage(true);
  }
  tray?.destroy();
  tray = new Tray(trayImage);
  tray.setToolTip(createTrayToolTip(desktopLocale));
  refreshDesktopTrayMenu();
  tray.on('click', revealMainWindow);
}

function destroyDesktopTray(): void {
  tray?.destroy();
  tray = null;
}

function readArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function redirectConsoleToStderr(): void {
  const write = (stream: NodeJS.WriteStream, args: unknown[]): void => {
    stream.write(`${args.map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry)).join(' ')}\n`);
  };
  console.log = (...args: unknown[]): void => write(process.stderr, args);
  console.info = (...args: unknown[]): void => write(process.stderr, args);
  console.warn = (...args: unknown[]): void => write(process.stderr, args);
  console.error = (...args: unknown[]): void => write(process.stderr, args);
}

function bootstrapMcpStdio(): void {
  redirectConsoleToStderr();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  const dataPath = configureDataPath();
  void app.whenReady().then(async () => {
    assertSupportedPlatform();
    prependBundledRuntimeToolsToPath();
    const secrets = await resolveDesktopRuntimeSecrets(dataPath);
    const runtime = createDesktopRuntime(dataPath, {
      permissionProfile: 'full',
      hostMutationApprovalProvider: requestMutationApproval,
      nativeCapabilityApi: createElectronNativeCapabilityApi(() => null),
      eccRuntimeOptions: resolveDesktopEccRuntimeOptions(),
      ...secrets,
      watchToolAvailability: true,
    });
    desktopRuntime = runtime;
    const workspacePath = readArgValue('--workspace')
      ?? process.env.LNWJUD_WORKSPACE
      ?? process.cwd();
    try {
      const workspaceId = await runtime.ensureDefaultWorkspace(workspacePath);
      process.stderr.write(`lnwjud MCP stdio ready workspace=${workspaceId}\n`);
    } catch (error: unknown) {
      process.stderr.write(`lnwjud MCP stdio workspace warning: ${error instanceof Error ? error.message : 'unknown'}\n`);
    }
    startMcpStdio({
      services: runtime.mcpServices,
      actor: runtime.mcpActor,
      activityTracker: runtime.activityTracker,
      destructivePolicyProvider: () => runtime.getDestructivePolicy(),
      activeWorkspaceScopeProvider: () => runtime.getActiveWorkspaceScope(),
      activeWorkspaceScopesProvider: () => runtime.getActiveWorkspaceScopes(),
      hostMutationApprovalProvider: requestMutationApproval,
      codexToolsEnabledProvider: () => runtime.getUserSettings().codexToolsEnabled,
      ponytailModeProvider: () => runtime.getUserSettings().ponytailMode,
      engineeringHarnessEnabledProvider: (): boolean => {
        const settings = runtime.getUserSettings();
        return settings.engineeringHarness?.enabled === true
          || Object.values(settings.engineeringHarnessWorkspaceOverrides ?? {}).some((entry) => entry.mode === 'on');
      },
      toolAvailabilitySnapshotProvider: () => runtime.toolAvailabilityService.snapshot(),
      toolAvailabilitySubscribe: (listener) => runtime.toolAvailabilityService.subscribe(listener),
      onError: (error): void => {
        if (/EPIPE|ECONNRESET|broken pipe/i.test(error.message)) {
          process.stderr.write(`lnwjud MCP stdio: peer closed (${error.message})\n`);
          void desktopRuntime?.close().finally(() => process.exit(0));
          return;
        }
        process.stderr.write(`lnwjud MCP stdio error: ${error.message}\n`);
      },
    });
    process.stdin.on('end', () => {
      void desktopRuntime?.close().finally(() => process.exit(0));
    });
    process.stdin.on('close', () => {
      void desktopRuntime?.close().finally(() => process.exit(0));
    });
    process.stdout.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE' || error.code === 'ECONNRESET') {
        void desktopRuntime?.close().finally(() => process.exit(0));
      }
    });
  }).catch((error: unknown) => {
    process.stderr.write(`lnwjud MCP stdio startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    app.quit();
  });
  app.on('window-all-closed', () => {
    // Keep the stdio MCP process alive without a BrowserWindow.
  });
  app.on('before-quit', () => {
    void desktopRuntime?.close();
  });
}

function applyDesktopUserSettings(settings: UserSettings): void {
  desktopUserSettings = settings;
  if ((process.platform === 'win32' || process.platform === 'darwin') && app.isPackaged) {
    try {
      app.setLoginItemSettings({
        openAtLogin: settings.launchAtStartup,
        path: process.execPath,
        ...(process.platform === 'darwin' ? { openAsHidden: settings.startMinimized } : {}),
      });
    } catch (error: unknown) {
      console.error(`Could not update ${process.platform} startup setting: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  if (process.platform === 'linux' && app.isPackaged) {
    void configureLinuxAutostart({ executablePath: process.execPath, enabled: settings.launchAtStartup }).catch((error: unknown) => {
      console.error(`Could not update Linux startup setting: ${error instanceof Error ? error.message : 'unknown error'}`);
    });
  }
  if (autoUpdaterInitialized) {
    autoUpdater.autoDownload = settings.updateAutoDownload;
    configureUpdateCheckSchedule();
  }
}

function configureUpdateCheckSchedule(): void {
  updateCheckScheduler?.stop();
  updateCheckScheduler = null;
  if (!app.isPackaged || !desktopUserSettings.updateAutoCheck) return;
  updateCheckScheduler = new UpdateCheckScheduler({
    check: (): void => { requestUpdateCheck('automatic'); },
    checkOnStartup: desktopUserSettings.updateCheckOnStartup,
    intervalMs: desktopUserSettings.updateIntervalMinutes * 60_000,
  });
  updateCheckScheduler.start();
}

function initAutoUpdater(runtime: DesktopRuntime): void {
  if (!app.isPackaged) {
    patchUpdateStatus({ phase: 'unavailable', message: nativeMessages(desktopLocale).updaterUnavailablePackagedOnly, canInstall: false });
    return;
  }
  if (updaterDistribution === 'unsupported') {
    patchUpdateStatus({ phase: 'unavailable', message: nativeMessages(desktopLocale).updaterUnavailablePlatform, canInstall: false });
    return;
  }
  try {
    configureUpdaterForDistribution(autoUpdater, windowsDistribution);
    configureUpdaterForPlatform(autoUpdater, updaterDistribution);
    autoUpdater.autoDownload = desktopUserSettings.updateAutoDownload;
    autoUpdater.autoInstallOnAppQuit = false;
    updateInstallCoordinator = new UpdateInstallCoordinator({
      activeCallCount: (): number => runtime.activityTracker.listInFlight().length,
      activityRevision: (): number => runtime.activityTracker.revision(),
      tunnelRunning: async (): Promise<boolean | 'unverifiable'> => {
        try {
          if ((await runtime.services.getTunnelStatus()).state === 'running') return true;
          try {
            await access(path.join(resolveTunnelProfileDirectory(), 'lnwjud.tunnel.lock'));
            return true;
          } catch (error: unknown) {
            return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : 'unverifiable';
          }
        } catch {
          return 'unverifiable';
        }
      },
      sharedActivitySnapshot: async (): Promise<UpdateSharedActivitySnapshot> => {
        const snapshot = await readSharedActivitySnapshot({ profileDirectory: resolveTunnelProfileDirectory() });
        return snapshot.state === 'available'
          ? { state: 'available', activeCallCount: snapshot.activeCount, revision: snapshot.revision, ownerKey: snapshot.ownerKey }
          : { state: snapshot.state, reason: snapshot.reason };
      },
      maxWaitMs: 5_000,
      install: (): void => {
        void stopTunnelForUpdateInstall(runtime).then((tunnelStopped) => {
          if (!tunnelStopped) return;
          void runtime.createBackup('pre-update').catch((error: unknown) => {
            console.error(`Pre-update backup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
          }).finally(() => {
            if (usesElectronUpdaterInstall(updaterDistribution)) {
              void desktopShutdownCoordinator?.requestQuit(() => autoUpdater.quitAndInstall(), 'install');
              return;
            }
            const portableUpdate = pendingPortableUpdate;
            if (portableUpdate === null) {
              patchUpdateStatus({ phase: 'error', message: 'Portable update file is unavailable. Check for updates again.', canInstall: false });
              return;
            }
            void preparePortableReplacement({
              downloadedFile: portableUpdate.downloadedFile,
              currentExecutablePath: currentPortableExecutablePath(),
            }).then((prepared) => {
              void desktopShutdownCoordinator?.requestQuit(() => {
                launchPortableReplacement(prepared);
                app.quit();
              }, 'install');
            }).catch((error: unknown) => {
              const message = error instanceof Error ? error.message : 'Portable update could not be prepared.';
              console.error(`[AutoUpdater] portable install preparation failed: ${message}`);
              patchUpdateStatus({ phase: 'error', message, canInstall: false });
            });
          });
        });
      },
    });

    autoUpdater.on('checking-for-update', () => {
      recordUpdaterEvent('checking-for-update');
      console.log('[AutoUpdater] Checking for updates on GitHub...');
      patchUpdateStatus({ phase: 'checking', progressPercent: null, message: nativeMessages(desktopLocale).updaterChecking, canInstall: false });
    });

    autoUpdater.on('update-available', (info) => {
      recordUpdaterEvent(`update-available:${info.version}`);
      const requestedFromTray = pendingUpdateCheckSource === 'tray';
      pendingUpdateCheckSource = null;
      pendingPortableUpdate = null;
      console.log(`[AutoUpdater] Update available: v${info.version}`);
      const messages = nativeMessages(desktopLocale);
      patchUpdateStatus({
        phase: 'available',
        availableVersion: info.version,
        progressPercent: 0,
        lastCheckedAt: new Date().toISOString(),
        message: messages.updateAvailableStatus(info.version),
        canInstall: false,
      });
      if (requestedFromTray) {
        void dialog.showMessageBox({
          type: 'info',
          title: messages.updaterAvailableTitle,
          message: boundedNativeDialogText(messages.updateAvailableDialog(info.version)),
          buttons: [messages.ok],
        });
      }
      broadcastToAllWindows(pushChannels.logEvent, {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        level: 'info',
        source: 'process',
        text: `[AutoUpdater] Version v${info.version} is available and downloading in background...`,
      });
    });

    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.max(0, Math.min(100, progress.percent));
      patchUpdateStatus({
        phase: 'downloading',
        progressPercent: percent,
        message: nativeMessages(desktopLocale).updateDownloadingStatus(currentUpdateStatus.availableVersion, percent),
        canInstall: false,
      });
    });

    autoUpdater.on('update-not-available', (info) => {
      recordUpdaterEvent(`update-not-available:${info.version}`);
      const requestedFromTray = pendingUpdateCheckSource === 'tray';
      pendingUpdateCheckSource = null;
      const messages = nativeMessages(desktopLocale);
      patchUpdateStatus({
        phase: 'up-to-date',
        availableVersion: null,
        progressPercent: null,
        lastCheckedAt: new Date().toISOString(),
        message: messages.updateCurrentStatus(info.version),
        canInstall: false,
      });
      if (!requestedFromTray) return;
      void dialog.showMessageBox({
        type: 'info',
        title: messages.updaterCheckTitle,
        message: boundedNativeDialogText(messages.updateCurrentDialog(info.version)),
        buttons: [messages.ok],
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      recordUpdaterDownload(info.version);
      if (windowsDistribution === 'portable') {
        pendingPortableUpdate = { version: info.version, downloadedFile: info.downloadedFile };
      }
      patchUpdateStatus({
        phase: 'ready',
        availableVersion: info.version,
        progressPercent: 100,
        message: nativeMessages(desktopLocale).updateReadyStatus(info.version),
        canInstall: true,
      });
      console.log(`[AutoUpdater] Downloaded update: v${info.version}; waiting for user action.`);
      broadcastToAllWindows(pushChannels.logEvent, {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        level: 'info',
        source: 'process',
        text: `[AutoUpdater] Update v${info.version} downloaded! Click the version badge to install.`,
      });
    });

    autoUpdater.on('error', (err) => {
      const requestedFromTray = pendingUpdateCheckSource === 'tray';
      pendingUpdateCheckSource = null;
      recordUpdaterEvent(`error:${err.message}`);
      console.error('[AutoUpdater] error:', err.message);
      const messages = nativeMessages(desktopLocale);
      const message = err.message || messages.updaterCheckFailed;
      patchUpdateStatus({
        phase: 'error',
        lastCheckedAt: new Date().toISOString(),
        message,
        canInstall: false,
      });
      if (!requestedFromTray) return;
      void dialog.showMessageBox({
        type: 'error',
        title: messages.updaterCheckTitle,
        message: boundedNativeDialogText(message),
        buttons: [messages.ok],
      });
    });

    autoUpdaterInitialized = true;
    configureUpdateCheckSchedule();

  } catch (err: unknown) {
    console.error('Failed to initialize auto updater:', err);
    patchUpdateStatus({ phase: 'error', message: err instanceof Error ? err.message : nativeMessages(desktopLocale).updaterCheckFailed, canInstall: false });
  }
}

async function resolveDesktopRuntimeSecrets(dataPath: string): Promise<{
  readonly checkpointEncryptionKey?: Buffer;
  readonly checkpointCipher?: CheckpointPayloadCipher;
  readonly secretProtector: SecretProtector;
}> {
  const useMacos26E2eSecrets = shouldUseMacos26E2eSecrets({
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    isPackaged: app.isPackaged,
    e2eFixture: process.env.LNWJUD_E2E_FIXTURE === '1',
    ephemeralSecrets: process.env.LNWJUD_E2E_EPHEMERAL_SECRETS === '1',
  });
  let secretProtector: SecretProtector;
  if (useMacos26E2eSecrets) {
    recordDesktopStartup('safe-storage:e2e-ephemeral:selected');
    secretProtector = createExplicitKeySecretProtector(randomBytes(32));
  } else {
    recordDesktopStartup('safe-storage:settle:begin');
    await waitForMacosAsyncSafeStorageStartup({
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      isPackaged: app.isPackaged,
    });
    recordDesktopStartup('safe-storage:settle:end');
    recordDesktopStartup('safe-storage:async:selected');
    secretProtector = new SafeStorageSecretProtector({
      api: safeStorage,
      platform: process.platform,
    });
    recordDesktopStartup('safe-storage:status:begin');
    const status = await secretProtector.status();
    recordDesktopStartup(`safe-storage:status:end:${status.secure ? 'secure' : status.reason ?? 'unavailable'}`);
    if (!status.secure) {
      const message = status.reason === 'plaintext_backend'
        ? 'Secure secret storage is unavailable: Linux is using the basic_text backend'
        : `Secure secret storage is unavailable (${status.backend})`;
      if (shouldDegradeUnavailableSecureStorage(process.platform, status)) {
        recordDesktopStartup(`safe-storage:degraded:${status.reason ?? status.backend}`);
        return { secretProtector, checkpointCipher: createUnavailableCheckpointCipher(message) };
      }
      throw new Error(message);
    }
  }
  recordDesktopStartup('safe-storage:migrations:begin');
  await migrateV3SafeStorageSecrets(dataPath, secretProtector);
  await migrateLegacyWindowsSecrets({
    platform: process.platform,
    checkpointPath: path.join(dataPath, 'checkpoint-master.key'),
    tunnelSecretPath: path.join(resolveTunnelProfileDirectory(), TUNNEL_SECRET_FILE_NAME),
    secretProtector,
  });
  recordDesktopStartup('safe-storage:migrations:end');
  recordDesktopStartup('checkpoint-key:begin');
  const checkpointKey = await new CheckpointKeyStore({
    filePath: path.join(dataPath, 'checkpoint-master.key'),
    secretProtector,
    quarantineUnsupported: true,
  }).loadOrCreate();
  recordDesktopStartup('checkpoint-key:end');
  return { checkpointEncryptionKey: checkpointKey, secretProtector };
}

async function migrateV3SafeStorageSecrets(dataPath: string, secretProtector: SecretProtector): Promise<void> {
  if (process.platform !== 'win32') return;
  const checkpointPath = path.join(dataPath, 'checkpoint-master.key');
  const checkpointEnvelope = await readTrustedSecretFile(checkpointPath);
  if (checkpointEnvelope !== null && checkpointEnvelope.trim().startsWith('lnwjud-secret:v3:')) {
    const key = decryptV3WindowsSafeStorageSecretIfPresent(checkpointEnvelope, safeStorage);
    if (key === undefined || key.byteLength !== 32) throw new Error('Legacy v3 checkpoint secret has an invalid key length');
    await atomicWrite(checkpointPath, await secretProtector.encrypt('checkpoint_master_key', key.toString('base64')));
  }

  const tunnelPath = path.join(resolveTunnelProfileDirectory(), TUNNEL_SECRET_FILE_NAME);
  const tunnelEnvelope = await readTrustedSecretFile(tunnelPath);
  if (tunnelEnvelope === null || !tunnelEnvelope.trim().startsWith('lnwjud-secret:v3:')) return;
  const secret = decryptV3WindowsSafeStorageSecretIfPresent(tunnelEnvelope, safeStorage);
  if (secret === undefined) return;
  await atomicWrite(tunnelPath, await secretProtector.encrypt('tunnel_api_key', secret.toString('utf8')));
}

async function readTrustedSecretFile(filePath: string): Promise<string | null> {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Protected secret file is not a trusted regular file: ${filePath}`);
    return await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function defaultStdioCommand(profile: PermissionProfileName): string {
  const launcher = process.platform === 'win32' ? 'lnwjud-mcp-stdio.cmd' : 'lnwjud-mcp-stdio';
  return `${launcher} --profile ${profile}`;
}

function collectIncidentMemory(): IncidentDesktopMemory {
  const main = process.memoryUsage();
  const processes = app.getAppMetrics().map((metric) => {
    const toBytes = (value: number | undefined): number | null => value === undefined ? null : Math.max(0, value) * 1024;
    return {
      pid: metric.pid,
      type: String(metric.type),
      name: metric.name ?? null,
      creationTime: metric.creationTime,
      percentCPUUsage: metric.cpu.percentCPUUsage,
      idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
      workingSetBytes: toBytes(metric.memory.workingSetSize),
      peakWorkingSetBytes: toBytes(metric.memory.peakWorkingSetSize),
      privateBytes: toBytes(metric.memory.privateBytes),
    };
  });
  return {
    capturedAt: new Date().toISOString(),
    main: {
      rssBytes: main.rss,
      heapTotalBytes: main.heapTotal,
      heapUsedBytes: main.heapUsed,
      externalBytes: main.external,
      arrayBuffersBytes: main.arrayBuffers,
    },
    processes,
    totalWorkingSetBytes: processes.reduce((total, metric) => total + (metric.workingSetBytes ?? 0), 0),
  };
}

function collectRuntimeDiagnosticsSample(runtime: DesktopRuntime): Omit<RuntimeDiagnosticsSample, 'schemaVersion' | 'capturedAt'> {
  const memory = collectIncidentMemory();
  const cpu = process.cpuUsage();
  const eventLoop = performance.eventLoopUtilization();
  const getActiveResourcesInfo = (process as typeof process & { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo;
  const activeResources: Record<string, number> = {};
  for (const resource of getActiveResourcesInfo?.call(process) ?? []) {
    activeResources[resource] = (activeResources[resource] ?? 0) + 1;
  }

  const byProcessType: Record<string, { count: number; workingSetBytes: number; privateBytes: number; percentCPUUsage: number }> = {};
  for (const metric of memory.processes) {
    const current = byProcessType[metric.type] ?? { count: 0, workingSetBytes: 0, privateBytes: 0, percentCPUUsage: 0 };
    current.count += 1;
    current.workingSetBytes += metric.workingSetBytes ?? 0;
    current.privateBytes += metric.privateBytes ?? 0;
    current.percentCPUUsage += metric.percentCPUUsage;
    byProcessType[metric.type] = current;
  }

  const telemetry = runtime.activityTracker.telemetrySnapshot();
  const inFlightByTool: Record<string, number> = {};
  for (const call of runtime.activityTracker.listInFlight()) {
    inFlightByTool[call.toolName] = (inFlightByTool[call.toolName] ?? 0) + 1;
  }

  return {
    sessionId: desktopSessionDiagnostics?.snapshot().current.sessionId ?? null,
    uptimeSeconds: process.uptime(),
    memory: {
      rssBytes: memory.main.rssBytes,
      heapTotalBytes: memory.main.heapTotalBytes,
      heapUsedBytes: memory.main.heapUsedBytes,
      externalBytes: memory.main.externalBytes,
      arrayBuffersBytes: memory.main.arrayBuffersBytes,
      totalWorkingSetBytes: memory.totalWorkingSetBytes,
      desktopProcessCount: memory.processes.length,
      byProcessType,
    },
    system: {
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
    },
    cpu: {
      userMicros: cpu.user,
      systemMicros: cpu.system,
    },
    eventLoop: {
      idleMs: eventLoop.idle,
      activeMs: eventLoop.active,
      utilization: eventLoop.utilization,
    },
    activeResources,
    logs: runtime.logHub.telemetrySnapshot(),
    mcp: {
      toolAvailabilityListeners: runtime.toolAvailabilityService.listenerCount(),
      calls: telemetry.calls,
      completed: telemetry.completed,
      successes: telemetry.successes,
      errors: telemetry.errors,
      cancellations: telemetry.cancellations,
      active: telemetry.active,
      recentErrorClasses: telemetry.recentErrorClasses,
      inFlightByTool,
    },
  };
}

function configureRuntimeDiagnosticsHistory(dataPath: string, runtime: DesktopRuntime): void {
  if (runtimeDiagnosticsHistory !== null) return;
  const recorder = new RuntimeDiagnosticsHistoryRecorder(dataPath, () => collectRuntimeDiagnosticsSample(runtime));
  recorder.start();
  runtimeDiagnosticsHistory = recorder;
}

async function createNativeDesktopRuntime(dataPath: string): Promise<DesktopRuntime> {
  recordDesktopStartup('runtime-secrets:begin');
  const secrets = await resolveDesktopRuntimeSecrets(dataPath);
  recordDesktopStartup('runtime-secrets:end');
  recordDesktopStartup('runtime-create:begin');
  const desktopLogSession = desktopSessionDiagnostics?.snapshot() ?? null;
  const runtime = createDesktopRuntime(dataPath, {
    ...secrets,
    nativeCapabilityApi: createElectronNativeCapabilityApi(() => mainWindow),
    eccRuntimeOptions: resolveDesktopEccRuntimeOptions(),
    collectIncidentMemory,
    captureRuntimeDiagnostics: () => { runtimeDiagnosticsHistory?.captureNow(); },
    ...(desktopLogSession === null ? {} : {
      logSessionId: desktopLogSession.current.sessionId,
      ...(desktopLogSession.previous === null ? {} : { previousLogSessionStartedAt: desktopLogSession.previous.startedAt }),
    }),
    hostMutationApprovalProvider: requestMutationApproval,
    pdfProviderInstaller: (rootPath) => installPdfProvider(rootPath, {
      fetchImpl: (url) => net.fetch(url, { redirect: 'follow' }),
      onProgress: (phase) => installActivity.set({ kind: 'pdf_provider', phase, progressPercent: null, message: null }),
    }),
    onInstallActivity: (kind, update) => {
      if (update === null) installActivity.clear(kind);
      else installActivity.set({ kind, ...update });
    },
    watchToolAvailability: true,
  });
  recordDesktopStartup('runtime-create:end');
  configureRuntimeDiagnosticsHistory(dataPath, runtime);
  return runtime;
}

function createElectronNativeCapabilityApi(windowProvider: () => BrowserWindow | null): ElectronNativeCapabilityApi {
  return {
    getDisplays: (): readonly NativeDisplayMetadata[] => {
      try {
        return screen.getAllDisplays().map((display) => ({
          id: display.id,
          bounds: display.bounds,
          workArea: display.workArea,
          scaleFactor: display.scaleFactor,
          rotation: display.rotation,
          label: display.label,
        }));
      } catch {
        return [];
      }
    },
    showNotification: (title, body): void => {
      if (!Notification.isSupported()) throw new Error('Desktop notifications are not supported by this session');
      new Notification({ title, body }).show();
    },
    showOpenDialog: async (options: NativeDialogOptions): Promise<NativeDialogResult> => {
      const owner = windowProvider();
      const electronOptions = toElectronOpenDialogOptions(options);
      return owner === null ? dialog.showOpenDialog(electronOptions) : dialog.showOpenDialog(owner, electronOptions);
    },
    showSaveDialog: async (options: NativeDialogOptions): Promise<NativeDialogResult> => {
      const owner = windowProvider();
      const electronOptions = toElectronSaveDialogOptions(options);
      return owner === null ? dialog.showSaveDialog(electronOptions) : dialog.showSaveDialog(owner, electronOptions);
    },
    readClipboardText: () => clipboard.readText(),
    writeClipboardText: (value) => clipboard.writeText(value),
    readClipboardImageBase64: async (): Promise<string | null> => {
      const items = await clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith('image/'));
        if (imageType === undefined) continue;
        const blob = await item.getType(imageType);
        if (blob instanceof Blob) return Buffer.from(await blob.arrayBuffer()).toString('base64');
      }
      return null;
    },
    writeClipboardImageBase64: async (value): Promise<void> => {
      const bytes = Buffer.from(value, 'base64');
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
    },
    captureDesktop: captureElectronDesktop,
    hasWindow: () => windowProvider() !== null,
  };
}


async function captureElectronDesktop(request: NativeDesktopCaptureRequest): Promise<NativeDesktopCaptureResult> {
  const displays = screen.getAllDisplays();
  if (displays.length === 0) throw new Error('No desktop displays are available');
  const thumbnailSize = {
    width: Math.min(16_384, Math.max(...displays.map((display) => Math.max(1, Math.round(display.bounds.width * display.scaleFactor))))),
    height: Math.min(16_384, Math.max(...displays.map((display) => Math.max(1, Math.round(display.bounds.height * display.scaleFactor))))),
  };
  const types: Electron.SourcesOptions['types'] = request.action === 'capture_window' ? ['window'] : ['screen'];
  const sources = await desktopCapturer.getSources({ types, thumbnailSize, fetchWindowIcons: false });
  if (sources.length === 0) throw new Error('Electron desktop capture returned no sources');

  if (request.action === 'capture_window') {
    let candidates = sources;
    const app = request.app ?? {};
    const nativeId = numericCaptureSelector(app.hwnd) ?? numericCaptureSelector(app.window_id);
    if (nativeId !== undefined) candidates = candidates.filter((source) => source.id === nativeId || source.id.split(':').includes(nativeId));
    const title = captureSelectorText(app.title);
    if (title !== undefined) candidates = candidates.filter((source) => source.name.toLocaleLowerCase().includes(title.toLocaleLowerCase()));
    const naturalName = captureSelectorText(app.name) ?? captureSelectorText(app.process_name);
    if (naturalName !== undefined) {
      const normalized = naturalName.replace(/\.exe$/iu, '').toLocaleLowerCase();
      candidates = candidates.filter((source) => source.name.toLocaleLowerCase().includes(normalized));
    }
    const index = request.windowIndex ?? 0;
    const source = candidates[index];
    if (source === undefined) throw new Error('Requested desktop window capture source was not found');
    const image = source.thumbnail;
    const size = image.getSize();
    if (image.isEmpty() || size.width < 1 || size.height < 1) throw new Error('Desktop window capture returned an empty image');
    return {
      format: 'png',
      mime_type: 'image/png',
      data_base64: image.toPNG().toString('base64'),
      width: size.width,
      height: size.height,
      origin_x: 0,
      origin_y: 0,
      scale_x: 1,
      scale_y: 1,
      backend: 'electron-desktop-capturer-window',
    };
  }

  const requestedDisplay = request.displayId?.trim();
  let display = requestedDisplay === undefined
    ? screen.getPrimaryDisplay()
    : displays.find((candidate) => String(candidate.id) === requestedDisplay || candidate.label === requestedDisplay);
  if (request.action === 'capture_region' && request.region !== undefined && requestedDisplay === undefined) {
    const { x, y, width, height } = request.region;
    display = displays.find((candidate) => x >= candidate.bounds.x && y >= candidate.bounds.y
      && x + width <= candidate.bounds.x + candidate.bounds.width
      && y + height <= candidate.bounds.y + candidate.bounds.height);
  }
  if (display === undefined) throw new Error('Requested desktop display capture source was not found');
  const source = sources.find((candidate) => candidate.display_id === String(display.id))
    ?? sources.find((candidate) => candidate.id.split(':').includes(String(display.id)))
    ?? (requestedDisplay === undefined ? sources[0] : undefined);
  if (source === undefined) throw new Error('Requested desktop display capture source was not found');

  let image = source.thumbnail;
  const fullSize = image.getSize();
  if (image.isEmpty() || fullSize.width < 1 || fullSize.height < 1) throw new Error('Desktop display capture returned an empty image');
  const scaleX = display.bounds.width / fullSize.width;
  const scaleY = display.bounds.height / fullSize.height;
  let originX = scaleX > 0 ? display.bounds.x / scaleX : 0;
  let originY = scaleY > 0 ? display.bounds.y / scaleY : 0;

  if (request.action === 'capture_region') {
    const region = request.region;
    if (region === undefined || scaleX <= 0 || scaleY <= 0) throw new Error('Desktop region capture is invalid');
    const crop = {
      x: Math.max(0, Math.round((region.x - display.bounds.x) / scaleX)),
      y: Math.max(0, Math.round((region.y - display.bounds.y) / scaleY)),
      width: Math.max(1, Math.round(region.width / scaleX)),
      height: Math.max(1, Math.round(region.height / scaleY)),
    };
    if (crop.x + crop.width > fullSize.width || crop.y + crop.height > fullSize.height) throw new Error('Desktop region capture is outside the selected display');
    image = image.crop(crop);
    originX = region.x / scaleX;
    originY = region.y / scaleY;
  }

  const size = image.getSize();
  return {
    format: 'png',
    mime_type: 'image/png',
    data_base64: image.toPNG().toString('base64'),
    width: size.width,
    height: size.height,
    origin_x: originX,
    origin_y: originY,
    scale_x: scaleX,
    scale_y: scaleY,
    backend: request.action === 'capture_region' ? 'electron-desktop-capturer-region' : 'electron-desktop-capturer-display',
  };
}

function captureSelectorText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 512) : undefined;
}

function numericCaptureSelector(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d{1,20}$/u.test(value.trim())) return value.trim();
  return undefined;
}

function toElectronOpenDialogOptions(options: NativeDialogOptions): Electron.OpenDialogOptions {
  const result: Electron.OpenDialogOptions = {};
  if (options.title !== undefined) result.title = options.title;
  if (options.defaultPath !== undefined) result.defaultPath = options.defaultPath;
  if (options.filters !== undefined) result.filters = options.filters.map((filter) => ({ name: filter.name, extensions: [...filter.extensions] }));
  if (options.properties !== undefined) result.properties = options.properties as NonNullable<Electron.OpenDialogOptions['properties']>;
  return result;
}

function toElectronSaveDialogOptions(options: NativeDialogOptions): Electron.SaveDialogOptions {
  const result: Electron.SaveDialogOptions = {};
  if (options.title !== undefined) result.title = options.title;
  if (options.defaultPath !== undefined) result.defaultPath = options.defaultPath;
  if (options.filters !== undefined) result.filters = options.filters.map((filter) => ({ name: filter.name, extensions: [...filter.extensions] }));
  return result;
}

function bootstrapDesktop(configuredDataPath?: string): void {
  if (platformCompatibility.disableHardwareAcceleration) app.disableHardwareAcceleration();
  const dataPath = configureDataPath(configuredDataPath);
  recordDesktopStartup('app-ready:waiting');
  void app.whenReady().then(async () => {
    recordDesktopStartup('app-ready:resolved');
    assertSupportedPlatform();
    app.setAppUserModelId('com.lnwjud.desktop');
    const session = platformCompatibility.linuxSession;
    console.log(
      `[PlatformCompatibility] family=${platformCompatibility.family} tier=${platformCompatibility.supportTier} generation=${platformCompatibility.generation} build=${platformCompatibility.build ?? 'unknown'} arch=${process.arch} gpu=${platformCompatibility.disableHardwareAcceleration ? 'software' : 'hardware'}${session === undefined ? '' : ` session=${session.sessionType} dbus=${session.dbusAvailable} portal=${session.portalAvailable} atspi=${session.atSpiAvailable} pipewire=${session.pipewireAvailable}`}; ${platformCompatibility.reason}`,
    );

    prependBundledRuntimeToolsToPath();
    recordDesktopStartup('runtime:begin');
    const runtime = await createNativeDesktopRuntime(dataPath);
    recordDesktopStartup('runtime:end');
    desktopRuntime = runtime;
    setDesktopLocale(runtime.getLocale());
    applyDesktopUserSettings(runtime.getUserSettings());
    configureDesktopShutdown(runtime);
    runtime.logHub.setOnLine((line) => broadcastToAllWindows(pushChannels.logEvent, line));
    runtime.logHub.start();
    registerIpcHandlers(() => mainWindow, runtime.services, {
      onLocaleChanged: setDesktopLocale,
      onUserSettingsChanged: applyDesktopUserSettings,
      onFactoryReset: () => requestFactoryReset(dataPath),
      ipcDrainBarrier: desktopIpcDrainBarrier,
    });
    recordDesktopStartup('window:create:begin');
    createDesktopWindow();
    recordDesktopStartup('window:create:end');
    createDesktopTray();
    recordDesktopStartup('desktop:started');
    crashDiagnostics?.record({ type: 'desktop-lifecycle', processType: 'main', reason: 'desktop-started' });
    void runtime.autoStartMcp().catch((error: unknown) => {
      console.error(`MCP auto-start failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    });
    void runtime.autoStartWatcher().then((endpoint) => {
      if (endpoint !== null) console.info(`Watcher API online ${endpoint}`);
    }).catch((error: unknown) => {
      console.error(`Watcher auto-start failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    });
    void runtime.autoStartTunnel().catch((error: unknown) => {
      console.error(`Tunnel persistent runtime auto-start failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    });
    void runtime.autoStartRemoteMcp().catch((error: unknown) => {
      console.error(`Remote MCP persistent runtime auto-start failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    });
    initAutoUpdater(runtime);
    app.on('activate', () => {
      revealMainWindow();
    });
  }).catch((error: unknown) => handleDesktopStartupFailure('desktop', error));
  app.on('before-quit', handleDesktopBeforeQuit);
  app.on('window-all-closed', () => {
    handleDesktopWindowsClosed('desktop');
  });
}

function bootstrapLogViewerOnly(configuredDataPath?: string): void {
  const dataPath = configureDataPath(configuredDataPath);
  if (platformCompatibility.disableHardwareAcceleration) app.disableHardwareAcceleration();
  void app.whenReady().then(async () => {
    assertSupportedPlatform();
    app.setAppUserModelId('com.lnwjud.desktop');
    prependBundledRuntimeToolsToPath();
    const runtime = await createNativeDesktopRuntime(dataPath);
    desktopRuntime = runtime;
    configureDesktopShutdown(runtime);
    runtime.logHub.setOnLine((line) => broadcastToAllWindows(pushChannels.logEvent, line));
    runtime.logHub.start();
    registerIpcHandlers(() => mainWindow, runtime.services, { ipcDrainBarrier: desktopIpcDrainBarrier });
    const viewer = openLogViewerWindow();
    if (viewer !== null) {
      mainWindow = viewer;
      viewer.on('closed', () => {
        if (mainWindow === viewer) mainWindow = null;
      });
    }
  }).catch((error: unknown) => handleDesktopStartupFailure('log viewer', error));
  app.on('window-all-closed', () => {
    handleDesktopWindowsClosed('log-viewer');
  });
  app.on('before-quit', handleDesktopBeforeQuit);
}

function handleDesktopStartupFailure(scope: string, error: unknown): void {
  const message = error instanceof Error ? error.message : 'unknown error';
  recordDesktopStartup(`${scope}:failed`, error);
  console.error('[Startup] ' + scope + ' failed: ' + message);
  try {
    dialog.showErrorBox('lnwjud failed to start', scope + ' startup failed.\n\n' + message);
  } catch {
    // Console/crash diagnostics remain available if native dialogs cannot be shown.
  }
  app.quit();
}

function assertSupportedPlatform(): void {
  if (!platformCompatibility.supportedReleaseTarget) {
    throw new Error(`Unsupported lnwjud host: ${platformCompatibility.reason}`);
  }
}

function configureDesktopShutdown(runtime: DesktopRuntime): void {
  desktopShutdownCoordinator = new DesktopShutdownCoordinator({
    closeRuntime: async (): Promise<void> => {
      await desktopIpcDrainBarrier.beginDrain();
      await runtime.close();
      if (desktopRuntime === runtime) desktopRuntime = null;
    },
    onDeferred: (error): void => {
      desktopIpcDrainBarrier.resume();
      quitRequested = false;
      if (currentUpdateStatus.phase === 'installing' && currentUpdateStatus.availableVersion !== null) {
        patchUpdateStatus({
          phase: 'ready',
          message: nativeMessages(desktopLocale).updateReadyStatus(currentUpdateStatus.availableVersion),
          canInstall: true,
        });
      }
      console.error(`Desktop shutdown deferred: ${error.message}`);
      broadcastToAllWindows(pushChannels.logEvent, {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        level: 'error',
        source: 'process',
        text: `Desktop shutdown deferred: ${error.message}`,
      });
      void dialog.showMessageBox({
        type: 'error',
        title: 'lnwjud is still running',
        message: 'The owned tunnel could not be confirmed stopped. lnwjud will remain open; retry Quit after checking the tunnel status.',
        detail: boundedNativeDialogText(error.message),
        buttons: ['OK'],
      });
    },
  });
}

function handleDesktopWindowsClosed(scope: 'desktop' | 'log-viewer'): void {
  const recoveryPending = rendererRecoveryBarrier.isPending();
  const shouldQuit = rendererRecoveryBarrier.shouldQuitWhenWindowsClosed(process.platform);
  crashDiagnostics?.record({
    type: 'desktop-lifecycle',
    processType: 'main',
    reason: `${scope}:window-all-closed:${shouldQuit ? 'app-quit' : recoveryPending ? 'renderer-recovery-pending' : 'keep-alive'}`,
  });
  if (shouldQuit) app.quit();
}

function handleDesktopBeforeQuit(event: Electron.Event): void {
  desktopSessionDiagnostics?.markShutdownRequested('before-quit');
  const coordinator = desktopShutdownCoordinator;
  crashDiagnostics?.record({
    type: 'desktop-lifecycle',
    processType: 'main',
    reason: `before-quit:${coordinator === null ? 'no-runtime' : coordinator.canQuit() ? 'ready' : 'coordinating'}`,
  });
  if (coordinator === null || coordinator.canQuit()) {
    quitRequested = true;
    updateInstallCoordinator?.cancel();
    updateCheckScheduler?.stop();
    updateCheckScheduler = null;
    destroyDesktopTray();
    return;
  }
  event.preventDefault();
  quitRequested = true;
  void coordinator.requestQuit(() => {
    desktopSessionDiagnostics?.markCleanExit();
    app.exit(0);
  }).then((result) => {
    if (result === 'deferred') quitRequested = false;
  });
}

function configureDesktopSessionDiagnostics(dataPath: string): void {
  if (desktopSessionDiagnostics !== null) return;
  try {
    configureNativeCrashDiagnostics(dataPath, APP_VERSION, crashReporter, (directory) => app.setPath('crashDumps', directory));
  } catch (error: unknown) {
    console.error(`Native crash diagnostics setup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  const diagnostics = new DesktopSessionDiagnostics(dataPath, APP_VERSION, () => new Date(), (error) => {
    console.error(`Desktop session diagnostics write failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  });
  diagnostics.start();
  desktopSessionDiagnostics = diagnostics;
  const previous = diagnostics.snapshot().previous;
  if (previous !== null && previous.state !== 'clean_exit') {
    crashDiagnostics?.record({
      type: 'desktop-lifecycle',
      processType: 'main',
      reason: `previous-session-ended-uncleanly:pid=${previous.pid}:last-heartbeat=${previous.lastHeartbeatAt}`,
    });
  }
}

function configureCrashRecovery(dataPath: string): void {
  crashDiagnostics ??= new CrashDiagnosticsRecorder(dataPath, APP_VERSION);
  if (crashRecoveryConfigured) return;
  crashRecoveryConfigured = true;

  process.on('uncaughtExceptionMonitor', (error) => {
    crashDiagnostics?.record({ type: 'main-uncaught-exception', processType: 'main', reason: 'uncaught-exception-monitor', error });
  });
  process.on('unhandledRejection', (reason) => {
    crashDiagnostics?.record({ type: 'main-unhandled-rejection', processType: 'main', reason: 'unhandled-rejection', error: reason });
  });
  process.on('exit', (exitCode) => {
    crashDiagnostics?.record({ type: 'desktop-lifecycle', processType: 'main', reason: 'process-exit', exitCode });
  });
  const handleTerminationSignal = (signal: NodeJS.Signals): void => {
    crashDiagnostics?.record({ type: 'desktop-lifecycle', processType: 'main', reason: `signal:${signal}`, signal });
    app.quit();
  };
  process.once('SIGTERM', () => handleTerminationSignal('SIGTERM'));
  process.once('SIGINT', () => handleTerminationSignal('SIGINT'));
  app.on('will-quit', () => {
    runtimeDiagnosticsHistory?.captureNow();
    runtimeDiagnosticsHistory?.stop();
    desktopSessionDiagnostics?.markCleanExit();
    crashDiagnostics?.record({ type: 'desktop-lifecycle', processType: 'main', reason: `will-quit:${quitRequested ? 'requested' : 'external'}` });
  });
  app.on('quit', (_event, exitCode) => {
    crashDiagnostics?.record({ type: 'desktop-lifecycle', processType: 'main', reason: 'quit', exitCode });
  });
  app.on('child-process-gone', (_event, details) => {
    try { pruneNativeCrashDumpsForDataPath(dataPath); } catch { /* diagnostics must never terminate the app */ }
    crashDiagnostics?.record({
      type: 'child-process-gone',
      processType: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  app.on('render-process-gone', (_event, webContents, details) => {
    try { pruneNativeCrashDumpsForDataPath(dataPath); } catch { /* diagnostics must never terminate the app */ }
    const shouldRecover = !quitRequested && rendererRecoveryPolicy.shouldRecover(details.reason);
    crashDiagnostics?.record({
      type: 'renderer-gone',
      processType: 'renderer',
      reason: details.reason,
      exitCode: details.exitCode,
    });
    crashDiagnostics?.record({
      type: 'desktop-lifecycle',
      processType: 'main',
      reason: `renderer-gone:${details.reason}:recovery=${shouldRecover ? 'scheduled' : quitRequested ? 'quit-requested' : 'rate-limited'}`,
    });
    if (!shouldRecover) return;
    const mainCrashed = mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.webContents.id === webContents.id;
    const logViewerCrashed = logViewerWindow !== null && !logViewerWindow.isDestroyed() && logViewerWindow.webContents.id === webContents.id;
    if (!mainCrashed && !logViewerCrashed) return;

    if (mainCrashed) {
      const completeRecovery = rendererRecoveryBarrier.begin();
      const crashedWindow = mainWindow;
      mainWindow = null;
      if (crashedWindow !== null && !crashedWindow.isDestroyed()) crashedWindow.destroy();
      setTimeout(() => {
        try {
          if (!quitRequested && (mainWindow === null || mainWindow.isDestroyed())) createDesktopWindow();
        } finally {
          completeRecovery();
        }
      }, 250);
    }
    if (logViewerCrashed) {
      const completeRecovery = rendererRecoveryBarrier.begin();
      const crashedViewer = logViewerWindow;
      logViewerWindow = null;
      if (crashedViewer !== null && !crashedViewer.isDestroyed()) crashedViewer.destroy();
      setTimeout(() => {
        try {
          if (!quitRequested && (logViewerWindow === null || logViewerWindow.isDestroyed())) openLogViewerWindow();
        } finally {
          completeRecovery();
        }
      }, 250);
    }
  });
}

function recordDesktopStartup(reason: string, error?: unknown): void {
  crashDiagnostics?.record({
    type: 'desktop-startup',
    processType: 'main',
    reason,
    ...(error === undefined ? {} : { error }),
  });
}

function configureUserDataPath(): string {
  app.setName(APP_NAME);
  const dataPath = resolveLnwjudDataPath(process.env, app.getPath('appData'), process.platform);
  app.setPath('userData', dataPath);
  return dataPath;
}

function configureDataPath(configuredDataPath?: string): string {
  const dataPath = configuredDataPath ?? configureUserDataPath();
  configureCrashRecovery(dataPath);
  recordDesktopStartup('data-path:configured');
  recordDesktopStartup('restore:begin');
  const restore = applyPendingSqliteRestoreSync(path.join(dataPath, 'lnwjud.sqlite'), path.join(dataPath, 'backups'), {
    platform: process.platform,
    arch: process.arch,
    hostBoundPaths: [
      path.join(dataPath, 'checkpoint-master.key'),
      path.join(resolveTunnelProfileDirectory(), TUNNEL_SECRET_FILE_NAME),
    ],
  });
  recordDesktopStartup('restore:end');
  if (restore.error !== undefined) console.error(`Scheduled database restore failed: ${restore.error}`);
  if (restore.applied) console.log(`Database restore applied from ${restore.backupId ?? 'scheduled backup'}`);
  return dataPath;
}

const factoryResetApplyRequested = process.argv.includes(FACTORY_RESET_APPLY_ARG);
if (factoryResetApplyRequested) {
  const dataPath = resolveLnwjudDataPath(process.env, app.getPath('appData'), process.platform);
  try {
    if (!applyPendingFactoryResetSync(dataPath, resolveTunnelProfileDirectory())) {
      throw new Error('Factory reset marker is missing');
    }
    const args = process.argv.slice(1).filter((argument) =>
      argument !== FACTORY_RESET_APPLY_ARG && !argument.startsWith('--user-data-dir='));
    app.relaunch({ args });
    app.exit(0);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown reset error';
    console.error(`Factory reset failed: ${message}`);
    try { dialog.showErrorBox('lnwjud reset failed', message); } catch { /* stderr remains available if native dialogs fail. */ }
    app.exit(1);
  }
} else {
  const holdsSingleInstanceLock = shouldHoldSingleInstanceLock(process.argv);
  const configuredUserDataPath = holdsSingleInstanceLock ? configureUserDataPath() : undefined;
  if (configuredUserDataPath !== undefined) {
    try { clearFactoryResetBootstrapSync(configuredUserDataPath); } catch (error: unknown) {
      console.error(`Factory reset bootstrap cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  const gotInstanceLock = holdsSingleInstanceLock ? app.requestSingleInstanceLock() : true;
  if (!gotInstanceLock) {
    app.quit();
  } else {
    if (configuredUserDataPath !== undefined) {
      configureCrashRecovery(configuredUserDataPath);
      recordDesktopStartup('entrypoint');
      recordDesktopStartup('instance-lock:acquired');
      configureDesktopSessionDiagnostics(configuredUserDataPath);
    }
    if (holdsSingleInstanceLock) {
      app.on('second-instance', (_event, argv) => {
        const existing = logViewerWindow !== null && !logViewerWindow.isDestroyed() ? logViewerWindow : null;
        if (existing !== null) {
          if (existing.isMinimized()) existing.restore();
          existing.show();
          existing.focus();
        } else if (argv.includes('--log-viewer')) {
          openLogViewerWindow();
        } else {
          revealMainWindow();
        }
      });
    }
    if (wantsMcpStdio(process.argv)) {
      bootstrapMcpStdio();
    } else if (process.argv.includes('--log-viewer')) {
      bootstrapLogViewerOnly(configuredUserDataPath);
    } else {
      bootstrapDesktop(configuredUserDataPath);
    }
  }
}
