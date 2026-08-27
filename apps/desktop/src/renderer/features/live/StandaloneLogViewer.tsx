import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { workspaceScopeMatches, type LogLine, type LogSource, type WorkspaceSummary } from '@lnwjud/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';
import { applyLogSnapshot } from './log-buffer.js';
import { LogStreamPanel, type LogScopeSelection } from './LogStreamPanel.js';

const MAX_CLIENT_LOG_LINES = 30_000;
const sources: readonly LogSource[] = ['tunnel', 'mcp', 'process'];

export function StandaloneLogViewer(): ReactElement {
  const t = createTranslator('th');
  const [lines, setLines] = useState<readonly LogLine[]>([]);
  const [tunnelLogPath, setTunnelLogPath] = useState<string | null>(null);
  const [tunnelLogExists, setTunnelLogExists] = useState(false);
  const [tab, setTab] = useState<LogSource>('tunnel');
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const logIds = useRef<Set<number>>(new Set());

  const appendLine = useCallback((line: LogLine): void => {
    if (logIds.current.has(line.id)) return;
    logIds.current.add(line.id);
    setLines((previous) => [...previous.slice(-(MAX_CLIENT_LOG_LINES - 1)), line]);
  }, []);

  useEffect(() => {
    let disposed = false;
    void window.lnwjud.getLogSnapshot().then((snapshot) => {
      if (disposed) return;
      setLines((previous) => {
        const merged = applyLogSnapshot(previous, logIds.current, snapshot.lines);
        logIds.current = merged.ids;
        return merged.lines;
      });
      setTunnelLogPath(snapshot.tunnelLogPath);
      setTunnelLogExists(snapshot.tunnelLogExists);
    }).catch(() => undefined);
    void window.lnwjud.listWorkspaces().then((nextWorkspaces) => {
      if (!disposed) setWorkspaces(nextWorkspaces);
    }).catch(() => undefined);
    const unsubscribe = window.lnwjud.onLogEvent((line) => {
      appendLine(line);
      if (line.source === 'tunnel') setTunnelLogExists(true);
    });
    const interval = window.setInterval(() => {
      void window.lnwjud.getDashboard().catch(() => undefined);
    }, 1_000);
    return (): void => {
      disposed = true;
      unsubscribe();
      window.clearInterval(interval);
    };
  }, [appendLine]);

  async function clear(source: LogSource, scope: LogScopeSelection): Promise<void> {
    const request = {
      source,
      ...(scope.workspaceId === null ? {} : { workspaceId: scope.workspaceId }),
      ...(scope.sessionId === null ? {} : { sessionId: scope.sessionId }),
    };
    await window.lnwjud.clearLogBuffer(request).catch(() => undefined);
    setLines((previous) => previous.filter((line) => line.source !== source || !lineMatchesScope(line, scope, workspaces)));
  }

  async function clearAll(): Promise<void> {
    await Promise.all(sources.map((source) => window.lnwjud.clearLogBuffer({ source }).catch(() => undefined)));
    logIds.current = new Set();
    setLines([]);
  }

  async function exportLogs(source: LogSource, scope: LogScopeSelection, query: string, lineIds: readonly number[], rows: readonly string[]): Promise<void> {
    await window.lnwjud.exportLogs({
      source,
      filePath: '',
      ...(scope.workspaceId === null ? {} : { workspaceId: scope.workspaceId }),
      ...(scope.sessionId === null ? {} : { sessionId: scope.sessionId }),
      ...(query.trim().length === 0 ? {} : { query: query.trim() }),
      lineIds,
      rows,
    }).catch(() => undefined);
  }

  return (
    <div className="window-container log-viewer-window">
      <header className="custom-titlebar">
        <div className="titlebar-drag-region">
          <div className="titlebar-brand">
            <img src="./favicon.ico" alt="lnwjud logo" className="titlebar-logo" />
            <span className="titlebar-title">{t('brand')}</span>
            <span className="titlebar-version">Live Logs</span>
          </div>
          <div className="titlebar-center">
            <span className="hint" style={{ fontSize: '11.5px' }}>{tunnelLogPath ?? ''}</span>
          </div>
        </div>
      </header>

      <div className="log-viewer-shell">
        <div className="log-tabs-toolbar">
          <div className="log-tabs" role="tablist" aria-label="Live Logs">
            {sources.map((source) => (
              <button
                key={source}
                type="button"
                role="tab"
                aria-selected={tab === source}
                className={tab === source ? 'log-tab active' : 'log-tab'}
                onClick={() => setTab(source)}
              >
                {source === 'tunnel' ? t('live.tabTunnel') : source === 'mcp' ? t('live.tabMcp') : t('live.tabProcess')}
              </button>
            ))}
          </div>
          <button type="button" className="clear-all-logs-button" onClick={() => { void clearAll(); }}>ล้าง Log ทั้งหมด</button>
        </div>
        <LogStreamPanel
          title={tab === 'tunnel' ? t('live.tabTunnel') : tab === 'mcp' ? t('live.tabMcp') : t('live.tabProcess')}
          source={tab}
          lines={lines.filter((line) => line.source === tab)}
          tunnelLogPath={tunnelLogPath}
          tunnelLogExists={tunnelLogExists}
          pauseLabel={t('live.pause')}
          followLabel={t('live.follow')}
          filterPlaceholder={t('live.filter')}
          clearLabel={t('live.clearTab')}
          clearSessionLabel={t('scope.clearSession')}
          clearWorkspaceLabel={t('scope.clearWorkspace')}
          exportLabel={t('live.export')}
          waitingLabel={tab === 'tunnel' ? t('live.waitingTunnel') : t('live.waiting')}
          workspaceLabel={t('scope.workspace')}
          sessionLabel={t('scope.session')}
          scopeAllLabel={t('scope.all')}
          workspaces={workspaces}
          onClear={(scope) => clear(tab, scope)}
          onExport={(scope, query, lineIds, rows) => exportLogs(tab, scope, query, lineIds, rows)}
        />
      </div>
    </div>
  );
}

function lineMatchesScope(line: Pick<LogLine, 'workspaceId' | 'sessionId'>, scope: LogScopeSelection, workspaces: readonly WorkspaceSummary[]): boolean {
  if (scope.workspaceId !== null && !workspaceScopeMatches(workspaces, line.workspaceId, scope.workspaceId)) return false;
  if (scope.sessionId !== null && line.sessionId !== scope.sessionId) return false;
  return true;
}
