import { contextBridge, ipcRenderer } from 'electron';
import {
  ipcChannels,
  type AddWorkspaceRequest,
  type DashboardSnapshot,
  type DoctorCheck,
  type DoctorReport,
  type LnwjudApi,
  type McpConnectionStatus,
  type PermissionProfileName,
  type ProcessSummary,
  type StartMcpRequest,
  type SetPermissionProfileRequest,
  type StartProcessRequest,
  type StopProcessRequest,
  type WorkspaceSummary,
} from '@lnwjud/ipc-contracts';

function invoke(channel: string, payload?: unknown): Promise<unknown> {
  return payload === undefined ? ipcRenderer.invoke(channel) : ipcRenderer.invoke(channel, payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, field: string): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== 'string') throw new Error('Invalid IPC response');
  return fieldValue;
}

function booleanField(value: Record<string, unknown>, field: string): boolean {
  const fieldValue = value[field];
  if (typeof fieldValue !== 'boolean') throw new Error('Invalid IPC response');
  return fieldValue;
}

function numberField(value: Record<string, unknown>, field: string): number {
  const fieldValue = value[field];
  if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) throw new Error('Invalid IPC response');
  return fieldValue;
}

function workspaceSummary(value: unknown): WorkspaceSummary {
  if (!isRecord(value)) throw new Error('Invalid IPC response');
  return {
    id: stringField(value, 'id'),
    displayName: stringField(value, 'displayName'),
    rootPath: stringField(value, 'rootPath'),
    realRootPath: stringField(value, 'realRootPath'),
    createdAt: stringField(value, 'createdAt'),
  };
}

function workspaceList(value: unknown): readonly WorkspaceSummary[] {
  if (!Array.isArray(value)) throw new Error('Invalid IPC response');
  return value.map(workspaceSummary);
}

function permissionProfile(value: unknown): PermissionProfileName {
  if (value === 'safe' || value === 'balanced' || value === 'full' || value === 'custom') return value;
  throw new Error('Invalid IPC response');
}

function dashboard(value: unknown): DashboardSnapshot {
  if (!isRecord(value) || !isRecord(value.gitSummary) || !isRecord(value.mcp) || !isRecord(value.codex)) {
    throw new Error('Invalid IPC response');
  }
  const selectedWorkspace = value.selectedWorkspace === null ? null : workspaceSummary(value.selectedWorkspace);
  const url = value.mcp.url;
  const version = value.codex.version;
  if ((url !== null && typeof url !== 'string') || (version !== null && typeof version !== 'string')) {
    throw new Error('Invalid IPC response');
  }
  return {
    selectedWorkspace,
    gitSummary: {
      branch: value.gitSummary.branch === null ? null : stringField(value.gitSummary, 'branch'),
      changedFiles: numberField(value.gitSummary, 'changedFiles'),
      stagedFiles: numberField(value.gitSummary, 'stagedFiles'),
      message: stringField(value.gitSummary, 'message'),
    },
    mcp: mcpStatus(value.mcp),
    codex: { installed: booleanField(value.codex, 'installed'), version },
    managedProcessCount: numberField(value, 'managedProcessCount'),
    auditEventCount: numberField(value, 'auditEventCount'),
    recentAuditEvents: auditEventSummaries(value.recentAuditEvents),
    permissionProfile: permissionProfile(value.permissionProfile),
  };
}

function mcpStatus(value: unknown): McpConnectionStatus {
  if (!isRecord(value)) throw new Error('Invalid IPC response');
  const url = value.url;
  const workspaceId = value.workspaceId;
  if ((url !== null && typeof url !== 'string') || (workspaceId !== null && typeof workspaceId !== 'string')) {
    throw new Error('Invalid IPC response');
  }
  return { running: booleanField(value, 'running'), url, workspaceId };
}

function auditEventSummaries(value: unknown): DashboardSnapshot['recentAuditEvents'] {
  if (!Array.isArray(value)) throw new Error('Invalid IPC response');
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error('Invalid IPC response');
    return {
      id: stringField(entry, 'id'),
      timestamp: stringField(entry, 'timestamp'),
      action: stringField(entry, 'action'),
      resultCode: stringField(entry, 'resultCode'),
    };
  });
}

