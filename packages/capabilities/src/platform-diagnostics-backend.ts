import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { appError, err, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';
import { sanitizedChildEnvironment } from './sanitized-child-environment.js';

const execFileAsync = promisify(execFile);
const MAX_EVENTS = 500;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface PlatformDiagnosticsRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
}

export interface PlatformDiagnosticsBackendOptions {
  readonly homeDirectory?: string;
  readonly uid?: () => number;
  readonly executableExists?: (executable: string) => boolean;
  readonly runImpl?: (executable: string, args: readonly string[], signal?: AbortSignal) => Promise<PlatformDiagnosticsRunResult>;
  readonly timeoutMs?: number;
}

type PortablePlatform = 'darwin' | 'linux';
type DiagnosticsAction = 'status' | 'logs' | 'service' | 'services' | 'ports' | 'startup';

/**
 * Read-only diagnostics for the target desktop managers. The provider is
 * intentionally separate from scheduler mutation code: every invocation is
 * argv-only, bounded, and never attempts to repair or mutate a foreign unit.
 */
export class PlatformDiagnosticsCapabilityBackend implements CapabilityBackend {
  private readonly executableExists: (executable: string) => boolean;
  private readonly runImpl: (executable: string, args: readonly string[], signal?: AbortSignal) => Promise<PlatformDiagnosticsRunResult>;
  private readonly timeoutMs: number;
  private readonly uid: () => number;

