import { useCallback, useState, type ReactElement } from 'react';
import type { IncidentClassification, LiveLogExportReference, LogLine, LogSource, TunnelAuthStatus, UiLocale, WorkspaceSummary } from '@lnwjud/ipc-contracts';
import { formatDateTime } from '../../date-time.js';
import { createTranslator } from '../../i18n/index.js';
import { tunnelAuthPresentation } from '../../tunnel-auth-presentation.js';
import { LogStreamPanel, type LogScopeSelection } from './LogStreamPanel.js';

interface LiveLogsPageProps {
  readonly locale: UiLocale;
  readonly lines: readonly LogLine[];
  readonly tunnelLogPath: string | null;
  readonly tunnelLogExists: boolean;
  readonly tunnelAuth?: TunnelAuthStatus | undefined;
  readonly onClear: (source: LogSource, scope: LogScopeSelection) => Promise<void>;
  readonly onClearAll: () => Promise<void>;
  readonly onExport: (source: LogSource, scope: LogScopeSelection, query: string, lines: readonly LiveLogExportReference[]) => Promise<void>;
  readonly onPopOut: () => Promise<void>;
  readonly onCaptureIncident: () => Promise<void>;
  readonly incidentBusy: boolean;
  readonly incidentClassification: IncidentClassification | null;
  readonly incidentCapturedAt: string | null;
  readonly incidentNotice: string | null;
  readonly workspaces: readonly WorkspaceSummary[];
}

type LogTab = LogSource;

export function LiveLogsPage(props: LiveLogsPageProps): ReactElement {
  const t = createTranslator(props.locale);
  const tunnelPresentation = tunnelAuthPresentation({ auth: props.tunnelAuth });
  const [tab, setTab] = useState<LogTab>('tunnel');
  const sources: readonly LogTab[] = ['tunnel', 'mcp', 'process'];
  const resolveTargetDetail = useCallback(async (detailRef: string) => (await window.lnwjud.resolveActivityTargetDetail({ detailRef })).detail, []);
  const searchTargetDetails = useCallback(async (
    query: string,
    candidates: readonly { readonly id: string; readonly detailRef: string | null }[],
  ) => (await window.lnwjud.searchActivityTargetDetails({ query, candidates })).matchingIds, []);

  return (
    <div className="page-content live-logs-page">
      <div className="page-heading">
        <div>
          <h1>{t('live.title')}</h1>
          <p className="page-subtitle">{t(tunnelPresentation.logSubtitleKey)}</p>
        </div>
        <div className="heading-actions">
          <button type="button" className="clear-all-logs-button" onClick={() => { void props.onClearAll(); }}>{props.locale === 'th' ? 'ล้าง Log ทั้งหมด' : 'Clear All Logs'}</button>
          <button type="button" disabled={props.incidentBusy} onClick={() => { void props.onCaptureIncident(); }}>{t('live.captureIncident')}</button>
          <button type="button" onClick={() => { void props.onPopOut(); }}>{t('live.popOut')}</button>
        </div>
      </div>
      {!props.incidentBusy && props.incidentNotice === null && props.incidentClassification === null ? null : <p className="hint" role="status">{props.incidentBusy ? t('live.incident.capturing') : props.incidentNotice ?? `${incidentSummary(t, props.incidentClassification!)} · ${formatDateTime(props.incidentCapturedAt, '—', props.locale)}`}</p>}
      <div className="log-tabs" role="tablist" aria-label={t('live.title')}>
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
      {sources.map((source) => (
        tab === source ? (
          <LogStreamPanel
            key={source}
            locale={props.locale}
            title={source === 'tunnel' ? t(tunnelPresentation.logTabKey) : source === 'mcp' ? t('live.tabMcp') : t('live.tabProcess')}
            source={source}
            lines={props.lines.filter((line) => line.source === source)}
            tunnelLogPath={props.tunnelLogPath}
            tunnelLogExists={props.tunnelLogExists}
            pauseLabel={t('live.pause')}
            followLabel={t('live.follow')}
            filterPlaceholder={t('live.filter')}
            clearLabel={t('live.clearTab')}
            clearSessionLabel={t('scope.clearSession')}
            clearWorkspaceLabel={t('scope.clearWorkspace')}
            exportLabel={t('live.export')}
            waitingLabel={source === 'tunnel' ? t(tunnelPresentation.logWaitingKey) : source === 'process' ? t('live.waitingProcess') : t('live.waiting')}
            {...(source === 'process' ? { description: t('live.processHint') } : {})}
            copyLabel={t('mcp.copy')}
            copiedLabel={t('mcp.copied')}
            onResolveTargetDetail={resolveTargetDetail}
            onSearchTargetDetails={searchTargetDetails}
            showMoreLabel={t('logDetail.showMore')}
            showLessLabel={t('logDetail.showLess')}
            detailHeadingLabel={t('logDetail.heading')}
            detailLoadingLabel={t('logDetail.loading')}
            detailErrorLabel={t('logDetail.error')}
            detailEmptyLabel={t('logDetail.empty')}
            legacyIncompleteLabel={t('logDetail.legacyIncomplete')}
            workspaces={props.workspaces}
            workspaceLabel={t('scope.workspace')}
            sessionLabel={t('scope.session')}
            scopeAllLabel={t('scope.all')}
            onClear={(scope) => props.onClear(source, scope)}
            onExport={(scope, query, lines) => props.onExport(source, scope, query, lines)}
          />
        ) : null
      ))}
    </div>
  );
}

function incidentSummary(t: ReturnType<typeof createTranslator>, classification: IncidentClassification): string {
  if (classification === 'local_tool_failed') return t('live.incident.localToolFailed');
  if (classification === 'tunnel_disconnected') return t('live.incident.tunnelDisconnected');
  if (classification === 'remote_turn_stopped') return t('live.incident.remoteTurnStopped');
  return t('live.incident.healthyOrInconclusive');
}
