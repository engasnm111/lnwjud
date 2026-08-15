import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { writeFile } from 'node:fs/promises';
import {
  ipcChannels,
  pushChannels,
  type AddWorkspaceRequest,
  type ClearLogBufferRequest,
  type DashboardSnapshot,
  type DoctorReport,
  type ExportLogsRequest,
  type IpcResponseMap,
  type LogSnapshot,
  type ManagedBrowserStatus,
  type McpConnectionStatus,
  type ProcessSummary,
  type PermissionProfileName,
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
  type WorkspaceSummary,
} from '@lnwjud/ipc-contracts';
import { startMcpStdio } from '@lnwjud/mcp-server';
import { createDesktopRuntime, type DesktopRuntime } from './desktop-services.js';
import { createLogViewerWindow, createMainWindow, getRendererEntryPath, isAllowedRendererUrl } from './window.js';

export interface DesktopIpcServices {
  listWorkspaces(): Promise<IpcResponseMap[typeof ipcChannels.listWorkspaces]>;
  addWorkspace(request: AddWorkspaceRequest): Promise<WorkspaceSummary>;
  selectWorkspace(request: SelectWorkspaceRequest): Promise<WorkspaceSummary>;
  getDashboard(): Promise<DashboardSnapshot>;
  setPermissionProfile(request: SetPermissionProfileRequest): Promise<{ readonly profile: PermissionProfileName }>;
  setUnrestrictedMode(request: SetUnrestrictedModeRequest): Promise<{ readonly unrestricted: boolean; readonly restartRequired: boolean }>;
  listProcesses(): Promise<IpcResponseMap[typeof ipcChannels.listProcesses]>;
  startProcess(request: StartProcessRequest): Promise<IpcResponseMap[typeof ipcChannels.startProcess]>;
  stopProcess(request: StopProcessRequest): Promise<{ readonly stopped: boolean }>;
  startMcp(request: StartMcpRequest): Promise<McpConnectionStatus>;
  stopMcp(): Promise<McpConnectionStatus>;
  restartMcp(): Promise<McpConnectionStatus>;
  clearWorkLog(): Promise<{ readonly cleared: boolean }>;
  saveTunnelApiKey(request: SaveTunnelApiKeyRequest): Promise<{ readonly saved: boolean }>;
  startTunnel(): Promise<TunnelStatus>;
  stopTunnel(): Promise<TunnelStatus>;
  getTunnelStatus(): Promise<TunnelStatus>;
  setTunnelClientPath(request: SetTunnelClientPathRequest): Promise<{ readonly clientPath: string }>;
  setLocale(request: SetLocaleRequest): Promise<{ readonly locale: UiLocale }>;
  launchManagedBrowser(): Promise<ManagedBrowserStatus>;
  runDoctor(): Promise<DoctorReport>;
  getLogSnapshot(): Promise<LogSnapshot>;
  clearLogBuffer(request: ClearLogBufferRequest): Promise<{ readonly cleared: boolean }>;
}

export type MainWindowProvider = () => BrowserWindow | null;

const emptyTunnel: TunnelStatus = {
  state: 'stopped',
  source: 'desktop',
  hasApiKey: false,
  clientPath: null,
  profileExists: false,
  message: null,
  logPath: null,
};

const defaultDesktopServices: DesktopIpcServices = {
  listWorkspaces: async (): Promise<readonly WorkspaceSummary[]> => [],
  addWorkspace: async (): Promise<WorkspaceSummary> => {
    throw new Error('Workspace service is not configured');
  },
  selectWorkspace: async (): Promise<WorkspaceSummary> => {
    throw new Error('Workspace service is not configured');
  },
  getDashboard: async (): Promise<DashboardSnapshot> => ({
    selectedWorkspace: null,
    gitSummary: { branch: null, changedFiles: 0, stagedFiles: 0, message: 'No workspace selected' },
    mcp: { running: false, url: null, workspaceId: null },
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
    connectionModes: { httpUrl: null, stdioCommand: 'lnwjud.exe --mcp-stdio' },
    workLog: [],
    inFlight: [],
    tunnel: emptyTunnel,
    appVersion: '0.1.0',
  }),
  setPermissionProfile: async (request): Promise<{ readonly profile: PermissionProfileName }> => ({ profile: request.profile }),
  setUnrestrictedMode: async (request): Promise<{ readonly unrestricted: boolean; readonly restartRequired: boolean }> => ({
    unrestricted: request.enabled,
    restartRequired: false,
  }),
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
  setTunnelClientPath: async (request): Promise<{ readonly clientPath: string }> => ({ clientPath: request.clientPath }),
  setLocale: async (request): Promise<{ readonly locale: UiLocale }> => ({ locale: request.locale }),
  launchManagedBrowser: async (): Promise<ManagedBrowserStatus> => ({ ready: false, port: 9222, launched: false }),
  runDoctor: async (): Promise<DoctorReport> => ({
    checks: [{ id: 'desktop', required: true, status: 'fail', message: 'Desktop services are not configured' }],
    exitCode: 1,
  }),
  getLogSnapshot: async (): Promise<LogSnapshot> => ({
    lines: [],
    tunnelLogPath: null,
    tunnelLogExists: false,
  }),
  clearLogBuffer: async (): Promise<{ readonly cleared: boolean }> => ({ cleared: false }),
};

