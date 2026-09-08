import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';
import { sanitizedChildEnvironment } from './sanitized-child-environment.js';

/**
 * Read-only Windows Event Log queries behind the `event_watch` and
 * `crash_trace` upgrade tools (Wave 5). Providers and log names are
 * allowlisted, results are bounded, and the query itself runs through
 * `powershell.exe Get-WinEvent` with parameters passed via environment
 * variables so request data never becomes command-line content.
 */

export interface EventLogBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly timeoutSeconds?: number;
  /** Injectable for tests: runs the PowerShell query and returns raw stdout. */
  readonly runner?: EventLogRunner;
  /** Injectable host-native runner for macOS Unified Log/Linux journal. */
  readonly portableRunner?: EventLogPortableRunner;
}

export type EventLogRunner = (
  script: string,
  environment: Readonly<Record<string, string>>,
  signal?: AbortSignal,
) => Promise<Result<string>>;

export type EventLogPortableRunner = (
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<Result<string>>;

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_EVENTS_HARD_LIMIT = 500;
const ALLOWED_LOG_NAMES: ReadonlySet<string> = new Set(['application', 'system']);
const ALLOWED_PROVIDERS: ReadonlySet<string> = new Set([
  'application error',
  'windows error reporting',
  '.net runtime',
  'microsoft-windows-windowsupdateclient',
  'microsoft-windows-kernel-power',
  'microsoft-windows-taskscheduler',
]);
const QUERY_SCRIPT = [
  '$ErrorActionPreference = \'Stop\'',
  '$events = @()',
  'try {',
  '  if ($env:LNWJUD_EVENT_MODE -eq \'crashes\') {',
  '    $since = (Get-Date).AddHours(-[double]$env:LNWJUD_EVENT_HOURS)',
  '    $events = @(Get-WinEvent -FilterHashtable @{ LogName = \'Application\'; Id = @(1000, 1001); StartTime = $since } -MaxEvents ([int]$env:LNWJUD_EVENT_MAX) -ErrorAction Stop)',
  '  } else {',
  '    $filter = @{}',
  '    if ($env:LNWJUD_EVENT_LOG) { $filter.LogName = $env:LNWJUD_EVENT_LOG }',
  '    if ($env:LNWJUD_EVENT_PROVIDER) { $filter.ProviderName = $env:LNWJUD_EVENT_PROVIDER }',
  '    if ($env:LNWJUD_EVENT_SINCE) { $filter.StartTime = [datetime]::Parse($env:LNWJUD_EVENT_SINCE) }',
  '    $events = @(Get-WinEvent -FilterHashtable $filter -MaxEvents ([int]$env:LNWJUD_EVENT_MAX) -ErrorAction Stop)',
  '  }',
  '} catch {',
  '  if ($_.FullyQualifiedErrorId -ne \'NoMatchingEventsFound,Microsoft.PowerShell.Commands.GetWinEventCommand\') { throw }',
  '}',
  '$mapped = foreach ($event in $events) { [ordered]@{',
  '  time = $event.TimeCreated.ToString(\'o\')',
  '  provider = [string]$event.ProviderName',
  '  id = $event.Id',
  '  level = [string]$event.LevelDisplayName',
  '  message = [string]$event.Message',
  '} }',
  '$json = @($mapped) | ConvertTo-Json -Compress -Depth 4',
  'if (-not $json -or $json.Trim().Length -eq 0) { \'[]\' } elseif (-not $json.TrimStart().StartsWith(\'[\')) { \'[\' + $json.Trim() + \']\' } else { $json.Trim() }',
].join('\n');
const execFileAsync = promisify(execFile);

export class EventLogCapabilityBackend implements CapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly timeoutSeconds: number;
  private readonly runner: EventLogRunner;
  private readonly portableRunner: EventLogPortableRunner;

  public constructor(options: EventLogBackendOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.timeoutSeconds = Math.min(600, Math.max(1, options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS));
    this.runner = options.runner ?? defaultRunner(this.timeoutSeconds);
    this.portableRunner = options.portableRunner ?? defaultPortableRunner(this.timeoutSeconds);
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Event log query was cancelled', true));
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return err(appError('INVALID_INPUT', 'Event log input must be an object'));
    }
    const request = input as Record<string, unknown>;
    const mode = request.operation === 'crashes' ? 'crashes' : 'query';

    if (this.platform !== 'win32') return this.executePortable(mode, request, signal);

    const environment: Record<string, string> = {
      LNWJUD_EVENT_MODE: mode,
      LNWJUD_EVENT_MAX: String(clampInteger(request.max_events ?? request.maxEvents, 100, 1, MAX_EVENTS_HARD_LIMIT)),
    };
    if (mode === 'crashes') {
      environment.LNWJUD_EVENT_HOURS = String(clampNumber(request.hours, 24, 1, 720));
    } else {
      const logName = readTrimmedString(request.log_name ?? request.logName);
      const provider = readTrimmedString(request.provider);
      if (logName === undefined && provider === undefined) {
        return err(appError('INVALID_INPUT', 'event_watch requires log_name or provider'));
      }
      if (logName !== undefined && !ALLOWED_LOG_NAMES.has(logName.toLowerCase())) {
        return err(appError('PERMISSION_DENIED', `Log name is not allowlisted: ${logName}. Allowed: ${[...ALLOWED_LOG_NAMES].join(', ')}`));
      }
      if (provider !== undefined && !ALLOWED_PROVIDERS.has(provider.toLowerCase())) {
        return err(appError('PERMISSION_DENIED', `Event provider is not allowlisted: ${provider}. Allowed: ${[...ALLOWED_PROVIDERS].join(', ')}`));
      }
      if (logName !== undefined) environment.LNWJUD_EVENT_LOG = logName;
      if (provider !== undefined) environment.LNWJUD_EVENT_PROVIDER = provider;
      const since = readTrimmedString(request.since);
      if (since !== undefined) {
        const parsed = Date.parse(since);
        if (!Number.isFinite(parsed)) return err(appError('INVALID_INPUT', 'since must be an ISO-8601 timestamp'));
        environment.LNWJUD_EVENT_SINCE = new Date(parsed).toISOString();
      }
    }

    const result = await this.runner(QUERY_SCRIPT, environment, signal);
    if (!result.ok) return result;
    let events: unknown;
    try {
      events = JSON.parse(result.value.trim());
    } catch {
      return err(appError('INTERNAL_ERROR', 'Event log query returned an unparsable response', true));
    }
    if (!Array.isArray(events)) return err(appError('INTERNAL_ERROR', 'Event log query returned a non-array response', true));
    return ok({ available: true, ready: true, local: true, backend: 'windows-event-log', mode, count: events.length, events });
  }

  private async executePortable(mode: 'query' | 'crashes', request: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
    const maxEvents = clampInteger(request.max_events ?? request.maxEvents, 100, 1, MAX_EVENTS_HARD_LIMIT);
    const hours = clampNumber(request.hours, 24, 1, 720);
    const logName = readTrimmedString(request.log_name ?? request.logName);
    const provider = readTrimmedString(request.provider);
    if (mode === 'query' && logName === undefined && provider === undefined) return err(appError('INVALID_INPUT', 'event_watch requires log_name or provider'));
    for (const value of [logName, provider]) {
      if (value !== undefined && (value.length > 256 || !/^[\w .:@/-]+$/u.test(value))) return err(appError('INVALID_INPUT', 'Portable log filters contain unsupported characters'));
    }
    const since = readTrimmedString(request.since);
    if (since !== undefined && !Number.isFinite(Date.parse(since))) return err(appError('INVALID_INPUT', 'since must be an ISO-8601 timestamp'));
    const normalizedSince = since === undefined ? undefined : new Date(Date.parse(since)).toISOString();
    const invocation = portableInvocation(this.platform, mode, {
      maxEvents,
      hours,
      ...(normalizedSince === undefined ? {} : { since: normalizedSince }),
      ...(logName === undefined ? {} : { logName }),
      ...(provider === undefined ? {} : { provider }),
    });
    if (invocation === null) return ok({ available: false, ready: false, local: true, reason: 'portable_log_provider_missing', backend: `${this.platform}-native-log`, mode });
    const result = await this.portableRunner(invocation.executable, invocation.args, signal);
    if (!result.ok) {
      if (result.error.code === 'PROCESS_NOT_FOUND') return ok({ available: false, ready: false, local: true, reason: 'portable_log_provider_missing', backend: `${this.platform}-native-log`, mode });
      return result;
    }
    const events = parsePortableEvents(result.value, this.platform, maxEvents);
    return ok({ available: true, ready: true, local: true, backend: `${this.platform}-native-log`, mode, count: events.length, events, ...(provider === undefined ? {} : { provider }), ...(logName === undefined ? {} : { logName }) });
  }
}

