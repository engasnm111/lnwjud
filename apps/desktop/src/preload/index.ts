import { contextBridge, ipcRenderer } from 'electron';
import {
  ipcChannels,
  pushChannels,
  type AddWorkspaceRequest,
  type AgentState,
  type ClearLogBufferRequest,
  type DashboardSnapshot,
  type DoctorCheck,
  type DoctorReport,
  type ExportLogsRequest,
  type InFlightWorkItem,
  type LnwjudApi,
  type LogLine,
  type LogSnapshot,
  type ManagedBrowserStatus,
  type McpConnectionStatus,
  type PermissionProfileName,
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

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw new Error('Invalid IPC response');
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

function agentState(value: unknown): AgentState {
  if (value === 'stopped' || value === 'idle' || value === 'busy') return value;
  throw new Error('Invalid IPC response');
}

function uiLocale(value: unknown): UiLocale {
  if (value === 'th' || value === 'en') return value;
  throw new Error('Invalid IPC response');
}

function workLogEntries(value: unknown): readonly WorkLogEntry[] {
  if (!Array.isArray(value)) throw new Error('Invalid IPC response');
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error('Invalid IPC response');
    const kind = entry.kind;
    if (kind !== 'task' && kind !== 'result' && kind !== 'error') throw new Error('Invalid IPC response');
    return {
      id: stringField(entry, 'id'),
      timestamp: stringField(entry, 'timestamp'),
      kind,
      toolName: stringField(entry, 'toolName'),
      resultCode: stringField(entry, 'resultCode'),
      targetSummary: nullableString(entry.targetSummary),
      durationMs: numberField(entry, 'durationMs'),
      workspaceId: nullableString(entry.workspaceId),
    };
  });
}

function inFlightItems(value: unknown): readonly InFlightWorkItem[] {
  if (!Array.isArray(value)) throw new Error('Invalid IPC response');
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error('Invalid IPC response');
    return {
      callId: stringField(entry, 'callId'),
      toolName: stringField(entry, 'toolName'),
      startedAt: stringField(entry, 'startedAt'),
      targetSummary: nullableString(entry.targetSummary),
      workspaceId: nullableString(entry.workspaceId),
    };
  });
}

function tunnelStatus(value: unknown): TunnelStatus {
  if (!isRecord(value)) throw new Error('Invalid IPC response');
  const state = value.state;
  const source = value.source;
  if (state !== 'stopped' && state !== 'starting' && state !== 'running' && state !== 'error') {
    throw new Error('Invalid IPC response');
  }
  if (source !== 'desktop' && source !== 'external') throw new Error('Invalid IPC response');
  return {
    state,
    source,
    hasApiKey: booleanField(value, 'hasApiKey'),
    clientPath: nullableString(value.clientPath),
    profileExists: booleanField(value, 'profileExists'),
    message: nullableString(value.message),
    logPath: nullableString(value.logPath),
  };
}

function dashboard(value: unknown): DashboardSnapshot {
  if (!isRecord(value) || !isRecord(value.gitSummary) || !isRecord(value.mcp) || !isRecord(value.codex)
    || !isRecord(value.connectionModes) || value.mode !== 'WORK') {
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
    capabilities: capabilitySummaries(value.capabilities),
    agentState: agentState(value.agentState),
    mode: 'WORK',
    locale: uiLocale(value.locale),
    unrestricted: booleanField(value, 'unrestricted'),
    connectionModes: {
      httpUrl: nullableString(value.connectionModes.httpUrl),
      stdioCommand: stringField(value.connectionModes, 'stdioCommand'),
    },
    workLog: workLogEntries(value.workLog),
    inFlight: inFlightItems(value.inFlight),
    tunnel: tunnelStatus(value.tunnel),
    appVersion: stringField(value, 'appVersion'),
  };
}

function capabilitySummaries(value: unknown): DashboardSnapshot['capabilities'] {
  if (!Array.isArray(value)) throw new Error('Invalid IPC response');
  return value.map((entry) => {
    if (!isRecord(entry) || !isCapabilityToolName(entry.name)) throw new Error('Invalid IPC response');
    return {
      name: entry.name,
      title: stringField(entry, 'title'),
      description: stringField(entry, 'description'),
      available: booleanField(entry, 'available'),
      ready: booleanField(entry, 'ready'),
    };
  });
}

function isCapabilityToolName(value: unknown): value is DashboardSnapshot['capabilities'][number]['name'] {
  return value === 'shell' || value === 'dom_cdp' || value === 'accessibility' || value === 'input_event'
    || value === 'vision' || value === 'window' || value === 'health';
}

function mcpStatus(value: unknown): McpConnectionStatus {
  if (!isRecord(value)) throw new Error('Invalid IPC response');
  return {
    running: booleanField(value, 'running'),
    url: nullableString(value.url),
    workspaceId: nullableString(value.workspaceId),
  };
}

function managedBrowserStatus(value: unknown): ManagedBrowserStatus {
  if (!isRecord(value) || typeof value.ready !== 'boolean' || typeof value.port !== 'number'
    || !Number.isInteger(value.port) || typeof value.launched !== 'boolean') {
    throw new Error('Invalid IPC response');
  }
  return { ready: value.ready, port: value.port, launched: value.launched };
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

function selectWorkspace(request: SelectWorkspaceRequest): Promise<WorkspaceSummary> {
  if (!isRecord(request) || typeof request.workspaceId !== 'string' || request.workspaceId.trim().length === 0) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.selectWorkspace, { workspaceId: request.workspaceId }).then(workspaceSummary);
}

function setPermissionProfile(request: SetPermissionProfileRequest): Promise<{ readonly profile: PermissionProfileName }> {
  if (!isRecord(request)) return Promise.reject(new Error('Invalid IPC request'));
  const profile = permissionProfile(request.profile);
  return invoke(ipcChannels.setPermissionProfile, { profile }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { profile: permissionProfile(value.profile) };
  });
}