export function isTrustedIpcSender(event: IpcMainInvokeEvent, window: BrowserWindow | null): boolean {
  void window;
  const senderFrame = event.senderFrame;
  return senderFrame !== null && isAllowedRendererUrl(senderFrame.url, getRendererEntryPath());
}

export function registerIpcHandlers(
  getMainWindow: MainWindowProvider,
  services: DesktopIpcServices = defaultDesktopServices,
): void {
  ipcMain.handle(ipcChannels.listWorkspaces, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.listWorkspaces();
  });
  ipcMain.handle(ipcChannels.addWorkspace, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.addWorkspace(parseAddWorkspaceRequest(payload));
  });
  ipcMain.handle(ipcChannels.selectWorkspace, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.selectWorkspace(parseSelectWorkspaceRequest(payload));
  });
  ipcMain.handle(ipcChannels.getDashboard, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.getDashboard();
  });
  ipcMain.handle(ipcChannels.setPermissionProfile, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setPermissionProfile(parseSetPermissionProfileRequest(payload));
  });
  ipcMain.handle(ipcChannels.setUnrestrictedMode, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setUnrestrictedMode(parseSetUnrestrictedModeRequest(payload));
  });
  ipcMain.handle(ipcChannels.listProcesses, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.listProcesses();
  });
  ipcMain.handle(ipcChannels.startProcess, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.startProcess(parseStartProcessRequest(payload));
  });
  ipcMain.handle(ipcChannels.stopProcess, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.stopProcess(parseStopProcessRequest(payload));
  });
  ipcMain.handle(ipcChannels.startMcp, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.startMcp(parseStartMcpRequest(payload));
  });
  ipcMain.handle(ipcChannels.stopMcp, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.stopMcp();
  });
  ipcMain.handle(ipcChannels.restartMcp, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.restartMcp();
  });
  ipcMain.handle(ipcChannels.clearWorkLog, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.clearWorkLog();
  });
  ipcMain.handle(ipcChannels.saveTunnelApiKey, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.saveTunnelApiKey(parseSaveTunnelApiKeyRequest(payload));
  });
  ipcMain.handle(ipcChannels.startTunnel, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.startTunnel();
  });
  ipcMain.handle(ipcChannels.stopTunnel, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.stopTunnel();
  });
  ipcMain.handle(ipcChannels.getTunnelStatus, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.getTunnelStatus();
  });
  ipcMain.handle(ipcChannels.setTunnelClientPath, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setTunnelClientPath(parseSetTunnelClientPathRequest(payload));
  });
  ipcMain.handle(ipcChannels.setLocale, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setLocale(parseSetLocaleRequest(payload));
  });
  ipcMain.handle(ipcChannels.launchManagedBrowser, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.launchManagedBrowser();
  });
  ipcMain.handle(ipcChannels.runDoctor, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.runDoctor();
  });
  ipcMain.handle(ipcChannels.getLogSnapshot, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.getLogSnapshot();
  });
  ipcMain.handle(ipcChannels.clearLogBuffer, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.clearLogBuffer(parseClearLogBufferRequest(payload));
  });
  ipcMain.handle(ipcChannels.exportLogs, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return exportLogsToFile(getMainWindow(), services, parseExportLogsRequest(payload));
  });
  ipcMain.handle(ipcChannels.openLogViewer, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return { opened: openLogViewerWindow() !== null };
  });
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

function parseSetPermissionProfileRequest(payload: unknown): SetPermissionProfileRequest {
  if (!isRecord(payload) || !isPermissionProfile(payload.profile)) throw new Error('Invalid IPC payload');
  return { profile: payload.profile };
}

function parseSetUnrestrictedModeRequest(payload: unknown): SetUnrestrictedModeRequest {
  if (!isRecord(payload) || typeof payload.enabled !== 'boolean') throw new Error('Invalid IPC payload: enabled');
  return { enabled: payload.enabled };
}

function parseClearLogBufferRequest(payload: unknown): ClearLogBufferRequest {
  if (!isRecord(payload) || !isLogSource(payload.source)) throw new Error('Invalid IPC payload: source');
  return { source: payload.source };
}

