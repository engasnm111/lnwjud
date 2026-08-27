import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { workspaceScopeMatches } from '@lnwjud/ipc-contracts';
import type {
  DashboardSnapshot,
  DestructiveDeletePolicy,
  DoctorReport,
  LogLine,
  LogSource,
  PermissionProfileName,
  UiLocale,
  UpdateStatus,
  UserSettings,
  IncidentClassification,
  ExternalSetupTarget,
  TunnelStatus,
  WorkspaceSummary,
} from '@lnwjud/ipc-contracts';
import { AppShell, type Screen } from './features/shell/AppShell.js';
import { ControlCenterPage } from './features/home/ControlCenterPage.js';
import { ProjectsPage } from './features/projects/ProjectsPage.js';
import { GitPage } from './features/git/GitPage.js';
import { WorkLogPage } from './features/worklog/WorkLogPage.js';
import { LiveLogsPage } from './features/live/LiveLogsPage.js';
import type { LogScopeSelection } from './features/live/LogStreamPanel.js';
import { applyLogSnapshot } from './features/live/log-buffer.js';
import { SettingsPage, type SettingsSection } from './features/settings/SettingsPage.js';
import { DoctorPanel } from './features/doctor/DoctorPanel.js';
import { FirstRunTunnelTip } from './features/onboarding/FirstRunTunnelTip.js';
import {
  guidedTunnelLaunchDecision,
  guidedTunnelPrerequisiteSignature,
  isTunnelRunning,
  readGuidedTunnelSetupState,
  writeGuidedTunnelSetupState,
} from './features/onboarding/guided-tunnel-setup-state.js';
import { createTranslator } from './i18n/index.js';
import { markStartupDoctorPassed, startupDoctorCorePassed, startupDoctorRequired } from './features/onboarding/startup-doctor-state.js';

const MAX_CLIENT_LOG_LINES = 30_000;

