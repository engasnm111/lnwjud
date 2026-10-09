import { ActionButton, FormInput } from '../ui/UiPrimitives.js';
import { useDeferredValue, useEffect, useMemo, useReducer, useRef, useState, type ReactElement, type UIEvent } from 'react';
import { canonicalWorkspaceScopeId, workspaceScopeMatches, type ActivityTargetDetail, type LiveLogExportReference, type LogLevel, type LogLine, type LogSessionSummary, type LogSource, type UiLocale, type WorkspaceSummary } from '@lnwjud/ipc-contracts';
import { formatDisplayTimestampItem } from '@lnwjud/shared/date-time-display';
import { copyTextToClipboard } from '../../clipboard.js';
import type { MessageKey } from '../../i18n/messages.js';
import { formatLogExportDateTime, formatLogUiTime } from '../../log-timestamp.js';
import { CopyableScopeBadge } from '../CopyableScopeBadge.js';
import { SearchableSelect } from '../../components/ui/SearchableSelect.js';
import { ExpandableTargetDetail } from '../logs/ExpandableTargetDetail.js';
import { activeDetailMatchIds, activeLogFeed, createDetailSearchState, normalizeDetailSearchQuery, reduceDetailSearchState, transitionLogFeedFreeze } from '../logs/detail-search-state.js';
import { collectSessionFilterOptions, collectWorkspaceFilterOptions } from '../../scope-filter-options.js';

export type LogTab = LogSource;
export type LogEventKind = 'task' | 'result';

export interface LogScopeSelection {
  readonly workspaceId: string | null;
  readonly sessionId: string | null;
}

interface LogStreamPanelProps {
  readonly locale?: UiLocale;
  readonly title: string;
  readonly source: LogSource;
  readonly lines: readonly LogLine[];
  readonly tunnelLogPath: string | null;
  readonly tunnelLogExists: boolean;
  readonly pauseLabel: string;
  readonly followLabel: string;
  readonly filterPlaceholder: string;
  readonly clearLabel: string;
  readonly clearSessionLabel: string;
  readonly clearWorkspaceLabel: string;
  readonly exportLabel: string;
  readonly waitingLabel: string;
  readonly description?: string;
  readonly copyLabel?: string;
  readonly copiedLabel?: string;
  readonly onClear: (scope: LogScopeSelection) => Promise<void>;
  readonly onExport: (scope: LogScopeSelection, query: string, lines: readonly LiveLogExportReference[]) => Promise<void>;
  readonly onResolveTargetDetail?: (detailRef: string) => Promise<ActivityTargetDetail | null>;
  readonly onSearchTargetDetails?: (query: string, candidates: readonly { readonly id: string; readonly detailRef: string | null }[]) => Promise<readonly string[]>;
  readonly workspaces?: readonly WorkspaceSummary[];
  readonly sessions?: readonly LogSessionSummary[];
  readonly onSessionChange?: (scope: LogScopeSelection) => Promise<void>;
  readonly workspaceLabel?: string;
  readonly sessionLabel?: string;
  readonly scopeAllLabel?: string;
  readonly showMoreLabel?: string;
  readonly showLessLabel?: string;
  readonly detailHeadingLabel?: string;
  readonly detailLoadingLabel?: string;
  readonly detailErrorLabel?: string;
  readonly detailEmptyLabel?: string;
  readonly legacyIncompleteLabel?: string;
}


const PROGRESSIVE_PAGE_SIZE = 120;