  public constructor(private readonly platform: PortablePlatform, options: PlatformDiagnosticsBackendOptions = {}) {
    this.executableExists = options.executableExists ?? ((executable: string): boolean => commandInPosixPath(executable));
    this.runImpl = options.runImpl ?? defaultRunner(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.timeoutMs = Math.min(60_000, Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.uid = options.uid ?? ((): number => typeof process.getuid === 'function' ? process.getuid() : 0);
    // Keep this read so a caller can provide a deterministic home in a test
    // without the implementation ever consulting it as a command argument.
    void options.homeDirectory;
  }

  public async execute(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    void authorization;
    if (!isRecord(input)) return err(appError('INVALID_INPUT', 'diagnostics input must be an object'));
    const action = readAction(input.action);
    if (action === null) return err(appError('INVALID_INPUT', 'diagnostics action is invalid'));
    if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'diagnostics operation was cancelled', true));
    if (action === 'status') return ok(this.status());

    const invocation = this.invocation(action, input);
    if (!invocation.ok) return invocation;
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'diagnostics operation was cancelled', true));
    try {
      const result = await this.runImpl(invocation.value.executable, invocation.value.args, signal);
      if (result.exitCode !== undefined && result.exitCode !== 0) {
        return err(appError('INTERNAL_ERROR', `${invocation.value.executable} exited with code ${result.exitCode}`, true));
      }
      if (action === 'logs') {
        const maxEvents = invocation.value.maxEvents ?? 100;
        const events = parseEvents(result.stdout, this.platform, maxEvents);
        return ok({
          available: true,
          ready: true,
          local: true,
          backend: this.platform === 'darwin' ? 'macos-unified-log' : 'linux-journal',
          count: events.length,
          events,
          ...(invocation.value.provider === undefined ? {} : { provider: invocation.value.provider }),
        });
      }
      return ok({
        available: true,
        ready: true,
        local: true,
        backend: invocation.value.backend,
        action,
        ...(invocation.value.service === undefined ? {} : { service: invocation.value.service }),
        output: result.stdout.slice(0, MAX_OUTPUT_BYTES),
        ...(result.stderr.trim().length === 0 ? {} : { stderr: result.stderr.slice(0, 16_384) }),
      });
    } catch (error: unknown) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return err(appError('PROCESS_TIMEOUT', 'diagnostics operation was cancelled', true));
      }
      if (isNotFound(error)) {
        return ok({ available: false, ready: false, local: true, backend: this.backendFor(action), reason: 'dependency_missing', readinessReason: 'dependency_missing' });
      }
      return err(appError('INTERNAL_ERROR', `${this.backendFor(action)} query failed`, true));
    }
  }

  private status(): Record<string, unknown> {
    const dependencies = this.platform === 'darwin'
      ? { log: this.hasExecutable('log'), launchctl: this.hasExecutable('launchctl'), lsof: this.hasExecutable('lsof') }
      : { journalctl: this.hasExecutable('journalctl'), systemctl: this.hasExecutable('systemctl'), ss: this.hasExecutable('ss') };
    const available = Object.values(dependencies).some(Boolean);
    const ready = this.platform === 'darwin'
      ? Boolean(dependencies.log || dependencies.launchctl)
      : Boolean(dependencies.journalctl || dependencies.systemctl);
    return {
      available,
      ready,
      local: true,
      backend: this.platform === 'darwin' ? 'macos-unified-log' : 'linux-journal',
      platform: this.platform,
      dependencies,
      ...(ready ? {} : { reason: 'dependency_missing', readinessReason: 'dependency_missing' }),
      supportedActions: ['status', 'logs', 'service', 'services', 'ports', 'startup'],
    };
  }

  private hasExecutable(executable: string): boolean {
    return this.executableExists(executable);
  }

  private invocation(action: Exclude<DiagnosticsAction, 'status'>, input: Record<string, unknown>): Result<DiagnosticInvocation> {
    if (action === 'logs') {
      const maxEvents = boundedInteger(input.max_events ?? input.maxEvents, 100, 1, MAX_EVENTS);
      const rawProvider = input.provider ?? input.service;
      const provider = readSafeFilter(rawProvider);
      if (rawProvider !== undefined && provider === undefined) return err(appError('INVALID_INPUT', 'diagnostic provider contains unsupported characters'));
      const since = readSince(input.since);
      if (since === null) return err(appError('INVALID_INPUT', 'diagnostic since must be an ISO-8601 timestamp'));
      if (this.platform === 'darwin') {
        const args = ['show', '--style', 'ndjson', '--no-pager'];
        if (provider !== undefined) args.push('--predicate', `(process == ${predicateLiteral(provider)} OR subsystem == ${predicateLiteral(provider)} OR senderImagePath ENDSWITH[c] ${predicateLiteral(provider)})`);
        if (since === undefined) args.push('--last', `${boundedInteger(input.hours, 24, 1, 720)}h`);
        else args.push('--start', since);
        return ok({ executable: 'log', args, backend: 'macos-unified-log', maxEvents, ...(provider === undefined ? {} : { provider }) });
      }
      const args = ['--no-pager', '--output=json', '-n', String(maxEvents), '--user'];
      if (provider !== undefined) args.push('-t', provider);
      if (since !== undefined) args.push('--since', since);
      return ok({ executable: 'journalctl', args, backend: 'linux-journal', maxEvents, ...(provider === undefined ? {} : { provider }) });
    }

    if (action === 'service') {
      const service = input.service === undefined ? undefined : readServiceName(input.service);
      if (input.service !== undefined && service === undefined) return err(appError('INVALID_INPUT', 'service name is invalid'));
      if (this.platform === 'darwin') {
        const args = service === undefined ? ['list'] : ['print', `gui/${this.uid()}/${service}`];
        return ok({ executable: 'launchctl', args, backend: 'launchd-user', ...(service === undefined ? {} : { service }) });
      }
      const args = service === undefined ? ['--user', 'list-units', '--type=service', '--all', '--no-pager', '--plain'] : ['--user', 'status', service, '--no-pager', '--plain'];
      return ok({ executable: 'systemctl', args, backend: 'systemd-user', ...(service === undefined ? {} : { service }) });
    }

    if (action === 'services') {
      return this.platform === 'darwin'
        ? ok({ executable: 'launchctl', args: ['list'], backend: 'launchd-user' })
        : ok({ executable: 'systemctl', args: ['--user', 'list-unit-files', '--state=enabled', '--no-pager', '--plain'], backend: 'systemd-user' });
    }

    if (action === 'startup') {
      return this.platform === 'darwin'
        ? ok({ executable: 'launchctl', args: ['print-disabled', `gui/${this.uid()}`], backend: 'launchd-user' })
        : ok({ executable: 'systemctl', args: ['--user', 'list-unit-files', '--state=enabled', '--no-pager', '--plain'], backend: 'systemd-user' });
    }

    return this.platform === 'darwin'
      ? ok({ executable: 'lsof', args: ['-nP', '-iTCP', '-sTCP:LISTEN'], backend: 'macos-lsof' })
      : ok({ executable: 'ss', args: ['-ltnp'], backend: 'linux-ss' });
  }

  private backendFor(action: DiagnosticsAction): string {
    if (action === 'logs') return this.platform === 'darwin' ? 'macos-unified-log' : 'linux-journal';
    if (action === 'ports') return this.platform === 'darwin' ? 'macos-lsof' : 'linux-ss';
    return this.platform === 'darwin' ? 'launchd-user' : 'systemd-user';
  }
}

