import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { EMPTY_INSTALL_ACTIVITY, workspaceScopeMatches } from '@lnwjud/ipc-contracts';
import type {
  DashboardSnapshot,
  DestructiveDeletePolicy,
  DoctorReport,
  ToolCatalogSnapshot,
  ResolvedRemediation,
  LogLine,
  LogSessionSummary,
  LiveLogExportReference,
  LogSource,
  InstallActivitySnapshot,
  PermissionProfileName,
  PdfProviderInstallResult,
  PonytailModeOverride,
  PonytailPolicyContext,
  UiLocale,
  UpdateStatus,
  UserSettings,
  IncidentClassification,
  ExternalSetupTarget,
  TunnelStatus,
  TunnelOAuthLoginStatus,
  WorkspaceSummary,
  WorkLogEntry,
} from '@lnwjud/ipc-contracts';
import { AppShell, type Screen } from './features/shell/AppShell.js';
import { WorkflowsPage } from './features/workflows/WorkflowsPage.js';
import { GlobalInstallProgressModal } from './features/shell/GlobalInstallProgressModal.js';
import { ControlCenterPage } from './features/home/ControlCenterPage.js';
import { ProjectsPage } from './features/projects/ProjectsPage.js';
import { GitPage } from './features/git/GitPage.js';
import { WorkLogPage } from './features/worklog/WorkLogPage.js';
import { LiveLogsPage } from './features/live/LiveLogsPage.js';
import type { LogScopeSelection } from './features/live/LogStreamPanel.js';
import { appendLogBatch, applyLogSnapshot, rememberLogId } from './features/live/log-buffer.js';
import { SettingsPage, type SettingsFocusTarget, type SettingsSection } from './features/settings/SettingsPage.js';
import { DoctorPanel } from './features/doctor/DoctorPanel.js';
import { DiagnosticsPage } from './features/doctor/DiagnosticsPage.js';
import { ToolsPage } from './features/tools/ToolsPage.js';
import { remediationNavigationForTarget } from './features/tools/remediation-navigation.js';
import { FirstRunTunnelTip } from './features/onboarding/FirstRunTunnelTip.js';
import {
  guidedTunnelLaunchDecision,
  guidedTunnelPrerequisiteSignature,
  isTunnelConfigured,
  isTunnelRunning,
  readGuidedTunnelSetupState,
  writeGuidedTunnelSetupState,
} from './features/onboarding/guided-tunnel-setup-state.js';
import { createTranslator } from './i18n/index.js';
import { STARTUP_CORE_CHECK_IDS, markStartupDoctorPassed, startupDoctorCorePassed, startupDoctorNavigationTarget, startupDoctorRequired } from './features/onboarding/startup-doctor-state.js';
import { McpDashboardState } from './mcp-dashboard-state.js';

const MAX_CLIENT_LOG_LINES = 30_000;

