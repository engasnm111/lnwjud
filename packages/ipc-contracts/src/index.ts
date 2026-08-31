export const APP_NAME = 'lnwjud';
export const APP_VERSION = '4.31.0';

export const ipcChannels = {
  listWorkspaces: 'lnwjud:list-workspaces',
  addWorkspace: 'lnwjud:add-workspace',
  selectWorkspace: 'lnwjud:select-workspace',
  setWorkspaceActive: 'lnwjud:set-workspace-active',
  setWorkspaceArchived: 'lnwjud:set-workspace-archived',
  deleteWorkspace: 'lnwjud:delete-workspace',
  getDashboard: 'lnwjud:get-dashboard',
  setPermissionProfile: 'lnwjud:set-permission-profile',
  setUnrestrictedMode: 'lnwjud:set-unrestricted-mode',
  setAiDeletePolicy: 'lnwjud:set-ai-delete-policy',
  setStdioPolicy: 'lnwjud:set-stdio-policy',
  createBackup: 'lnwjud:create-backup',
  scheduleRestoreBackup: 'lnwjud:schedule-restore-backup',
  restoreRecoveryItem: 'lnwjud:restore-recovery-item',
  restoreCheckpoint: 'lnwjud:restore-checkpoint',
  listProcesses: 'lnwjud:list-processes',
  startProcess: 'lnwjud:start-process',
  stopProcess: 'lnwjud:stop-process',
  startMcp: 'lnwjud:start-mcp',
  stopMcp: 'lnwjud:stop-mcp',
  restartMcp: 'lnwjud:restart-mcp',
  clearWorkLog: 'lnwjud:clear-work-log',
  saveTunnelApiKey: 'lnwjud:save-tunnel-api-key',
  startTunnel: 'lnwjud:start-tunnel',
  stopTunnel: 'lnwjud:stop-tunnel',
  getTunnelStatus: 'lnwjud:get-tunnel-status',
  setTunnelClientPath: 'lnwjud:set-tunnel-client-path',
  setLocale: 'lnwjud:set-locale',
  setUserSettings: 'lnwjud:set-user-settings',
  chooseTunnelClientPath: 'lnwjud:choose-tunnel-client-path',
  configureTunnelProfile: 'lnwjud:configure-tunnel-profile',
  openExternalSetupPage: 'lnwjud:open-external-setup-page',
  launchManagedBrowser: 'lnwjud:launch-managed-browser',
  installPdfProvider: 'lnwjud:install-pdf-provider',
  runDoctor: 'lnwjud:run-doctor',
  getToolCatalog: 'lnwjud:get-tool-catalog',
  recheckToolCatalog: 'lnwjud:recheck-tool-catalog',
  openToolSetupTarget: 'lnwjud:open-tool-setup-target',
  copyToolCommand: 'lnwjud:copy-tool-command',
  getLogSnapshot: 'lnwjud:get-log-snapshot',
  clearLogBuffer: 'lnwjud:clear-log-buffer',
  exportLogs: 'lnwjud:export-logs',

  exportWorkLog: 'lnwjud:export-work-log',
  captureIncident: 'lnwjud:capture-incident',
  openLogViewer: 'lnwjud:open-log-viewer',
  getUpdateStatus: 'lnwjud:get-update-status',
  checkForUpdates: 'lnwjud:check-for-updates',
  installUpdate: 'lnwjud:install-update',
} as const;

export const pushChannels = {
  logEvent: 'lnwjud:event:log',
  updateStatus: 'lnwjud:event:update-status',
} as const;

export type IpcChannel = typeof ipcChannels[keyof typeof ipcChannels];
export type PermissionProfileName = 'safe' | 'balanced' | 'full' | 'custom';
export type DestructiveApprovalKey =
  | 'delete_file'
  | 'git_rm'
  | 'git_clean'
  | 'git_reset_restore'
  | 'shell_rm_unlink'
  | 'shell_rmdir'
  | 'shell_del_erase'
  | 'wsl_rm_unlink'
  | 'wsl_rmdir';
export interface DestructiveDeletePolicy {
  readonly protectCriticalFiles: boolean;
  readonly recoverableDelete: boolean;
  readonly approvals: Readonly<Record<DestructiveApprovalKey, boolean>>;
}
export type UiLocale = 'th' | 'en';

export type ToolOrigin = 'lnwjud' | 'external_mcp';
export type ToolCategory =
  | 'workspace'
  | 'files'
  | 'search_context'
  | 'git'
  | 'process'
  | 'browser_desktop'
  | 'system'
  | 'office_media'
  | 'automation'
  | 'agent_goals'
  | 'extensions';
export type ToolRiskMode = 'fixed' | 'input_dependent';
export type ToolReadinessStatus = 'ready' | 'needs_setup' | 'blocked' | 'disabled' | 'unsupported' | 'unknown';
export type ToolDeclaredPermission = 'READ' | 'WRITE' | 'EXECUTE' | 'DANGEROUS' | 'UNKNOWN';
export type ToolProfileDecision = 'ALLOW' | 'ASK' | 'DENY' | 'UNKNOWN';

