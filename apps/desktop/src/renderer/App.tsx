import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type {
  DashboardSnapshot,
  DoctorReport,
  LogLine,
  LogSource,
  PermissionProfileName,
  UiLocale,
  WorkspaceSummary,
} from '@lnwjud/ipc-contracts';
import { AppShell, type Screen } from './features/shell/AppShell.js';
import { ControlCenterPage } from './features/home/ControlCenterPage.js';
import { ProjectsPage } from './features/projects/ProjectsPage.js';
import { GitPage } from './features/git/GitPage.js';
import { WorkLogPage } from './features/worklog/WorkLogPage.js';
import { LiveLogsPage } from './features/live/LiveLogsPage.js';
import { SettingsPage } from './features/settings/SettingsPage.js';
import { DoctorPanel } from './features/doctor/DoctorPanel.js';
import { createTranslator } from './i18n/index.js';

const MAX_CLIENT_LOG_LINES = 4_000;

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
  const logIds = useRef<Set<number>>(new Set());

  const appendLogLine = useCallback((line: LogLine): void => {
    if (logIds.current.has(line.id)) return;
    logIds.current.add(line.id);
    setLogLines((previous) => [...previous.slice(-(MAX_CLIENT_LOG_LINES - 1)), line]);
  }, []);

  useEffect(() => {
    let disposed = false;
    void window.lnwjud.getLogSnapshot().then((snapshot) => {
      if (disposed) return;
      setLogLines(snapshot.lines);
      setTunnelLogPath(snapshot.tunnelLogPath);
      setTunnelLogExists(snapshot.tunnelLogExists);
      logIds.current = new Set(snapshot.lines.map((line) => line.id));
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

  async function clearLogSource(source: LogSource): Promise<void> {
    try {
      await window.lnwjud.clearLogBuffer({ source });
      setLogLines((previous) => previous.filter((line) => line.source !== source));
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'Log buffer could not be cleared'));
    }
  }

  async function exportLogSource(source: LogSource): Promise<void> {
    try {
      await window.lnwjud.exportLogs({ source, filePath: '' });
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'Log export failed'));
    }
  }

  async function popOutLogViewer(): Promise<void> {
    try {
      await window.lnwjud.openLogViewer();
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'Log viewer could not be opened'));
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
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Desktop service request failed');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 1_000);
    return (): void => { window.clearInterval(interval); };
  }, [refresh]);

  async function addWorkspace(rootPath: string): Promise<void> {
    try {
      await window.lnwjud.addWorkspace({ rootPath });
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'Workspace could not be added'));
    }
  }

  async function selectWorkspace(workspaceId: string): Promise<void> {
    try {
      setMcpBusy(true);
      await window.lnwjud.selectWorkspace({ workspaceId });
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'Workspace could not be selected'));
    } finally {
      setMcpBusy(false);
    }
  }

  async function setPermissionProfile(profile: PermissionProfileName): Promise<void> {
    try {
      await window.lnwjud.setPermissionProfile({ profile });
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'Permission profile could not be changed'));
    }
  }

  async function setUnrestrictedMode(enabled: boolean): Promise<boolean> {
    try {
      const result = await window.lnwjud.setUnrestrictedMode({ enabled });
      await refresh();
      return result.restartRequired;
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'Unrestricted mode could not be changed'));
      return true;
    }
  }

  async function stopMcp(): Promise<void> {
    try {
      setMcpBusy(true);
      await window.lnwjud.stopMcp();
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'MCP could not be stopped'));
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
      setError(errorMessage(cause, 'MCP could not be restarted'));
    } finally {
      setMcpBusy(false);
    }
  }

  async function clearWorkLog(): Promise<void> {
    try {
      await window.lnwjud.clearWorkLog();
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'Work log could not be cleared'));
    }
  }

  async function startTunnel(): Promise<void> {
    try {
      setTunnelBusy(true);
      await window.lnwjud.startTunnel();
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'Tunnel could not be started'));
    } finally {
      setTunnelBusy(false);
    }
  }

  async function stopTunnel(): Promise<void> {
    try {
      setTunnelBusy(true);
      await window.lnwjud.stopTunnel();
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'Tunnel could not be stopped'));
    } finally {
      setTunnelBusy(false);
    }
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

  async function runDoctor(): Promise<void> {
    try {
      setDoctor(await window.lnwjud.runDoctor());
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'Doctor could not run'));
    }
  }

  if (dashboard === null) {
    return <div className="boot-screen">Loading…</div>;
  }

  const t = createTranslator(locale);

  return (
    <AppShell
      locale={locale}
      appVersion={dashboard.appVersion}
      mcpRunning={dashboard.mcp.running}
      screen={screen}
      onNavigate={setScreen}
      onLocaleChange={(next) => { void changeLocale(next); }}
    >
      {error === null ? null : <div className="error-banner" role="alert">{error}</div>}
      {screen === 'home' ? (
        <ControlCenterPage
          dashboard={dashboard}
          workspaces={workspaces}
          locale={locale}
          mcpBusy={mcpBusy}
          tunnelBusy={tunnelBusy}
          onRefresh={refresh}
          onStopMcp={stopMcp}
          onRestartMcp={restartMcp}
          onSelectWorkspace={selectWorkspace}
          onAddWorkspace={addWorkspace}
          onStartTunnel={startTunnel}
          onStopTunnel={stopTunnel}
          onClearWorkLog={clearWorkLog}
        />
      ) : null}
      {screen === 'projects' ? (
        <ProjectsPage
          locale={locale}
          workspaces={workspaces}
          selectedWorkspaceId={dashboard.selectedWorkspace?.id ?? null}
          onSelectWorkspace={selectWorkspace}
          onAddWorkspace={addWorkspace}
        />
      ) : null}
      {screen === 'git' ? <GitPage locale={locale} gitSummary={dashboard.gitSummary} /> : null}
      {screen === 'worklog' ? (
        <WorkLogPage locale={locale} dashboard={dashboard} onClearWorkLog={clearWorkLog} />
      ) : null}
      {screen === 'live' ? (
        <LiveLogsPage
          locale={locale}
          lines={logLines}
          tunnelLogPath={tunnelLogPath}
          tunnelLogExists={tunnelLogExists}
          onClear={clearLogSource}
          onExport={exportLogSource}
          onPopOut={popOutLogViewer}
        />
      ) : null}
      {screen === 'settings' ? (
        <SettingsPage
          locale={locale}
          dashboard={dashboard}
          onLocaleChange={changeLocale}
          onPermissionProfileChange={setPermissionProfile}
          onUnrestrictedChange={setUnrestrictedMode}
          onSaveTunnelApiKey={saveTunnelApiKey}
          onSetTunnelClientPath={setTunnelClientPath}
        />
      ) : null}
      {screen === 'doctor' ? (
        <div className="page-content">
          <h1>{t('doctor.title')}</h1>
          <DoctorPanel report={doctor} onRunDoctor={runDoctor} />
        </div>
      ) : null}
    </AppShell>
  );
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;
}
