import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { LogLine, LogSource } from '@lnwjud/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';
import { LogStreamPanel } from './LogStreamPanel.js';

const MAX_CLIENT_LOG_LINES = 4_000;

export function StandaloneLogViewer(): ReactElement {
  const t = createTranslator('th');
  const [lines, setLines] = useState<readonly LogLine[]>([]);
  const [tunnelLogPath, setTunnelLogPath] = useState<string | null>(null);
  const [tunnelLogExists, setTunnelLogExists] = useState(false);
  const [tab, setTab] = useState<LogSource>('tunnel');
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
      setLines(snapshot.lines);
      setTunnelLogPath(snapshot.tunnelLogPath);
      setTunnelLogExists(snapshot.tunnelLogExists);
      logIds.current = new Set(snapshot.lines.map((line) => line.id));
    }).catch(() => undefined);
    const unsubscribe = window.lnwjud.onLogEvent((line) => {
      appendLine(line);
      if (line.source === 'tunnel') setTunnelLogExists(true);
    });
    // Polling the dashboard keeps the work-log and process feeds flowing into the log hub.
    const interval = window.setInterval(() => {
      void window.lnwjud.getDashboard().catch(() => undefined);
    }, 1_000);
    return (): void => {
      disposed = true;
      unsubscribe();
      window.clearInterval(interval);
    };
  }, [appendLine]);

  async function clear(source: LogSource): Promise<void> {
    await window.lnwjud.clearLogBuffer({ source }).catch(() => undefined);
    setLines((previous) => previous.filter((line) => line.source !== source));
  }

  async function exportLogs(source: LogSource): Promise<void> {
    await window.lnwjud.exportLogs({ source, filePath: '' }).catch(() => undefined);
  }

  const sources: readonly LogSource[] = ['tunnel', 'mcp', 'process'];

  return (
    <div className="log-viewer-shell">
      <header className="log-viewer-header">
        <strong>lnwjud — Live Logs</strong>
        <span className="hint">{tunnelLogPath ?? ''}</span>
      </header>
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
      <LogStreamPanel
        title={tab === 'tunnel' ? t('live.tabTunnel') : tab === 'mcp' ? t('live.tabMcp') : t('live.tabProcess')}
        source={tab}
        lines={lines.filter((line) => line.source === tab)}
        tunnelLogPath={tunnelLogPath}
        tunnelLogExists={tunnelLogExists}
        pauseLabel={t('live.pause')}
        followLabel={t('live.follow')}
        filterPlaceholder={t('live.filter')}
        clearLabel={t('workLog.clear')}
        exportLabel={t('live.export')}
        waitingLabel={tab === 'tunnel' ? t('live.waitingTunnel') : t('live.waiting')}
        onClear={() => clear(tab)}
        onExport={() => exportLogs(tab)}
      />
    </div>
  );
}