function setUnrestrictedMode(request: SetUnrestrictedModeRequest): Promise<{ readonly unrestricted: boolean; readonly restartRequired: boolean }> {
  if (!isRecord(request) || typeof request.enabled !== 'boolean') {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.setUnrestrictedMode, { enabled: request.enabled }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { unrestricted: booleanField(value, 'unrestricted'), restartRequired: booleanField(value, 'restartRequired') };
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

function restartMcp(): Promise<McpConnectionStatus> {
  return invoke(ipcChannels.restartMcp).then(mcpStatus);
}

function clearWorkLog(): Promise<{ readonly cleared: boolean }> {
  return invoke(ipcChannels.clearWorkLog).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { cleared: booleanField(value, 'cleared') };
  });
}

function saveTunnelApiKey(request: SaveTunnelApiKeyRequest): Promise<{ readonly saved: boolean }> {
  if (!isRecord(request) || typeof request.apiKey !== 'string' || request.apiKey.trim().length === 0) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.saveTunnelApiKey, { apiKey: request.apiKey }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { saved: booleanField(value, 'saved') };
  });
}

function setTunnelClientPath(request: SetTunnelClientPathRequest): Promise<{ readonly clientPath: string }> {
  if (!isRecord(request) || typeof request.clientPath !== 'string' || request.clientPath.trim().length === 0) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.setTunnelClientPath, { clientPath: request.clientPath }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { clientPath: stringField(value, 'clientPath') };
  });
}

function setLocale(request: SetLocaleRequest): Promise<{ readonly locale: UiLocale }> {
  if (!isRecord(request) || (request.locale !== 'th' && request.locale !== 'en')) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.setLocale, { locale: request.locale }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { locale: uiLocale(value.locale) };
  });
}

function launchManagedBrowser(): Promise<ManagedBrowserStatus> {
  return invoke(ipcChannels.launchManagedBrowser).then(managedBrowserStatus);
}

function logLine(value: unknown): LogLine {
  if (!isRecord(value) || !isLogSource(value.source) || !isLogLevel(value.level)) throw new Error('Invalid IPC response');
  return {
    id: numberField(value, 'id'),
    source: value.source,
    timestamp: stringField(value, 'timestamp'),
    level: value.level,
    text: stringField(value, 'text'),
  };
}

function logSnapshot(value: unknown): LogSnapshot {
  if (!isRecord(value) || !Array.isArray(value.lines)) throw new Error('Invalid IPC response');
  return {
    lines: value.lines.map(logLine),
    tunnelLogPath: nullableString(value.tunnelLogPath),
    tunnelLogExists: booleanField(value, 'tunnelLogExists'),
  };
}

function isLogSource(value: unknown): value is 'tunnel' | 'mcp' | 'process' {
  return value === 'tunnel' || value === 'mcp' || value === 'process';
}

function isLogLevel(value: unknown): value is 'info' | 'warn' | 'error' {
  return value === 'info' || value === 'warn' || value === 'error';
}

function clearLogBuffer(request: ClearLogBufferRequest): Promise<{ readonly cleared: boolean }> {
  if (!isRecord(request) || !isLogSource(request.source)) return Promise.reject(new Error('Invalid IPC request'));
  return invoke(ipcChannels.clearLogBuffer, { source: request.source }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { cleared: booleanField(value, 'cleared') };
  });
}

function exportLogs(request: ExportLogsRequest): Promise<{ readonly exported: boolean }> {
  if (!isRecord(request) || !isLogSource(request.source)) {
    return Promise.reject(new Error('Invalid IPC request'));
  }
  return invoke(ipcChannels.exportLogs, { source: request.source, filePath: request.filePath ?? '' }).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { exported: booleanField(value, 'exported') };
  });
}

function onLogEvent(callback: (line: LogLine) => void): () => void {
  const listener = (_event: unknown, payload: unknown): void => {
    try {
      callback(logLine(payload));
    } catch {
      // Ignore malformed push events.
    }
  };
  ipcRenderer.on(pushChannels.logEvent, listener);
  return (): void => {
    ipcRenderer.removeListener(pushChannels.logEvent, listener);
  };
}

const api: LnwjudApi = {
  listWorkspaces: () => invoke(ipcChannels.listWorkspaces).then(workspaceList),
  addWorkspace,
  selectWorkspace,
  getDashboard: () => invoke(ipcChannels.getDashboard).then(dashboard),
  setPermissionProfile,
  setUnrestrictedMode,
  listProcesses: () => invoke(ipcChannels.listProcesses).then(processList),
  startProcess,
  stopProcess,
  startMcp,
  stopMcp,
  restartMcp,
  clearWorkLog,
  saveTunnelApiKey,
  startTunnel: () => invoke(ipcChannels.startTunnel).then(tunnelStatus),
  stopTunnel: () => invoke(ipcChannels.stopTunnel).then(tunnelStatus),
  getTunnelStatus: () => invoke(ipcChannels.getTunnelStatus).then(tunnelStatus),
  setTunnelClientPath,
  setLocale,
  launchManagedBrowser,
  runDoctor: () => invoke(ipcChannels.runDoctor).then(doctorReport),
  getLogSnapshot: () => invoke(ipcChannels.getLogSnapshot).then(logSnapshot),
  clearLogBuffer,
  exportLogs,
  openLogViewer: () => invoke(ipcChannels.openLogViewer).then((value: unknown) => {
    if (!isRecord(value)) throw new Error('Invalid IPC response');
    return { opened: booleanField(value, 'opened') };
  }),
  onLogEvent,
};

contextBridge.exposeInMainWorld('lnwjud', api);
