import type { ReactElement } from 'react';
import type { InFlightWorkItem, WorkLogEntry } from '@lnwjud/ipc-contracts';
import type { MessageKey } from '../../i18n/messages.js';

export type WorkLogFilter = 'all' | 'error';

interface WorkLogPanelProps {
  readonly title: string;
  readonly emptyLabel: string;
  readonly filterAllLabel: string;
  readonly filterErrorLabel: string;
  readonly clearLabel: string;
  readonly filter: WorkLogFilter;
  readonly onFilterChange: (filter: WorkLogFilter) => void;
  readonly onClear: () => Promise<void>;
  readonly entries: readonly WorkLogEntry[];
  readonly inFlight: readonly InFlightWorkItem[];
  readonly compact?: boolean;
}

export function WorkLogPanel(props: WorkLogPanelProps): ReactElement {
  const filtered = props.filter === 'error'
    ? props.entries.filter((entry) => entry.kind === 'error')
    : props.entries;
  const visible = props.compact ? filtered.slice(0, 40) : filtered;

  return (
    <section className="panel worklog-panel" aria-label={props.title}>
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
          <button type="button" onClick={() => { void props.onClear(); }}>{props.clearLabel}</button>
        </div>
      </div>
      <div className="worklog-stream" data-testid="work-log">
        {props.inFlight.map((item) => (
          <div key={item.callId} className="worklog-line inflight">
            <time>{formatTime(item.startedAt)}</time>
            <span className="tag">[TASK]</span>
            <strong>{item.toolName}</strong>
            <span>{item.targetSummary ?? ''}</span>
          </div>
        ))}
        {visible.length === 0 && props.inFlight.length === 0 ? <p>{props.emptyLabel}</p> : null}
        {visible.map((entry) => (
          <div key={entry.id} className={`worklog-line ${entry.kind}`}>
            <time>{formatTime(entry.timestamp)}</time>
            <span className="tag">{tagFor(entry.kind)}</span>
            <strong>{entry.toolName}</strong>
            <span>{entry.targetSummary ?? entry.resultCode}</span>
            {entry.kind !== 'task' ? <em>{entry.durationMs}ms</em> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function tagFor(kind: WorkLogEntry['kind']): string {
  if (kind === 'task') return '[TASK]';
  if (kind === 'error') return '[ERROR]';
  return '[RESULT]';
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString();
}

export type { MessageKey };
