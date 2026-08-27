import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_VERSION, ipcChannels, type TunnelStatus } from '@lnwjud/ipc-contracts';

const electronHarness = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>(),
  quit: vi.fn(),
  shellOpenExternal: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: vi.fn(() => false),
    quit: electronHarness.quit,
    on: vi.fn(),
    whenReady: vi.fn(async () => undefined),
    setName: vi.fn(),
    setPath: vi.fn(),
    getPath: vi.fn(() => ''),
    setAppUserModelId: vi.fn(),
    isPackaged: false,
  },
  BrowserWindow: class BrowserWindow {
    public static getAllWindows(): unknown[] { return []; }
  },
  dialog: {
    showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })),
    showMessageBox: vi.fn(async () => ({ response: 1 })),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, payload?: unknown) => Promise<unknown>) => {
      electronHarness.handlers.set(channel, handler);
    }),
  },
  Menu: { buildFromTemplate: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  shell: { openExternal: electronHarness.shellOpenExternal },
  Tray: class Tray {},
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}));

import { registerIpcHandlers, type DesktopIpcServices } from '../src/main/main.js';
import { getRendererEntryPath } from '../src/main/window.js';

const stoppedTunnel: TunnelStatus = {
  state: 'stopped',
  source: 'desktop',
  hasApiKey: false,
  clientPath: null,
  profileExists: false,
  message: null,
  logPath: null,
  persistent: null,
};