export interface ToolCatalogDefinition {
  readonly name: string;
  readonly category: ToolCategory;
  readonly titleKey: string;
  readonly shortDescriptionKey: string;
  readonly longDescriptionKey: string;
  readonly requirementIds: readonly string[];
  readonly riskMode: ToolRiskMode;
  readonly supportsCancel: boolean;
  readonly supportsDryRun: boolean;
  readonly documentationTarget?: string;
}

export interface RequirementResult {
  readonly id: string;
  readonly status: 'pass' | 'warn' | 'fail' | 'unknown';
  readonly required: boolean;
  readonly checkedAt: string;
  readonly summaryKey: string;
  readonly detail?: string;
  readonly remediationId?: string;
}

export type RemediationAction =
  | { readonly kind: 'open_settings'; readonly target: string }
  | { readonly kind: 'open_official_url'; readonly target: string }
  | { readonly kind: 'open_system_settings'; readonly target: 'windows_optional_features' }
  | { readonly kind: 'copy_command'; readonly commandId: string }
  | { readonly kind: 'launch_managed_browser' }
  | { readonly kind: 'install_pdf_provider' }
  | { readonly kind: 'set_user_setting'; readonly setting: 'codexToolsEnabled'; readonly value: boolean }
  | { readonly kind: 'recheck'; readonly requirementIds: readonly string[] };

export interface ToolCatalogItem {
  readonly name: string;
  readonly origin: ToolOrigin;
  readonly serverName?: string;
  readonly category: ToolCategory;
  readonly title: string;
  readonly shortDescription: string;
  readonly longDescription: string;
  readonly declaredPermission: ToolDeclaredPermission;
  readonly profileDecision: ToolProfileDecision;
  readonly riskMode: ToolRiskMode | 'external_unknown';
  readonly readiness: ToolReadinessStatus;
  readonly stale: boolean;
  readonly checkedAt: string | null;
  readonly supportsCancel: boolean | null;
  readonly supportsDryRun: boolean | null;
  readonly requirements: readonly RequirementResult[];
  readonly remediationIds: readonly string[];
  readonly inputSchema: Record<string, unknown> | null;
  readonly searchText: readonly string[];
}

export interface ResolvedRemediation {
  readonly id: string;
  readonly title: string;
  readonly explanation: string;
  readonly steps: readonly string[];
  readonly actions: readonly RemediationAction[];
}

export interface ToolCatalogSnapshot {
  readonly generatedAt: string;
  readonly locale: UiLocale;
  readonly items: readonly ToolCatalogItem[];
  readonly remediations: readonly ResolvedRemediation[];
}

export type AgentState = 'stopped' | 'idle' | 'busy';
export type TunnelRunState = 'stopped' | 'starting' | 'running' | 'error';
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'up-to-date' | 'error' | 'unavailable';

export interface UpdateStatus {
  readonly phase: UpdatePhase;
  readonly currentVersion: string;
  readonly availableVersion: string | null;
  readonly progressPercent: number | null;
  readonly lastCheckedAt: string | null;
  readonly message: string | null;
  readonly canInstall: boolean;
}

export type CloseBehavior = 'tray' | 'quit';
export type PermissionDecisionSetting = 'ALLOW' | 'ASK' | 'DENY';
export type ExtensionMode = 'enable_all' | 'allowlist';

export interface CustomPermissionSettings {
  readonly read: PermissionDecisionSetting;
  readonly write: PermissionDecisionSetting;
  readonly execute: PermissionDecisionSetting;
  readonly dangerous: PermissionDecisionSetting;
  readonly allowedExecutables: readonly string[];
}