interface DiagnosticInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly backend: string;
  readonly maxEvents?: number;
  readonly provider?: string;
  readonly service?: string;
}

function readAction(value: unknown): DiagnosticsAction | null {
  const action = value === undefined ? 'status' : value;
  return typeof action === 'string' && ['status', 'logs', 'service', 'services', 'ports', 'startup'].includes(action)
    ? action as DiagnosticsAction
    : null;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.trunc(numeric))) : fallback;
}

function readSafeFilter(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 && /^[\w .:@/-]+$/u.test(trimmed) ? trimmed : undefined;
}

function readServiceName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 && !trimmed.startsWith('-') && /^[A-Za-z0-9_.:@-]+$/u.test(trimmed) ? trimmed : undefined;
}

function readSince(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function predicateLiteral(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function parseEvents(raw: string, platform: PortablePlatform, maxEvents: number): readonly Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (events.length >= maxEvents) break;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let value: unknown;
    try { value = JSON.parse(trimmed) as unknown; } catch { continue; }
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (events.length >= maxEvents || !isRecord(candidate)) continue;
      if (platform === 'darwin' && 'finished' in candidate) continue;
      const time = platform === 'linux' ? candidate.__REALTIME_TIMESTAMP ?? candidate._SOURCE_REALTIME_TIMESTAMP : candidate.timestamp ?? candidate.time;
      const provider = platform === 'linux' ? candidate.SYSLOG_IDENTIFIER : candidate.process ?? candidate.processImagePath ?? candidate.sender;
      const id = platform === 'linux' ? candidate._PID : candidate.processID ?? candidate.processIdentifier;
      const level = platform === 'linux' ? candidate.PRIORITY : candidate.messageType ?? candidate.logType;
      const message = platform === 'linux' ? candidate.MESSAGE : candidate.eventMessage;
      events.push({
        time: typeof time === 'string' || typeof time === 'number' ? String(time) : null,
        provider: typeof provider === 'string' ? provider : null,
        id: typeof id === 'string' || typeof id === 'number' ? id : null,
        level: typeof level === 'string' || typeof level === 'number' ? level : null,
        message: typeof message === 'string' ? message.slice(0, 16_384) : JSON.stringify(candidate).slice(0, 16_384),
      });
    }
  }
  return events;
}

function defaultRunner(timeoutMs: number): NonNullable<PlatformDiagnosticsBackendOptions['runImpl']> {
  return async (executable: string, args: readonly string[], signal?: AbortSignal): Promise<PlatformDiagnosticsRunResult> => {
    try {
      const result = await execFileAsync(executable, [...args], { encoding: 'utf8', shell: false, env: sanitizedChildEnvironment(), timeout: Math.min(60_000, Math.max(1_000, timeoutMs)), maxBuffer: MAX_OUTPUT_BYTES, ...(signal === undefined ? {} : { signal }) });
      return { stdout: typeof result.stdout === 'string' ? result.stdout : '', stderr: typeof result.stderr === 'string' ? result.stderr : '', exitCode: 0 };
    } catch (error: unknown) {
      if (error instanceof Error) throw error;
      throw new Error('diagnostic command failed');
    }
  };
}

function commandInPosixPath(executable: string): boolean {
  if (path.posix.isAbsolute(executable)) return existsSync(executable);
  return (process.env.PATH ?? '').split(':').filter(Boolean).some((directory) => existsSync(path.posix.join(directory, executable)));
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