export function LogStreamPanel(props: LogStreamPanelProps): ReactElement {
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [copyErrorId, setCopyErrorId] = useState<number | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PROGRESSIVE_PAGE_SIZE);
  const [detailSearchState, dispatchDetailSearch] = useReducer(reduceDetailSearchState, undefined, createDetailSearchState);
  const detailSearchGeneration = useRef(0);
  const currentFeed = useMemo(
    () => ({ lines: props.lines, workspaces: props.workspaces }),
    [props.lines, props.workspaces],
  );
  const [feedFreeze, setFeedFreeze] = useState<typeof currentFeed | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const feed = activeLogFeed(feedFreeze, currentFeed);
  const feedLines = feed.lines;
  const sessionSamples = useMemo(() => [
    ...feedLines,
    ...(props.sessions ?? []).map((session) => ({ workspaceId: session.workspaceId, sessionId: session.sessionId, timestamp: session.startedAt })),
  ], [feedLines, props.sessions]);
  const workspaceOptions = useMemo(() => collectWorkspaceFilterOptions(sessionSamples, feed.workspaces), [sessionSamples, feed.workspaces]);
  const sessionOptions = useMemo(
    () => collectSessionFilterOptions(sessionSamples, workspaceId, feed.workspaces, props.locale ?? 'th', props.sessionLabel ?? 'Session'),
    [sessionSamples, workspaceId, feed.workspaces, props.locale, props.sessionLabel],
  );
  useEffect(() => {
    if (sessionId !== null && !sessionOptions.some((option) => option.id === sessionId)) {
      setSessionId(null);
      void props.onSessionChange?.({ workspaceId, sessionId: null });
    }
  }, [props.onSessionChange, sessionId, sessionOptions, workspaceId]);
  const scope = useMemo<LogScopeSelection>(() => ({ workspaceId, sessionId }), [workspaceId, sessionId]);
  const searchCandidates = useMemo(() => visibleLogLines(feedLines, scope, '', feed.workspaces), [feed, scope]);
  useEffect(() => {
    const query = normalizeDetailSearchQuery(deferredFilter);
    const generation = ++detailSearchGeneration.current;
    if (query.length === 0 || props.onSearchTargetDetails === undefined) {
      dispatchDetailSearch({ type: 'reset', generation });
      return;
    }
    dispatchDetailSearch({ type: 'start', generation, query });
    const timeout = window.setTimeout(() => {
      const candidates = searchCandidates.flatMap((line) => {
        const detailRef = detailRefForLine(line);
        if (detailRef === null || line.text.toLocaleLowerCase().includes(query)) return [];
        return [{ id: liveLineIdentity(line), detailRef }];
      });
      if (candidates.length === 0) {
        dispatchDetailSearch({ type: 'success', generation, query, matchingIds: [] });
        return;
      }
      void props.onSearchTargetDetails?.(query, candidates).then((ids) => {
        dispatchDetailSearch({ type: 'success', generation, query, matchingIds: ids });
      }).catch(() => {
        dispatchDetailSearch({ type: 'failure', generation, query });
      });
    }, 180);
    return (): void => window.clearTimeout(timeout);
  }, [deferredFilter, props.onSearchTargetDetails, searchCandidates]);
  const hiddenMatches = activeDetailMatchIds(detailSearchState, deferredFilter);
  const matchingLines = useMemo(() => visibleLogLines(feedLines, scope, deferredFilter, feed.workspaces, hiddenMatches), [feed, scope, deferredFilter, hiddenMatches]);
  useEffect(() => setVisibleCount(PROGRESSIVE_PAGE_SIZE), [props.source, filter, workspaceId, sessionId]);
  const visible = useMemo(() => matchingLines.slice(0, visibleCount), [matchingLines, visibleCount]);
  const newestLineId = matchingLines[0]?.id ?? null;

  useEffect(() => {
    if (paused) return;
    const element = streamRef.current;
    if (element === null) return;
    element.scrollTop = 0;
  }, [newestLineId, paused]);

  function loadMoreOnScroll(event: UIEvent<HTMLDivElement>): void {
    if (visibleCount >= matchingLines.length) return;
    const element = event.currentTarget;
    if (element.scrollHeight - element.scrollTop - element.clientHeight > 320) return;
    setVisibleCount((current) => Math.min(matchingLines.length, current + PROGRESSIVE_PAGE_SIZE));
  }

  async function copyLine(line: LogLine): Promise<void> {
    const detailRef = detailRefForLine(line);
    const detail = detailRef === null || props.onResolveTargetDetail === undefined ? null : await props.onResolveTargetDetail(detailRef).catch(() => null);
    const needsFullDetail = line.targetDetail !== undefined && line.targetDetail.itemCount > line.targetDetail.preview.length;
    if (needsFullDetail && detail === null) {
      setCopyErrorId(line.id);
      return;
    }
    setCopyErrorId(null);
    if (!(await copyTextToClipboard(formatLogCopyText(line, detail, props.locale ?? 'th')))) return;
    setCopiedId(line.id);
    window.setTimeout(() => setCopiedId((current) => current === line.id ? null : current), 1_200);
  }

  return (
    <section className="panel log-panel" aria-label={props.title}>
      <div className="section-heading">
        <h2>{props.title}</h2>
        <div className="worklog-actions">
          <ActionButton type="button" className={paused ? 'active' : undefined} onClick={() => {
            const nextPaused = !paused;
            setFeedFreeze((state) => transitionLogFeedFreeze(state, currentFeed, nextPaused || normalizeDetailSearchQuery(filter).length > 0));
            setPaused(nextPaused);
          }}>
            {paused ? props.followLabel : props.pauseLabel}
          </ActionButton>
          {props.source === 'tunnel' ? null : <>
            <ActionButton type="button" disabled={sessionId === null} onClick={() => { if (sessionId !== null) void props.onClear({ workspaceId: null, sessionId }); }}>{props.clearSessionLabel}</ActionButton>
            <ActionButton type="button" disabled={workspaceId === null} onClick={() => { if (workspaceId !== null) void props.onClear({ workspaceId, sessionId: null }); }}>{props.clearWorkspaceLabel}</ActionButton>
          </>}
          <ActionButton type="button" onClick={() => { void props.onClear({ workspaceId: null, sessionId: null }); }}>{props.clearLabel}</ActionButton>
          <ActionButton type="button" onClick={() => { void props.onExport(scope, filter, matchingLines.map((line) => ({ lineId: line.id, correlationRef: detailRefForLine(line) }))); }}>{props.exportLabel}</ActionButton>
        </div>
      </div>
      {props.description === undefined ? null : <p className="hint log-source-description">{props.description}</p>}
      {props.source === 'tunnel' ? null : <div className="scope-filter-bar">
        <label>
          <span>{props.workspaceLabel ?? 'Workspace'}</span>
          <SearchableSelect label={props.workspaceLabel ?? 'Workspace'} value={workspaceId ?? ''}
            options={[{value:'',label:props.scopeAllLabel ?? 'All'},...workspaceOptions.map(option=>({value:option.id,label:option.label}))]}
            onChange={(value) => {
              const nextWorkspaceId = value.length === 0 ? null : value;
              setWorkspaceId(nextWorkspaceId);
              if (sessionId !== null) void props.onSessionChange?.({ workspaceId: nextWorkspaceId, sessionId });
            }} />
        </label>
        <label>
          <span>{props.sessionLabel ?? 'Session'}</span>
          <SearchableSelect label={props.sessionLabel ?? 'Session'} value={sessionId ?? ''}
            options={[{value:'',label:props.scopeAllLabel ?? 'All'},...sessionOptions.map(option=>({value:option.id,label:option.label}))]}
            onChange={(value) => {
              const nextSessionId = value.length === 0 ? null : value;
              setSessionId(nextSessionId);
              void props.onSessionChange?.({ workspaceId, sessionId: nextSessionId });
            }} />
        </label>
      </div>}
      <FormInput
        type="text"
        className="log-filter"
        placeholder={props.filterPlaceholder}
        value={filter}
        onChange={(event) => {
          const nextFilter = event.target.value;
          setFeedFreeze((state) => transitionLogFeedFreeze(state, currentFeed, paused || normalizeDetailSearchQuery(nextFilter).length > 0));
          setFilter(nextFilter);
        }}
        aria-label={props.filterPlaceholder}
      />
      {filter !== deferredFilter ? <p role="status" className="ui-loading-status">{props.locale === 'en' ? 'Filtering logs' : 'กำลังกรองบันทึก'}…</p> : null}
      {detailSearchState.status === 'loading' ? <p className="log-detail-search-status" role="status">{props.detailLoadingLabel ?? 'Searching complete details…'}</p> : null}
      {detailSearchState.status === 'error' ? <p className="log-detail-search-status log-detail-error" role="alert">{props.detailErrorLabel ?? 'Complete details could not be searched.'}</p> : null}
      {props.source === 'tunnel' && !props.tunnelLogExists ? (
        <p className="hint">
          {props.waitingLabel}
          {props.tunnelLogPath === null ? '' : ` (${props.tunnelLogPath})`}
        </p>
      ) : null}
      <div className="log-stream" ref={streamRef} data-testid="log-stream" role="log" aria-live="polite" onScroll={loadMoreOnScroll}>
        {visible.length === 0 && detailSearchState.status !== 'loading' && !(props.source === 'tunnel' && !props.tunnelLogExists) ? (
          <p className="hint">{props.waitingLabel}</p>
        ) : null}
        {visible.map((line) => {
          const display = logDisplayParts(line);
          return (
            <div key={line.id} className={`log-line ${line.source} ${line.level}${display.kind === null ? '' : ' has-kind'}`}>
              <time>{formatLogUiTime(line.timestamp, props.locale ?? 'th')}</time>
              <span className="tag level-tag">[{line.level.toUpperCase()}]</span>
              {display.kind === null ? null : <span className={`event-tag ${display.kind}`}>[{display.kind.toUpperCase()}]</span>}
              <span className="log-message"><ScopeBadges line={line} showWorkspace={workspaceId === null} showSession={sessionId === null} workspaces={feed.workspaces} />{display.detail}</span>
              <ActionButton
                type="button"
                className="row-copy-button"
                title={copiedId === line.id ? (props.copiedLabel ?? 'Copied') : (props.copyLabel ?? 'Copy full log')}
                aria-label={copiedId === line.id ? (props.copiedLabel ?? 'Copied') : (props.copyLabel ?? 'Copy full log')}
                onClick={() => { void copyLine(line); }}
              >
                {copiedId === line.id ? '✓' : '⧉'}
              </ActionButton>
              {copyErrorId === line.id ? <p className="log-detail-error row-copy-error" role="alert">{props.detailErrorLabel ?? 'Complete details are unavailable; nothing was copied.'}</p> : null}
              {line.targetDetail === undefined ? null : (
                <ExpandableTargetDetail
                  locale={props.locale ?? 'th'}
                  reference={line.targetDetail}
                  legacySummary={line.text}
                  showMoreLabel={props.showMoreLabel ?? 'Show more'}
                  showLessLabel={props.showLessLabel ?? 'Show less'}
                  detailHeadingLabel={props.detailHeadingLabel ?? 'Target items'}
                  loadingLabel={props.detailLoadingLabel ?? 'Loading complete details…'}
                  errorLabel={props.detailErrorLabel ?? 'Complete details are unavailable.'}
                  emptyLabel={props.detailEmptyLabel ?? 'No target items.'}
                  legacyIncompleteLabel={props.legacyIncompleteLabel ?? 'Older log: the omitted items were not retained.'}
                  {...(props.onResolveTargetDetail === undefined ? {} : { loadDetail: props.onResolveTargetDetail })}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function filterLines(lines: readonly LogLine[], source: LogSource): readonly LogLine[] {
  return lines.filter((line) => line.source === source);
}

export function filterLogLinesByScope(lines: readonly LogLine[], scope: LogScopeSelection, search = '', workspaces: readonly WorkspaceSummary[] = [], hiddenMatches: ReadonlySet<string> = new Set()): readonly LogLine[] {
  const needle = search.trim().toLowerCase();
  return lines.filter((line) => {
    if (scope.workspaceId !== null && !workspaceScopeMatches(workspaces, line.workspaceId, scope.workspaceId)) return false;
    if (scope.sessionId !== null && line.sessionId !== scope.sessionId) return false;
    return needle.length === 0 || line.text.toLowerCase().includes(needle) || hiddenMatches.has(liveLineIdentity(line));
  });
}

export function visibleLogLines(lines: readonly LogLine[], scope: LogScopeSelection, search = '', workspaces: readonly WorkspaceSummary[] = [], hiddenMatches: ReadonlySet<string> = new Set()): readonly LogLine[] {
  return [...filterLogLinesByScope(lines, scope, search, workspaces, hiddenMatches)].sort(compareLogLinesNewestFirst);
}

function ScopeBadges(props: { readonly line: LogLine; readonly showWorkspace: boolean; readonly showSession: boolean; readonly workspaces: readonly WorkspaceSummary[] | undefined }): ReactElement | null {
  const canonicalId = props.line.workspaceId === null ? null : canonicalWorkspaceScopeId(props.workspaces ?? [], props.line.workspaceId);
  const workspace = canonicalId === null ? undefined : props.workspaces?.find((candidate) => candidate.id === canonicalId);
  const workspaceLabel = canonicalId === null ? null : workspace === undefined ? shortScopeId(canonicalId) : `${workspace.displayName} — ${workspace.id}`;
  const sessionLabel = props.line.sessionId === null ? null : shortScopeId(props.line.sessionId);
  if ((!props.showWorkspace || workspaceLabel === null) && (!props.showSession || sessionLabel === null)) return null;
  return <span className="scope-badges">
    {props.showWorkspace && workspaceLabel !== null && canonicalId !== null ? <CopyableScopeBadge kind="workspace" value={canonicalId} displayLabel={workspaceLabel} /> : null}
    {props.showSession && sessionLabel !== null && props.line.sessionId !== null ? <CopyableScopeBadge kind="session" value={props.line.sessionId} displayLabel={sessionLabel} /> : null}
  </span>;
}

function shortScopeId(value: string): string {
  // Scope identifiers are diagnostic evidence; never abbreviate them in logs.
  return value;
}

export function logLevelFor(line: LogLine): LogLevel {
  return line.level;
}

export function compareLogLinesNewestFirst(left: LogLine, right: LogLine): number {
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime;
  return right.id - left.id;
}

export function logDisplayParts(line: LogLine): { readonly kind: LogEventKind | null; readonly detail: string } {
  if (line.source === 'mcp' || line.source === 'process') {
    const match = /^\[(TASK|RESULT|ERROR)\]\s*(.*)$/s.exec(line.text);
    if (match !== null) return { kind: match[1] === 'TASK' ? 'task' : 'result', detail: match[2] ?? '' };
    if (line.correlation?.kind === 'mcp') {
      return { kind: line.correlation.phase === 'started' ? 'task' : 'result', detail: line.text };
    }
  }
  return { kind: null, detail: line.text };
}

export function formatLogCopyText(line: LogLine, detail: ActivityTargetDetail | null = null, locale: UiLocale = 'th'): string {
  const base = `${formatLogExportDateTime(line.timestamp, locale)} [${line.level.toUpperCase()}] ${line.text}`;
  const metadata = [
    `lineId=${line.id}`,
    `source=${line.source}`,
    `level=${line.level}`,
    `workspaceId=${line.workspaceId ?? '<none>'}`,
    `sessionId=${line.sessionId ?? '<none>'}`,
    ...(line.correlation?.kind === 'mcp' ? [
      `callId=${line.correlation.callId}`,
      `toolName=${line.correlation.toolName}`,
      `phase=${line.correlation.phase}`,
      `resultCode=${line.correlation.resultCode ?? '<none>'}`,
    ] : line.correlation?.kind === 'tunnel' ? [
      `lifecycle=${line.correlation.lifecycle ?? '<none>'}`,
      `instanceId=${line.correlation.instanceId ?? '<none>'}`,
      `requestId=${line.correlation.requestId ?? '<none>'}`,
      `pid=${line.correlation.pid ?? '<none>'}`,
    ] : []),
  ];
  const fullBase = `${base}\r\n${metadata.join('\r\n')}`;
  if (detail === null || detail.items.length === 0) return fullBase;
  const heading = detail.kind === 'files' ? 'Files' : detail.kind === 'tools' ? 'Tools' : 'Details';
  return `${fullBase}\r\n${heading}:\r\n${detail.items.map((item) => `- ${formatDisplayTimestampItem(item, locale)}`).join('\r\n')}`;
}

function liveLineIdentity(line: LogLine): string {
  return `line:${line.id}`;
}

function detailRefForLine(line: LogLine): string | null {
  return line.targetDetail?.detailRef ?? (line.correlation?.kind === 'mcp' ? line.correlation.callId : null);
}

export type { MessageKey };
export { activeDetailMatchIds, activeLogFeed, createDetailSearchState, reduceDetailSearchState, transitionLogFeedFreeze };