export interface ExtraMcpServerSettings {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly type: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface UserSettings {
  readonly customPermission: CustomPermissionSettings;
  /** Full profile only. Explicitly bypasses lnwjud application authorization on Desktop HTTP/Secure Tunnel. */
  readonly desktopFullBypassAll: boolean;
  /** Full profile only. Explicitly bypasses lnwjud application authorization for direct STDIO. */
  readonly stdioFullBypassAll: boolean;
  readonly mcpCallTimeoutMs: number;
  readonly mcpIdleTimeoutMs: number;
  readonly processTimeoutMs: number;
  readonly mcpPollWaitSeconds: number;
  readonly shellSynchronousWaitSeconds: number;
  readonly capabilityRoots: readonly string[];
  readonly pdfProviderPath: string;
  readonly lspCommands: Readonly<Record<string, string>>;
  readonly mcpHttpPort: number;
  readonly codexToolsEnabled: boolean;
  readonly updateAutoCheck: boolean;
  readonly updateCheckOnStartup: boolean;
  readonly updateIntervalMinutes: number;
  readonly updateAutoDownload: boolean;
  readonly closeBehavior: CloseBehavior;
  readonly launchAtStartup: boolean;
  readonly startMinimized: boolean;
  readonly tunnelAutoReconnect: boolean;
  readonly tunnelMaxAutoRestarts: number;
  /** 0 keeps Recovery Trash/checkpoints forever; otherwise purge items older than this many days. */
  readonly recoveryRetentionDays: number;
  readonly extensions: {
    readonly mode: ExtensionMode;
    readonly disabledServers: readonly string[];
    readonly enabledServers: readonly string[];
    readonly disabledSkillRoots: readonly string[];
    readonly extraSkillRoots: readonly string[];
    readonly extraMcpServers: readonly ExtraMcpServerSettings[];
  };
}

export interface WorkspaceSummary {
  readonly id: string;
  readonly displayName: string;
  readonly rootPath: string;
  readonly realRootPath: string;
  readonly createdAt: string;
  readonly archivedAt?: string | null;
  readonly kind?: 'project' | 'machine_root';
}

export type CapabilityToolName = 'shell' | 'dom_cdp' | 'accessibility' | 'input_event' | 'vision' | 'window' | 'health' | 'system_info' | 'notification' | 'file_dialog' | 'clipboard' | 'web_fetch' | 'audio' | 'screen_record' | 'office' | 'scheduler' | 'wsl_exec' | 'wsl_fs';

export interface CapabilitySummary {
  readonly name: CapabilityToolName;
  readonly title: string;
  readonly description: string;
  readonly available: boolean;
  readonly ready: boolean;
}

export interface WorkLogEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly kind: 'task' | 'result' | 'error';
  readonly toolName: string;
  readonly resultCode: string;
  readonly errorMessage: string | null;
  readonly targetSummary: string | null;
  readonly durationMs: number;
  readonly workspaceId: string | null;
  readonly sessionId: string | null;
  readonly callId?: string;
}

export interface InFlightWorkItem {
  readonly callId: string;
  readonly toolName: string;
  readonly startedAt: string;
  readonly targetSummary: string | null;
  readonly workspaceId: string | null;
  readonly sessionId: string | null;
}

export interface ConnectionModes {
  readonly httpUrl: string | null;
  readonly stdioCommand: string;
}

export type TunnelPersistentRunState = 'stopped' | 'starting' | 'running' | 'reconnecting' | 'error' | 'auth-required';
export type TunnelPersistentMode = 'native-managed' | 'profile-child' | 'external';

export interface TunnelPersistentStatus {
  readonly enabled: boolean;
  readonly tunnelIdMasked: string | null;
  readonly runtimeAlias: string;
  /** True when tunnel-client runtimes status confirms this alias currently has a live process. */
  readonly runtimeAliasActive?: boolean;
  readonly mode: TunnelPersistentMode;
  readonly state: TunnelPersistentRunState;
  readonly healthy: boolean | null;
  readonly ready: boolean | null;
  readonly pollHealthy: boolean | null;
  readonly reconnectCount: number;
  readonly lastConnectedAt: string | null;
  readonly lastReconnectAt: string | null;
  readonly nextReconnectAt: string | null;
  readonly lastErrorCode: string | null;
  readonly clientVersion: string | null;
  readonly localMcpUrl: string | null;
  readonly uiUrl: string | null;
  readonly readyBeforeRetire: boolean;
  readonly strictZeroDowntime: boolean;
  readonly capabilityEvidence: string | null;
}

export interface TunnelStatus {
  readonly state: TunnelRunState;
  /** desktop = started by this app; external = started by a script or another process. */
  readonly source: 'desktop' | 'external';
  readonly hasApiKey: boolean;
  readonly clientPath: string | null;
  readonly profileExists: boolean;
  readonly message: string | null;
  readonly logPath: string | null;
  readonly persistent: TunnelPersistentStatus | null;
}

export type LogSource = 'tunnel' | 'mcp' | 'process';
export type LogLevel = 'info' | 'warn' | 'error';

export interface LogLine {
  readonly id: number;
  readonly source: LogSource;
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly text: string;
  readonly workspaceId: string | null;
  readonly sessionId: string | null;
  readonly correlation?: LogCorrelation;
}

export type McpResultCode = 'SUCCESS' | 'FAILED' | 'FATAL' | 'UNKNOWN';
export type TunnelLifecycleCategory = 'ttl_expired' | 'stdio_stopped' | 'transport_stopped' | 'transport_live' | 'other';
export type LogCorrelation =
  | { readonly kind: 'mcp'; readonly phase: 'started' | 'completed'; readonly callId: string; readonly toolName: string; readonly resultCode: McpResultCode | null }
  | { readonly kind: 'tunnel'; readonly lifecycle?: TunnelLifecycleCategory; readonly instanceId?: string; readonly requestId?: string; readonly pid?: number };

export interface LogSnapshot {
  readonly lines: readonly LogLine[];
  readonly tunnelLogPath: string | null;
  readonly tunnelLogExists: boolean;
}

export interface LogScopeRequest {
  readonly workspaceId?: string;
  readonly sessionId?: string;
}

export type ClearWorkLogRequest = LogScopeRequest;