describe('production desktop IPC acceptance', () => {
  beforeEach(() => {
    electronHarness.handlers.clear();
    electronHarness.quit.mockClear();
    electronHarness.shellOpenExternal.mockClear();
  });

  it('routes critical MCP and tunnel start/stop/status calls through registered production handlers', async () => {
    const services = desktopServices();
    registerIpcHandlers(() => ({}) as never, services);

    const event = { senderFrame: { url: pathToFileURL(getRendererEntryPath()).href } };
    const startMcp = requiredHandler(ipcChannels.startMcp);
    const stopMcp = requiredHandler(ipcChannels.stopMcp);
    const startTunnel = requiredHandler(ipcChannels.startTunnel);
    const stopTunnel = requiredHandler(ipcChannels.stopTunnel);
    const getTunnelStatus = requiredHandler(ipcChannels.getTunnelStatus);

    await expect(startMcp(event, { workspaceId: 'workspace-production' })).resolves.toEqual({ running: true, url: null, workspaceId: 'workspace-production' });
    await expect(stopMcp(event)).resolves.toEqual({ running: false, url: null, workspaceId: null });
    await expect(startTunnel(event)).resolves.toMatchObject({ state: 'running', source: 'desktop' });
    await expect(getTunnelStatus(event)).resolves.toMatchObject({ state: 'running', source: 'desktop' });
    await expect(stopTunnel(event)).resolves.toMatchObject({ state: 'stopped', source: 'desktop' });

    expect(services.startMcp).toHaveBeenCalledWith({ workspaceId: 'workspace-production' });
    expect(services.stopMcp).toHaveBeenCalledOnce();
    expect(services.startTunnel).toHaveBeenCalledOnce();
    expect(services.getTunnelStatus).toHaveBeenCalledOnce();
    expect(services.stopTunnel).toHaveBeenCalledOnce();
  });

  it('routes and validates AI delete and STDIO security policy changes', async () => {
    const services = desktopServices();
    registerIpcHandlers(() => ({}) as never, services);
    const trusted = { senderFrame: { url: pathToFileURL(getRendererEntryPath()).href } };

    await expect(requiredHandler(ipcChannels.setAiDeletePolicy)(trusted, { enabled: true })).resolves.toEqual({ enabled: true });
    await expect(requiredHandler(ipcChannels.setStdioPolicy)(trusted, { profile: 'safe', strictRoots: true, allowedRoots: ['E:\\work'] }))
      .resolves.toMatchObject({ profile: 'safe', strictRoots: true, allowedRoots: ['E:\\work'] });
    await expect(requiredHandler(ipcChannels.setStdioPolicy)(trusted, { profile: 'safe', strictRoots: true, allowedRoots: [] }))
      .rejects.toThrow(/requires at least one allowed root/);
  });

  it('routes and validates project archive, restore, and registration deletion', async () => {
    const services = desktopServices();
    registerIpcHandlers(() => ({}) as never, services);
    const trusted = { senderFrame: { url: pathToFileURL(getRendererEntryPath()).href } };

    await expect(requiredHandler(ipcChannels.setWorkspaceArchived)(trusted, { workspaceId: 'workspace-production', archived: true }))
      .resolves.toMatchObject({ id: 'workspace-production', archivedAt: expect.any(String) });
    expect(services.setWorkspaceArchived).toHaveBeenCalledWith({ workspaceId: 'workspace-production', archived: true });
    await expect(requiredHandler(ipcChannels.setWorkspaceArchived)(trusted, { workspaceId: 'workspace-production', archived: 'yes' }))
      .rejects.toThrow(/archived/);

    await expect(requiredHandler(ipcChannels.deleteWorkspace)(trusted, { workspaceId: 'workspace-production' }))
      .rejects.toThrow('Invalid IPC payload');
    await expect(requiredHandler(ipcChannels.deleteWorkspace)(trusted, { workspaceId: 'workspace-production', userConfirmed: true })).resolves.toEqual({
      deleted: true,
      workspaceId: 'workspace-production',
      rootPath: 'E:\\workspace-production',
      backupId: 'backup-production',
    });
    expect(services.deleteWorkspace).toHaveBeenCalledWith({ workspaceId: 'workspace-production', userConfirmed: true });
  });

  it('notifies the native tray after a trusted locale change', async () => {
    const services = desktopServices();
    const onLocaleChanged = vi.fn();
    registerIpcHandlers(() => ({}) as never, services, { onLocaleChanged });
    const trusted = { senderFrame: { url: pathToFileURL(getRendererEntryPath()).href } };

    await expect(requiredHandler(ipcChannels.setLocale)(trusted, { locale: 'en' })).resolves.toEqual({ locale: 'en' });

    expect(services.setLocale).toHaveBeenCalledWith({ locale: 'en' });
    expect(onLocaleChanged).toHaveBeenCalledExactlyOnceWith('en');
  });

  it('opens only allowlisted setup pages for a trusted renderer', async () => {
    const services = desktopServices();
    registerIpcHandlers(() => ({}) as never, services);
    const trusted = { senderFrame: { url: pathToFileURL(getRendererEntryPath()).href } };
    const untrusted = { senderFrame: { url: 'https://example.invalid/' } };
    const handler = requiredHandler(ipcChannels.openExternalSetupPage);

    await expect(handler(trusted, { target: 'openai_tunnels' })).resolves.toEqual({ opened: true });
    expect(electronHarness.shellOpenExternal).toHaveBeenCalledExactlyOnceWith(
      'https://platform.openai.com/settings/organization/tunnels',
    );
    await expect(handler(trusted, { target: 'https://evil.example/' })).rejects.toThrow(/target/);
    await expect(handler(untrusted, { target: 'openai_tunnels' })).rejects.toThrow('IPC sender rejected');
    expect(electronHarness.shellOpenExternal).toHaveBeenCalledTimes(1);
  });

  it('exposes updater status, manual check, and install actions through trusted IPC', async () => {
    const services = desktopServices();
    registerIpcHandlers(() => ({}) as never, services);
    const trusted = { senderFrame: { url: pathToFileURL(getRendererEntryPath()).href } };

    await expect(requiredHandler(ipcChannels.getUpdateStatus)(trusted)).resolves.toMatchObject({
      phase: 'unavailable',
      currentVersion: APP_VERSION,
      canInstall: false,
    });
    await expect(requiredHandler(ipcChannels.checkForUpdates)(trusted)).resolves.toMatchObject({ phase: 'unavailable' });
    await expect(requiredHandler(ipcChannels.installUpdate)(trusted)).resolves.toMatchObject({
      accepted: false,
      status: { phase: 'unavailable' },
    });
  });

  it('routes and validates scoped work-log, live-log, and export requests', async () => {
    const services = desktopServices();
    registerIpcHandlers(() => ({}) as never, services);
    const trusted = { senderFrame: { url: pathToFileURL(getRendererEntryPath()).href } };

    await expect(requiredHandler(ipcChannels.clearWorkLog)(trusted, { workspaceId: 'ws-a', sessionId: 'session-a' })).resolves.toEqual({ cleared: true });
    expect(services.clearWorkLog).toHaveBeenCalledWith({ workspaceId: 'ws-a', sessionId: 'session-a' });

    await expect(requiredHandler(ipcChannels.clearLogBuffer)(trusted, { source: 'mcp', workspaceId: 'ws-a', sessionId: 'session-a' })).resolves.toEqual({ cleared: true });
    expect(services.clearLogBuffer).toHaveBeenCalledWith({ source: 'mcp', workspaceId: 'ws-a', sessionId: 'session-a' });

    await expect(requiredHandler(ipcChannels.clearLogBuffer)(trusted, { source: 'mcp', sessionId: '' })).rejects.toThrow(/sessionId/);
    await expect(requiredHandler(ipcChannels.exportLogs)(trusted, { source: 'mcp', filePath: '', workspaceId: 'ws-a', sessionId: 'session-a', query: 'needle', lineIds: [9, 4, 1], rows: ['8/27/2026, 2:30:00 AM [INFO] needle'] })).resolves.toEqual({ exported: false });
    await expect(requiredHandler(ipcChannels.exportLogs)(trusted, { source: 'mcp', filePath: '', workspaceId: '' })).rejects.toThrow(/workspaceId/);
    await expect(requiredHandler(ipcChannels.exportLogs)(trusted, { source: 'mcp', filePath: '', lineIds: [0] })).rejects.toThrow(/lineIds/);
    await expect(requiredHandler(ipcChannels.exportLogs)(trusted, { source: 'mcp', filePath: '', rows: ['ok', 7] })).rejects.toThrow(/rows/);

    await expect(requiredHandler(ipcChannels.exportWorkLog)(trusted, { rows: ['first visible row', 'second visible row'] })).resolves.toEqual({ exported: false });
    await expect(requiredHandler(ipcChannels.exportWorkLog)(trusted, { rows: ['ok', 7] })).rejects.toThrow(/rows/);
  });

  it('enforces the production IPC sender and payload guards before invoking services', async () => {
    const services = desktopServices();
    registerIpcHandlers(() => ({}) as never, services);
    const handler = requiredHandler(ipcChannels.startMcp);
    const trusted = { senderFrame: { url: pathToFileURL(getRendererEntryPath()).href } };

    await expect(handler(trusted, { workspaceId: '' })).rejects.toThrow('Invalid IPC payload: workspaceId');
    await expect(handler({ senderFrame: { url: 'https://example.invalid/' } }, { workspaceId: 'workspace-production' })).rejects.toThrow('IPC sender rejected');
    expect(services.startMcp).not.toHaveBeenCalled();
  });
});

