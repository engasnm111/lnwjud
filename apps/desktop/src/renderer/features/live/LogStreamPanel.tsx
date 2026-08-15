import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { LogLevel, LogLine, LogSource } from '@lnwjud/ipc-contracts';
import type { MessageKey } from '../../i18n/messages.js';

export type LogTab = LogSource;

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
  readonly exportLabel: string;
  readonly waitingLabel: string;
  readonly onClear: () => Promise<void>;
  readonly onExport: () => Promise<void>;
}

const MAX_VISIBLE_LINES = 1_000;

export function LogStreamPanel(props: LogStreamPanelProps): ReactElement {
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const streamRef = useRef<HTMLDivElement | null>(null);
  const filtered = useMemo(() => (
    filter.length === 0
      ? props.lines
      : props.lines.filter((line) => line.text.toLowerCase().includes(filter.toLowerCase()))
  ), [props.lines, filter]);
  const visible = filtered.slice(-MAX_VISIBLE_LINES);

  useEffect(() => {
    if (paused) return;
    const element = streamRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [visible.length, paused]);

  return (
    <section className="panel log-panel" aria-label={props.title}>
      <div className="section-heading">
        <h2>{props.title}</h2>
        <div className="worklog-actions">
          <button type="button" className={paused ? 'active' : undefined} onClick={() => setPaused((value) => !value)}>
            {paused ? props.followLabel : props.pauseLabel}
          </button>
          <button type="button" onClick={() => { void props.onClear(); }}>{props.clearLabel}</button>
          <button type="button" onClick={() => { void props.onExport(); }}>{props.exportLabel}</button>
        </div>
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
        {visible.map((line) => (
          <div key={line.id} className={`log-line ${line.level}`}>
            <time>{formatTime(line.timestamp)}</time>
            <span className="tag">[{line.level.toUpperCase()}]</span>
            <span>{line.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function filterLines(lines: readonly LogLine[], source: LogSource): readonly LogLine[] {
  return lines.filter((line) => line.source === source);
}

export function logLevelFor(line: LogLine): LogLevel {
  return line.level;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString();
}

export type { MessageKey };