function processSummary(value: unknown): ProcessSummary {
  if (!isRecord(value) || !Array.isArray(value.args)) throw new Error('Invalid IPC response');
  const state = processState(value.state);
  if (value.args.some((arg) => typeof arg !== 'string')) throw new Error('Invalid IPC response');
  return {
    id: stringField(value, 'id'),
    workspaceId: stringField(value, 'workspaceId'),
    executable: stringField(value, 'executable'),
    args: value.args,
    state,
    logSummary: stringField(value, 'logSummary'),
  };
}

function processState(value: unknown): ProcessSummary['state'] {
  if (value === 'starting' || value === 'running' || value === 'exited' || value === 'failed' || value === 'stopped' || value === 'timed_out') {
    return value;
  }
  throw new Error('Invalid IPC response');
}

function processList(value: unknown): readonly ProcessSummary[] {
  if (!Array.isArray(value)) throw new Error('Invalid IPC response');
  return value.map(processSummary);
}

function doctorReport(value: unknown): DoctorReport {
  if (!isRecord(value) || !Array.isArray(value.checks) || (value.exitCode !== 0 && value.exitCode !== 1)) {
    throw new Error('Invalid IPC response');
  }
  const checks: readonly DoctorCheck[] = value.checks.map((check) => {
    if (!isRecord(check) || typeof check.required !== 'boolean') throw new Error('Invalid IPC response');
    const status = check.status;
    if (status !== 'pass' && status !== 'warn' && status !== 'fail') throw new Error('Invalid IPC response');
    return {
      id: stringField(check, 'id'),
      required: check.required,
      status,
      message: stringField(check, 'message'),
    };
  });
  return { checks, exitCode: value.exitCode };
}

function addWorkspace(request: AddWorkspaceRequest): Promise<WorkspaceSummary> {
  if (!isRecord(request) || typeof request.rootPath !== 'string' || request.rootPath.trim().length === 0) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.addWorkspace, { rootPath: request.rootPath }).then(workspaceSummary);
}

function setPermissionProfile(request: SetPermissionProfileRequest): Promise<{ readonly profile: PermissionProfileName }> {
  if (!isRecord(request)) return Promise.reject(new Error('Invalid IPC request'));
  const profile = permissionProfile(request.profile);
  return invoke(ipcChannels.setPermissionProfile, { profile }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { profile: permissionProfile(value.profile) };
  });
}

function stopProcess(request: StopProcessRequest): Promise<{ readonly stopped: boolean }> {
  if (!isRecord(request) || typeof request.processId !== 'string' || request.processId.trim().length === 0) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.stopProcess, { processId: request.processId }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { stopped: booleanField(value, 'stopped') };
  });
}

function startProcess(request: StartProcessRequest): Promise<ProcessSummary> {
  if (!isRecord(request) || typeof request.workspaceId !== 'string' || request.workspaceId.trim().length === 0
    || (request.mode !== 'fixture' && request.mode !== 'project-dev')) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.startProcess, { workspaceId: request.workspaceId, mode: request.mode }).then(processSummary);
}

function startMcp(request: StartMcpRequest): Promise<McpConnectionStatus> {
  if (!isRecord(request) || typeof request.workspaceId !== 'string' || request.workspaceId.trim().length === 0) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.startMcp, { workspaceId: request.workspaceId }).then(mcpStatus);
}

function stopMcp(): Promise<McpConnectionStatus> {
  return invoke(ipcChannels.stopMcp).then(mcpStatus);
}

const api: LnwjudApi = {
  listWorkspaces: () => invoke(ipcChannels.listWorkspaces).then(workspaceList),
  addWorkspace,
  getDashboard: () => invoke(ipcChannels.getDashboard).then(dashboard),
  setPermissionProfile,
  listProcesses: () => invoke(ipcChannels.listProcesses).then(processList),
  startProcess,
  stopProcess,
  startMcp,
  stopMcp,
  runDoctor: () => invoke(ipcChannels.runDoctor).then(doctorReport),
};

contextBridge.exposeInMainWorld('lnwjud', api);
