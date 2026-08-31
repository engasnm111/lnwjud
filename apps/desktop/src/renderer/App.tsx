import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { workspaceScopeMatches } from '@lnwjud/ipc-contracts';
import type {
  DashboardSnapshot,
  DestructiveDeletePolicy,
  DoctorReport,
  ToolCatalogSnapshot,
  ResolvedRemediation,
  LogLine,
  LogSource,
  PermissionProfileName,
  PdfProviderInstallResult,
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
import { SettingsPage, type SettingsFocusTarget, type SettingsSection } from './features/settings/SettingsPage.js';
import { DoctorPanel } from './features/doctor/DoctorPanel.js';
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
import { markStartupDoctorPassed, startupDoctorCorePassed, startupDoctorNavigationTarget, startupDoctorRequired } from './features/onboarding/startup-doctor-state.js';

const MAX_CLIENT_LOG_LINES = 30_000;
const REFRESH_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Clear the timer on settle: refresh() runs every second, and a leaked
    // 8 s timer per call would otherwise accumulate live timers indefinitely.
    const timer = setTimeout((): void => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    void promise.then(
      (value: T) => { clearTimeout(timer); resolve(value); },
      (cause: unknown) => { clearTimeout(timer); reject(cause); },
    );
  });
}

export function App(): ReactElement {
  const [screen, setScreen] = useState<Screen>('home');
  const [dashboard, setDashboard] = useState<DashboardSnapshot | null>(null);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [toolCatalog, setToolCatalog] = useState<ToolCatalogSnapshot | null>(null);
  const [toolCatalogLoading, setToolCatalogLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
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
  const [requestedSettingsSection, setRequestedSettingsSection] = useState<{ readonly section: SettingsSection; readonly focus?: SettingsFocusTarget; readonly requestId: number } | undefined>(undefined);
  const incidentBusyRef = useRef(false);
  const refreshInFlight = useRef(false);
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
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const [dashboardResult, workspacesResult] = await Promise.allSettled([
        withTimeout(window.lnwjud.getDashboard(), REFRESH_TIMEOUT_MS, 'getDashboard'),
        withTimeout(window.lnwjud.listWorkspaces(), REFRESH_TIMEOUT_MS, 'listWorkspaces'),
      ]);
      const failures: string[] = [];
      if (dashboardResult.status === 'fulfilled') {
        setDashboard(dashboardResult.value);
        setLocale(dashboardResult.value.locale);
      } else {
        failures.push(errorMessage(dashboardResult.reason, createTranslator(locale)('error.desktopService')));
      }
      if (workspacesResult.status === 'fulfilled') {
        setWorkspaces(workspacesResult.value);
      } else {
        failures.push(errorMessage(workspacesResult.reason, createTranslator(locale)('error.desktopService')));
      }
      setBootError(failures.length === 0 ? null : failures.join(' · '));
    } finally {
      refreshInFlight.current = false;
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
    ]).then(([report, catalog]) => {
      setDoctor(report);
      setToolCatalog(catalog);
      if (startupDoctorCorePassed(report)) {
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
        const result = await window.lnwjud.installUpdate();
        setUpdateStatus(result.status);
        return;
      }
      setUpdateStatus(await window.lnwjud.checkForUpdates());
    } catch (cause: unknown) {
      setError(errorMessage(cause, locale === 'th' ? 'ไม่สามารถตรวจอัปเดตได้' : 'Unable to check for updates'));
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
    const catalogPromise = screen === 'tools' || screen === 'doctor' ? window.lnwjud.getToolCatalog({ locale: next }) : null;
    const doctorPromise = screen === 'doctor' ? window.lnwjud.runDoctor() : null;
    await refresh();
    if (catalogPromise !== null) setToolCatalog(await catalogPromise);
    if (doctorPromise !== null) setDoctor(await doctorPromise);
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

  async function installPdfProvider(): Promise<PdfProviderInstallResult> {
    setError(null);
    try {
      const result = await window.lnwjud.installPdfProvider();
      await refresh();
      await loadToolCatalog(['local_pdf_provider']);
      return result;
    } catch (cause: unknown) {
      const message = errorMessage(cause, propsText(locale, 'ดาวน์โหลดหรือติดตั้ง PDF Provider ไม่สำเร็จ', 'Could not download or install the PDF Provider'));
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
      setError(errorMessage(cause, propsText(locale, 'ไม่สามารถโหลดรายการเครื่องมือได้', 'Could not load the tool catalog')));
    } finally {
      setToolCatalogLoading(false);
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
        if (!status.ready) throw new Error(propsText(locale, 'Managed Browser เปิดแล้วแต่ CDP ยังไม่พร้อม', 'Managed Browser started but CDP is not ready'));
        await loadToolCatalog(['browser_cdp']);
      } catch (cause: unknown) {
        const message = errorMessage(cause, propsText(locale, 'ไม่สามารถเปิด Managed Browser ได้', 'Could not start Managed Browser'));
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
      setError(propsText(locale, `ไม่รู้จักเป้าหมายการตั้งค่า: ${action.target}`, `Unknown settings target: ${action.target}`));
      return;
    }
    if (navigation.screen === 'projects') { setScreen('projects'); return; }
    requestSettingsSection(navigation.section, navigation.focus);
  }

  async function runDoctor(): Promise<void> {
    try {
      const [report, catalog] = await Promise.all([
        window.lnwjud.runDoctor(),
        window.lnwjud.getToolCatalog({ locale }),
      ]);
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

  if (dashboard === null) {
    return (
      <div className="boot-screen">
        {bootError === null ? t('app.loading') : (
          <div className="boot-recovery" role="alert">
            <strong>{locale === 'th' ? 'เปิด lnwjud ไม่สำเร็จ' : 'lnwjud could not finish starting'}</strong>
            <p>{bootError}</p>
            <div className="inline-actions">
              <button type="button" onClick={() => { void refresh(); }}>{locale === 'th' ? 'ลองใหม่' : 'Retry'}</button>
              <button type="button" onClick={() => { void popOutLogViewer(); }}>{locale === 'th' ? 'เปิดบันทึกการทำงาน' : 'Open Logs'}</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <AppShell
      locale={locale}
      appVersion={dashboard.appVersion}
      mcpRunning={dashboard.mcp.running}
      desktopFullBypassOn={dashboard.permissionProfile === 'full' && dashboard.settings?.desktopFullBypassAll === true}
      stdioFullBypassOn={dashboard.stdioPermissionProfile === 'full' && dashboard.settings?.stdioFullBypassAll === true}
      updateStatus={updateStatus}
      screen={screen}
      onNavigate={(nextScreen) => {
        setError(null);
        const target = startupDoctorNavigationTarget(startupDoctorReady, nextScreen);
        setScreen(target);
        if (target === 'tools') void loadToolCatalog();
      }}
      onLocaleChange={(next) => { void changeLocale(next); }}
      onUpdateAction={() => { void handleUpdateAction(); }}
    >
      {bootError === null ? null : (
        <div className="error-banner boot-partial-error" role="alert">
          <span>{bootError}</span>
          <button type="button" onClick={() => { void refresh(); }}>{locale === 'th' ? 'ลองใหม่' : 'Retry'}</button>
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
          onRefresh={() => loadToolCatalog()}
          onRemediation={handleToolRemediation}
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
          onInstallPdfProvider={installPdfProvider}
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
          <DoctorPanel
            locale={locale}
            report={doctor}
            remediations={toolCatalog?.remediations ?? []}
            onRunDoctor={runDoctor}
            onRecheck={(requirementIds) => loadToolCatalog(requirementIds)}
            onRemediation={handleToolRemediation}
            onOpenProjects={() => setScreen('projects')}
          />
        </div>
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