export function App(): ReactElement {
  const [screen, setScreen] = useState<Screen>('home');
  const [dashboard, setDashboard] = useState<DashboardSnapshot | null>(null);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [locale, setLocale] = useState<UiLocale>('th');
  const [logLines, setLogLines] = useState<readonly LogLine[]>([]);
  const [tunnelLogPath, setTunnelLogPath] = useState<string | null>(null);
  const [tunnelLogExists, setTunnelLogExists] = useState(false);
  const [incidentClassification, setIncidentClassification] = useState<IncidentClassification | null>(null);
  const [incidentCapturedAt, setIncidentCapturedAt] = useState<string | null>(null);
  const [incidentNotice, setIncidentNotice] = useState<string | null>(null);
  const [incidentBusy, setIncidentBusy] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [firstRunTunnelTipOpen, setFirstRunTunnelTipOpen] = useState(false);
  const [guidedTunnelSetupOpen, setGuidedTunnelSetupOpen] = useState(false);
  const [startupDoctorReady, setStartupDoctorReady] = useState(false);
  const [requestedSettingsSection, setRequestedSettingsSection] = useState<{ readonly section: SettingsSection; readonly requestId: number } | undefined>(undefined);
  const incidentBusyRef = useRef(false);
  const logIds = useRef<Set<number>>(new Set());
  const guidedTunnelLaunchSignature = useRef<string | null>(null);
  const startupDoctorVersion = useRef<string | null>(null);
  const settingsRequestId = useRef(0);

  const t = createTranslator(locale);
  const appVersion = dashboard?.appVersion ?? null;
  const projectWorkspaces = workspaces.filter((workspace) => workspace.kind !== 'machine_root' && (workspace.archivedAt === undefined || workspace.archivedAt === null));

  const appendLogLine = useCallback((line: LogLine): void => {
    if (logIds.current.has(line.id)) return;
    logIds.current.add(line.id);
    setLogLines((previous) => [...previous.slice(-(MAX_CLIENT_LOG_LINES - 1)), line]);
  }, []);

  useEffect(() => {
    let disposed = false;
    void window.lnwjud.getUpdateStatus().then((status) => {
      if (!disposed) setUpdateStatus(status);
    }).catch(() => undefined);
    const unsubscribe = window.lnwjud.onUpdateStatus((status) => {
      if (!disposed) setUpdateStatus(status);
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
        const merged = applyLogSnapshot(previous, logIds.current, snapshot.lines);
        logIds.current = merged.ids;
        return merged.lines;
      });
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
    };
  }, [appendLogLine]);

  async function clearLogSource(source: LogSource, scope: LogScopeSelection): Promise<void> {
    try {
      await window.lnwjud.clearLogBuffer({
        source,
        ...(scope.workspaceId === null ? {} : { workspaceId: scope.workspaceId }),
        ...(scope.sessionId === null ? {} : { sessionId: scope.sessionId }),
      });
      setLogLines((previous) => previous.filter((line) => line.source !== source || !lineMatchesScope(line, scope, workspaces)));
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.logBufferClear')));
    }
  }

  async function clearAllLogs(): Promise<void> {
    try {
      await Promise.all((['tunnel', 'mcp', 'process'] as const).map((source) => window.lnwjud.clearLogBuffer({ source })));
      logIds.current = new Set();
      setLogLines([]);
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.logBufferClear')));
    }
  }

  async function exportLogSource(source: LogSource, scope: LogScopeSelection, query: string, lineIds: readonly number[], rows: readonly string[]): Promise<void> {
    try {
      await window.lnwjud.exportLogs({
        source,
        filePath: '',
        ...(scope.workspaceId === null ? {} : { workspaceId: scope.workspaceId }),
        ...(scope.sessionId === null ? {} : { sessionId: scope.sessionId }),
        ...(query.trim().length === 0 ? {} : { query: query.trim() }),
        lineIds,
        rows,
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
    try {
      const [nextDashboard, nextWorkspaces] = await Promise.all([
        window.lnwjud.getDashboard(),
        window.lnwjud.listWorkspaces(),
      ]);
      setDashboard(nextDashboard);
      setWorkspaces(nextWorkspaces);
      setLocale(nextDashboard.locale);

    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : createTranslator(locale)('error.desktopService'));
    }
  }, [locale]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 1_000);
    return (): void => { window.clearInterval(interval); };
  }, [refresh]);

  useEffect(() => {
    if (dashboard === null || !startupDoctorReady) return;
    const tunnel = dashboard.tunnel;
    const signature = guidedTunnelPrerequisiteSignature(tunnel);
    if (guidedTunnelLaunchSignature.current === signature) return;
    guidedTunnelLaunchSignature.current = signature;
    const state = readGuidedTunnelSetupState(window.localStorage);
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
    void window.lnwjud.runDoctor().then((report) => {
      setDoctor(report);
      if (startupDoctorCorePassed(report)) {
        try { markStartupDoctorPassed(window.localStorage, appVersion); } catch { /* Re-run next launch if storage is unavailable. */ }
        setStartupDoctorReady(true);
        return;
      }
      setFirstRunTunnelTipOpen(false);
      setGuidedTunnelSetupOpen(false);
      setScreen('doctor');
    }).catch((cause: unknown) => {
      setError(errorMessage(cause, createTranslator(locale)('error.doctorRun')));
      setFirstRunTunnelTipOpen(false);
      setGuidedTunnelSetupOpen(false);
      setScreen('doctor');
    });
  }, [appVersion, locale]);

  function requestSettingsSection(section: SettingsSection): void {
    settingsRequestId.current += 1;
    setRequestedSettingsSection({ section, requestId: settingsRequestId.current });
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
        const result = await window.lnwjud.installUpdate();
        setUpdateStatus(result.status);
        return;
      }
      setUpdateStatus(await window.lnwjud.checkForUpdates());
    } catch (cause: unknown) {
      setError(errorMessage(cause, locale === 'th' ? 'ไม่สามารถตรวจอัปเดตได้' : 'Unable to check for updates'));
    }
  }

  async function addWorkspace(rootPath: string): Promise<void> {
    setError(null);
    try {
      await window.lnwjud.addWorkspace({ rootPath });
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, t('error.workspaceAdd')));
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
      setError(errorMessage(cause, propsText(locale, 'ไม่สามารถเปลี่ยน Active Project ได้', 'Could not change Active Project')));
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
      setError(errorMessage(cause, propsText(locale, 'ไม่สามารถเปลี่ยนนโยบายการลบได้', 'Could not change destructive-action policy')));
    }
  }

  async function setStdioPolicy(profile: PermissionProfileName, strictRoots: boolean, allowedRoots: readonly string[]): Promise<boolean> {
    try {
      const result = await window.lnwjud.setStdioPolicy({ profile, strictRoots, allowedRoots });
      await refresh();
      return result.restartRequired;
    } catch (cause: unknown) {
      setError(errorMessage(cause, propsText(locale, 'ไม่สามารถบันทึก STDIO policy ได้', 'Could not save STDIO policy')));
      throw cause;
    }
  }

  async function stopMcp(): Promise<void> {
    try {
      setMcpBusy(true);
      await window.lnwjud.stopMcp();
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
      await window.lnwjud.restartMcp();
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
    }
  }

  async function exportWorkLog(rows: readonly string[]): Promise<void> {
    try {
      await window.lnwjud.exportWorkLog({ rows });
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
    await refresh();
  }

  async function setUserSettings(settings: UserSettings): Promise<boolean> {
    try {
      const result = await window.lnwjud.setUserSettings({ settings });
      await refresh();
      return result.restartRequired;
    } catch (cause: unknown) {
      setError(errorMessage(cause, propsText(locale, 'ไม่สามารถบันทึกการตั้งค่าได้', 'Could not save settings')));
      throw cause;
    }
  }

  async function chooseTunnelClientPath(): Promise<string | null> {
    const result = await window.lnwjud.chooseTunnelClientPath();
    return result.clientPath;
  }

  async function configureTunnelProfile(tunnelId: string): Promise<string> {
    const result = await window.lnwjud.configureTunnelProfile({ tunnelId });
    await refresh();
    return result.profilePath;
  }

  async function runDoctor(): Promise<void> {
    try {
      const report = await window.lnwjud.runDoctor();
      setDoctor(report);
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

  if (dashboard === null) {
    return <div className="boot-screen">{t('app.loading')}</div>;
  }

  return (
    <AppShell
      locale={locale}
      appVersion={dashboard.appVersion}
      mcpRunning={dashboard.mcp.running}
      updateStatus={updateStatus}
      screen={screen}
      onNavigate={(nextScreen) => {
        setError(null);
        if (!startupDoctorReady && doctor?.exitCode === 1 && nextScreen !== 'doctor') {
          setScreen('doctor');
          return;
        }
        setScreen(nextScreen);
      }}
      onLocaleChange={(next) => { void changeLocale(next); }}
      onUpdateAction={() => { void handleUpdateAction(); }}
    >
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
        <WorkLogPage locale={locale} dashboard={dashboard} workspaces={workspaces} onClearWorkLog={clearWorkLog} onExportWorkLog={exportWorkLog} />
      ) : null}
      {screen === 'live' ? (
        <LiveLogsPage
          locale={locale}
          lines={logLines}
          tunnelLogPath={tunnelLogPath}
          tunnelLogExists={tunnelLogExists}
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
        />
      ) : null}
      {screen === 'settings' ? (
        <SettingsPage
          locale={locale}
          dashboard={dashboard}
          onLocaleChange={changeLocale}
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
          onChooseTunnelClientPath={chooseTunnelClientPath}
          onConfigureTunnelProfile={configureTunnelProfile}
          onStartTunnel={startTunnelWithStatus}
          onStopTunnel={stopTunnel}
          onOpenExternalSetupPage={openExternalSetupPage}
          onRefresh={refresh}
          guidedTunnelSetupOpen={guidedTunnelSetupOpen}
          onGuidedTunnelSetupOpenChange={changeGuidedTunnelSetupOpen}
          onGuidedTunnelLocalComplete={completeGuidedTunnelSetup}
          requestedSection={requestedSettingsSection}
        />
      ) : null}
      {screen === 'doctor' ? (
        <div className="page-content">
          <h1>{t('doctor.title')}</h1>
          <DoctorPanel locale={locale} report={doctor} onRunDoctor={runDoctor} />
        </div>
      ) : null}
      {firstRunTunnelTipOpen ? (
        <FirstRunTunnelTip
          locale={locale}
          onStart={() => openGuidedTunnelSettings(true)}
          onLater={() => {
            try { writeGuidedTunnelSetupState(window.localStorage, 'dismissed'); } catch { /* Dismiss for this session even if storage is unavailable. */ }
            setFirstRunTunnelTipOpen(false);
          }}
        />
      ) : null}
    </AppShell>
  );
}

function propsText(locale: UiLocale, th: string, en: string): string {
  return locale === 'th' ? th : en;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;
}

function lineMatchesScope(line: Pick<LogLine, 'workspaceId' | 'sessionId'>, scope: LogScopeSelection, workspaces: readonly WorkspaceSummary[]): boolean {
  if (scope.workspaceId !== null && !workspaceScopeMatches(workspaces, line.workspaceId, scope.workspaceId)) return false;
  if (scope.sessionId !== null && line.sessionId !== scope.sessionId) return false;
  return true;
}