function requiredHandler(channel: string): (event: unknown, payload?: unknown) => Promise<unknown> {
  const handler = electronHarness.handlers.get(channel);
  if (handler === undefined) throw new Error(`Production IPC handler was not registered: ${channel}`);
  return handler;
}

function desktopServices(): DesktopIpcServices {
  let tunnelStatus: TunnelStatus = stoppedTunnel;
  return {
    listWorkspaces: vi.fn(async () => []),
    addWorkspace: vi.fn(async () => { throw new Error('unused'); }),
    selectWorkspace: vi.fn(async () => { throw new Error('unused'); }),
    setWorkspaceArchived: vi.fn(async (request) => ({ id: request.workspaceId, displayName: 'Production', rootPath: 'E:\\workspace-production', realRootPath: 'E:\\workspace-production', createdAt: new Date(0).toISOString(), archivedAt: request.archived ? new Date().toISOString() : null, kind: 'project' as const })),
    deleteWorkspace: vi.fn(async (request) => ({ deleted: true, workspaceId: request.workspaceId, rootPath: 'E:\\workspace-production', backupId: 'backup-production' })),
    getDashboard: vi.fn(async () => { throw new Error('unused'); }),
    setPermissionProfile: vi.fn(async (request) => ({ profile: request.profile })),
    setUnrestrictedMode: vi.fn(async (request) => ({ unrestricted: request.enabled, restartRequired: false })),
    setAiDeletePolicy: vi.fn(async (request) => ({ enabled: request.enabled })),
    setStdioPolicy: vi.fn(async (request) => ({ profile: request.profile, strictRoots: request.strictRoots, allowedRoots: request.allowedRoots, restartRequired: false })),
    listProcesses: vi.fn(async () => []),
    startProcess: vi.fn(async () => { throw new Error('unused'); }),
    stopProcess: vi.fn(async () => ({ stopped: true })),
    startMcp: vi.fn(async (request) => ({ running: true, url: null, workspaceId: request.workspaceId })),
    stopMcp: vi.fn(async () => ({ running: false, url: null, workspaceId: null })),
    restartMcp: vi.fn(async () => ({ running: true, url: null, workspaceId: 'workspace-production' })),
    clearWorkLog: vi.fn(async () => ({ cleared: true })),
    saveTunnelApiKey: vi.fn(async () => ({ saved: true })),
    startTunnel: vi.fn(async () => {
      tunnelStatus = { ...stoppedTunnel, state: 'running' };
      return tunnelStatus;
    }),
    stopTunnel: vi.fn(async () => {
      tunnelStatus = stoppedTunnel;
      return tunnelStatus;
    }),
    getTunnelStatus: vi.fn(async () => tunnelStatus),
    setTunnelClientPath: vi.fn(async (request) => ({ clientPath: request.clientPath })),
    setLocale: vi.fn(async (request) => ({ locale: request.locale })),
    launchManagedBrowser: vi.fn(async () => ({ ready: true, port: 9222, launched: false })),
    runDoctor: vi.fn(async () => ({ checks: [], exitCode: 0 })),
    getLogSnapshot: vi.fn(async () => ({ lines: [], tunnelLogPath: null, tunnelLogExists: false })),
    clearLogBuffer: vi.fn(async () => ({ cleared: true })),
    captureIncident: vi.fn(async () => ({
      schemaVersion: 1,
      capturedAt: new Date(0).toISOString(),
      appVersion: 'test',
      tunnelClientVersion: null,
      tunnelClientVersionReason: 'test',
      classification: 'healthy_or_inconclusive',
      classificationReasons: [],
      updaterEventTail: [],
      tunnel: { state: 'stopped', source: 'desktop', instanceIds: [], requestIds: [], health: { state: 'unavailable', message: 'test' } },
      mcpCalls: [],
      tunnelLogTail: [],
      processTree: { available: false, entries: [], error: 'test' },
      tcpListeners: { available: false, entries: [], error: 'test' },
    })),
  };
}
