import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { workspaceScopeMatches, type LiveLogExportReference, type LogLine, type LogSource, type TunnelAuthStatus, type UiLocale, type WorkspaceSummary } from '@lnwjud/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';
import { tunnelAuthPresentation } from '../../tunnel-auth-presentation.js';
import { appendLogBatch, applyLogSnapshot, rememberLogId } from './log-buffer.js';
import { LogStreamPanel, type LogScopeSelection } from './LogStreamPanel.js';

const MAX_CLIENT_LOG_LINES = 30_000;
const sources: readonly LogSource[] = ['tunnel', 'mcp', 'process'];

export function StandaloneLogViewer(): ReactElement {
  const [locale, setLocale] = useState<UiLocale>('th');
  const t = createTranslator(locale);
  const [lines, setLines] = useState<readonly LogLine[]>([]);
  const [tunnelLogPath, setTunnelLogPath] = useState<string | null>(null);
  const [tunnelLogExists, setTunnelLogExists] = useState(false);
  const [tunnelAuth, setTunnelAuth] = useState<TunnelAuthStatus | undefined>(undefined);
  const [tab, setTab] = useState<LogSource>('tunnel');
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const logIds = useRef<Set<number>>(new Set());
  const pendingLogLines = useRef<LogLine[]>([]);
  const logFlushTimer = useRef<number | null>(null);
  const tunnelPresentation = tunnelAuthPresentation({ auth: tunnelAuth });

  const flushPendingLogLines = useCallback((): void => {
    logFlushTimer.current = null;
    if (pendingLogLines.current.length === 0) return;
    const batch = pendingLogLines.current;
    pendingLogLines.current = [];
    setLines((previous) => appendLogBatch(previous, batch, MAX_CLIENT_LOG_LINES));
  }, []);

  const appendLine = useCallback((line: LogLine): void => {
    if (!rememberLogId(logIds.current, line.id, MAX_CLIENT_LOG_LINES * 2)) return;
    pendingLogLines.current.push(line);
    if (logFlushTimer.current === null) {
      logFlushTimer.current = window.setTimeout(flushPendingLogLines, 40);
    }
  }, [flushPendingLogLines]);
  const resolveTargetDetail = useCallback(async (detailRef: string) => (await window.lnwjud.resolveActivityTargetDetail({ detailRef })).detail, []);
  const searchTargetDetails = useCallback(async (
    query: string,
    candidates: readonly { readonly id: string; readonly detailRef: string | null }[],
  ) => (await window.lnwjud.searchActivityTargetDetails({ query, candidates })).matchingIds, []);

  useEffect(() => {
    let disposed = false;
    void window.lnwjud.getLogSnapshot().then((snapshot) => {
      if (disposed) return;
      setLines((previous) => {
        const merged = applyLogSnapshot(previous, logIds.current, snapshot.lines, MAX_CLIENT_LOG_LINES);
        logIds.current = merged.ids;
        return merged.lines;
      });
      setTunnelLogPath(snapshot.tunnelLogPath);
      setTunnelLogExists(snapshot.tunnelLogExists);
      setTunnelAuth(snapshot.tunnelAuth);
    }).catch(() => undefined);
    void window.lnwjud.listWorkspaces().then((nextWorkspaces) => {
      if (!disposed) setWorkspaces(nextWorkspaces);
    }).catch(() => undefined);
    void window.lnwjud.getDashboard().then((dashboard) => {
      if (!disposed) setLocale(dashboard.locale);
    }).catch(() => undefined);
    const unsubscribe = window.lnwjud.onLogEvent((line) => {
      appendLine(line);
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
  }, [appendLine]);

  async function clear(source: LogSource, scope: LogScopeSelection): Promise<void> {
    const request = {
      source,
      ...(scope.workspaceId === null ? {} : { workspaceId: scope.workspaceId }),
      ...(scope.sessionId === null ? {} : { sessionId: scope.sessionId }),
    };
    await window.lnwjud.clearLogBuffer(request).catch(() => undefined);
    pendingLogLines.current = pendingLogLines.current.filter((line) => line.source !== source || !lineMatchesScope(line, scope, workspaces));
    setLines((previous) => previous.filter((line) => line.source !== source || !lineMatchesScope(line, scope, workspaces)));
  }

  async function clearAll(): Promise<void> {
    await Promise.all(sources.map((source) => window.lnwjud.clearLogBuffer({ source }).catch(() => undefined)));
    if (logFlushTimer.current !== null) {
      window.clearTimeout(logFlushTimer.current);
      logFlushTimer.current = null;
    }
    pendingLogLines.current = [];
    logIds.current = new Set();
    setLines([]);
  }

  async function exportLogs(source: LogSource, scope: LogScopeSelection, query: string, lines: readonly LiveLogExportReference[]): Promise<void> {
    await window.lnwjud.exportLogs({
      source,
      filePath: '',
      locale,
      ...(scope.workspaceId === null ? {} : { workspaceId: scope.workspaceId }),
      ...(scope.sessionId === null ? {} : { sessionId: scope.sessionId }),
      ...(query.trim().length === 0 ? {} : { query: query.trim() }),
      lines,
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
                {source === 'tunnel' ? t(tunnelPresentation.logTabKey) : source === 'mcp' ? t('live.tabMcp') : t('live.tabProcess')}
              </button>
            ))}
          </div>
          <button type="button" className="clear-all-logs-button" onClick={() => { void clearAll(); }}>{locale === 'th' ? 'ล้าง Log ทั้งหมด' : 'Clear All Logs'}</button>
        </div>
        <LogStreamPanel
          locale={locale}
          title={tab === 'tunnel' ? t(tunnelPresentation.logTabKey) : tab === 'mcp' ? t('live.tabMcp') : t('live.tabProcess')}
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
          waitingLabel={tab === 'tunnel' ? t(tunnelPresentation.logWaitingKey) : tab === 'process' ? t('live.waitingProcess') : t('live.waiting')}
          {...(tab === 'process' ? { description: t('live.processHint') } : {})}
          workspaceLabel={t('scope.workspace')}
          sessionLabel={t('scope.session')}
          scopeAllLabel={t('scope.all')}
          onResolveTargetDetail={resolveTargetDetail}
          onSearchTargetDetails={searchTargetDetails}
          showMoreLabel={t('logDetail.showMore')}
          showLessLabel={t('logDetail.showLess')}
          detailHeadingLabel={t('logDetail.heading')}
          detailLoadingLabel={t('logDetail.loading')}
          detailErrorLabel={t('logDetail.error')}
          detailEmptyLabel={t('logDetail.empty')}
          legacyIncompleteLabel={t('logDetail.legacyIncomplete')}
          workspaces={workspaces}
          onClear={(scope) => clear(tab, scope)}
          onExport={(scope, query, lines) => exportLogs(tab, scope, query, lines)}
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
