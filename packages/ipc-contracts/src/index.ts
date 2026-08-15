export const ipcChannels = {
  listWorkspaces: 'lnwjud:list-workspaces',
  addWorkspace: 'lnwjud:add-workspace',
  selectWorkspace: 'lnwjud:select-workspace',
  getDashboard: 'lnwjud:get-dashboard',
  setPermissionProfile: 'lnwjud:set-permission-profile',
  setUnrestrictedMode: 'lnwjud:set-unrestricted-mode',
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
  launchManagedBrowser: 'lnwjud:launch-managed-browser',
  runDoctor: 'lnwjud:run-doctor',
  getLogSnapshot: 'lnwjud:get-log-snapshot',
  clearLogBuffer: 'lnwjud:clear-log-buffer',
  exportLogs: 'lnwjud:export-logs',
  openLogViewer: 'lnwjud:open-log-viewer',
} as const;

export const pushChannels = {
  logEvent: 'lnwjud:event:log',
} as const;

export type IpcChannel = typeof ipcChannels[keyof typeof ipcChannels];
export type PermissionProfileName = 'safe' | 'balanced' | 'full' | 'custom';
export type UiLocale = 'th' | 'en';
export type AgentState = 'stopped' | 'idle' | 'busy';
export type TunnelRunState = 'stopped' | 'starting' | 'running' | 'error';

export interface WorkspaceSummary {
  readonly id: string;
  readonly displayName: string;
  readonly rootPath: string;
  readonly realRootPath: string;
  readonly createdAt: string;
}

export type CapabilityToolName = 'shell' | 'dom_cdp' | 'accessibility' | 'input_event' | 'vision' | 'window' | 'health';

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
  readonly targetSummary: string | null;
  readonly durationMs: number;
  readonly workspaceId: string | null;
}

export interface InFlightWorkItem {
  readonly callId: string;
  readonly toolName: string;
  readonly startedAt: string;
  readonly targetSummary: string | null;
  readonly workspaceId: string | null;
}

export interface ConnectionModes {
  readonly httpUrl: string | null;
  readonly stdioCommand: string;
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
}

export type LogSource = 'tunnel' | 'mcp' | 'process';
export type LogLevel = 'info' | 'warn' | 'error';

export interface LogLine {
  readonly id: number;
  readonly source: LogSource;
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly text: string;
}

export interface LogSnapshot {
  readonly lines: readonly LogLine[];
  readonly tunnelLogPath: string | null;
  readonly tunnelLogExists: boolean;
}

export interface ClearLogBufferRequest {
  readonly source: LogSource;
}

export interface ExportLogsRequest {
  readonly source: LogSource;
  readonly filePath: string;
}

export interface DashboardSnapshot {
  readonly selectedWorkspace: WorkspaceSummary | null;
  readonly gitSummary: {
    readonly branch: string | null;
    readonly changedFiles: number;
    readonly stagedFiles: number;
    readonly message: string;
  };
  readonly mcp: {
    readonly running: boolean;
    readonly url: string | null;
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
  readonly connectionModes: ConnectionModes;
  readonly workLog: readonly WorkLogEntry[];
  readonly inFlight: readonly InFlightWorkItem[];
  readonly tunnel: TunnelStatus;
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
  readonly executable: string;
  readonly args: readonly string[];
  readonly state: 'starting' | 'running' | 'exited' | 'failed' | 'stopped' | 'timed_out';
  readonly logSummary: string;
}

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  readonly id: string;
  readonly required: boolean;
  readonly status: DoctorCheckStatus;
  readonly message: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly exitCode: 0 | 1;
}

export interface AddWorkspaceRequest {
  readonly rootPath: string;
}

export interface SelectWorkspaceRequest {
  readonly workspaceId: string;
}

export interface SetPermissionProfileRequest {
  readonly profile: PermissionProfileName;
}