export interface ClearLogBufferRequest extends LogScopeRequest {
  readonly source: LogSource;
}

export interface ExportLogsRequest extends LogScopeRequest {
  readonly source: LogSource;
  readonly filePath: string;
  readonly query?: string;
  /** Exact line identities visible in the renderer when Export was clicked. */
  readonly lineIds?: readonly number[];
  /** Exact locally formatted rows visible/copyable in the renderer when Export was clicked. */
  readonly rows?: readonly string[];
}

export interface ExportWorkLogRequest {
  /** Exact formatted rows visible in Work Log when Export was clicked. */
  readonly rows: readonly string[];
}

/** Normalize legacy path-shaped workspace IDs emitted by older builds. */
export function normalizeWorkspaceScopeIdentity(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
}

export function canonicalWorkspaceScopeId(workspaces: readonly WorkspaceSummary[], workspaceId: string): string {
  const direct = workspaces.find((workspace) => workspace.id === workspaceId);
  if (direct !== undefined) {
    const identity = normalizeWorkspaceScopeIdentity(direct.realRootPath || direct.rootPath);
    const rootMatch = workspaces.find((workspace) =>
      workspace.kind !== 'machine_root'
      && (normalizeWorkspaceScopeIdentity(workspace.realRootPath) === identity
        || normalizeWorkspaceScopeIdentity(workspace.rootPath) === identity),
    );
    return rootMatch?.id ?? workspaceId;
  }

  const identity = normalizeWorkspaceScopeIdentity(workspaceId);
  const rootMatch = workspaces.find((workspace) =>
    workspace.kind !== 'machine_root'
    && (normalizeWorkspaceScopeIdentity(workspace.realRootPath) === identity
      || normalizeWorkspaceScopeIdentity(workspace.rootPath) === identity),
  );
  if (rootMatch !== undefined) return rootMatch.id;

  const displayMatches = workspaces.filter((workspace) =>
    workspace.kind !== 'machine_root'
    && normalizeWorkspaceScopeIdentity(workspace.displayName) === identity,
  );
  return displayMatches.length === 1 ? displayMatches[0]!.id : workspaceId;
}

export function workspaceScopeMatches(workspaces: readonly WorkspaceSummary[], candidate: string | null, selected: string): boolean {
  if (candidate === null) return false;
  return canonicalWorkspaceScopeId(workspaces, candidate) === canonicalWorkspaceScopeId(workspaces, selected);
}

export type IncidentClassification = 'local_tool_failed' | 'tunnel_disconnected' | 'remote_turn_stopped' | 'healthy_or_inconclusive';
export interface IncidentExportResult {
  readonly exported: boolean;
  readonly cancelled: boolean;
  readonly classification: IncidentClassification;
  readonly capturedAt: string | null;
}

export interface GitStatusEntrySummary {
  readonly path: string;
  readonly kind: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
}

export interface DashboardGitSummary {
  readonly branch: string | null;
  readonly changedFiles: number;
  readonly stagedFiles: number;
  readonly message: string;
  readonly repositoryPath?: string | null;
  readonly isRepo?: boolean;
  readonly entries?: readonly GitStatusEntrySummary[];
}

export interface BackupSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly reason: 'daily' | 'manual' | 'pre-update' | 'pre-migration';
  readonly sizeBytes: number;
}

export interface RecoveryTrashItemSummary {
  readonly recoveryId: string;
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly deletedAt: string;
  readonly isDirectory: boolean;
  readonly payloadAvailable: boolean;
  readonly kind: 'deleted' | 'replacement_backup';
}

export interface RecoveryCheckpointFileSummary {
  readonly path: string;
  readonly contentSha256: string;
  readonly size: number;
}

export interface RecoveryCheckpointSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly createdAt: string;
  readonly files: readonly RecoveryCheckpointFileSummary[];
}

export interface RecoveryCenterSummary {
  readonly trashRoot: string | null;
  readonly trashItems: readonly RecoveryTrashItemSummary[];
  readonly checkpoints: readonly RecoveryCheckpointSummary[];
}

export interface DashboardSnapshot {
  /** Primary workspace used when a tool call omits workspaceId. */
  readonly selectedWorkspace: WorkspaceSummary | null;
  /** Host-authorized project set. Parallel chats may safely target different active workspaceIds. */
  readonly activeWorkspaces: readonly WorkspaceSummary[];
  readonly gitSummary: DashboardGitSummary;
  readonly mcp: {
    readonly running: boolean;
    readonly url: string | null;
    readonly lastStartError?: string | null;
    readonly workspaceId: string | null;
  };
  readonly codex: {
    readonly installed: boolean;
    readonly version: string | null;
  };
  readonly managedProcessCount: number;
  readonly auditEventCount: number;
  readonly recentAuditEvents: readonly AuditEventSummary[];
  readonly permissionProfile: PermissionProfileName;
  readonly capabilities: readonly CapabilitySummary[];
  readonly agentState: AgentState;
  readonly mode: 'WORK';
  readonly locale: UiLocale;
  readonly unrestricted: boolean;
  /** Legacy alias for destructiveDeletePolicy.approvals.delete_file. */
  readonly allowAiDelete: boolean;
  readonly destructiveDeletePolicy: DestructiveDeletePolicy;
  readonly stdioPermissionProfile: PermissionProfileName;
  readonly stdioStrictRoots: boolean;
  readonly stdioAllowedRoots: readonly string[];
  readonly backups: readonly BackupSummary[];
  readonly recovery: RecoveryCenterSummary;
  readonly connectionModes: ConnectionModes;
  readonly workLog: readonly WorkLogEntry[];
  readonly inFlight: readonly InFlightWorkItem[];
  readonly tunnel: TunnelStatus;
  readonly settings: UserSettings;
  readonly appVersion: string;
}

