import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { access } from 'node:fs/promises';
import { autoUpdater } from 'electron-updater';
import {
  APP_NAME,
  APP_VERSION,
  ipcChannels,
  pushChannels,
  type AddWorkspaceRequest,
  type BackupSummary,
  type ClearLogBufferRequest,
  type ClearWorkLogRequest,
  type ConfigureTunnelProfileRequest,
  type DeleteWorkspaceRequest,
  type DashboardSnapshot,
  type DestructiveDeletePolicy,
  type DoctorReport,
  type ExportLogsRequest,
  type ExportWorkLogRequest,
  type IpcResponseMap,
  type LogSnapshot,
  type ManagedBrowserStatus,
  type McpConnectionStatus,
  type ProcessSummary,
  type RestoreCheckpointRequest,
  type RestoreRecoveryItemRequest,
  type PermissionProfileName,
  type SaveTunnelApiKeyRequest,
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
  type StartMcpRequest,
  type StartProcessRequest,
  type StopProcessRequest,
  type TunnelStatus,
  type UiLocale,
  type UserSettings,
  type UpdateStatus,
  type WorkspaceSummary,
} from '@lnwjud/ipc-contracts';
import { readSharedActivitySnapshot, startMcpStdio, type HostMutationApprovalRequest } from '@lnwjud/mcp-server';
import { DEFAULT_MCP_POLL_WAIT_SECONDS, DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS, MIN_CONFIGURABLE_WAIT_SECONDS, resolveLnwjudDataPath } from '@lnwjud/shared';
import { applyPendingSqliteRestoreSync } from '@lnwjud/storage';
import { createDesktopRuntime, type DesktopRuntime } from './desktop-services.js';
import { DesktopShutdownCoordinator } from './desktop-shutdown.js';
import { parseOpenExternalSetupPageRequest, resolveExternalSetupUrl } from './external-setup-links.js';
import { shouldHoldSingleInstanceLock, wantsMcpStdio } from './instance-lock.js';
import { createLogViewerWindow, createMainWindow, getRendererEntryPath, getWindowIconPath, isAllowedRendererUrl } from './window.js';
import { createTrayMenuTemplate, createTrayToolTip, createTrayUpdateLabel, shouldHideMainWindowOnClose } from './tray.js';
import { UpdateInstallCoordinator, type UpdateSharedActivitySnapshot } from './update-install.js';
import { UpdateCheckScheduler } from './update-check-scheduler.js';
import {
  configureUpdaterForDistribution,
  currentPortableExecutablePath,
  detectWindowsDistribution,
  launchPortableReplacement,
  preparePortableReplacement,
} from './portable-update.js';
import { windowsCompatibilityProfile } from './windows-compatibility.js';
import { atomicWrite, type IncidentReport } from './incident-report.js';
import { IncidentSaveCoordinator } from './incident-save.js';
import { localizedUpdateStatusMessage, nativeMessages } from './native-i18n.js';
import { CrashDiagnosticsRecorder, RendererRecoveryPolicy } from './crash-recovery.js';
import { isMutationApprovalResponse, mutationApprovalDialogOptions } from './mutation-approval.js';
import { prependBundledRuntimeToolsToPath } from './runtime-tools.js';

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
  setTunnelClientPath(request: SetTunnelClientPathRequest): Promise<{ readonly clientPath: string }>;
  setLocale(request: SetLocaleRequest): Promise<{ readonly locale: UiLocale }>;
  setUserSettings(request: SetUserSettingsRequest): Promise<{ readonly settings: UserSettings; readonly restartRequired: boolean }>;
  configureTunnelProfile(request: ConfigureTunnelProfileRequest): Promise<{ readonly configured: boolean; readonly profilePath: string }>;
  launchManagedBrowser(): Promise<ManagedBrowserStatus>;
  runDoctor(): Promise<DoctorReport>;
  getLogSnapshot(): Promise<LogSnapshot>;
  clearLogBuffer(request: ClearLogBufferRequest): Promise<{ readonly cleared: boolean }>;
  captureIncident(updaterEvents?: readonly string[]): Promise<IncidentReport>;
}

export type MainWindowProvider = () => BrowserWindow | null;

