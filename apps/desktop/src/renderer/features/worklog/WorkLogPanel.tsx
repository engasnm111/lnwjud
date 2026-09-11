import { useEffect, useMemo, useReducer, useRef, useState, type ComponentProps, type ReactElement } from 'react';
import { canonicalWorkspaceScopeId, workspaceScopeMatches, type ActivityTargetDetail, type InFlightWorkItem, type UiLocale, type WorkLogEntry, type WorkspaceSummary } from '@lnwjud/ipc-contracts';
import { formatDisplayTimestampItem } from '@lnwjud/shared/date-time-display';
import { copyTextToClipboard } from '../../clipboard.js';
import type { MessageKey } from '../../i18n/messages.js';
import { formatLogExportDateTime, formatLogUiTime } from '../../log-timestamp.js';
import { ExpandableTargetDetail } from '../logs/ExpandableTargetDetail.js';
import { activeDetailMatchIds, activeLogFeed, createDetailSearchState, normalizeDetailSearchQuery, reduceDetailSearchState, transitionLogFeedFreeze } from '../logs/detail-search-state.js';

export type WorkLogFilter = 'all' | 'error';

export interface LogScopeSelection {
  readonly workspaceId: string | null;
  readonly sessionId: string | null;
}

type WorkLogRow =
  | { readonly kind: 'inflight'; readonly timestamp: string; readonly id: string; readonly item: InFlightWorkItem }
  | { readonly kind: 'entry'; readonly timestamp: string; readonly id: string; readonly item: WorkLogEntry };

