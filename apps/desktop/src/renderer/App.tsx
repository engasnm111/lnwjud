import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type {
  DashboardSnapshot,
  DoctorReport,
  PermissionProfileName,
  ProcessSummary,
  WorkspaceSummary,
} from '@lnwjud/ipc-contracts';
import { DashboardPage } from './features/dashboard/DashboardPage.js';
import { DoctorPanel } from './features/doctor/DoctorPanel.js';

type Screen = 'dashboard' | 'doctor';

export function App(): ReactElement {
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [dashboard, setDashboard] = useState<DashboardSnapshot | null>(null);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [processes, setProcesses] = useState<readonly ProcessSummary[]>([]);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextDashboard, nextWorkspaces, nextProcesses] = await Promise.all([
        window.lnwjud.getDashboard(),
        window.lnwjud.listWorkspaces(),
        window.lnwjud.listProcesses(),
      ]);
      setDashboard(nextDashboard);
      setWorkspaces(nextWorkspaces);
      setProcesses(nextProcesses);
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Desktop service request failed');
    }
  }, []);

  const refreshProcesses = useCallback(async (): Promise<void> => {
    try {
      setProcesses(await window.lnwjud.listProcesses());
    } catch {
      // The primary dashboard error carries initial-load failures; transient polling errors are not fatal.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => { void refreshProcesses(); }, 250);
    return (): void => { window.clearInterval(interval); };
  }, [refresh, refreshProcesses]);

  async function addWorkspace(rootPath: string): Promise<void> {
    try {
      await window.lnwjud.addWorkspace({ rootPath });
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'Workspace could not be added'));
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

  async function startFixtureProcess(): Promise<void> {
    const workspaceId = dashboard?.selectedWorkspace?.id;
    if (workspaceId === undefined) return;
    try {
      await window.lnwjud.startProcess({ workspaceId, mode: 'fixture' });
      await refreshProcesses();
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'Process could not be started'));
    }
  }

  async function stopProcess(processId: string): Promise<void> {
    try {
      await window.lnwjud.stopProcess({ processId });
      await refreshProcesses();
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'Process could not be stopped'));
    }
  }

  async function runDoctor(): Promise<void> {
    try {
      setDoctor(await window.lnwjud.runDoctor());
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'Doctor could not run'));
    }
  }

  async function startMcp(): Promise<void> {
    const workspaceId = dashboard?.selectedWorkspace?.id;
    if (workspaceId === undefined) {
      setError('Select a workspace before starting MCP');
      return;
    }
    setMcpBusy(true);
    try {
      await window.lnwjud.startMcp({ workspaceId });
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'MCP connection could not be started'));
    } finally {
      setMcpBusy(false);
    }
  }

  async function stopMcp(): Promise<void> {
    setMcpBusy(true);
    try {
      await window.lnwjud.stopMcp();
      await refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'MCP connection could not be stopped'));
    } finally {
      setMcpBusy(false);
    }
  }

  const selectedProcess = processes[processes.length - 1] ?? null;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">LOCAL DEVELOPMENT AGENT GATEWAY</p>
          <p className="brand">lnwjud</p>
        </div>
        <nav aria-label="Primary navigation">
          <button type="button" onClick={() => setScreen('dashboard')}>Dashboard</button>
          <button type="button" onClick={() => setScreen('doctor')}>Doctor</button>
        </nav>
      </header>
      {error === null ? null : <p role="alert" className="error-banner">{error}</p>}
      {screen === 'dashboard' && dashboard !== null ? (
        <DashboardPage
          dashboard={dashboard}
          workspaces={workspaces}
          processes={processes}
          selectedProcess={selectedProcess}
          onAddWorkspace={addWorkspace}
          onPermissionProfileChange={setPermissionProfile}
          onStartFixtureProcess={startFixtureProcess}
          onStopProcess={stopProcess}
          onStartMcp={startMcp}
          onStopMcp={stopMcp}
          mcpBusy={mcpBusy}
        />
      ) : null}
      {screen === 'doctor' ? <DoctorPanel report={doctor} onRunDoctor={runDoctor} /> : null}
      {screen === 'dashboard' && dashboard === null && error === null ? <p>Loading dashboard…</p> : null}
    </main>
  );
}

function errorMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error) || cause.message.trim().length === 0 || cause.message.startsWith('Error invoking remote method')) return fallback;
  return cause.message;
}