export interface SetUnrestrictedModeRequest {
  readonly enabled: boolean;
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

export interface McpConnectionStatus {
  readonly running: boolean;
  readonly url: string | null;
  readonly workspaceId: string | null;
}

export interface ManagedBrowserStatus {
  readonly ready: boolean;
  readonly port: number;
  readonly launched: boolean;
}

export interface IpcRequestMap {
  readonly [ipcChannels.listWorkspaces]: undefined;
  readonly [ipcChannels.addWorkspace]: AddWorkspaceRequest;
  readonly [ipcChannels.selectWorkspace]: SelectWorkspaceRequest;
  readonly [ipcChannels.getDashboard]: undefined;
  readonly [ipcChannels.setPermissionProfile]: SetPermissionProfileRequest;
  readonly [ipcChannels.setUnrestrictedMode]: SetUnrestrictedModeRequest;
  readonly [ipcChannels.listProcesses]: undefined;
  readonly [ipcChannels.startProcess]: StartProcessRequest;
  readonly [ipcChannels.stopProcess]: StopProcessRequest;
  readonly [ipcChannels.startMcp]: StartMcpRequest;
  readonly [ipcChannels.stopMcp]: undefined;
  readonly [ipcChannels.restartMcp]: undefined;
  readonly [ipcChannels.clearWorkLog]: undefined;
  readonly [ipcChannels.saveTunnelApiKey]: SaveTunnelApiKeyRequest;
  readonly [ipcChannels.startTunnel]: undefined;
  readonly [ipcChannels.stopTunnel]: undefined;
  readonly [ipcChannels.getTunnelStatus]: undefined;
  readonly [ipcChannels.setTunnelClientPath]: SetTunnelClientPathRequest;
  readonly [ipcChannels.setLocale]: SetLocaleRequest;
  readonly [ipcChannels.launchManagedBrowser]: undefined;
  readonly [ipcChannels.runDoctor]: undefined;
  readonly [ipcChannels.getLogSnapshot]: undefined;
  readonly [ipcChannels.clearLogBuffer]: ClearLogBufferRequest;
  readonly [ipcChannels.exportLogs]: ExportLogsRequest;
  readonly [ipcChannels.openLogViewer]: undefined;
}

export interface IpcResponseMap {
  readonly [ipcChannels.listWorkspaces]: readonly WorkspaceSummary[];
  readonly [ipcChannels.addWorkspace]: WorkspaceSummary;
  readonly [ipcChannels.selectWorkspace]: WorkspaceSummary;
  readonly [ipcChannels.getDashboard]: DashboardSnapshot;
  readonly [ipcChannels.setPermissionProfile]: { readonly profile: PermissionProfileName };
  readonly [ipcChannels.setUnrestrictedMode]: { readonly unrestricted: boolean; readonly restartRequired: boolean };
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
  readonly [ipcChannels.launchManagedBrowser]: ManagedBrowserStatus;
  readonly [ipcChannels.runDoctor]: DoctorReport;
  readonly [ipcChannels.getLogSnapshot]: LogSnapshot;
  readonly [ipcChannels.clearLogBuffer]: { readonly cleared: boolean };
  readonly [ipcChannels.exportLogs]: { readonly exported: boolean };
  readonly [ipcChannels.openLogViewer]: { readonly opened: boolean };
}

export interface LnwjudApi {
  listWorkspaces(): Promise<IpcResponseMap[typeof ipcChannels.listWorkspaces]>;
  addWorkspace(request: AddWorkspaceRequest): Promise<IpcResponseMap[typeof ipcChannels.addWorkspace]>;
  selectWorkspace(request: SelectWorkspaceRequest): Promise<IpcResponseMap[typeof ipcChannels.selectWorkspace]>;
  getDashboard(): Promise<IpcResponseMap[typeof ipcChannels.getDashboard]>;
  setPermissionProfile(request: SetPermissionProfileRequest): Promise<IpcResponseMap[typeof ipcChannels.setPermissionProfile]>;
  setUnrestrictedMode(request: SetUnrestrictedModeRequest): Promise<IpcResponseMap[typeof ipcChannels.setUnrestrictedMode]>;
  listProcesses(): Promise<IpcResponseMap[typeof ipcChannels.listProcesses]>;
  startProcess(request: StartProcessRequest): Promise<IpcResponseMap[typeof ipcChannels.startProcess]>;
  stopProcess(request: StopProcessRequest): Promise<IpcResponseMap[typeof ipcChannels.stopProcess]>;
  startMcp(request: StartMcpRequest): Promise<IpcResponseMap[typeof ipcChannels.startMcp]>;
  stopMcp(): Promise<IpcResponseMap[typeof ipcChannels.stopMcp]>;
  restartMcp(): Promise<IpcResponseMap[typeof ipcChannels.restartMcp]>;
  clearWorkLog(): Promise<IpcResponseMap[typeof ipcChannels.clearWorkLog]>;
  saveTunnelApiKey(request: SaveTunnelApiKeyRequest): Promise<IpcResponseMap[typeof ipcChannels.saveTunnelApiKey]>;
  startTunnel(): Promise<IpcResponseMap[typeof ipcChannels.startTunnel]>;
  stopTunnel(): Promise<IpcResponseMap[typeof ipcChannels.stopTunnel]>;
  getTunnelStatus(): Promise<IpcResponseMap[typeof ipcChannels.getTunnelStatus]>;
  setTunnelClientPath(request: SetTunnelClientPathRequest): Promise<IpcResponseMap[typeof ipcChannels.setTunnelClientPath]>;
  setLocale(request: SetLocaleRequest): Promise<IpcResponseMap[typeof ipcChannels.setLocale]>;
  launchManagedBrowser(): Promise<IpcResponseMap[typeof ipcChannels.launchManagedBrowser]>;
  runDoctor(): Promise<IpcResponseMap[typeof ipcChannels.runDoctor]>;
  getLogSnapshot(): Promise<IpcResponseMap[typeof ipcChannels.getLogSnapshot]>;
  clearLogBuffer(request: ClearLogBufferRequest): Promise<IpcResponseMap[typeof ipcChannels.clearLogBuffer]>;
  exportLogs(request: ExportLogsRequest): Promise<IpcResponseMap[typeof ipcChannels.exportLogs]>;
  openLogViewer(): Promise<IpcResponseMap[typeof ipcChannels.openLogViewer]>;
  onLogEvent(callback: (line: LogLine) => void): () => void;
}
