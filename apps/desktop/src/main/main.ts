import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  ipcChannels,
  type AddWorkspaceRequest,
  type DashboardSnapshot,
  type DoctorReport,
  type IpcResponseMap,
  type McpConnectionStatus,
  type ProcessSummary,
  type PermissionProfileName,
  type SetPermissionProfileRequest,
  type StartMcpRequest,
  type StartProcessRequest,
  type StopProcessRequest,
  type WorkspaceSummary,
} from '@lnwjud/ipc-contracts';
import { createDesktopRuntime, type DesktopRuntime } from './desktop-services.js';
import { createMainWindow, getRendererEntryPath, isAllowedRendererUrl } from './window.js';

export interface DesktopIpcServices {
  listWorkspaces(): Promise<IpcResponseMap[typeof ipcChannels.listWorkspaces]>;
  addWorkspace(request: AddWorkspaceRequest): Promise<WorkspaceSummary>;
  getDashboard(): Promise<DashboardSnapshot>;
  setPermissionProfile(request: SetPermissionProfileRequest): Promise<{ readonly profile: PermissionProfileName }>;
  listProcesses(): Promise<IpcResponseMap[typeof ipcChannels.listProcesses]>;
  startProcess(request: StartProcessRequest): Promise<IpcResponseMap[typeof ipcChannels.startProcess]>;
  stopProcess(request: StopProcessRequest): Promise<{ readonly stopped: boolean }>;
  startMcp(request: StartMcpRequest): Promise<McpConnectionStatus>;
  stopMcp(): Promise<McpConnectionStatus>;
  runDoctor(): Promise<DoctorReport>;
}

export type MainWindowProvider = () => BrowserWindow | null;

const defaultDesktopServices: DesktopIpcServices = {
  listWorkspaces: async (): Promise<readonly WorkspaceSummary[]> => [],
  addWorkspace: async (): Promise<WorkspaceSummary> => {
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
  }),
  setPermissionProfile: async (request): Promise<{ readonly profile: PermissionProfileName }> => ({ profile: request.profile }),
  listProcesses: async (): Promise<readonly ProcessSummary[]> => [],
  startProcess: async (): Promise<IpcResponseMap[typeof ipcChannels.startProcess]> => {
    throw new Error('Desktop services are not configured');
  },
  stopProcess: async (): Promise<{ readonly stopped: boolean }> => ({ stopped: false }),
  startMcp: async (): Promise<McpConnectionStatus> => ({ running: false, url: null, workspaceId: null }),
  stopMcp: async (): Promise<McpConnectionStatus> => ({ running: false, url: null, workspaceId: null }),
  runDoctor: async (): Promise<DoctorReport> => ({
    checks: [{ id: 'desktop', required: true, status: 'fail', message: 'Desktop services are not configured' }],
    exitCode: 1,
  }),
};

export function isTrustedIpcSender(event: IpcMainInvokeEvent, mainWindow: BrowserWindow): boolean {
  const senderFrame = event.senderFrame;
  return event.sender === mainWindow.webContents
    && senderFrame !== null
    && isAllowedRendererUrl(senderFrame.url, getRendererEntryPath());
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
  ipcMain.handle(ipcChannels.getDashboard, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.getDashboard();
  });
  ipcMain.handle(ipcChannels.setPermissionProfile, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setPermissionProfile(parseSetPermissionProfileRequest(payload));
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
  ipcMain.handle(ipcChannels.runDoctor, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.runDoctor();
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

function parseSetPermissionProfileRequest(payload: unknown): SetPermissionProfileRequest {
  if (!isRecord(payload) || !isPermissionProfile(payload.profile)) throw new Error('Invalid IPC payload');
  return { profile: payload.profile };
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
let desktopRuntime: DesktopRuntime | null = null;
let shutdownStarted = false;

function createDesktopWindow(): void {
  mainWindow = createMainWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function bootstrapDesktop(): void {
  const dataPath = configureDataPath();
  void app.whenReady().then(() => {
    const runtime = createDesktopRuntime(dataPath);
    desktopRuntime = runtime;
    registerIpcHandlers(() => mainWindow, runtime.services);
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

bootstrapDesktop();