export interface AuditEventSummary {
  readonly id: string;
  readonly timestamp: string;
  readonly action: string;
  readonly resultCode: string;
}

export interface ProcessSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly sessionId: string | null;
  readonly executable: string;
  readonly args: readonly string[];
  readonly state: 'starting' | 'running' | 'exited' | 'failed' | 'stopped' | 'timed_out' | 'termination_unverified';
  readonly logSummary: string;
}

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export interface DoctorCheck {
  readonly id: string;
  readonly required: boolean;
  readonly status: DoctorCheckStatus;
  readonly title: string;
  readonly summary: string;
  readonly detail?: string;
  readonly affectedToolNames: readonly string[];
  readonly remediationId?: string;
  readonly checkedAt: string;
  readonly durationMs: number;
  /** Legacy compatibility while renderer migration is in progress. */
  readonly message?: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly exitCode: 0 | 1;
}

export interface GetToolCatalogRequest {
  readonly locale: UiLocale;
}
export interface RecheckToolCatalogRequest {
  readonly locale: UiLocale;
  readonly requirementIds: readonly string[];
}
export interface OpenToolSetupTargetRequest {
  readonly target: string;
}
export interface CopyToolCommandRequest {
  readonly commandId: string;
}

export interface AddWorkspaceRequest {
  readonly rootPath: string;
}

export interface SelectWorkspaceRequest {
  readonly workspaceId: string;
}

export interface SetWorkspaceActiveRequest {
  readonly workspaceId: string;
  readonly active: boolean;
}

export interface SetWorkspaceArchivedRequest {
  readonly workspaceId: string;
  readonly archived: boolean;
}

export interface DeleteWorkspaceRequest {
  readonly workspaceId: string;
  readonly userConfirmed: boolean;
}

export interface SetPermissionProfileRequest {
  readonly profile: PermissionProfileName;
}

export interface SetUnrestrictedModeRequest {
  readonly enabled: boolean;
}

export interface SetAiDeletePolicyRequest {
  /** Legacy single-toggle compatibility. */
  readonly enabled?: boolean;
  /** Preferred fine-grained destructive auto-approval policy. */
  readonly policy?: DestructiveDeletePolicy;
}

export interface SetStdioPolicyRequest {
  readonly profile: PermissionProfileName;
  readonly strictRoots: boolean;
  readonly allowedRoots: readonly string[];
}

export interface ScheduleRestoreBackupRequest {
  readonly backupId: string;
}

export interface RestoreRecoveryItemRequest {
  readonly workspaceId: string;
  readonly recoveryId: string;
}

export interface RestoreCheckpointRequest {
  readonly workspaceId: string;
  readonly checkpointId: string;
}

export interface StartProcessRequest {
  readonly workspaceId: string;
  readonly mode: 'fixture' | 'project-dev';
}

export interface StopProcessRequest {
  readonly processId: string;
}

export interface StartMcpRequest {
  readonly workspaceId: string;
}

export interface SaveTunnelApiKeyRequest {
  readonly apiKey: string;
}

export interface SetTunnelClientPathRequest {
  readonly clientPath: string;
}

export interface SetLocaleRequest {
  readonly locale: UiLocale;
}

export interface SetUserSettingsRequest {
  readonly settings: UserSettings;
}

export interface ConfigureTunnelProfileRequest {
  readonly tunnelId: string;
}

export type ExternalSetupTarget = 'openai_tunnels' | 'openai_api_keys' | 'chatgpt_plugins';

export const EXTERNAL_SETUP_URLS: Readonly<Record<ExternalSetupTarget, string>> = Object.freeze({
  openai_tunnels: 'https://platform.openai.com/settings/organization/tunnels',
  openai_api_keys: 'https://platform.openai.com/api-keys',
  chatgpt_plugins: 'https://chatgpt.com/plugins',
});

export interface OpenExternalSetupPageRequest {
  readonly target: ExternalSetupTarget;
}

export interface McpConnectionStatus {
  readonly running: boolean;
  readonly url: string | null;
  readonly lastStartError?: string | null;
  readonly workspaceId: string | null;
}

