import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { canonicalWorkspaceScopeId, workspaceScopeMatches, type LogLevel, type LogLine, type LogSource, type WorkspaceSummary } from '@lnwjud/ipc-contracts';
import { copyTextToClipboard } from '../../clipboard.js';
import type { MessageKey } from '../../i18n/messages.js';
import { formatLogExportDateTime, formatLogUiTime } from '../../log-timestamp.js';

export type LogTab = LogSource;
export type LogEventKind = 'task' | 'result' | 'error';

export interface LogScopeSelection {
  readonly workspaceId: string | null;
  readonly sessionId: string | null;
}

interface LogStreamPanelProps {
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
  readonly copyLabel?: string;
  readonly copiedLabel?: string;
  readonly onClear: (scope: LogScopeSelection) => Promise<void>;
  readonly onExport: (scope: LogScopeSelection, query: string, lineIds: readonly number[], rows: readonly string[]) => Promise<void>;
  readonly workspaces?: readonly WorkspaceSummary[];
  readonly workspaceLabel?: string;
  readonly sessionLabel?: string;
  readonly scopeAllLabel?: string;
}


const MAX_VISIBLE_LINES = 5_000;

export function LogStreamPanel(props: LogStreamPanelProps): ReactElement {
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const workspaceOptions = useMemo(() => collectWorkspaceOptions(props.lines, props.workspaces), [props.lines, props.workspaces]);
  const sessionOptions = useMemo(() => collectSessionOptions(props.lines, workspaceId, props.workspaces), [props.lines, workspaceId, props.workspaces]);
  useEffect(() => {
    if (sessionId !== null && !sessionOptions.includes(sessionId)) setSessionId(null);
  }, [sessionId, sessionOptions]);
  const scope = useMemo<LogScopeSelection>(() => ({ workspaceId, sessionId }), [workspaceId, sessionId]);
  const visible = useMemo(() => visibleLogLines(props.lines, scope, filter, props.workspaces), [props.lines, scope, filter, props.workspaces]);

  useEffect(() => {
    if (paused) return;
    const element = streamRef.current;
    if (element === null) return;
    element.scrollTop = 0;
  }, [visible.length, paused]);

  async function copyLine(line: LogLine): Promise<void> {
    if (!(await copyTextToClipboard(formatLogCopyText(line)))) return;
    setCopiedId(line.id);
    window.setTimeout(() => setCopiedId((current) => current === line.id ? null : current), 1_200);
  }

  return (
    <section className="panel log-panel" aria-label={props.title}>
      <div className="section-heading">
        <h2>{props.title}</h2>
        <div className="worklog-actions">
          <button type="button" className={paused ? 'active' : undefined} onClick={() => setPaused((value) => !value)}>
            {paused ? props.followLabel : props.pauseLabel}
          </button>
          <button type="button" disabled={sessionId === null} onClick={() => { if (sessionId !== null) void props.onClear({ workspaceId: null, sessionId }); }}>{props.clearSessionLabel}</button>
          <button type="button" disabled={workspaceId === null} onClick={() => { if (workspaceId !== null) void props.onClear({ workspaceId, sessionId: null }); }}>{props.clearWorkspaceLabel}</button>
          <button type="button" onClick={() => { void props.onClear({ workspaceId: null, sessionId: null }); }}>{props.clearLabel}</button>
          <button type="button" onClick={() => { void props.onExport(scope, filter, visible.map((line) => line.id), visible.map(formatLogCopyText)); }}>{props.exportLabel}</button>
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
        type="text"
        className="log-filter"
        placeholder={props.filterPlaceholder}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        aria-label={props.filterPlaceholder}
      />
      {props.source === 'tunnel' && !props.tunnelLogExists ? (
        <p className="hint">
          {props.waitingLabel}
          {props.tunnelLogPath === null ? '' : ` (${props.tunnelLogPath})`}
        </p>
      ) : null}
      <div className="log-stream" ref={streamRef} data-testid="log-stream" role="log" aria-live="polite">
        {visible.length === 0 && !(props.source === 'tunnel' && !props.tunnelLogExists) ? (
          <p className="hint">{props.waitingLabel}</p>
        ) : null}
        {visible.map((line) => {
          const display = logDisplayParts(line);
          return (
            <div key={line.id} className={`log-line ${line.source} ${line.level}${display.kind === null ? '' : ' has-kind'}`}>
              <time>{formatLogUiTime(line.timestamp)}</time>
              <span className="tag level-tag">[{line.level.toUpperCase()}]</span>
              {display.kind === null ? null : <span className={`event-tag ${display.kind}`}>[{display.kind.toUpperCase()}]</span>}
              <span className="log-message"><ScopeBadges line={line} showWorkspace={workspaceId === null} showSession={sessionId === null} workspaces={props.workspaces} />{display.detail}</span>
              <button
                type="button"
                className="row-copy-button"
                title={copiedId === line.id ? (props.copiedLabel ?? 'Copied') : (props.copyLabel ?? 'Copy full log')}
                aria-label={copiedId === line.id ? (props.copiedLabel ?? 'Copied') : (props.copyLabel ?? 'Copy full log')}
                onClick={() => { void copyLine(line); }}
              >
                {copiedId === line.id ? '✓' : '⧉'}
              </button>
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

export function filterLogLinesByScope(lines: readonly LogLine[], scope: LogScopeSelection, search = '', workspaces: readonly WorkspaceSummary[] = []): readonly LogLine[] {
  const needle = search.trim().toLowerCase();
  return lines.filter((line) => {
    if (scope.workspaceId !== null && !workspaceScopeMatches(workspaces, line.workspaceId, scope.workspaceId)) return false;
    if (scope.sessionId !== null && line.sessionId !== scope.sessionId) return false;
    return needle.length === 0 || line.text.toLowerCase().includes(needle);
  });
}

export function visibleLogLines(lines: readonly LogLine[], scope: LogScopeSelection, search = '', workspaces: readonly WorkspaceSummary[] = []): readonly LogLine[] {
  return [...filterLogLinesByScope(lines, scope, search, workspaces)].sort(compareLogLinesNewestFirst).slice(0, MAX_VISIBLE_LINES);
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
    labels.set(workspace.id, duplicateName ? workspace.displayName + ' — ' + workspace.realRootPath : workspace.displayName);
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
  const workspaceLabel = canonicalId === null ? null : props.workspaces?.find((workspace) => workspace.id === canonicalId)?.displayName ?? shortScopeId(canonicalId);
  const sessionLabel = props.line.sessionId === null ? null : shortScopeId(props.line.sessionId);
  if ((!props.showWorkspace || workspaceLabel === null) && (!props.showSession || sessionLabel === null)) return null;
  return <span className="scope-badges">
    {props.showWorkspace && workspaceLabel !== null ? <span className="scope-badge workspace">{workspaceLabel}</span> : null}
    {props.showSession && sessionLabel !== null ? <span className="scope-badge session">{sessionLabel}</span> : null}
  </span>;
}

function shortScopeId(value: string): string {
  return value.length <= 14 ? value : value.slice(0, 8) + '…' + value.slice(-4);
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
  if (line.source === 'mcp') {
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

export function formatLogCopyText(line: LogLine): string {
  return `${formatLogExportDateTime(line.timestamp)} [${line.level.toUpperCase()}] ${line.text}`;
}

export type { MessageKey };