export interface DesktopIpcHooks {
  readonly onLocaleChanged?: (locale: UiLocale) => void;
  readonly onUserSettingsChanged?: (settings: UserSettings) => void;
}

const defaultDestructiveDeletePolicy: DestructiveDeletePolicy = {
  protectCriticalFiles: true,
  recoverableDelete: true,
  approvals: { delete_file: false, git_rm: false, git_clean: false, git_reset_restore: false, shell_rm_unlink: false, shell_rmdir: false, shell_del_erase: false, wsl_rm_unlink: false, wsl_rmdir: false },
};

const emptyTunnel: TunnelStatus = {
  state: 'stopped',
  source: 'desktop',
  hasApiKey: false,
  clientPath: null,
  profileExists: false,
  message: null,
  logPath: null,
  persistent: null,
};
const defaultUserSettings: UserSettings = {
  customPermission: { read: 'ALLOW', write: 'ASK', execute: 'ASK', dangerous: 'DENY', allowedExecutables: [] },
  mcpCallTimeoutMs: 60_000,
  mcpIdleTimeoutMs: 5 * 60_000,
  processTimeoutMs: 60 * 60_000,
  mcpPollWaitSeconds: DEFAULT_MCP_POLL_WAIT_SECONDS,
  shellSynchronousWaitSeconds: DEFAULT_SHELL_SYNCHRONOUS_WAIT_SECONDS,
  capabilityRoots: [],
  pdfProviderPath: '',
  lspCommands: {},
  mcpHttpPort: 18_765,
  codexToolsEnabled: false,
  updateAutoCheck: true,
  updateCheckOnStartup: true,
  updateIntervalMinutes: 30,
  updateAutoDownload: true,
  closeBehavior: 'tray',
  launchAtStartup: false,
  startMinimized: false,
  tunnelAutoReconnect: true,
  tunnelMaxAutoRestarts: 5,
  recoveryRetentionDays: 0,
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
    connectionModes: { httpUrl: null, stdioCommand: 'lnwjud.exe --mcp-stdio' },
    workLog: [],
    inFlight: [],
    tunnel: emptyTunnel,
    settings: defaultUserSettings,
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
  setTunnelClientPath: async (request): Promise<{ readonly clientPath: string }> => ({ clientPath: request.clientPath }),
  setLocale: async (request): Promise<{ readonly locale: UiLocale }> => ({ locale: request.locale }),
  setUserSettings: async (request): Promise<{ readonly settings: UserSettings; readonly restartRequired: boolean }> => ({ settings: request.settings, restartRequired: false }),
  configureTunnelProfile: async (): Promise<{ readonly configured: boolean; readonly profilePath: string }> => ({ configured: false, profilePath: '' }),
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
  captureIncident: async (): Promise<IncidentReport> => ({ schemaVersion: 1, capturedAt: new Date().toISOString(), appVersion: APP_VERSION, tunnelClientVersion: null, tunnelClientVersionReason: 'desktop_services_unavailable', classification: 'healthy_or_inconclusive', classificationReasons: ['desktop_services_unavailable'], updaterEventTail: [], tunnel: { state: 'stopped', source: 'desktop', instanceIds: [], requestIds: [], health: { state: 'unavailable', message: 'unavailable' } }, mcpCalls: [], tunnelLogTail: [], processTree: { available: false, entries: [], error: 'unavailable' }, tcpListeners: { available: false, entries: [], error: 'unavailable' } }),
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
  ipcMain.handle(ipcChannels.setWorkspaceActive, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setWorkspaceActive(parseSetWorkspaceActiveRequest(payload));
  });
  ipcMain.handle(ipcChannels.setWorkspaceArchived, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setWorkspaceArchived(parseSetWorkspaceArchivedRequest(payload));
  });
  ipcMain.handle(ipcChannels.deleteWorkspace, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.deleteWorkspace(parseDeleteWorkspaceRequest(payload));
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
  ipcMain.handle(ipcChannels.setAiDeletePolicy, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setAiDeletePolicy(parseSetAiDeletePolicyRequest(payload));
  });
  ipcMain.handle(ipcChannels.setStdioPolicy, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.setStdioPolicy(parseSetStdioPolicyRequest(payload));
  });
  ipcMain.handle(ipcChannels.createBackup, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return services.createBackup();
  });
  ipcMain.handle(ipcChannels.scheduleRestoreBackup, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.scheduleRestoreBackup(parseScheduleRestoreBackupRequest(payload));
  });
  ipcMain.handle(ipcChannels.restoreRecoveryItem, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.restoreRecoveryItem(parseRestoreRecoveryItemRequest(payload));
  });
  ipcMain.handle(ipcChannels.restoreCheckpoint, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.restoreCheckpoint(parseRestoreCheckpointRequest(payload));
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
    return services.clearWorkLog(parseClearWorkLogRequest(payload));
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
    const result = await services.setLocale(parseSetLocaleRequest(payload));
    hooks.onLocaleChanged?.(result.locale);
    return result;
  });
  ipcMain.handle(ipcChannels.setUserSettings, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    const result = await services.setUserSettings(parseSetUserSettingsRequest(payload));
    hooks.onUserSettingsChanged?.(result.settings);
    return result;
  });
  ipcMain.handle(ipcChannels.chooseTunnelClientPath, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    const window = getMainWindow();
    if (window === null) return { clientPath: null };
    const result = await dialog.showOpenDialog(window, {
      title: 'Select tunnel-client.exe',
      properties: ['openFile'],
      filters: [{ name: 'OpenAI Secure MCP Tunnel client', extensions: ['exe'] }],
    });
    return { clientPath: result.canceled ? null : (result.filePaths[0] ?? null) };
  });
  ipcMain.handle(ipcChannels.configureTunnelProfile, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return services.configureTunnelProfile(parseConfigureTunnelProfileRequest(payload));
  });
  ipcMain.handle(ipcChannels.openExternalSetupPage, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    const request = parseOpenExternalSetupPageRequest(payload);
    await shell.openExternal(resolveExternalSetupUrl(request.target));
    return { opened: true as const };
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
  ipcMain.handle(ipcChannels.exportWorkLog, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    return exportWorkLogToFile(getMainWindow(), parseExportWorkLogRequest(payload));
  });
  ipcMain.handle(ipcChannels.captureIncident, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return incidentSaver.captureAndSave();
  });
  ipcMain.handle(ipcChannels.openLogViewer, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return { opened: openLogViewerWindow() !== null };
  });
  ipcMain.handle(ipcChannels.getUpdateStatus, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return currentUpdateStatus;
  });
  ipcMain.handle(ipcChannels.checkForUpdates, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return requestUpdateCheck('renderer');
  });
  ipcMain.handle(ipcChannels.installUpdate, async (event, payload: unknown) => {
    assertTrustedSender(event, getMainWindow());
    assertNoPayload(payload);
    return requestUpdateInstall();
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

function parseClearLogBufferRequest(payload: unknown): ClearLogBufferRequest {
  if (!isRecord(payload) || !isLogSource(payload.source)) throw new Error('Invalid IPC payload: source');
  const workspaceId = optionalScopeId(payload.workspaceId, 'workspaceId');
  const sessionId = optionalScopeId(payload.sessionId, 'sessionId');
  return { source: payload.source, ...(workspaceId === undefined ? {} : { workspaceId }), ...(sessionId === undefined ? {} : { sessionId }) };
}

function parseExportLogsRequest(payload: unknown): ExportLogsRequest {
  if (!isRecord(payload) || !isLogSource(payload.source)) {
    throw new Error('Invalid IPC payload');
  }
  const workspaceId = optionalScopeId(payload.workspaceId, 'workspaceId');
  const sessionId = optionalScopeId(payload.sessionId, 'sessionId');
  const lineIds = payload.lineIds;
  if (lineIds !== undefined && (!Array.isArray(lineIds) || lineIds.length > 5_000 || lineIds.some((id) => !Number.isSafeInteger(id) || Number(id) <= 0))) {
    throw new Error('Invalid IPC payload: lineIds');
  }
  const rows = payload.rows;
  if (rows !== undefined && (!Array.isArray(rows) || rows.length > 5_000 || rows.some((row) => typeof row !== 'string' || row.length > 16_384))) {
    throw new Error('Invalid IPC payload: rows');
  }
  return {
    source: payload.source,
    filePath: typeof payload.filePath === 'string' ? payload.filePath : '',
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(typeof payload.query === 'string' && payload.query.trim().length > 0 ? { query: payload.query.trim().slice(0, 512) } : {}),
    ...(lineIds === undefined ? {} : { lineIds: lineIds as number[] }),
    ...(rows === undefined ? {} : { rows: rows as string[] }),
  };
}

function parseExportWorkLogRequest(payload: unknown): ExportWorkLogRequest {
  if (!isRecord(payload) || !Array.isArray(payload.rows) || payload.rows.length > 5_000) {
    throw new Error('Invalid IPC payload: rows');
  }
  const rows = payload.rows.map((row) => {
    if (typeof row !== 'string' || row.length > 16_384) throw new Error('Invalid IPC payload: rows');
    return row;
  });
  return { rows };
}

function optionalScopeId(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(value, key).trim();
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
  let content: string;
  if (request.rows !== undefined) {
    content = request.rows.join('\r\n');
  } else {
    const snapshot = await services.getLogSnapshot();
    const query = request.query?.toLowerCase() ?? '';
    const requestedLineIds = request.lineIds === undefined ? null : new Set(request.lineIds);
    content = snapshot.lines
      .filter((line) => line.source === request.source)
      .filter((line) => requestedLineIds === null || requestedLineIds.has(line.id))
      .filter((line) => requestedLineIds !== null || request.workspaceId === undefined || line.workspaceId === request.workspaceId)
      .filter((line) => requestedLineIds !== null || request.sessionId === undefined || line.sessionId === request.sessionId)
      .filter((line) => requestedLineIds !== null || query.length === 0 || line.text.toLowerCase().includes(query))
      .sort((left, right) => {
        const leftTime = Date.parse(left.timestamp);
        const rightTime = Date.parse(right.timestamp);
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime;
        return right.id - left.id;
      })
      .map((line) => `${formatExportLogTimestamp(line.timestamp)} [${line.level.toUpperCase()}] ${line.text}`)
      .join('\r\n');
  }
  await atomicWrite(result.filePath, content.length === 0 ? '' : `${content}\r\n`);
  return { exported: true };
}

async function exportWorkLogToFile(window: BrowserWindow | null, request: ExportWorkLogRequest): Promise<{ readonly exported: boolean }> {
  if (window === null) return { exported: false };
  const result = await dialog.showSaveDialog(window, {
    title: 'Export lnwjud work log',
    defaultPath: 'lnwjud-work-log.txt',
    filters: [{ name: 'Text', extensions: ['txt', 'log'] }],
  });
  if (result.canceled || result.filePath === undefined || result.filePath.length === 0) return { exported: false };
  const content = request.rows.join('\r\n');
  await atomicWrite(result.filePath, content.length === 0 ? '' : `${content}\r\n`);
  return { exported: true };
}

function formatExportLogTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
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

function parseSetUserSettingsRequest(payload: unknown): SetUserSettingsRequest {
  if (!isRecord(payload) || !isRecord(payload.settings)) throw new Error('Invalid IPC payload: settings');
  return { settings: parseUserSettings(payload.settings) };
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
    mcpCallTimeoutMs: boundedInteger(record.mcpCallTimeoutMs, 'mcpCallTimeoutMs', 1_000, 60 * 60_000),
    mcpIdleTimeoutMs: boundedInteger(record.mcpIdleTimeoutMs, 'mcpIdleTimeoutMs', 30_000, 24 * 60 * 60_000),
    processTimeoutMs: boundedInteger(record.processTimeoutMs, 'processTimeoutMs', 1_000, 4 * 60 * 60_000),
    mcpPollWaitSeconds: boundedInteger(record.mcpPollWaitSeconds, 'mcpPollWaitSeconds', MIN_CONFIGURABLE_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS),
    shellSynchronousWaitSeconds: boundedInteger(record.shellSynchronousWaitSeconds, 'shellSynchronousWaitSeconds', MIN_CONFIGURABLE_WAIT_SECONDS, MAX_CONFIGURABLE_WAIT_SECONDS),
    capabilityRoots: stringArray(record.capabilityRoots, 'capabilityRoots', 128),
    pdfProviderPath: typeof record.pdfProviderPath === 'string' ? record.pdfProviderPath.trim() : invalidField('pdfProviderPath'),
    lspCommands: stringRecord(record.lspCommands, 'lspCommands', 32),
    mcpHttpPort: boundedInteger(record.mcpHttpPort, 'mcpHttpPort', 0, 65_535),
    codexToolsEnabled: booleanField(record.codexToolsEnabled, 'codexToolsEnabled'),
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
let desktopRuntime: DesktopRuntime | null = null;
let tray: Tray | null = null;
let desktopLocale: UiLocale = 'th';
let desktopUserSettings: UserSettings = defaultUserSettings;
let autoUpdaterInitialized = false;
let quitRequested = false;
let desktopShutdownCoordinator: DesktopShutdownCoordinator | null = null;
let updateInstallCoordinator: UpdateInstallCoordinator | null = null;
let updateCheckScheduler: UpdateCheckScheduler | null = null;
let pendingUpdateCheckSource: 'automatic' | 'tray' | 'renderer' | null = null;
const windowsDistribution = detectWindowsDistribution(app.isPackaged);
const windowsCompatibility = windowsCompatibilityProfile(process.platform, os.release(), process.arch);
let pendingPortableUpdate: { readonly version: string; readonly downloadedFile: string } | null = null;
let crashDiagnostics: CrashDiagnosticsRecorder | null = null;
const rendererRecoveryPolicy = new RendererRecoveryPolicy();
let crashRecoveryConfigured = false;
let currentUpdateStatus: UpdateStatus = {
  phase: app.isPackaged ? 'idle' : 'unavailable',
  currentVersion: APP_VERSION,
  availableVersion: null,
  progressPercent: null,
  lastCheckedAt: null,
  message: app.isPackaged ? null : nativeMessages(desktopLocale).updaterUnavailablePackagedOnly,
  canInstall: false,
};

async function requestNativeMutationApproval(request: HostMutationApprovalRequest): Promise<boolean> {
  const options = mutationApprovalDialogOptions(desktopLocale, request);
  const dialogOptions = { ...options, buttons: [...options.buttons] };
  const parent = mainWindow !== null && !mainWindow.isDestroyed()
    ? mainWindow
    : logViewerWindow !== null && !logViewerWindow.isDestroyed()
      ? logViewerWindow
      : null;
  const result = parent === null
    ? await dialog.showMessageBox(dialogOptions)
    : await dialog.showMessageBox(parent, dialogOptions);
  return isMutationApprovalResponse(result.response);
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
    if (!shouldHideMainWindowOnClose(quitRequested, desktopUserSettings.closeBehavior)) return;
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
  broadcastToAllWindows(pushChannels.updateStatus, next);
  refreshDesktopTrayMenu();
  return next;
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

function requestUpdateCheck(source: 'automatic' | 'tray' | 'renderer'): UpdateStatus {
  const messages = nativeMessages(desktopLocale);
  if (!app.isPackaged) {
    const status = patchUpdateStatus({ phase: 'unavailable', message: messages.updaterUnavailable, canInstall: false });
    if (source === 'tray') {
      void dialog.showMessageBox({ type: 'info', title: messages.updaterCheckTitle, message: status.message ?? messages.updaterUnavailablePackagedOnly, buttons: [messages.ok] });
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
          void dialog.showMessageBox({ type: 'error', title: currentMessages.updaterCheckTitle, message, buttons: [currentMessages.ok] });
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
      void dialog.showMessageBox({ type: 'error', title: currentMessages.updaterCheckTitle, message, buttons: [currentMessages.ok] });
    }
  });
  return status;
}

function requestUpdateInstall(): { readonly accepted: boolean; readonly status: UpdateStatus } {
  if (!app.isPackaged || currentUpdateStatus.phase !== 'ready' || updateInstallCoordinator === null) {
    return { accepted: false, status: currentUpdateStatus };
  }
  const status = patchUpdateStatus({
    phase: 'installing',
    message: nativeMessages(desktopLocale).updaterInstallWaiting,
    canInstall: false,
  });
  updateInstallCoordinator.requestInstall();
  return { accepted: true, status };
}

function checkForUpdatesFromTray(): void {
  if (currentUpdateStatus.phase === 'ready') {
    requestUpdateInstall();
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
  const iconPath = getWindowIconPath();
  if (iconPath === undefined) {
    console.error('lnwjud tray icon was not found');
    return;
  }
  tray?.destroy();
  tray = new Tray(nativeImage.createFromPath(iconPath));
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
    prependBundledRuntimeToolsToPath();
    const runtime = createDesktopRuntime(dataPath, {
      permissionProfile: 'full',
      hostMutationApprovalProvider: requestNativeMutationApproval,
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
      hostMutationApprovalProvider: requestNativeMutationApproval,
      codexToolsEnabled: runtime.getUserSettings().codexToolsEnabled,
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

function applyDesktopUserSettings(settings: UserSettings): void {
  desktopUserSettings = settings;
  if (process.platform === 'win32' && app.isPackaged) {
    try {
      app.setLoginItemSettings({ openAtLogin: settings.launchAtStartup, path: process.execPath });
    } catch (error: unknown) {
      console.error(`Could not update Windows startup setting: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
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
  try {
    configureUpdaterForDistribution(autoUpdater, windowsDistribution);
    autoUpdater.autoDownload = desktopUserSettings.updateAutoDownload;
    autoUpdater.autoInstallOnAppQuit = false;
    updateInstallCoordinator = new UpdateInstallCoordinator({
      activeCallCount: (): number => runtime.activityTracker.listInFlight().length,
      activityRevision: (): number => runtime.activityTracker.revision(),
      tunnelRunning: async (): Promise<boolean | 'unverifiable'> => {
        try {
          if ((await runtime.services.getTunnelStatus()).state === 'running') return true;
          try {
            await access(path.join(process.env.APPDATA ?? app.getPath('appData'), 'tunnel-client', 'lnwjud.tunnel.lock'));
            return true;
          } catch (error: unknown) {
            return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : 'unverifiable';
          }
        } catch {
          return 'unverifiable';
        }
      },
      sharedActivitySnapshot: async (): Promise<UpdateSharedActivitySnapshot> => {
        const snapshot = await readSharedActivitySnapshot({ profileDirectory: path.join(process.env.APPDATA ?? app.getPath('appData'), 'tunnel-client') });
        return snapshot.state === 'available'
          ? { state: 'available', activeCallCount: snapshot.activeCount, revision: snapshot.revision, ownerKey: snapshot.ownerKey }
          : { state: snapshot.state, reason: snapshot.reason };
      },
      install: (): void => {
        void runtime.createBackup('pre-update').catch((error: unknown) => {
          console.error(`Pre-update backup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }).finally(() => {
          if (windowsDistribution === 'installer') {
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
          message: messages.updateAvailableDialog(info.version),
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
        message: messages.updateCurrentDialog(info.version),
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
        message,
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

function bootstrapDesktop(): void {
  if (windowsCompatibility.disableHardwareAcceleration) app.disableHardwareAcceleration();
  const dataPath = configureDataPath();
  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.lnwjud.desktop');
    console.log(
      `[WindowsCompatibility] ${windowsCompatibility.generation} build=${windowsCompatibility.build ?? 'unknown'} arch=${process.arch} gpu=${windowsCompatibility.disableHardwareAcceleration ? 'software' : 'hardware'}; ${windowsCompatibility.reason}`,
    );

    prependBundledRuntimeToolsToPath();
    const runtime = createDesktopRuntime(dataPath, { hostMutationApprovalProvider: requestNativeMutationApproval });
    desktopRuntime = runtime;
    setDesktopLocale(runtime.getLocale());
    applyDesktopUserSettings(runtime.getUserSettings());
    configureDesktopShutdown(runtime);
    runtime.logHub.setOnLine((line) => broadcastToAllWindows(pushChannels.logEvent, line));
    runtime.logHub.start();
    registerIpcHandlers(() => mainWindow, runtime.services, { onLocaleChanged: setDesktopLocale, onUserSettingsChanged: applyDesktopUserSettings });
    try {
      await runtime.autoStartMcp();
    } catch (error: unknown) {
      console.error(`MCP auto-start failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    createDesktopWindow();
    createDesktopTray();
    void runtime.autoStartTunnel().catch((error: unknown) => {
      console.error(`Tunnel persistent runtime auto-start failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    });
    initAutoUpdater(runtime);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createDesktopWindow(true);
    });
  });
  app.on('before-quit', handleDesktopBeforeQuit);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

function bootstrapLogViewerOnly(): void {
  const dataPath = configureDataPath();
  if (windowsCompatibility.disableHardwareAcceleration) app.disableHardwareAcceleration();
  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.lnwjud.desktop');
    prependBundledRuntimeToolsToPath();
    const runtime = createDesktopRuntime(dataPath, { hostMutationApprovalProvider: requestNativeMutationApproval });
    desktopRuntime = runtime;
    configureDesktopShutdown(runtime);
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
  app.on('before-quit', handleDesktopBeforeQuit);
}

function configureDesktopShutdown(runtime: DesktopRuntime): void {
  desktopShutdownCoordinator = new DesktopShutdownCoordinator({
    closeRuntime: async (): Promise<void> => {
      await runtime.close();
      if (desktopRuntime === runtime) desktopRuntime = null;
    },
    onDeferred: (error): void => {
      quitRequested = false;
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
        detail: error.message,
        buttons: ['OK'],
      });
    },
  });
}

function handleDesktopBeforeQuit(event: Electron.Event): void {
  const coordinator = desktopShutdownCoordinator;
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
  void coordinator.requestQuit(() => app.quit()).then((result) => {
    if (result === 'deferred') quitRequested = false;
  });
}

function configureCrashRecovery(dataPath: string): void {
  crashDiagnostics ??= new CrashDiagnosticsRecorder(dataPath, APP_VERSION);
  if (crashRecoveryConfigured) return;
  crashRecoveryConfigured = true;

  process.on('uncaughtExceptionMonitor', (error) => {
    crashDiagnostics?.record({ type: 'main-uncaught-exception', processType: 'main', error });
  });
  app.on('child-process-gone', (_event, details) => {
    crashDiagnostics?.record({
      type: 'child-process-gone',
      processType: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  app.on('render-process-gone', (_event, webContents, details) => {
    crashDiagnostics?.record({
      type: 'renderer-gone',
      processType: 'renderer',
      reason: details.reason,
      exitCode: details.exitCode,
    });
    if (quitRequested || !rendererRecoveryPolicy.shouldRecover(details.reason)) return;
    const mainCrashed = mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.webContents.id === webContents.id;
    const logViewerCrashed = logViewerWindow !== null && !logViewerWindow.isDestroyed() && logViewerWindow.webContents.id === webContents.id;
    if (!mainCrashed && !logViewerCrashed) return;

    if (mainCrashed) {
      const crashedWindow = mainWindow;
      mainWindow = null;
      if (crashedWindow !== null && !crashedWindow.isDestroyed()) crashedWindow.destroy();
      setTimeout(() => {
        if (!quitRequested && (mainWindow === null || mainWindow.isDestroyed())) createDesktopWindow();
      }, 250);
    }
    if (logViewerCrashed) {
      const crashedViewer = logViewerWindow;
      logViewerWindow = null;
      if (crashedViewer !== null && !crashedViewer.isDestroyed()) crashedViewer.destroy();
      setTimeout(() => {
        if (!quitRequested && (logViewerWindow === null || logViewerWindow.isDestroyed())) openLogViewerWindow();
      }, 250);
    }
  });
}

function configureDataPath(): string {
  app.setName(APP_NAME);
  const dataPath = resolveLnwjudDataPath(process.env, app.getPath('appData'));
  app.setPath('userData', dataPath);
  configureCrashRecovery(dataPath);
  const restore = applyPendingSqliteRestoreSync(path.join(dataPath, 'lnwjud.sqlite'), path.join(dataPath, 'backups'));
  if (restore.error !== undefined) console.error(`Scheduled database restore failed: ${restore.error}`);
  if (restore.applied) console.log(`Database restore applied from ${restore.backupId ?? 'scheduled backup'}`);
  return dataPath;
}

const gotInstanceLock = shouldHoldSingleInstanceLock(process.argv) ? app.requestSingleInstanceLock() : true;
if (!gotInstanceLock) {
  app.quit();
} else {
  if (shouldHoldSingleInstanceLock(process.argv)) {
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
  }
  if (wantsMcpStdio(process.argv)) {
    bootstrapMcpStdio();
  } else if (process.argv.includes('--log-viewer')) {
    bootstrapLogViewerOnly();
  } else {
    bootstrapDesktop();
  }
}