export interface ManagedBrowserStatus {
  readonly ready: boolean;
  readonly port: number;
  readonly launched: boolean;
}

export interface PdfProviderInstallResult {
  readonly providerPath: string;
  readonly version: string;
  readonly sourceUrl: string;
  readonly archiveSha256: string;
  readonly reused: boolean;
  readonly restartRequired: boolean;
}

export interface IpcRequestMap {
  readonly [ipcChannels.listWorkspaces]: undefined;
  readonly [ipcChannels.addWorkspace]: AddWorkspaceRequest;
  readonly [ipcChannels.selectWorkspace]: SelectWorkspaceRequest;
  readonly [ipcChannels.setWorkspaceActive]: SetWorkspaceActiveRequest;
  readonly [ipcChannels.setWorkspaceArchived]: SetWorkspaceArchivedRequest;
  readonly [ipcChannels.deleteWorkspace]: DeleteWorkspaceRequest;
  readonly [ipcChannels.getDashboard]: undefined;
  readonly [ipcChannels.setPermissionProfile]: SetPermissionProfileRequest;
  readonly [ipcChannels.setUnrestrictedMode]: SetUnrestrictedModeRequest;
  readonly [ipcChannels.setAiDeletePolicy]: SetAiDeletePolicyRequest;
  readonly [ipcChannels.setStdioPolicy]: SetStdioPolicyRequest;
  readonly [ipcChannels.createBackup]: undefined;
  readonly [ipcChannels.scheduleRestoreBackup]: ScheduleRestoreBackupRequest;
  readonly [ipcChannels.restoreRecoveryItem]: RestoreRecoveryItemRequest;
  readonly [ipcChannels.restoreCheckpoint]: RestoreCheckpointRequest;
  readonly [ipcChannels.listProcesses]: undefined;
  readonly [ipcChannels.startProcess]: StartProcessRequest;
  readonly [ipcChannels.stopProcess]: StopProcessRequest;
  readonly [ipcChannels.startMcp]: StartMcpRequest;
  readonly [ipcChannels.stopMcp]: undefined;
  readonly [ipcChannels.restartMcp]: undefined;
  readonly [ipcChannels.clearWorkLog]: ClearWorkLogRequest | undefined;
  readonly [ipcChannels.saveTunnelApiKey]: SaveTunnelApiKeyRequest;
  readonly [ipcChannels.startTunnel]: undefined;
  readonly [ipcChannels.stopTunnel]: undefined;
  readonly [ipcChannels.getTunnelStatus]: undefined;
  readonly [ipcChannels.setTunnelClientPath]: SetTunnelClientPathRequest;
  readonly [ipcChannels.setLocale]: SetLocaleRequest;
  readonly [ipcChannels.setUserSettings]: SetUserSettingsRequest;
  readonly [ipcChannels.chooseTunnelClientPath]: undefined;
  readonly [ipcChannels.configureTunnelProfile]: ConfigureTunnelProfileRequest;
  readonly [ipcChannels.openExternalSetupPage]: OpenExternalSetupPageRequest;
  readonly [ipcChannels.launchManagedBrowser]: undefined;
  readonly [ipcChannels.installPdfProvider]: undefined;
  readonly [ipcChannels.runDoctor]: undefined;
  readonly [ipcChannels.getLogSnapshot]: undefined;
  readonly [ipcChannels.clearLogBuffer]: ClearLogBufferRequest;
  readonly [ipcChannels.exportLogs]: ExportLogsRequest;
  readonly [ipcChannels.exportWorkLog]: ExportWorkLogRequest;
  readonly [ipcChannels.captureIncident]: undefined;
  readonly [ipcChannels.openLogViewer]: undefined;
  readonly [ipcChannels.getUpdateStatus]: undefined;
  readonly [ipcChannels.checkForUpdates]: undefined;
  readonly [ipcChannels.installUpdate]: undefined;
}