interface WorkLogPanelProps {
  readonly locale?: UiLocale;
  readonly title: string;
  readonly emptyLabel: string;
  readonly filterAllLabel: string;
  readonly filterErrorLabel: string;
  readonly clearSessionLabel: string;
  readonly clearWorkspaceLabel: string;
  readonly clearAllLabel: string;
  readonly filter: WorkLogFilter;
  readonly onFilterChange: (filter: WorkLogFilter) => void;
  readonly onClear: (scope: LogScopeSelection) => Promise<void>;
  readonly exportLabel?: string;
  readonly onExport?: (rowIds: readonly string[]) => Promise<void>;
  readonly onResolveTargetDetail?: (detailRef: string) => Promise<ActivityTargetDetail | null>;
  readonly onSearchTargetDetails?: (query: string, candidates: readonly { readonly id: string; readonly detailRef: string | null }[]) => Promise<readonly string[]>;
  readonly entries: readonly WorkLogEntry[];
  readonly inFlight: readonly InFlightWorkItem[];
  readonly searchPlaceholder?: string;
  readonly copyLabel?: string;
  readonly copiedLabel?: string;
  readonly compact?: boolean;
  readonly workspaces?: readonly WorkspaceSummary[];
  readonly defaultWorkspaceId?: string | null;
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


export function WorkLogPanel(props: WorkLogPanelProps): ReactElement {
  const [search, setSearch] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyErrorId, setCopyErrorId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(props.defaultWorkspaceId ?? null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [detailSearchState, dispatchDetailSearch] = useReducer(reduceDetailSearchState, undefined, createDetailSearchState);
  const detailSearchGeneration = useRef(0);
  const currentFeed = useMemo(() => ({ entries: props.entries, inFlight: props.inFlight }), [props.entries, props.inFlight]);
  const [feedFreeze, setFeedFreeze] = useState<typeof currentFeed | null>(null);
  const feed = activeLogFeed(feedFreeze, currentFeed);
  const workspaceOptions = useMemo(() => collectWorkspaceOptions(feed.entries, feed.inFlight, props.workspaces), [feed, props.workspaces]);
  const sessionOptions = useMemo(() => collectSessionOptions(feed.entries, feed.inFlight, workspaceId, props.workspaces), [feed, workspaceId, props.workspaces]);
  useEffect(() => {
    if (workspaceId !== null && !workspaceOptions.some((option) => option.id === workspaceId)) setWorkspaceId(null);
  }, [workspaceId, workspaceOptions]);
  useEffect(() => {
    if (sessionId !== null && !sessionOptions.includes(sessionId)) setSessionId(null);
  }, [sessionId, sessionOptions]);
  const scope = useMemo<LogScopeSelection>(() => ({ workspaceId, sessionId }), [workspaceId, sessionId]);
  const candidates = useMemo(
    () => newestFirstWorkLogRows(feed.entries, feed.inFlight, props.filter, '', scope, props.workspaces),
    [feed, props.filter, scope, props.workspaces],
  );
  useEffect(() => {
    const query = normalizeDetailSearchQuery(search);
    const generation = ++detailSearchGeneration.current;
    if (query.length === 0 || props.onSearchTargetDetails === undefined) {
      dispatchDetailSearch({ type: 'reset', generation });
      return;
    }
    dispatchDetailSearch({ type: 'start', generation, query });
    const timeout = window.setTimeout(() => {
      const searchCandidates = candidates.flatMap((row) => {
        const detailRef = row.item.targetDetail.detailRef;
        if (detailRef === null || workLogSearchText(row).includes(query)) return [];
        return [{ id: workLogRowIdentity(row), detailRef }];
      });
      if (searchCandidates.length === 0) {
        dispatchDetailSearch({ type: 'success', generation, query, matchingIds: [] });
        return;
      }
      void props.onSearchTargetDetails?.(query, searchCandidates).then((ids) => {
        dispatchDetailSearch({ type: 'success', generation, query, matchingIds: ids });
      }).catch(() => {
        dispatchDetailSearch({ type: 'failure', generation, query });
      });
    }, 180);
    return (): void => window.clearTimeout(timeout);
  }, [candidates, props.onSearchTargetDetails, search]);
  const hiddenMatches = activeDetailMatchIds(detailSearchState, search);
  const rows = useMemo(
    () => newestFirstWorkLogRows(feed.entries, feed.inFlight, props.filter, search, scope, props.workspaces, hiddenMatches),
    [feed, props.filter, search, scope, props.workspaces, hiddenMatches],
  );
  const visible = props.compact ? rows.slice(0, 40) : rows;
  const resolvedTargets = useMemo(() => completedTargetByCallId(feed.entries), [feed]);

  async function copyRow(row: WorkLogRow): Promise<void> {
    const detailRef = row.item.targetDetail.detailRef;
    const needsFullDetail = row.item.targetDetail.itemCount > row.item.targetDetail.preview.length;
    const detail = detailRef === null || props.onResolveTargetDetail === undefined ? null : await props.onResolveTargetDetail(detailRef).catch(() => null);
    if (needsFullDetail && detail === null) {
      setCopyErrorId(row.id);
      return;
    }
    setCopyErrorId(null);
    if (!(await copyTextToClipboard(formatWorkLogCopyText(row, resolvedTargets, detail, props.locale ?? 'th')))) return;
    setCopiedId(row.id);
    window.setTimeout(() => setCopiedId((current) => current === row.id ? null : current), 1_200);
  }

  return (
    <section className={`panel worklog-panel${props.compact ? ' compact' : ''}`} aria-label={props.title}>
      <div className="section-heading">
        <h2>{props.title}</h2>
        <div className="worklog-actions">
          <button
            type="button"
            className={props.filter === 'all' ? 'active' : undefined}
            onClick={() => props.onFilterChange('all')}
          >
            {props.filterAllLabel}
          </button>
          <button
            type="button"
            className={props.filter === 'error' ? 'active' : undefined}
            onClick={() => props.onFilterChange('error')}
          >
            {props.filterErrorLabel}
          </button>
          {props.onExport === undefined ? null : <button type="button" onClick={() => { void props.onExport?.(visible.map(workLogRowIdentity)); }}>{props.exportLabel ?? 'Export'}</button>}
          <button type="button" disabled={sessionId === null} onClick={() => { if (sessionId !== null) void props.onClear({ workspaceId: null, sessionId }); }}>{props.clearSessionLabel}</button>
          <button type="button" disabled={workspaceId === null} onClick={() => { if (workspaceId !== null) void props.onClear({ workspaceId, sessionId: null }); }}>{props.clearWorkspaceLabel}</button>
          <button type="button" onClick={() => { void props.onClear({ workspaceId: null, sessionId: null }); }}>{props.clearAllLabel}</button>
        </div>
      </div>
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
        type="search"
        className="log-filter worklog-search"
        placeholder={props.searchPlaceholder ?? 'Search work log...'}
        aria-label={props.searchPlaceholder ?? 'Search work log'}
        value={search}
        onChange={(event) => {
          const nextSearch = event.target.value;
          setFeedFreeze((state) => transitionLogFeedFreeze(state, currentFeed, normalizeDetailSearchQuery(nextSearch).length > 0));
          setSearch(nextSearch);
        }}
      />
      {detailSearchState.status === 'loading' ? <p className="log-detail-search-status" role="status">{props.detailLoadingLabel ?? 'Searching complete details…'}</p> : null}
      {detailSearchState.status === 'error' ? <p className="log-detail-search-status log-detail-error" role="alert">{props.detailErrorLabel ?? 'Complete details could not be searched.'}</p> : null}
      <div className="worklog-stream" data-testid="work-log">
        {visible.length === 0 ? <p>{props.emptyLabel}</p> : null}
        {visible.map((row) => row.kind === 'inflight' ? (
          <div key={`inflight:${row.id}`} className="worklog-line inflight">
            <time>{formatLogUiTime(row.item.startedAt, props.locale ?? 'th')}</time>
            <span className="tag task-tag">[TASK]</span>
            <strong>{row.item.toolName}</strong>
            <span className="worklog-summary"><ScopeBadges item={row.item} showWorkspace={workspaceId === null} showSession={sessionId === null} workspaces={props.workspaces} />{row.item.targetSummary ?? ''}</span>
            <span className="worklog-duration" />
            <CopyButton row={row} copiedId={copiedId} copyLabel={props.copyLabel} copiedLabel={props.copiedLabel} onCopy={copyRow} />
            {copyErrorId === row.id ? <p className="log-detail-error row-copy-error" role="alert">{props.detailErrorLabel ?? 'Complete details are unavailable; nothing was copied.'}</p> : null}
            <ExpandableTargetDetail {...detailProps(props)} reference={row.item.targetDetail} legacySummary={row.item.targetSummary} {...(props.onResolveTargetDetail === undefined ? {} : { loadDetail: props.onResolveTargetDetail })} />
          </div>
        ) : (
          <div key={`entry:${row.item.id}`} className={`worklog-line ${row.item.kind}`}>
            <time>{formatLogUiTime(row.item.timestamp, props.locale ?? 'th')}</time>
            <span className={`tag ${row.item.kind}-tag`}>{tagFor(row.item.kind)}</span>
            <strong>{row.item.toolName}</strong>
            <span className="worklog-summary"><ScopeBadges item={row.item} showWorkspace={workspaceId === null} showSession={sessionId === null} workspaces={props.workspaces} />{renderEntryDetail(row.item, resolvedTargets)}</span>
            {row.item.kind !== 'task' ? <em>{row.item.durationMs}ms</em> : <span className="worklog-duration" />}
            <CopyButton row={row} copiedId={copiedId} copyLabel={props.copyLabel} copiedLabel={props.copiedLabel} onCopy={copyRow} />
            {copyErrorId === row.id ? <p className="log-detail-error row-copy-error" role="alert">{props.detailErrorLabel ?? 'Complete details are unavailable; nothing was copied.'}</p> : null}
            <ExpandableTargetDetail {...detailProps(props)} reference={row.item.targetDetail} legacySummary={row.item.targetSummary} {...(props.onResolveTargetDetail === undefined ? {} : { loadDetail: props.onResolveTargetDetail })} />
          </div>
        ))}
      </div>
    </section>
  );
}

function CopyButton(props: {
  readonly row: WorkLogRow;
  readonly copiedId: string | null;
  readonly copyLabel: string | undefined;
  readonly copiedLabel: string | undefined;
  readonly onCopy: (row: WorkLogRow) => Promise<void>;
}): ReactElement {
  const copied = props.copiedId === props.row.id;
  const label = copied ? (props.copiedLabel ?? 'Copied') : (props.copyLabel ?? 'Copy full log');
  return (
    <button type="button" className="row-copy-button" title={label} aria-label={label} onClick={() => { void props.onCopy(props.row); }}>
      {copied ? '✓' : '⧉'}
    </button>
  );
}

export function newestFirstWorkLogRows(
  entries: readonly WorkLogEntry[],
  inFlight: readonly InFlightWorkItem[],
  filter: WorkLogFilter = 'all',
  search = '',
  scope: LogScopeSelection = { workspaceId: null, sessionId: null },
  workspaces: readonly WorkspaceSummary[] = [],
  hiddenMatches: ReadonlySet<string> = new Set(),
): readonly WorkLogRow[] {
  const needle = search.trim().toLowerCase();
  const scopedEntries = entries.filter((entry) => matchesScope(entry, scope, workspaces));
  const scopedInFlight = inFlight.filter((entry) => matchesScope(entry, scope, workspaces));
  const entryRows = (filter === 'error' ? scopedEntries.filter((entry) => entry.kind === 'error') : scopedEntries)
    .map((item): WorkLogRow => ({ kind: 'entry', timestamp: item.timestamp, id: item.id, item }));
  const inFlightRows = filter === 'error'
    ? []
    : scopedInFlight.map((item): WorkLogRow => ({ kind: 'inflight', timestamp: item.startedAt, id: scopedActivityId(item), item }));
  return [...entryRows, ...inFlightRows]
    .filter((row) => needle.length === 0 || workLogSearchText(row).includes(needle) || hiddenMatches.has(workLogRowIdentity(row)))
    .sort((left, right) => {
      const leftTime = Date.parse(left.timestamp);
      const rightTime = Date.parse(right.timestamp);
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime;
      const timestampOrder = right.timestamp.localeCompare(left.timestamp);
      return timestampOrder !== 0 ? timestampOrder : right.id.localeCompare(left.id);
    });
}

function workLogSearchText(row: WorkLogRow): string {
  if (row.kind === 'inflight') {
    return `${row.item.callId} ${row.item.toolName} ${row.item.targetSummary ?? ''} ${row.item.workspaceId ?? ''} ${row.item.sessionId ?? ''} task`.toLowerCase();
  }
  return `${row.item.id} ${row.item.callId ?? ''} ${row.item.toolName} ${row.item.resultCode} ${row.item.targetSummary ?? ''} ${row.item.errorMessage ?? ''} ${row.item.workspaceId ?? ''} ${row.item.sessionId ?? ''} ${row.item.kind}`.toLowerCase();
}


function matchesScope(item: Pick<WorkLogEntry, 'workspaceId' | 'sessionId'> | Pick<InFlightWorkItem, 'workspaceId' | 'sessionId'>, scope: LogScopeSelection, workspaces: readonly WorkspaceSummary[]): boolean {
  if (scope.workspaceId !== null && !workspaceScopeMatches(workspaces, item.workspaceId, scope.workspaceId)) return false;
  if (scope.sessionId !== null && item.sessionId !== scope.sessionId) return false;
  return true;
}

function scopedActivityId(item: InFlightWorkItem): string {
  if (item.workspaceId === null && item.sessionId === null) return item.callId;
  return [item.workspaceId ?? 'global', item.sessionId ?? 'global', item.callId].join(':');
}

function collectWorkspaceOptions(entries: readonly WorkLogEntry[], inFlight: readonly InFlightWorkItem[], workspaces: readonly WorkspaceSummary[] | undefined): readonly { readonly id: string; readonly label: string }[] {
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
  for (const item of [...entries, ...inFlight]) {
    if (item.workspaceId === null) continue;
    const canonicalId = canonicalWorkspaceScopeId(workspaceList, item.workspaceId);
    if (labels.has(canonicalId)) continue;
    labels.set(canonicalId, shortScopeId(canonicalId));
  }
  return [...labels.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
}

function collectSessionOptions(entries: readonly WorkLogEntry[], inFlight: readonly InFlightWorkItem[], workspaceId: string | null, workspaces: readonly WorkspaceSummary[] | undefined): readonly string[] {
  const values = new Set<string>();
  for (const item of [...entries, ...inFlight]) {
    if (workspaceId !== null && !workspaceScopeMatches(workspaces ?? [], item.workspaceId, workspaceId)) continue;
    if (item.sessionId !== null) values.add(item.sessionId);
  }
  return [...values].sort();
}

function ScopeBadges(props: { readonly item: Pick<WorkLogEntry, 'workspaceId' | 'sessionId'> | Pick<InFlightWorkItem, 'workspaceId' | 'sessionId'>; readonly showWorkspace: boolean; readonly showSession: boolean; readonly workspaces: readonly WorkspaceSummary[] | undefined }): ReactElement | null {
  const workspaceLabel = props.item.workspaceId === null ? null : displayWorkspaceLabel(props.workspaces, props.item.workspaceId);
  const sessionLabel = props.item.sessionId === null ? null : shortScopeId(props.item.sessionId);
  if ((!props.showWorkspace || workspaceLabel === null) && (!props.showSession || sessionLabel === null)) return null;
  return <span className="scope-badges">
    {props.showWorkspace && workspaceLabel !== null ? <span className="scope-badge workspace">{workspaceLabel}</span> : null}
    {props.showSession && sessionLabel !== null ? <span className="scope-badge session">{sessionLabel}</span> : null}
  </span>;
}

function displayWorkspaceLabel(workspaces: readonly WorkspaceSummary[] | undefined, workspaceId: string): string {
  const workspaceList = workspaces ?? [];
  const canonicalId = canonicalWorkspaceScopeId(workspaceList, workspaceId);
  const workspace = workspaceList.find((candidate) => candidate.id === canonicalId);
  if (workspace === undefined) return shortScopeId(canonicalId);
  const duplicateName = (workspaces ?? []).some((candidate) => candidate.id !== workspace.id && candidate.displayName.trim().toLocaleLowerCase() === workspace.displayName.trim().toLocaleLowerCase());
  return duplicateName
    ? `${workspace.displayName} — ${workspace.id} — ${workspace.realRootPath}`
    : `${workspace.displayName} — ${workspace.id}`;
}

function shortScopeId(value: string): string {
  // Scope identifiers are diagnostic evidence; never abbreviate them in logs.
  return value;
}

function renderEntryDetail(entry: WorkLogEntry, resolvedTargets: ReadonlyMap<string, string>): ReactElement | string {
  const targetSummary = resolvedTargetSummary(entry, resolvedTargets);
  if (entry.kind === 'error') {
    if (targetSummary && entry.errorMessage) {
      return (
        <>
          <span>{targetSummary}</span>
          <span className="worklog-error-detail"> — {entry.errorMessage}</span>
        </>
      );
    }
    if (entry.errorMessage) return <span className="worklog-error-detail">{entry.errorMessage}</span>;
    return targetSummary ?? legacyEntryDetail(entry);
  }
  return targetSummary ?? legacyEntryDetail(entry);
}

function entryDetailText(entry: WorkLogEntry, resolvedTargets: ReadonlyMap<string, string>): string {
  const targetSummary = resolvedTargetSummary(entry, resolvedTargets);
  if (entry.kind === 'error') {
    if (targetSummary && entry.errorMessage) return `${targetSummary} — ${entry.errorMessage}`;
    return entry.errorMessage ?? targetSummary ?? legacyEntryDetail(entry);
  }
  return targetSummary ?? legacyEntryDetail(entry);
}

export function formatWorkLogCopyText(row: WorkLogRow, resolvedTargets: ReadonlyMap<string, string> = new Map(), detail: ActivityTargetDetail | null = null, locale: UiLocale = 'th'): string {
  if (row.kind === 'inflight') {
    const base = `${formatLogExportDateTime(row.item.startedAt, locale)} [TASK] ${row.item.toolName}${row.item.targetSummary === null ? '' : ` ${row.item.targetSummary}`}`;
    return appendCompleteTargetDetail(`${base}\r\n${workLogMetadataLines(row).join('\r\n')}`, detail, locale);
  }
  const duration = row.item.kind === 'task' ? '' : ` ${row.item.durationMs}ms`;
  const base = `${formatLogExportDateTime(row.item.timestamp, locale)} ${tagFor(row.item.kind)} ${row.item.toolName} ${entryDetailText(row.item, resolvedTargets)}${duration}`.trim();
  return appendCompleteTargetDetail(`${base}\r\n${workLogMetadataLines(row).join('\r\n')}`, detail, locale);
}

function workLogMetadataLines(row: WorkLogRow): readonly string[] {
  if (row.kind === 'inflight') {
    return [
      `rowId=inflight:${row.item.callId}`,
      `callId=${row.item.callId}`,
      `workspaceId=${row.item.workspaceId ?? '<none>'}`,
      `sessionId=${row.item.sessionId ?? '<none>'}`,
      `toolName=${row.item.toolName}`,
      'phase=started',
      'resultCode=STARTED',
      ...(row.item.targetSummary === null ? [] : [`targetSummary=${row.item.targetSummary}`]),
    ];
  }
  return [
    `rowId=audit:${row.item.id}`,
    `eventId=${row.item.id}`,
    `callId=${row.item.callId ?? '<none>'}`,
    `workspaceId=${row.item.workspaceId ?? '<none>'}`,
    `sessionId=${row.item.sessionId ?? '<none>'}`,
    `toolName=${row.item.toolName}`,
    `kind=${row.item.kind}`,
    `resultCode=${row.item.resultCode}`,
    `durationMs=${row.item.durationMs}`,
    ...(row.item.targetSummary === null ? [] : [`targetSummary=${row.item.targetSummary}`]),
    ...(row.item.errorMessage === null ? [] : [`errorMessage=${row.item.errorMessage}`]),
  ];
}

export function workLogRowIdentity(row: WorkLogRow): string {
  return row.kind === 'inflight' ? `inflight:${row.item.callId}` : `audit:${row.item.id}`;
}

function appendCompleteTargetDetail(base: string, detail: ActivityTargetDetail | null, locale: UiLocale): string {
  if (detail === null || detail.items.length === 0) return base;
  const heading = detail.kind === 'files' ? 'Files' : detail.kind === 'tools' ? 'Tools' : 'Details';
  return `${base}\r\n${heading}:\r\n${detail.items.map((item) => `- ${formatDisplayTimestampItem(item, locale)}`).join('\r\n')}`;
}

function detailProps(props: WorkLogPanelProps): Omit<ComponentProps<typeof ExpandableTargetDetail>, 'reference' | 'legacySummary' | 'loadDetail'> {
  return {
    locale: props.locale ?? 'th',
    showMoreLabel: props.showMoreLabel ?? 'Show more',
    showLessLabel: props.showLessLabel ?? 'Show less',
    detailHeadingLabel: props.detailHeadingLabel ?? 'Target items',
    loadingLabel: props.detailLoadingLabel ?? 'Loading complete details…',
    errorLabel: props.detailErrorLabel ?? 'Complete details are unavailable.',
    emptyLabel: props.detailEmptyLabel ?? 'No target items.',
    legacyIncompleteLabel: props.legacyIncompleteLabel ?? 'Older log: the omitted items were not retained.',
  };
}

function completedTargetByCallId(entries: readonly WorkLogEntry[]): ReadonlyMap<string, string> {
  const targets = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind === 'task' || entry.callId === undefined || entry.targetSummary === null || entry.targetSummary.trim().length === 0) continue;
    targets.set(entry.callId, entry.targetSummary);
  }
  return targets;
}

function resolvedTargetSummary(entry: WorkLogEntry, resolvedTargets: ReadonlyMap<string, string>): string | null {
  if (entry.targetSummary !== null && entry.targetSummary.trim().length > 0) {
    if (entry.kind !== 'task' || entry.callId === undefined) return entry.targetSummary;
    return resolvedTargets.get(entry.callId) ?? entry.targetSummary;
  }
  if (entry.callId === undefined) return null;
  return resolvedTargets.get(entry.callId) ?? null;
}

function legacyEntryDetail(entry: WorkLogEntry): string {
  if (entry.kind === 'task' || entry.resultCode === 'SUCCESS') return 'details unavailable (legacy log)';
  return `${entry.resultCode} · details unavailable (legacy log)`;
}

function tagFor(kind: WorkLogEntry['kind']): string {
  if (kind === 'task') return '[TASK]';
  if (kind === 'error') return '[ERROR]';
  return '[RESULT]';
}

export type { MessageKey };
export { activeDetailMatchIds, activeLogFeed, createDetailSearchState, reduceDetailSearchState, transitionLogFeedFreeze };