function portableInvocation(
  platform: NodeJS.Platform,
  mode: 'query' | 'crashes',
  input: {
    readonly maxEvents: number;
    readonly hours: number;
    readonly since?: string;
    readonly logName?: string;
    readonly provider?: string;
  },
): { readonly executable: string; readonly args: readonly string[] } | null {
  if (platform === 'darwin') {
    // `log show` has no event-count switch (unlike `log stats`); the runner's
    // byte cap and parser's maxEvents bound keep this read-only query finite.
    // NDJSON keeps parsing bounded and avoids buffering one potentially huge
    // top-level JSON array. Use an absolute start when the caller supplied one;
    // combining `--last` and `--start` is ambiguous across macOS releases.
    const args = ['show', '--style', 'ndjson', '--no-pager'];
    if (input.since === undefined) args.push('--last', `${input.hours}h`);
    const predicates: string[] = [];
    if (mode === 'crashes') predicates.push('(eventMessage CONTAINS[c] "crash" OR eventMessage CONTAINS[c] "exception")');
    if (input.provider !== undefined) {
      const provider = predicateLiteral(input.provider);
      // Unified Log has no Windows-style provider column. Match the stable
      // process/subsystem/sender fields without interpolating raw request
      // text into an executable command or predicate expression.
      predicates.push(`(process == ${provider} OR subsystem == ${provider} OR senderImagePath ENDSWITH[c] ${provider})`);
    }
    if (predicates.length > 0) args.push('--predicate', predicates.join(' AND '));
    if (input.since !== undefined) args.push('--start', input.since);
    return { executable: 'log', args };
  }
  if (platform === 'linux') {
    const args = ['--no-pager', '--output=json', '-n', String(input.maxEvents)];
    if (input.logName?.toLowerCase() === 'application') args.push('--user');
    if (mode === 'crashes') args.push('-p', 'err..emerg');
    if (input.provider !== undefined) args.push('-t', input.provider);
    if (input.since !== undefined) args.push('--since', input.since);
    return { executable: 'journalctl', args };
  }
  return null;
}