export interface IpcResponseMap {
  readonly [ipcChannels.listWorkspaces]: readonly WorkspaceSummary[];
  readonly [ipcChannels.addWorkspace]: WorkspaceSummary;
  readonly [ipcChannels.selectWorkspace]: WorkspaceSummary;
  readonly [ipcChannels.setWorkspaceActive]: { readonly workspace: WorkspaceSummary; readonly active: boolean };
  readonly [ipcChannels.setWorkspaceArchived]: WorkspaceSummary;
  readonly [ipcChannels.deleteWorkspace]: { readonly deleted: boolean; readonly workspaceId: string; readonly rootPath: string; readonly backupId: string };
  readonly [ipcChannels.getDashboard]: DashboardSnapshot;
  readonly [ipcChannels.setPermissionProfile]: { readonly profile: PermissionProfileName };
  readonly [ipcChannels.setUnrestrictedMode]: { readonly unrestricted: boolean; readonly restartRequired: boolean };
  readonly [ipcChannels.setAiDeletePolicy]: { readonly enabled: boolean; readonly policy: DestructiveDeletePolicy };
  readonly [ipcChannels.setStdioPolicy]: { readonly profile: PermissionProfileName; readonly strictRoots: boolean; readonly allowedRoots: readonly string[]; readonly restartRequired: boolean };
  readonly [ipcChannels.createBackup]: BackupSummary;
  readonly [ipcChannels.scheduleRestoreBackup]: { readonly scheduled: boolean; readonly restartRequired: boolean };
  readonly [ipcChannels.restoreRecoveryItem]: { readonly restored: boolean; readonly path: string; readonly rollbackRecoveryId: string | null };
  readonly [ipcChannels.restoreCheckpoint]: { readonly restored: boolean; readonly paths: readonly string[]; readonly rollbackCheckpointId: string | null };
  readonly [ipcChannels.listProcesses]: readonly ProcessSummary[];
  readonly [ipcChannels.startProcess]: ProcessSummary;
  readonly [ipcChannels.stopProcess]: { readonly stopped: boolean };
  readonly [ipcChannels.startMcp]: McpConnectionStatus;
  readonly [ipcChannels.stopMcp]: McpConnectionStatus;
  readonly [ipcChannels.restartMcp]: McpConnectionStatus;
  readonly [ipcChannels.clearWorkLog]: { readonly cleared: boolean };
  readonly [ipcChannels.saveTunnelApiKey]: { readonly saved: boolean };
  readonly [ipcChannels.startTunnel]: TunnelStatus;
  readonly [ipcChannels.stopTunnel]: TunnelStatus;
  readonly [ipcChannels.getTunnelStatus]: TunnelStatus;
  readonly [ipcChannels.setTunnelClientPath]: { readonly clientPath: string };
  readonly [ipcChannels.setLocale]: { readonly locale: UiLocale };
  readonly [ipcChannels.setUserSettings]: { readonly settings: UserSettings; readonly restartRequired: boolean };
  readonly [ipcChannels.chooseTunnelClientPath]: { readonly clientPath: string | null };
  readonly [ipcChannels.configureTunnelProfile]: { readonly configured: boolean; readonly profilePath: string };
  readonly [ipcChannels.openExternalSetupPage]: { readonly opened: true };
  readonly [ipcChannels.launchManagedBrowser]: ManagedBrowserStatus;
  readonly [ipcChannels.installPdfProvider]: PdfProviderInstallResult;
  readonly [ipcChannels.runDoctor]: DoctorReport;
  readonly [ipcChannels.getToolCatalog]: ToolCatalogSnapshot;
  readonly [ipcChannels.recheckToolCatalog]: { readonly catalog: ToolCatalogSnapshot; readonly doctor: DoctorReport };
  readonly [ipcChannels.openToolSetupTarget]: { readonly opened: true };
  readonly [ipcChannels.copyToolCommand]: { readonly copied: true };
  readonly [ipcChannels.getLogSnapshot]: LogSnapshot;
  readonly [ipcChannels.clearLogBuffer]: { readonly cleared: boolean };
  readonly [ipcChannels.exportLogs]: { readonly exported: boolean };
  readonly [ipcChannels.exportWorkLog]: { readonly exported: boolean };
  readonly [ipcChannels.captureIncident]: IncidentExportResult;
  readonly [ipcChannels.openLogViewer]: { readonly opened: boolean };
  readonly [ipcChannels.getUpdateStatus]: UpdateStatus;
  readonly [ipcChannels.checkForUpdates]: UpdateStatus;
  readonly [ipcChannels.installUpdate]: { readonly accepted: boolean; readonly status: UpdateStatus };
}