export function App(): ReactElement {
  const [screen, setScreen] = useState<Screen>('home');
  const [dashboard, setDashboard] = useState<DashboardSnapshot | null>(null);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [toolCatalog, setToolCatalog] = useState<ToolCatalogSnapshot | null>(null);
  const [toolCatalogLoading, setToolCatalogLoading] = useState(false);
  const [toolHostSyncNotice, setToolHostSyncNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [locale, setLocale] = useState<UiLocale>('th');
  const [logLines, setLogLines] = useState<readonly LogLine[]>([]);
  const [logSessions, setLogSessions] = useState<readonly LogSessionSummary[]>([]);
  const [tunnelLogPath, setTunnelLogPath] = useState<string | null>(null);
  const [tunnelLogExists, setTunnelLogExists] = useState(false);
  const [incidentClassification, setIncidentClassification] = useState<IncidentClassification | null>(null);
  const [incidentCapturedAt, setIncidentCapturedAt] = useState<string | null>(null);
  const [incidentNotice, setIncidentNotice] = useState<string | null>(null);
  const [incidentBusy, setIncidentBusy] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [installActivity, setInstallActivity] = useState<InstallActivitySnapshot>(EMPTY_INSTALL_ACTIVITY);
  const updateInstallTransitionRef = useRef(false);
  const [firstRunTunnelTipOpen, setFirstRunTunnelTipOpen] = useState(false);
  const [guidedTunnelSetupOpen, setGuidedTunnelSetupOpen] = useState(false);
  const [startupDoctorReady, setStartupDoctorReady] = useState(false);
  const [requestedSettingsSection, setRequestedSettingsSection] = useState<{ readonly section: SettingsSection; readonly focus?: SettingsFocusTarget; readonly requestId: number } | undefined>(undefined);
  const [ponytailPolicyContext, setPonytailPolicyContext] = useState<PonytailPolicyContext | null>(null);
  const [ponytailPolicyBusy, setPonytailPolicyBusy] = useState(false);
  const [ponytailPolicyError, setPonytailPolicyError] = useState<string | null>(null);
  const incidentBusyRef = useRef(false);
  const refreshBusyRef = useRef(false);
  const mcpDashboardStateRef = useRef(new McpDashboardState());
  const logIds = useRef<Set<number>>(new Set());
  const pendingLogLines = useRef<LogLine[]>([]);
  const logFlushTimer = useRef<number | null>(null);
  const guidedTunnelLaunchSignature = useRef<string | null>(null);
  const startupDoctorVersion = useRef<string | null>(null);
  const settingsRequestId = useRef(0);

  const t = createTranslator(locale);
  const appVersion = dashboard?.appVersion ?? null;
  const selectedWorkspaceId = dashboard?.selectedWorkspace?.id ?? null;
  const globalPonytailMode = dashboard?.settings.ponytailMode ?? 'off';
  const projectWorkspaces = workspaces.filter((workspace) => workspace.kind !== 'machine_root' && (workspace.archivedAt === undefined || workspace.archivedAt === null));

  const flushPendingLogLines = useCallback((): void => {
    logFlushTimer.current = null;
    if (pendingLogLines.current.length === 0) return;
    const batch = pendingLogLines.current;
    pendingLogLines.current = [];
    setLogLines((previous) => appendLogBatch(previous, batch, MAX_CLIENT_LOG_LINES));
  }, []);

  const appendLogLine = useCallback((line: LogLine): void => {
    if (!rememberLogId(logIds.current, line.id, MAX_CLIENT_LOG_LINES * 2)) return;
    pendingLogLines.current.push(line);
    if (logFlushTimer.current === null) {
      logFlushTimer.current = window.setTimeout(flushPendingLogLines, 40);
    }
  }, [flushPendingLogLines]);

  useEffect(() => {
    let disposed = false;
    void window.lnwjud.getUpdateStatus().then((status) => {
      if (!disposed) {
        updateInstallTransitionRef.current = status.phase === 'installing';
        setUpdateStatus(status);
      }
    }).catch(() => undefined);
    const unsubscribe = window.lnwjud.onUpdateStatus((status) => {
      if (!disposed) {
        updateInstallTransitionRef.current = status.phase === 'installing';
        setUpdateStatus(status);
      }
    });
    return (): void => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let eventSeen = false;
    void window.lnwjud.getInstallActivity().then((snapshot) => {
      if (!disposed && !eventSeen) setInstallActivity(snapshot);
    }).catch(() => undefined);
    const unsubscribe = window.lnwjud.onInstallActivity((snapshot) => {
      eventSeen = true;
      if (!disposed) setInstallActivity(snapshot);
    });
    return (): void => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    void window.lnwjud.getLogSnapshot().then((snapshot) => {
      if (disposed) return;
      setLogLines((previous) => {
        const merged = applyLogSnapshot(previous, logIds.current, snapshot.lines, MAX_CLIENT_LOG_LINES);
        logIds.current = merged.ids;
        return merged.lines;
      });
      setLogSessions(snapshot.sessions ?? []);
      setTunnelLogPath(snapshot.tunnelLogPath);
      setTunnelLogExists(snapshot.tunnelLogExists);
    }).catch(() => undefined);
    const unsubscribe = window.lnwjud.onLogEvent((line) => {
      appendLogLine(line);
      if (line.source === 'tunnel') setTunnelLogExists(true);
    });
    return (): void => {
      disposed = true;
      unsubscribe();
      if (logFlushTimer.current !== null) {
        window.clearTimeout(logFlushTimer.current);
        logFlushTimer.current = null;
      }
      pendingLogLines.current = [];
    };
  }, [appendLogLine]);

  async function clearLogSource(source: LogSource, scope: LogScopeSelection): Promise<void> {
    try {
      await window.lnwjud.clearLogBuffer({
        source,
        ...(scope.workspaceId === null ? {} : { workspaceId: scope.workspaceId }),
        ...(scope.sessionId === null ? {} : { sessionId: scope.sessionId }),
      });
      pendingLogLines.current = pendingLogLines.current.filter((line) => line.source !== source || !lineMatchesScope(line, scope, workspaces));
      setLogLines((previous) => previous.filter((line) => line.source !== source || !lineMatchesScope(line, scope, workspaces)));
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.logBufferClear')));
    }
  }

  async function clearAllLogs(): Promise<void> {
    try {
      await Promise.all((['tunnel', 'mcp', 'process'] as const).map((source) => window.lnwjud.clearLogBuffer({ source })));
      if (logFlushTimer.current !== null) {
        window.clearTimeout(logFlushTimer.current);
        logFlushTimer.current = null;
      }
      pendingLogLines.current = [];
      logIds.current = new Set();
      setLogLines([]);
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.logBufferClear')));
    }
  }

  async function exportLogSource(source: LogSource, scope: LogScopeSelection, query: string, lines: readonly LiveLogExportReference[]): Promise<void> {
    try {
      await window.lnwjud.exportLogs({
        source,
        filePath: '',
        locale,
        ...(scope.workspaceId === null ? {} : { workspaceId: scope.workspaceId }),
        ...(scope.sessionId === null ? {} : { sessionId: scope.sessionId }),
        ...(query.trim().length === 0 ? {} : { query: query.trim() }),
        lines,
      });
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.logExport')));
    }
  }

  async function popOutLogViewer(): Promise<void> {
    try {
      await window.lnwjud.openLogViewer();
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.logViewerOpen')));
    }
  }

  async function captureIncident(): Promise<void> {
    if (incidentBusyRef.current) return;
    incidentBusyRef.current = true;
    setIncidentBusy(true);
    try {
      const result = await window.lnwjud.captureIncident();
      if (result.exported && !result.cancelled) {
        setIncidentClassification(result.classification);
        setIncidentCapturedAt(result.capturedAt);
        setIncidentNotice(null);
      } else {
        setIncidentNotice(t('live.incident.cancelled'));
      }
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.logExport')));
    } finally {
      incidentBusyRef.current = false;
      setIncidentBusy(false);
    }
  }

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshBusyRef.current || updateInstallTransitionRef.current) return;
    refreshBusyRef.current = true;
    const mcpStatusRevision = mcpDashboardStateRef.current.captureRevision();
    try {
      const [dashboardResult, workspacesResult] = await Promise.allSettled([
        window.lnwjud.getDashboard(),
        window.lnwjud.listWorkspaces(),
      ]);
      const failures: string[] = [];
      if (dashboardResult.status === 'fulfilled') {
        // A dashboard request can start before Stop/Restart and finish afterward.
        // Its MCP state must not replace the result of the user's action.
        if (mcpDashboardStateRef.current.isCurrent(mcpStatusRevision)) {
          setDashboard(dashboardResult.value);
          setLocale(dashboardResult.value.locale);
        }
      } else {
        failures.push(errorMessage(dashboardResult.reason, createTranslator(locale)('error.desktopService')));
      }
      if (workspacesResult.status === 'fulfilled') {
        setWorkspaces(workspacesResult.value);
      } else {
        failures.push(errorMessage(workspacesResult.reason, createTranslator(locale)('error.desktopService')));
      }
      setBootError(updateInstallTransitionRef.current || failures.length === 0 ? null : failures.join(' · '));
    } finally {
      refreshBusyRef.current = false;
    }
  }, [locale]);

  useEffect(() => {
    if (updateStatus?.phase === 'installing') {
      setBootError(null);
      return;
    }
    void refresh();
    const reconcileInterval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 30_000);
    const refreshOnFocus = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const refreshOnVisibility = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnVisibility);
    return (): void => {
      window.clearInterval(reconcileInterval);
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnVisibility);
    };
  }, [refresh, updateStatus?.phase]);

  useEffect(() => {
    if (selectedWorkspaceId === null) {
      setPonytailPolicyContext(null);
      setPonytailPolicyError(null);
      return;
    }
    let disposed = false;
    setPonytailPolicyBusy(true);
    void window.lnwjud.getPonytailPolicyContext({ workspaceId: selectedWorkspaceId }).then((context) => {
      if (disposed) return;
      setPonytailPolicyContext(context);
      setPonytailPolicyError(null);
    }).catch((cause: unknown) => {
      if (disposed) return;
      setPonytailPolicyContext(null);
      setPonytailPolicyError(errorMessage(cause, t('app.ponytailProjectLoadError')));
    }).finally(() => {
      if (!disposed) setPonytailPolicyBusy(false);
    });
    return (): void => { disposed = true; };
  }, [selectedWorkspaceId, globalPonytailMode, locale]);

  useEffect(() => {
    if (dashboard === null || !startupDoctorReady) return;
    const tunnel = dashboard.tunnel;
    const signature = guidedTunnelPrerequisiteSignature(tunnel);
    if (guidedTunnelLaunchSignature.current === signature) return;
    guidedTunnelLaunchSignature.current = signature;
    let state = readGuidedTunnelSetupState(window.localStorage);
    if (isTunnelConfigured(tunnel) && state !== 'completed') {
      // Upgrades/reinstalls preserve the real tunnel prerequisites outside this
      // renderer's localStorage. Normalize any stale onboarding marker so a
      // previously configured user is never sent back to setup on next launch.
      try { writeGuidedTunnelSetupState(window.localStorage, 'completed'); } catch { /* Real tunnel state remains authoritative. */ }
      state = 'completed';
    }
    const decision = guidedTunnelLaunchDecision(tunnel, state);
    if (decision === 'show_tip') {
      setFirstRunTunnelTipOpen(true);
      return;
    }
    if (decision === 'resume_settings') openGuidedTunnelSettings(true);
  }, [dashboard, startupDoctorReady]);

  useEffect(() => {
    if (appVersion === null || startupDoctorVersion.current === appVersion) return;
    startupDoctorVersion.current = appVersion;
    if (!startupDoctorRequired(window.localStorage, appVersion)) {
      setStartupDoctorReady(true);
      return;
    }

    setStartupDoctorReady(false);
    void Promise.all([
      window.lnwjud.runDoctor(),
      window.lnwjud.getToolCatalog({ locale }),
    ]).then(async ([initialReport, initialCatalog]) => {
      // A cold host can time out one localhost identity probe while MCP is
      // starting. Recheck the real core requirements before holding onboarding.
      const result = startupDoctorCorePassed(initialReport)
        ? { doctor: initialReport, catalog: initialCatalog }
        : await window.lnwjud.recheckToolCatalog({ locale, requirementIds: STARTUP_CORE_CHECK_IDS });
      setDoctor(result.doctor);
      setToolCatalog(result.catalog);
      if (startupDoctorCorePassed(result.doctor)) {
        try { markStartupDoctorPassed(window.localStorage, appVersion); } catch { /* Re-run next launch if storage is unavailable. */ }
        setStartupDoctorReady(true);
        return;
      }
      setFirstRunTunnelTipOpen(false);
      setGuidedTunnelSetupOpen(false);
      setScreen('doctor');
    }).catch((cause: unknown) => {
      setStartupDoctorReady(false);
      setError(errorMessage(cause, createTranslator(locale)('error.doctorRun')));
      setFirstRunTunnelTipOpen(false);
      setGuidedTunnelSetupOpen(false);
      setScreen('doctor');
    });
  }, [appVersion, locale]);

  function requestSettingsSection(section: SettingsSection, focus?: SettingsFocusTarget): void {
    settingsRequestId.current += 1;
    setRequestedSettingsSection({ section, ...(focus === undefined ? {} : { focus }), requestId: settingsRequestId.current });
    setError(null);
    setScreen('settings');
  }

  function openGuidedTunnelSettings(markInProgress: boolean): void {
    if (markInProgress) {
      try { writeGuidedTunnelSetupState(window.localStorage, 'in_progress'); } catch { /* UI still works without storage. */ }
    }
    setFirstRunTunnelTipOpen(false);
    setGuidedTunnelSetupOpen(true);
    requestSettingsSection('tunnel');
  }

  function changeGuidedTunnelSetupOpen(open: boolean): void {
    if (!open) {
      if (dashboard === null || !isTunnelRunning(dashboard.tunnel)) {
        try { writeGuidedTunnelSetupState(window.localStorage, 'dismissed'); } catch { /* Closing still dismisses for this session. */ }
      }
      setGuidedTunnelSetupOpen(false);
      return;
    }
    openGuidedTunnelSettings(dashboard === null || !isTunnelRunning(dashboard.tunnel));
  }

  function completeGuidedTunnelSetup(): void {
    try { writeGuidedTunnelSetupState(window.localStorage, 'completed'); } catch { /* Completion is also derived from tunnel state. */ }
  }

  async function openExternalSetupPage(target: ExternalSetupTarget): Promise<void> {
    await window.lnwjud.openExternalSetupPage({ target });
  }

  async function handleUpdateAction(): Promise<void> {
    try {
      if (updateStatus?.canInstall === true) {
        updateInstallTransitionRef.current = true;
        const result = await window.lnwjud.installUpdate();
        updateInstallTransitionRef.current = result.status.phase === 'installing';
        setUpdateStatus(result.status);
        return;
      }
      setUpdateStatus(await window.lnwjud.checkForUpdates());
    } catch (cause: unknown) {
      updateInstallTransitionRef.current = false;
      setError(errorMessage(cause, t('app.updateCheckError')));
    }
  }

  async function addWorkspace(rootPath: string): Promise<boolean> {
    setError(null);
    try {
      await window.lnwjud.addWorkspace({ rootPath });
      await refresh();
      await runDoctor();
      return true;
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.workspaceAdd')));
      return false;
    }
  }

  async function selectWorkspace(workspaceId: string): Promise<void> {
    try {
      setMcpBusy(true);
      await window.lnwjud.selectWorkspace({ workspaceId });
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.workspaceSelect')));
    } finally {
      setMcpBusy(false);
    }
  }

  async function setWorkspaceActive(workspaceId: string, active: boolean): Promise<void> {
    setError(null);
    try {
      await window.lnwjud.setWorkspaceActive({ workspaceId, active });
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('app.workspaceActiveError')));
      throw cause;
    }
  }

  async function setWorkspaceArchived(workspaceId: string, archived: boolean): Promise<void> {
    setError(null);
    try {
      await window.lnwjud.setWorkspaceArchived({ workspaceId, archived });
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.workspaceArchive')));
      throw cause;
    }
  }

  async function deleteWorkspace(workspaceId: string): Promise<void> {
    setError(null);
    try {
      await window.lnwjud.deleteWorkspace({ workspaceId, userConfirmed: true });
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.workspaceDelete')));
      throw cause;
    }
  }

  async function setPermissionProfile(profile: PermissionProfileName): Promise<void> {
    try {
      await window.lnwjud.setPermissionProfile({ profile });
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.permissionProfileChange')));
    }
  }

  async function setUnrestrictedMode(enabled: boolean): Promise<boolean> {
    try {
      const result = await window.lnwjud.setUnrestrictedMode({ enabled });
      await refresh();
      return result.restartRequired;
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.unrestrictedModeChange')));
      return true;
    }
  }

  async function setDestructiveDeletePolicy(policy: DestructiveDeletePolicy): Promise<void> {
    try {
      await window.lnwjud.setAiDeletePolicy({ policy });
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('app.destructivePolicyError')));
    }
  }

  async function setStdioPolicy(profile: PermissionProfileName, strictRoots: boolean, allowedRoots: readonly string[]): Promise<boolean> {
    try {
      const result = await window.lnwjud.setStdioPolicy({ profile, strictRoots, allowedRoots });
      await refresh();
      return result.restartRequired;
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('app.stdioPolicyError')));
      throw cause;
    }
  }

  async function stopMcp(): Promise<void> {
    try {
      setMcpBusy(true);
      const status = await window.lnwjud.stopMcp();
      mcpDashboardStateRef.current.recordMutation();
      setDashboard((current) => mcpDashboardStateRef.current.applyStatus(current, status));
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.mcpStop')));
    } finally {
      setMcpBusy(false);
    }
  }

  async function restartMcp(): Promise<void> {
    try {
      setMcpBusy(true);
      const status = await window.lnwjud.restartMcp();
      mcpDashboardStateRef.current.recordMutation();
      setDashboard((current) => mcpDashboardStateRef.current.applyStatus(current, status));
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.mcpRestart')));
    } finally {
      setMcpBusy(false);
    }
  }

  async function clearWorkLog(scope: LogScopeSelection): Promise<void> {
    try {
      await window.lnwjud.clearWorkLog({
        ...(scope.workspaceId === null ? {} : { workspaceId: scope.workspaceId }),
        ...(scope.sessionId === null ? {} : { sessionId: scope.sessionId }),
      });
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.workLogClear')));
      throw cause;
    }
  }

  async function loadLogSessionHistory(scope: LogScopeSelection): Promise<readonly WorkLogEntry[]> {
    if (scope.sessionId === null) return [];
    try {
      const history = await window.lnwjud.loadLogSessionHistory({
        sessionId: scope.sessionId,
        ...(scope.workspaceId === null ? {} : { workspaceId: scope.workspaceId }),
        limit: 500,
      });
      setLogLines((previous) => {
        const merged = applyLogSnapshot(previous, logIds.current, history.logSnapshot.lines, MAX_CLIENT_LOG_LINES);
        logIds.current = merged.ids;
        return merged.lines;
      });
      setLogSessions(history.logSnapshot.sessions ?? []);
      return history.workLog;
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.desktopService')));
      return [];
    }
  }

  async function exportWorkLog(rowIds: readonly string[]): Promise<void> {
    try {
      await window.lnwjud.exportWorkLog({ rowIds, locale });
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.logExport')));
    }
  }

  async function startTunnelWithStatus(): Promise<TunnelStatus> {
    setTunnelBusy(true);
    try {
      const status = await window.lnwjud.startTunnel();
      await refresh();
      return status;
    } finally {
      setTunnelBusy(false);
    }
  }

  async function startTunnel(): Promise<void> {
    try {
      await startTunnelWithStatus();
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.tunnelStart')));
    }
  }

  async function stopTunnel(): Promise<void> {
    try {
      setTunnelBusy(true);
      await window.lnwjud.stopTunnel();
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.tunnelStop')));
    } finally {
      setTunnelBusy(false);
    }
  }

  async function beginTunnelOAuthLogin(): Promise<TunnelOAuthLoginStatus> {
    return window.lnwjud.beginTunnelOAuthLogin();
  }

  async function getTunnelOAuthLoginStatus(): Promise<TunnelOAuthLoginStatus> {
    return window.lnwjud.getTunnelOAuthLoginStatus();
  }

  async function cancelTunnelOAuthLogin(): Promise<TunnelOAuthLoginStatus> {
    return window.lnwjud.cancelTunnelOAuthLogin();
  }

  async function switchTunnelAuthToLegacy(): Promise<TunnelStatus> {
    const status = await window.lnwjud.switchTunnelAuthToLegacy();
    await refresh();
    return status;
  }

  async function logoutTunnelOAuth(): Promise<TunnelStatus> {
    const status = await window.lnwjud.logoutTunnelOAuth();
    await refresh();
    return status;
  }

  async function createBackup(): Promise<void> {
    await window.lnwjud.createBackup();
    await refresh();
  }

  async function scheduleRestoreBackup(backupId: string): Promise<boolean> {
    const result = await window.lnwjud.scheduleRestoreBackup({ backupId });
    await refresh();
    return result.restartRequired;
  }

  async function restoreRecoveryItem(workspaceId: string, recoveryId: string): Promise<void> {
    await window.lnwjud.restoreRecoveryItem({ workspaceId, recoveryId });
    await refresh();
  }

  async function restoreCheckpoint(workspaceId: string, checkpointId: string): Promise<void> {
    await window.lnwjud.restoreCheckpoint({ workspaceId, checkpointId });
    await refresh();
  }

  async function saveTunnelApiKey(apiKey: string): Promise<void> {
    await window.lnwjud.saveTunnelApiKey({ apiKey });
    await refresh();
  }

  async function setTunnelClientPath(clientPath: string): Promise<void> {
    await window.lnwjud.setTunnelClientPath({ clientPath });
    await refresh();
  }

  async function changeLocale(next: UiLocale): Promise<void> {
    await window.lnwjud.setLocale({ locale: next });
    setLocale(next);
    const catalogPromise = screen === 'tools' || screen === 'doctor' ? window.lnwjud.getToolCatalog({ locale: next }) : null;
    const doctorPromise = screen === 'doctor' ? window.lnwjud.runDoctor() : null;
    await refresh();
    if (catalogPromise !== null) setToolCatalog(await catalogPromise);
    if (doctorPromise !== null) setDoctor(await doctorPromise);
  }

  async function factoryReset(): Promise<{ readonly accepted: boolean }> {
    try {
      return await window.lnwjud.factoryReset();
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('settingsPage.factoryResetFailed')));
      throw cause;
    }
  }

  async function setUserSettings(settings: UserSettings): Promise<boolean> {
    try {
      const result = await window.lnwjud.setUserSettings({ settings });
      await refresh();
      return result.restartRequired;
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('app.settingsSaveError')));
      throw cause;
    }
  }

  async function setWorkspacePonytailMode(mode: PonytailModeOverride): Promise<void> {
    if (selectedWorkspaceId === null) return;
    setPonytailPolicyBusy(true);
    setPonytailPolicyError(null);
    try {
      const context = await window.lnwjud.setWorkspacePonytailMode({ workspaceId: selectedWorkspaceId, mode });
      setPonytailPolicyContext(context);
    } catch (cause: unknown) {
      const message = errorMessage(cause, t('app.ponytailProjectSaveError'));
      setPonytailPolicyError(message);
      throw cause;
    } finally {
      setPonytailPolicyBusy(false);
    }
  }

  async function setGoalPonytailMode(goalId: string, expectedRevision: number, mode: PonytailModeOverride): Promise<void> {
    if (selectedWorkspaceId === null) return;
    setPonytailPolicyBusy(true);
    setPonytailPolicyError(null);
    try {
      const context = await window.lnwjud.setGoalPonytailMode({ workspaceId: selectedWorkspaceId, goalId, expectedRevision, mode });
      setPonytailPolicyContext(context);
    } catch (cause: unknown) {
      const message = errorMessage(cause, t('app.ponytailGoalSaveError'));
      setPonytailPolicyError(message);
      throw cause;
    } finally {
      setPonytailPolicyBusy(false);
    }
  }

  async function chooseTunnelClientPath(): Promise<string | null> {
    const result = await window.lnwjud.chooseTunnelClientPath();
    return result.clientPath;
  }

  async function installPdfProvider(): Promise<PdfProviderInstallResult> {
    setError(null);
    try {
      const result = await window.lnwjud.installPdfProvider();
      await refresh();
      await loadToolCatalog(['local_pdf_provider']);
      return result;
    } catch (cause: unknown) {
      const message = errorMessage(cause, t('app.pdfProviderInstallError'));
      setError(message);
      throw cause instanceof Error ? cause : new Error(message);
    }
  }

  async function configureTunnelProfile(tunnelId: string): Promise<string> {
    const result = await window.lnwjud.configureTunnelProfile({ tunnelId });
    await refresh();
    return result.profilePath;
  }

  async function loadToolCatalog(forceRequirementIds?: readonly string[]): Promise<void> {
    setToolCatalogLoading(true);
    try {
      if (forceRequirementIds === undefined) {
        setToolCatalog(await window.lnwjud.getToolCatalog({ locale }));
      } else {
        const result = await window.lnwjud.recheckToolCatalog({ locale, requirementIds: forceRequirementIds });
        setToolCatalog(result.catalog);
        setDoctor(result.doctor);
      }
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('app.toolCatalogLoadError')));
    } finally {
      setToolCatalogLoading(false);
    }
  }

  function mergeToolCatalogItem(item: ToolCatalogSnapshot['items'][number]): void {
    setToolCatalog((current) => current === null ? current : {
      ...current,
      generatedAt: new Date().toISOString(),
      items: current.items.map((candidate) => candidate.origin === item.origin && candidate.serverName === item.serverName && candidate.name === item.name ? item : candidate),
    });
  }

  async function setToolAvailability(name: string, enabled: boolean): Promise<void> {
    setError(null);
    try {
      const result = await window.lnwjud.setToolAvailability({ locale, name, enabled });
      mergeToolCatalogItem(result.item);
      setToolHostSyncNotice(result.hostSyncMessage);
    } catch (cause: unknown) {
      const message = errorMessage(cause, t('app.toolAvailabilityChangeError'));
      setError(message);
      throw cause instanceof Error ? cause : new Error(message);
    }
  }

  async function resetToolAvailability(name: string): Promise<void> {
    setError(null);
    try {
      const result = await window.lnwjud.resetToolAvailability({ locale, name });
      mergeToolCatalogItem(result.item);
      setToolHostSyncNotice(result.hostSyncMessage);
    } catch (cause: unknown) {
      const message = errorMessage(cause, t('app.toolAvailabilityResetError'));
      setError(message);
      throw cause instanceof Error ? cause : new Error(message);
    }
  }

  async function handleToolRemediation(action: ResolvedRemediation['actions'][number]): Promise<void> {
    if (action.kind === 'recheck') { await loadToolCatalog(action.requirementIds); return; }
    if (action.kind === 'open_official_url' || action.kind === 'open_system_settings') { await window.lnwjud.openToolSetupTarget({ target: action.target }); return; }
    if (action.kind === 'copy_command') { await window.lnwjud.copyToolCommand({ commandId: action.commandId }); return; }
    if (action.kind === 'launch_managed_browser') {
      setError(null);
      try {
        const status = await window.lnwjud.launchManagedBrowser();
        if (!status.ready) throw new Error(t('app.managedBrowserNotReady'));
        await loadToolCatalog(['browser_cdp']);
      } catch (cause: unknown) {
        const message = errorMessage(cause, t('app.managedBrowserStartError'));
        setError(message);
        throw cause instanceof Error ? cause : new Error(message);
      }
      return;
    }
    if (action.kind === 'install_pdf_provider') { await installPdfProvider(); return; }
    if (action.kind === 'set_user_setting') {
      if (dashboard === null) return;
      const restartRequired = await setUserSettings({ ...dashboard.settings, [action.setting]: action.value });
      if (restartRequired) {
        try {
          setMcpBusy(true);
          await window.lnwjud.restartMcp();
          await refresh();
        } catch (cause: unknown) {
          setError(errorMessage(cause, t('error.mcpRestart')));
          return;
        } finally {
          setMcpBusy(false);
        }
      }
      await loadToolCatalog(action.setting === 'codexToolsEnabled' ? ['codex_runtime'] : undefined);
      return;
    }
    const navigation = remediationNavigationForTarget(action.target);
    if (navigation === null) {
      setError(t('app.unknownSettingsTarget', { target: action.target }));
      return;
    }
    if (navigation.screen === 'projects') { setScreen('projects'); return; }
    requestSettingsSection(navigation.section, navigation.focus);
  }

  async function runDoctor(): Promise<void> {
    try {
      const { doctor: report, catalog } = await window.lnwjud.recheckToolCatalog({
        locale,
        requirementIds: STARTUP_CORE_CHECK_IDS,
      });
      setDoctor(report);
      setToolCatalog(catalog);
      if (startupDoctorCorePassed(report) && appVersion !== null) {
        try { markStartupDoctorPassed(window.localStorage, appVersion); } catch { /* Re-run next launch if storage is unavailable. */ }
        startupDoctorVersion.current = appVersion;
        setStartupDoctorReady(true);
      } else {
        setStartupDoctorReady(false);
      }
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.doctorRun')));
    }
  }

  const installBusy = installActivity.operations.length > 0;

  if (dashboard === null) {
    return (
      <>
        <div className="app-interaction-root" inert={installBusy ? true : undefined} aria-hidden={installBusy ? true : undefined}>
          <div className="boot-screen">
            {bootError === null ? t('app.loading') : (
              <div className="boot-recovery" role="alert">
                <strong>{t('app.bootFailed')}</strong>
                <p>{bootError}</p>
                <div className="inline-actions">
                  <button type="button" onClick={() => { void refresh(); }}>{t('action.retry')}</button>
                  <button type="button" onClick={() => { void popOutLogViewer(); }}>{t('app.openLogs')}</button>
                </div>
              </div>
            )}
          </div>
        </div>
        <GlobalInstallProgressModal locale={locale} activity={installActivity} />
      </>
    );
  }

  return (
    <>
      <div className="app-interaction-root" inert={installBusy ? true : undefined} aria-hidden={installBusy ? true : undefined}>
        <AppShell
      locale={locale}
      appVersion={dashboard.appVersion}
      hostPlatform={dashboard.hostPlatform}
      mcpRunning={dashboard.mcp.running}
      desktopFullBypassOn={dashboard.permissionProfile === 'full' && dashboard.settings?.desktopFullBypassAll === true}
      stdioFullBypassOn={dashboard.stdioPermissionProfile === 'full' && dashboard.settings?.stdioFullBypassAll === true}
      updateStatus={updateStatus}
      screen={screen}
      onNavigate={(nextScreen) => {
        setError(null);
        const target = startupDoctorNavigationTarget(startupDoctorReady, nextScreen);
        if (target === 'settings') setRequestedSettingsSection(undefined);
        setScreen(target);
        if (target === 'worklog') void refresh();
        if (target === 'tools') void loadToolCatalog(['external_mcp_connection']);
      }}
      onLocaleChange={(next) => { void changeLocale(next); }}
      onUpdateAction={() => { void handleUpdateAction(); }}
    >
      {bootError === null ? null : (
        <div className="error-banner boot-partial-error" role="alert">
          <span>{bootError}</span>
          <button type="button" onClick={() => { void refresh(); }}>{t('action.retry')}</button>
        </div>
      )}
      {error === null ? null : <div className="error-banner" role="alert">{error}</div>}
      {screen === 'home' ? (
        <ControlCenterPage
          dashboard={dashboard}
          workspaces={projectWorkspaces}
          locale={locale}
          mcpBusy={mcpBusy}
          tunnelBusy={tunnelBusy}
          onRefresh={refresh}
          onStopMcp={stopMcp}
          onRestartMcp={restartMcp}
          onSelectWorkspace={selectWorkspace}
          onSetWorkspaceActive={setWorkspaceActive}
          onAddWorkspace={addWorkspace}
          onStartTunnel={startTunnel}
          onStopTunnel={stopTunnel}
          onOpenTunnelSetup={() => openGuidedTunnelSettings(!isTunnelRunning(dashboard.tunnel))}
          onCaptureIncident={captureIncident}
          incidentBusy={incidentBusy}
          incidentClassification={incidentClassification}
          incidentCapturedAt={incidentCapturedAt}
          incidentNotice={incidentNotice}
        />
      ) : null}
      {screen === 'projects' ? (
        <ProjectsPage
          locale={locale}
          workspaces={workspaces}
          selectedWorkspaceId={dashboard.selectedWorkspace?.id ?? null}
          activeWorkspaceIds={dashboard.activeWorkspaces.map((workspace) => workspace.id)}
          onSelectWorkspace={selectWorkspace}
          onSetWorkspaceActive={setWorkspaceActive}
          onAddWorkspace={addWorkspace}
          onSetWorkspaceArchived={setWorkspaceArchived}
          onDeleteWorkspace={deleteWorkspace}
        />
      ) : null}
      {screen === 'tools' ? (
        <ToolsPage
          locale={locale}
          snapshot={toolCatalog}
          loading={toolCatalogLoading}
          hostSyncNotice={toolHostSyncNotice}
          onRefresh={() => loadToolCatalog([])}
          onRemediation={handleToolRemediation}
          onSetAvailability={setToolAvailability}
          onResetAvailability={resetToolAvailability}
        />
      ) : null}
      {screen === 'git' ? (
        <GitPage
          locale={locale}
          gitSummary={dashboard.gitSummary}
          selectedWorkspace={dashboard.selectedWorkspace}
          workspaces={projectWorkspaces}
          onSelectWorkspace={selectWorkspace}
          onRefresh={refresh}
        />
      ) : null}
      {screen === 'worklog' ? (
        <WorkLogPage locale={locale} dashboard={dashboard} workspaces={workspaces} onClearWorkLog={clearWorkLog} onExportWorkLog={exportWorkLog} onLoadSessionHistory={loadLogSessionHistory} />
      ) : null}
      {screen === 'live' ? (
        <LiveLogsPage
          locale={locale}
          lines={logLines}
          tunnelLogPath={tunnelLogPath}
          tunnelLogExists={tunnelLogExists}
          tunnelAuth={dashboard.tunnel.auth}
          onClear={clearLogSource}
          onClearAll={clearAllLogs}
          onExport={exportLogSource}
          onPopOut={popOutLogViewer}
          onCaptureIncident={captureIncident}
          incidentBusy={incidentBusy}
          incidentClassification={incidentClassification}
          incidentCapturedAt={incidentCapturedAt}
          incidentNotice={incidentNotice}
          workspaces={workspaces}
          sessions={logSessions}
          onLoadSessionHistory={loadLogSessionHistory}
        />
      ) : null}
      {screen === 'settings' ? (
        <SettingsPage
          locale={locale}
          dashboard={dashboard}
          onLocaleChange={changeLocale}
          onFactoryReset={factoryReset}
          onPermissionProfileChange={setPermissionProfile}
          onUnrestrictedChange={setUnrestrictedMode}
          onDestructiveDeletePolicyChange={setDestructiveDeletePolicy}
          onStdioPolicyChange={setStdioPolicy}
          onCreateBackup={createBackup}
          onScheduleRestoreBackup={scheduleRestoreBackup}
          onRestoreRecoveryItem={restoreRecoveryItem}
          onRestoreCheckpoint={restoreCheckpoint}
          onSaveTunnelApiKey={saveTunnelApiKey}
          onSetTunnelClientPath={setTunnelClientPath}
          onUserSettingsChange={setUserSettings}
          ponytailPolicyContext={ponytailPolicyContext}
          ponytailPolicyBusy={ponytailPolicyBusy}
          ponytailPolicyError={ponytailPolicyError}
          onWorkspacePonytailModeChange={setWorkspacePonytailMode}
          onGoalPonytailModeChange={setGoalPonytailMode}
          onInstallPdfProvider={installPdfProvider}
          onChooseTunnelClientPath={chooseTunnelClientPath}
          onConfigureTunnelProfile={configureTunnelProfile}
          onStartTunnel={startTunnelWithStatus}
          onStopTunnel={stopTunnel}
          tunnelBusy={tunnelBusy}
          onBeginTunnelOAuthLogin={beginTunnelOAuthLogin}
          onGetTunnelOAuthLoginStatus={getTunnelOAuthLoginStatus}
          onCancelTunnelOAuthLogin={cancelTunnelOAuthLogin}
          onSwitchTunnelAuthToLegacy={switchTunnelAuthToLegacy}
          onLogoutTunnelOAuth={logoutTunnelOAuth}
          onOpenExternalSetupPage={openExternalSetupPage}
          onRefresh={refresh}
          guidedTunnelSetupOpen={guidedTunnelSetupOpen}
          onGuidedTunnelSetupOpenChange={changeGuidedTunnelSetupOpen}
          onGuidedTunnelLocalComplete={completeGuidedTunnelSetup}
          requestedSection={requestedSettingsSection}
        />
      ) : null}
      {screen === 'workflows' ? (
        <WorkflowsPage locale={locale} workspaceId={selectedWorkspaceId} workspacePath={dashboard?.selectedWorkspace?.rootPath ?? null} />
      ) : null}
      {screen === 'doctor' ? (
        <DiagnosticsPage locale={locale} workspaceId={selectedWorkspaceId} checks={
          <DoctorPanel
            locale={locale}
            report={doctor}
            remediations={toolCatalog?.remediations ?? []}
            onRunDoctor={runDoctor}
            onRecheck={(requirementIds) => loadToolCatalog(requirementIds)}
            onRemediation={handleToolRemediation}
            onOpenProjects={() => setScreen('projects')}
          />
        } />
      ) : null}
      {firstRunTunnelTipOpen ? (
        <FirstRunTunnelTip
          locale={locale}
          permissionProfile={dashboard.permissionProfile}
          onPermissionProfileChange={(profile) => { void setPermissionProfile(profile); }}
          onStart={() => openGuidedTunnelSettings(true)}
          onLater={() => {
            try { writeGuidedTunnelSetupState(window.localStorage, 'dismissed'); } catch { /* Dismiss for this session even if storage is unavailable. */ }
            setFirstRunTunnelTipOpen(false);
          }}
        />
      ) : null}
        </AppShell>
      </div>
      <GlobalInstallProgressModal locale={locale} activity={installActivity} />
    </>
  );
}


function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;
}

function lineMatchesScope(line: Pick<LogLine, 'workspaceId' | 'sessionId'>, scope: LogScopeSelection, workspaces: readonly WorkspaceSummary[]): boolean {
  if (scope.workspaceId !== null && !workspaceScopeMatches(workspaces, line.workspaceId, scope.workspaceId)) return false;
  if (scope.sessionId !== null && line.sessionId !== scope.sessionId) return false;
  return true;
}