function predicateLiteral(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function parsePortableEvents(raw: string, platform: NodeJS.Platform, maxEvents: number): readonly Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (events.length >= maxEvents) break;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const records = Array.isArray(parsed) ? parsed : [parsed];
      for (const value of records) {
        if (events.length >= maxEvents) break;
        if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
        // `log --style ndjson` emits a final `{ "finished": ... }` marker.
        if (platform === 'darwin' && 'finished' in value) continue;
        const record = value as Record<string, unknown>;
        const time = platform === 'linux'
          ? record.__REALTIME_TIMESTAMP ?? record._SOURCE_REALTIME_TIMESTAMP
          : record.timestamp ?? record.time;
        const message = platform === 'linux' ? record.MESSAGE : record.eventMessage;
        const provider = platform === 'linux'
          ? record.SYSLOG_IDENTIFIER
          : record.process ?? record.processImagePath ?? record.sender ?? record.senderImagePath;
        const id = platform === 'linux' ? record._PID : record.processID ?? record.processIdentifier;
        const level = platform === 'linux' ? record.PRIORITY : record.messageType ?? record.logType;
        events.push({
          time: typeof time === 'string' || typeof time === 'number' ? String(time) : null,
          provider: typeof provider === 'string' ? provider : null,
          id: typeof id === 'string' || typeof id === 'number' ? id : null,
          level: typeof level === 'string' || typeof level === 'number' ? level : null,
          message: typeof message === 'string' ? message.slice(0, 16_384) : JSON.stringify(record).slice(0, 16_384),
        });
      }
    } catch {
      // Unified Log may emit non-JSON framing; skip it rather than exposing
      // unbounded diagnostic text or claiming a parsed event.
    }
  }
  return events;
}

function defaultRunner(timeoutSeconds: number): EventLogRunner {
  return (script, environment, signal): Promise<Result<string>> => new Promise((resolve) => {
    // The script is a repo constant (request data travels via env vars), so
    // passing it as the -Command argument is injection-safe.
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      shell: false,
      env: { ...sanitizedChildEnvironment(), ...environment },
    });
    let stdout = '';
    let settled = false;
    const finish = (result: Result<string>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(err(appError('PROCESS_TIMEOUT', `Event log query timed out after ${timeoutSeconds}s`, true)));
    }, timeoutSeconds * 1_000);
    const onAbort = (): void => {
      child.kill();
      finish(err(appError('PROCESS_TIMEOUT', 'Event log query was cancelled', true)));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.resume();
    child.once('error', () => finish(err(appError('INTERNAL_ERROR', 'powershell.exe could not start for the event log query', true))));
    child.once('close', () => finish(ok(stdout)));
    child.stdin?.end();
  });
}

function defaultPortableRunner(timeoutSeconds: number): EventLogPortableRunner {
  return async (executable, args, signal): Promise<Result<string>> => {
    try {
      const result = await execFileAsync(executable, [...args], {
        windowsHide: true,
        shell: false,
        env: sanitizedChildEnvironment(),
        encoding: 'utf8',
        timeout: timeoutSeconds * 1_000,
        maxBuffer: 4 * 1024 * 1024,
        ...(signal === undefined ? {} : { signal }),
      });
      return ok(typeof result.stdout === 'string' ? result.stdout : '');
    } catch (error: unknown) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
      if (code === 'ENOENT') return err(appError('PROCESS_NOT_FOUND', `${executable} is unavailable`, true));
      if (code === 'ETIMEDOUT' || code === 'ABORT_ERR') return err(appError('PROCESS_TIMEOUT', `${executable} query timed out`, true));
      return err(appError('INTERNAL_ERROR', `${executable} query failed`, true));
    }
  };
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