export interface LnwjudApi {
  listWorkspaces(): Promise<IpcResponseMap[typeof ipcChannels.listWorkspaces]>;
  addWorkspace(request: AddWorkspaceRequest): Promise<IpcResponseMap[typeof ipcChannels.addWorkspace]>;
  selectWorkspace(request: SelectWorkspaceRequest): Promise<IpcResponseMap[typeof ipcChannels.selectWorkspace]>;
  setWorkspaceActive(request: SetWorkspaceActiveRequest): Promise<IpcResponseMap[typeof ipcChannels.setWorkspaceActive]>;
  setWorkspaceArchived(request: SetWorkspaceArchivedRequest): Promise<IpcResponseMap[typeof ipcChannels.setWorkspaceArchived]>;
  deleteWorkspace(request: DeleteWorkspaceRequest): Promise<IpcResponseMap[typeof ipcChannels.deleteWorkspace]>;
  getDashboard(): Promise<IpcResponseMap[typeof ipcChannels.getDashboard]>;
  setPermissionProfile(request: SetPermissionProfileRequest): Promise<IpcResponseMap[typeof ipcChannels.setPermissionProfile]>;
  setUnrestrictedMode(request: SetUnrestrictedModeRequest): Promise<IpcResponseMap[typeof ipcChannels.setUnrestrictedMode]>;
  setAiDeletePolicy(request: SetAiDeletePolicyRequest): Promise<IpcResponseMap[typeof ipcChannels.setAiDeletePolicy]>;
  setStdioPolicy(request: SetStdioPolicyRequest): Promise<IpcResponseMap[typeof ipcChannels.setStdioPolicy]>;
  createBackup(): Promise<IpcResponseMap[typeof ipcChannels.createBackup]>;
  scheduleRestoreBackup(request: ScheduleRestoreBackupRequest): Promise<IpcResponseMap[typeof ipcChannels.scheduleRestoreBackup]>;
  restoreRecoveryItem(request: RestoreRecoveryItemRequest): Promise<IpcResponseMap[typeof ipcChannels.restoreRecoveryItem]>;
  restoreCheckpoint(request: RestoreCheckpointRequest): Promise<IpcResponseMap[typeof ipcChannels.restoreCheckpoint]>;
  listProcesses(): Promise<IpcResponseMap[typeof ipcChannels.listProcesses]>;
  startProcess(request: StartProcessRequest): Promise<IpcResponseMap[typeof ipcChannels.startProcess]>;
  stopProcess(request: StopProcessRequest): Promise<IpcResponseMap[typeof ipcChannels.stopProcess]>;
  startMcp(request: StartMcpRequest): Promise<IpcResponseMap[typeof ipcChannels.startMcp]>;
  stopMcp(): Promise<IpcResponseMap[typeof ipcChannels.stopMcp]>;
  restartMcp(): Promise<IpcResponseMap[typeof ipcChannels.restartMcp]>;
  clearWorkLog(request?: ClearWorkLogRequest): Promise<IpcResponseMap[typeof ipcChannels.clearWorkLog]>;
  saveTunnelApiKey(request: SaveTunnelApiKeyRequest): Promise<IpcResponseMap[typeof ipcChannels.saveTunnelApiKey]>;
  startTunnel(): Promise<IpcResponseMap[typeof ipcChannels.startTunnel]>;
  stopTunnel(): Promise<IpcResponseMap[typeof ipcChannels.stopTunnel]>;
  getTunnelStatus(): Promise<IpcResponseMap[typeof ipcChannels.getTunnelStatus]>;
  setTunnelClientPath(request: SetTunnelClientPathRequest): Promise<IpcResponseMap[typeof ipcChannels.setTunnelClientPath]>;
  setLocale(request: SetLocaleRequest): Promise<IpcResponseMap[typeof ipcChannels.setLocale]>;
  setUserSettings(request: SetUserSettingsRequest): Promise<IpcResponseMap[typeof ipcChannels.setUserSettings]>;
  chooseTunnelClientPath(): Promise<IpcResponseMap[typeof ipcChannels.chooseTunnelClientPath]>;
  configureTunnelProfile(request: ConfigureTunnelProfileRequest): Promise<IpcResponseMap[typeof ipcChannels.configureTunnelProfile]>;
  openExternalSetupPage(request: OpenExternalSetupPageRequest): Promise<IpcResponseMap[typeof ipcChannels.openExternalSetupPage]>;
  launchManagedBrowser(): Promise<IpcResponseMap[typeof ipcChannels.launchManagedBrowser]>;
  installPdfProvider(): Promise<IpcResponseMap[typeof ipcChannels.installPdfProvider]>;
  runDoctor(): Promise<IpcResponseMap[typeof ipcChannels.runDoctor]>;
  getToolCatalog(request: GetToolCatalogRequest): Promise<IpcResponseMap[typeof ipcChannels.getToolCatalog]>;
  recheckToolCatalog(request: RecheckToolCatalogRequest): Promise<IpcResponseMap[typeof ipcChannels.recheckToolCatalog]>;
  openToolSetupTarget(request: OpenToolSetupTargetRequest): Promise<IpcResponseMap[typeof ipcChannels.openToolSetupTarget]>;
  copyToolCommand(request: CopyToolCommandRequest): Promise<IpcResponseMap[typeof ipcChannels.copyToolCommand]>;
  getLogSnapshot(): Promise<IpcResponseMap[typeof ipcChannels.getLogSnapshot]>;
  clearLogBuffer(request: ClearLogBufferRequest): Promise<IpcResponseMap[typeof ipcChannels.clearLogBuffer]>;
  exportLogs(request: ExportLogsRequest): Promise<IpcResponseMap[typeof ipcChannels.exportLogs]>;
  exportWorkLog(request: ExportWorkLogRequest): Promise<IpcResponseMap[typeof ipcChannels.exportWorkLog]>;
  captureIncident(): Promise<IpcResponseMap[typeof ipcChannels.captureIncident]>;
  openLogViewer(): Promise<IpcResponseMap[typeof ipcChannels.openLogViewer]>;
  getUpdateStatus(): Promise<IpcResponseMap[typeof ipcChannels.getUpdateStatus]>;
  checkForUpdates(): Promise<IpcResponseMap[typeof ipcChannels.checkForUpdates]>;
  installUpdate(): Promise<IpcResponseMap[typeof ipcChannels.installUpdate]>;
  onLogEvent(callback: (line: LogLine) => void): () => void;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
}