function parseExportLogsRequest(payload: unknown): ExportLogsRequest {
  if (!isRecord(payload) || !isLogSource(payload.source)) {
    throw new Error('Invalid IPC payload');
  }
  return {
    source: payload.source,
    filePath: typeof payload.filePath === 'string' ? payload.filePath : '',
  };
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
  const result = await dialog.showSaveDialog(window, {
    title: 'Export lnwjud logs',
    defaultPath: `lnwjud-${request.source}-logs.txt`,
    filters: [{ name: 'Text', extensions: ['txt', 'log'] }],
  });
  if (result.canceled || result.filePath === undefined || result.filePath.length === 0) {
    return { exported: false };
  }
  const snapshot = await services.getLogSnapshot();
  const content = snapshot.lines
    .filter((line) => line.source === request.source)
    .map((line) => `[${line.timestamp}] [${line.level.toUpperCase()}] ${line.text}`)
    .join('\r\n');
  await writeFile(result.filePath, content.length === 0 ? '' : `${content}\r\n`, 'utf8');
  return { exported: true };
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

function parseSetTunnelClientPathRequest(payload: unknown): SetTunnelClientPathRequest {
  if (!isRecord(payload)) throw new Error('Invalid IPC payload');
  return { clientPath: nonEmptyString(payload.clientPath, 'clientPath') };
}

function parseSetLocaleRequest(payload: unknown): SetLocaleRequest {
  if (!isRecord(payload) || (payload.locale !== 'th' && payload.locale !== 'en')) throw new Error('Invalid IPC payload: locale');
  return { locale: payload.locale };
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
let desktopRuntime: DesktopRuntime | null = null;
let shutdownStarted = false;

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

function createDesktopWindow(): void {
  mainWindow = createMainWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function readArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function wantsMcpStdio(): boolean {
  return process.argv.includes('--mcp-stdio');
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
    const runtime = createDesktopRuntime(dataPath);
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
  });
  app.on('window-all-closed', () => {
    // Keep the stdio MCP process alive without a BrowserWindow.
  });
  app.on('before-quit', () => {
    void desktopRuntime?.close();
  });
}

function bootstrapDesktop(): void {
  const dataPath = configureDataPath();
  void app.whenReady().then(async () => {
    const runtime = createDesktopRuntime(dataPath);
    desktopRuntime = runtime;
    runtime.logHub.setOnLine((line) => broadcastToAllWindows(pushChannels.logEvent, line));
    runtime.logHub.start();
    registerIpcHandlers(() => mainWindow, runtime.services);
    try {
      await runtime.autoStartMcp();
    } catch (error: unknown) {
      console.error(`MCP auto-start failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    createDesktopWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createDesktopWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('will-quit', (event) => {
    if (shutdownStarted) return;
    event.preventDefault();
    shutdownStarted = true;
    void closeDesktopRuntimeAndQuit();
  });
}

function bootstrapLogViewerOnly(): void {
  const dataPath = configureDataPath();
  void app.whenReady().then(async () => {
    const runtime = createDesktopRuntime(dataPath);
    desktopRuntime = runtime;
    runtime.logHub.setOnLine((line) => broadcastToAllWindows(pushChannels.logEvent, line));
    runtime.logHub.start();
    registerIpcHandlers(() => mainWindow, runtime.services);
    const viewer = openLogViewerWindow();
    if (viewer !== null) {
      mainWindow = viewer;
      viewer.on('closed', () => {
        if (mainWindow === viewer) mainWindow = null;
      });
    }
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('will-quit', (event) => {
    if (shutdownStarted) return;
    event.preventDefault();
    shutdownStarted = true;
    void closeDesktopRuntimeAndQuit();
  });
}

async function closeDesktopRuntimeAndQuit(): Promise<void> {
  try {
    await desktopRuntime?.close();
  } catch (error: unknown) {
    console.error(`Desktop shutdown failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  } finally {
    desktopRuntime = null;
    app.quit();
  }
}

function configureDataPath(): string {
  app.setName('lnwjud');
  const configuredDataPath = process.env.LNWJUD_DATA_PATH;
  if (typeof configuredDataPath === 'string' && configuredDataPath.trim().length > 0) {
    app.setPath('userData', configuredDataPath);
    return configuredDataPath;
  }
  return app.getPath('userData');
}

const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const existing = logViewerWindow !== null && !logViewerWindow.isDestroyed() ? logViewerWindow : null;
    if (existing !== null) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
    } else if (argv.includes('--log-viewer')) {
      openLogViewerWindow();
    } else if (mainWindow !== null) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  if (wantsMcpStdio()) {
    bootstrapMcpStdio();
  } else if (process.argv.includes('--log-viewer')) {
    bootstrapLogViewerOnly();
  } else {
    bootstrapDesktop();
  }
}
