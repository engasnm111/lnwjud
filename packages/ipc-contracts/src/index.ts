export const ipcChannels = {
  listWorkspaces: 'lnwjud:list-workspaces',
  addWorkspace: 'lnwjud:add-workspace',
  getDashboard: 'lnwjud:get-dashboard',
  setPermissionProfile: 'lnwjud:set-permission-profile',
  listProcesses: 'lnwjud:list-processes',
  startProcess: 'lnwjud:start-process',
  stopProcess: 'lnwjud:stop-process',
  startMcp: 'lnwjud:start-mcp',
  stopMcp: 'lnwjud:stop-mcp',
  runDoctor: 'lnwjud:run-doctor',
} as const;

export type IpcChannel = typeof ipcChannels[keyof typeof ipcChannels];
export type PermissionProfileName = 'safe' | 'balanced' | 'full' | 'custom';

export interface WorkspaceSummary {
  readonly id: string;
  readonly displayName: string;
  readonly rootPath: string;
  readonly realRootPath: string;
  readonly createdAt: string;
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

export interface SetPermissionProfileRequest {
  readonly profile: PermissionProfileName;
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

export interface McpConnectionStatus {
  readonly running: boolean;
  readonly url: string | null;
  readonly workspaceId: string | null;
}

export interface IpcRequestMap {
  readonly [ipcChannels.listWorkspaces]: undefined;
  readonly [ipcChannels.addWorkspace]: AddWorkspaceRequest;
  readonly [ipcChannels.getDashboard]: undefined;
  readonly [ipcChannels.setPermissionProfile]: SetPermissionProfileRequest;
  readonly [ipcChannels.listProcesses]: undefined;
  readonly [ipcChannels.startProcess]: StartProcessRequest;
  readonly [ipcChannels.stopProcess]: StopProcessRequest;
  readonly [ipcChannels.startMcp]: StartMcpRequest;
  readonly [ipcChannels.stopMcp]: undefined;
  readonly [ipcChannels.runDoctor]: undefined;
}

export interface IpcResponseMap {
  readonly [ipcChannels.listWorkspaces]: readonly WorkspaceSummary[];
  readonly [ipcChannels.addWorkspace]: WorkspaceSummary;
  readonly [ipcChannels.getDashboard]: DashboardSnapshot;
  readonly [ipcChannels.setPermissionProfile]: { readonly profile: PermissionProfileName };
  readonly [ipcChannels.listProcesses]: readonly ProcessSummary[];
  readonly [ipcChannels.startProcess]: ProcessSummary;
  readonly [ipcChannels.stopProcess]: { readonly stopped: boolean };
  readonly [ipcChannels.startMcp]: McpConnectionStatus;
  readonly [ipcChannels.stopMcp]: McpConnectionStatus;
  readonly [ipcChannels.runDoctor]: DoctorReport;
}

export interface LnwjudApi {
  listWorkspaces(): Promise<IpcResponseMap[typeof ipcChannels.listWorkspaces]>;
  addWorkspace(request: AddWorkspaceRequest): Promise<IpcResponseMap[typeof ipcChannels.addWorkspace]>;
  getDashboard(): Promise<IpcResponseMap[typeof ipcChannels.getDashboard]>;
  setPermissionProfile(request: SetPermissionProfileRequest): Promise<IpcResponseMap[typeof ipcChannels.setPermissionProfile]>;
  listProcesses(): Promise<IpcResponseMap[typeof ipcChannels.listProcesses]>;
  startProcess(request: StartProcessRequest): Promise<IpcResponseMap[typeof ipcChannels.startProcess]>;
  stopProcess(request: StopProcessRequest): Promise<IpcResponseMap[typeof ipcChannels.stopProcess]>;
  startMcp(request: StartMcpRequest): Promise<IpcResponseMap[typeof ipcChannels.startMcp]>;
  stopMcp(): Promise<IpcResponseMap[typeof ipcChannels.stopMcp]>;
  runDoctor(): Promise<IpcResponseMap[typeof ipcChannels.runDoctor]>;
}
