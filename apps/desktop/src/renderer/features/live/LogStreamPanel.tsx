import { useEffect, useMemo, useReducer, useRef, useState, type ReactElement } from 'react';
import { canonicalWorkspaceScopeId, workspaceScopeMatches, type ActivityTargetDetail, type LiveLogExportReference, type LogLevel, type LogLine, type LogSource, type UiLocale, type WorkspaceSummary } from '@lnwjud/ipc-contracts';
import { formatDisplayTimestampItem } from '@lnwjud/shared/date-time-display';
import { copyTextToClipboard } from '../../clipboard.js';
import type { MessageKey } from '../../i18n/messages.js';
import { formatLogExportDateTime, formatLogUiTime } from '../../log-timestamp.js';
import { ExpandableTargetDetail } from '../logs/ExpandableTargetDetail.js';
import { activeDetailMatchIds, activeLogFeed, createDetailSearchState, normalizeDetailSearchQuery, reduceDetailSearchState, transitionLogFeedFreeze } from '../logs/detail-search-state.js';

export type LogTab = LogSource;
export type LogEventKind = 'task' | 'result' | 'error';

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


const MAX_VISIBLE_LINES = 5_000;

export function LogStreamPanel(props: LogStreamPanelProps): ReactElement {
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [copyErrorId, setCopyErrorId] = useState<number | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
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
  const workspaceOptions = useMemo(() => collectWorkspaceOptions(feedLines, feed.workspaces), [feed]);
  const sessionOptions = useMemo(() => collectSessionOptions(feedLines, workspaceId, feed.workspaces), [feed, workspaceId]);
  useEffect(() => {
    if (sessionId !== null && !sessionOptions.includes(sessionId)) setSessionId(null);
  }, [sessionId, sessionOptions]);
  const scope = useMemo<LogScopeSelection>(() => ({ workspaceId, sessionId }), [workspaceId, sessionId]);
  const searchCandidates = useMemo(() => visibleLogLines(feedLines, scope, '', feed.workspaces), [feed, scope]);
  useEffect(() => {
    const query = normalizeDetailSearchQuery(filter);
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
  }, [filter, props.onSearchTargetDetails, searchCandidates]);
  const hiddenMatches = activeDetailMatchIds(detailSearchState, filter);
  const visible = useMemo(() => visibleLogLines(feedLines, scope, filter, feed.workspaces, hiddenMatches), [feed, scope, filter, hiddenMatches]);

  useEffect(() => {
    if (paused) return;
    const element = streamRef.current;
    if (element === null) return;
    element.scrollTop = 0;
  }, [visible.length, paused]);

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
          <button type="button" className={paused ? 'active' : undefined} onClick={() => {
            const nextPaused = !paused;
            setFeedFreeze((state) => transitionLogFeedFreeze(state, currentFeed, nextPaused || normalizeDetailSearchQuery(filter).length > 0));
            setPaused(nextPaused);
          }}>
            {paused ? props.followLabel : props.pauseLabel}
          </button>
          <button type="button" disabled={sessionId === null} onClick={() => { if (sessionId !== null) void props.onClear({ workspaceId: null, sessionId }); }}>{props.clearSessionLabel}</button>
          <button type="button" disabled={workspaceId === null} onClick={() => { if (workspaceId !== null) void props.onClear({ workspaceId, sessionId: null }); }}>{props.clearWorkspaceLabel}</button>
          <button type="button" onClick={() => { void props.onClear({ workspaceId: null, sessionId: null }); }}>{props.clearLabel}</button>
          <button type="button" onClick={() => { void props.onExport(scope, filter, visible.map((line) => ({ lineId: line.id, correlationRef: detailRefForLine(line) }))); }}>{props.exportLabel}</button>
        </div>
      </div>
      {props.description === undefined ? null : <p className="hint log-source-description">{props.description}</p>}
      <div className="scope-filter-bar">
        <label>
          <span>{props.workspaceLabel ?? 'Workspace'}</span>
          <select value={workspaceId ?? ''} onChange={(event) => setWorkspaceId(event.target.value.length === 0 ? null : event.target.value)}>
            <option value="">{props.scopeAllLabel ?? 'All'}</option>
            {workspaceOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
        <label>
          <span>{props.sessionLabel ?? 'Session'}</span>
          <select value={sessionId ?? ''} onChange={(event) => setSessionId(event.target.value.length === 0 ? null : event.target.value)}>
            <option value="">{props.scopeAllLabel ?? 'All'}</option>
            {sessionOptions.map((value) => <option key={value} value={value}>{shortScopeId(value)}</option>)}
          </select>
        </label>
      </div>
      <input
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
      {detailSearchState.status === 'loading' ? <p className="log-detail-search-status" role="status">{props.detailLoadingLabel ?? 'Searching complete details…'}</p> : null}
      {detailSearchState.status === 'error' ? <p className="log-detail-search-status log-detail-error" role="alert">{props.detailErrorLabel ?? 'Complete details could not be searched.'}</p> : null}
      {props.source === 'tunnel' && !props.tunnelLogExists ? (
        <p className="hint">
          {props.waitingLabel}
          {props.tunnelLogPath === null ? '' : ` (${props.tunnelLogPath})`}
        </p>
      ) : null}
      <div className="log-stream" ref={streamRef} data-testid="log-stream" role="log" aria-live="polite">
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
              <button
                type="button"
                className="row-copy-button"
                title={copiedId === line.id ? (props.copiedLabel ?? 'Copied') : (props.copyLabel ?? 'Copy full log')}
                aria-label={copiedId === line.id ? (props.copiedLabel ?? 'Copied') : (props.copyLabel ?? 'Copy full log')}
                onClick={() => { void copyLine(line); }}
              >
                {copiedId === line.id ? '✓' : '⧉'}
              </button>
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
  return [...filterLogLinesByScope(lines, scope, search, workspaces, hiddenMatches)].sort(compareLogLinesNewestFirst).slice(0, MAX_VISIBLE_LINES);
}

function collectWorkspaceOptions(lines: readonly LogLine[], workspaces: readonly WorkspaceSummary[] | undefined): readonly { readonly id: string; readonly label: string }[] {
  const workspaceList = workspaces ?? [];
  const canonicalWorkspaces = workspaceList.filter((workspace, index) =>
    workspace.kind !== 'machine_root'
    && canonicalWorkspaceScopeId(workspaceList, workspace.id) === workspace.id
    && workspaceList.findIndex((candidate) => canonicalWorkspaceScopeId(workspaceList, candidate.id) === workspace.id) === index,
  );
  const nameCounts = new Map<string, number>();
  for (const workspace of canonicalWorkspaces) {
    const key = workspace.displayName.trim().toLocaleLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const workspace of canonicalWorkspaces) {
    const key = workspace.displayName.trim().toLocaleLowerCase();
    const duplicateName = (nameCounts.get(key) ?? 0) > 1;
    labels.set(workspace.id, duplicateName
      ? `${workspace.displayName} — ${workspace.id} — ${workspace.realRootPath}`
      : `${workspace.displayName} — ${workspace.id}`);
  }
  for (const line of lines) {
    if (line.workspaceId === null) continue;
    const canonicalId = canonicalWorkspaceScopeId(workspaceList, line.workspaceId);
    if (labels.has(canonicalId)) continue;
    labels.set(canonicalId, shortScopeId(canonicalId));
  }
  return [...labels.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
}

function collectSessionOptions(lines: readonly LogLine[], workspaceId: string | null, workspaces: readonly WorkspaceSummary[] | undefined): readonly string[] {
  const values = new Set<string>();
  for (const line of lines) {
    if (workspaceId !== null && !workspaceScopeMatches(workspaces ?? [], line.workspaceId, workspaceId)) continue;
    if (line.sessionId !== null) values.add(line.sessionId);
  }
  return [...values].sort();
}

function ScopeBadges(props: { readonly line: LogLine; readonly showWorkspace: boolean; readonly showSession: boolean; readonly workspaces: readonly WorkspaceSummary[] | undefined }): ReactElement | null {
  const canonicalId = props.line.workspaceId === null ? null : canonicalWorkspaceScopeId(props.workspaces ?? [], props.line.workspaceId);
  const workspace = canonicalId === null ? undefined : props.workspaces?.find((candidate) => candidate.id === canonicalId);
  const workspaceLabel = canonicalId === null ? null : workspace === undefined ? shortScopeId(canonicalId) : `${workspace.displayName} — ${workspace.id}`;
  const sessionLabel = props.line.sessionId === null ? null : shortScopeId(props.line.sessionId);
  if ((!props.showWorkspace || workspaceLabel === null) && (!props.showSession || sessionLabel === null)) return null;
  return <span className="scope-badges">
    {props.showWorkspace && workspaceLabel !== null ? <span className="scope-badge workspace">{workspaceLabel}</span> : null}
    {props.showSession && sessionLabel !== null ? <span className="scope-badge session">{sessionLabel}</span> : null}
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
    if (match !== null) return { kind: match[1]!.toLowerCase() as LogEventKind, detail: match[2] ?? '' };
    if (line.correlation?.kind === 'mcp') {
      if (line.correlation.phase === 'started') return { kind: 'task', detail: line.text };
      const failed = line.correlation.resultCode !== null && line.correlation.resultCode !== 'SUCCESS';
      return { kind: failed ? 'error' : 'result', detail: line.text };
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
