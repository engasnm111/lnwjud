import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { appError, err, ok, type AppErrorCode, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import type { ProcessTreeTerminator } from '@lnwjud/process';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
// Captures are returned as bounded PNG/base64 payloads. Keep the transport
// ceiling above the 8 MiB image limit while still bounding a single response
// and the in-memory unfinished line.
const DEFAULT_MAX_PAYLOAD_BYTES = 12 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const APP_ERROR_CODES: readonly AppErrorCode[] = [
  'INVALID_INPUT', 'CONFLICT', 'WORKSPACE_NOT_FOUND', 'PATH_OUTSIDE_WORKSPACE', 'SECRET_ACCESS_DENIED',
  'PERMISSION_DENIED', 'PERMISSION_REQUIRED', 'FILE_NOT_FOUND', 'FILE_TOO_LARGE', 'BINARY_FILE',
  'PROCESS_NOT_FOUND', 'PROCESS_TIMEOUT', 'EXECUTABLE_NOT_FOUND', 'GIT_NOT_REPOSITORY', 'CODEX_NOT_AVAILABLE',
  'UNSUPPORTED_PLATFORM', 'INTERNAL_ERROR',
];

export interface NativeHostProtocolOptions {
  readonly platform: 'darwin' | 'linux';
  readonly executablePath: string;
  readonly expectedSha256?: string;
  readonly expectedSizeBytes?: number;
  /** Release composition sets this to true; local development may opt out explicitly. */
  readonly requireIntegrity?: boolean;
  readonly timeoutMs?: number;
  readonly maxPayloadBytes?: number;
  readonly terminator: ProcessTreeTerminator;
  readonly spawnProcess?: NativeHostSpawner;
}

export type NativeHostSpawner = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

interface PendingRequest {
  readonly resolve: (result: Result<unknown>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal | undefined;
  readonly onAbort: () => void;
}

/**
 * Bounded newline-delimited JSON transport for the signed native helpers.
 * One long-lived child can serve concurrent requests; response IDs are always
 * matched before a request is settled, so an out-of-order response cannot
 * satisfy another operation.
 */
export class NativeHostProcessBridge {
  private readonly platform: 'darwin' | 'linux';
  private readonly executablePath: string;
  private readonly expectedSha256: string | undefined;
  private readonly expectedSizeBytes: number | undefined;
  private readonly requireIntegrity: boolean;
  private readonly timeoutMs: number;
  private readonly maxPayloadBytes: number;
  private readonly terminator: ProcessTreeTerminator;
  private readonly spawnProcess: NativeHostSpawner;
  private child: ChildProcess | undefined;
  private starting: Promise<Result<void>> | undefined;
  private terminationInFlight: Promise<Result<void>> | undefined;
  private terminationUnverified = false;
  private stdoutBuffer = '';
  private stdoutBytes = 0;
  private readonly pending = new Map<string, PendingRequest>();

  public constructor(options: NativeHostProtocolOptions) {
    this.platform = options.platform;
    this.executablePath = path.resolve(options.executablePath);
    this.expectedSha256 = options.expectedSha256?.trim().toLowerCase();
    this.expectedSizeBytes = options.expectedSizeBytes;
    this.requireIntegrity = options.requireIntegrity === true;
    this.timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.maxPayloadBytes = Math.min(MAX_PAYLOAD_BYTES, Math.max(1024, options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES));
    this.terminator = options.terminator;
    this.spawnProcess = options.spawnProcess ?? ((executable: string, args: readonly string[], spawnOptions: SpawnOptions): ChildProcess => spawn(executable, [...args], spawnOptions));
  }

  public async execute(
    operation: string,
    input: unknown,
    signal?: AbortSignal,
    authorization?: InvocationAuthorization,
  ): Promise<Result<unknown>> {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(operation)) return err(appError('INVALID_INPUT', 'Native host operation name is invalid'));
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Native host operation was cancelled', true));
    let serialized: string;
    const id = cryptoRandomId();
    try {
      serialized = JSON.stringify({ id, operation, input, ...(authorization === undefined ? {} : { authorization }) });
    } catch {
      return err(appError('INVALID_INPUT', 'Native host input could not be serialized'));
    }
    if (Buffer.byteLength(serialized, 'utf8') > this.maxPayloadBytes) return err(appError('FILE_TOO_LARGE', 'Native host request exceeds the payload limit'));

    const started = await this.ensureStarted();
    if (!started.ok) return started;
    const child = this.child;
    const stdin = child?.stdin;
    if (child === undefined || stdin === null || stdin === undefined || stdin.destroyed) return err(appError('PROCESS_NOT_FOUND', 'Native host is not running', true));

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: Result<unknown>): void => {
        if (settled) return;
        settled = true;
        const pending = this.pending.get(id);
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          pending.signal?.removeEventListener('abort', pending.onAbort);
          this.pending.delete(id);
        }
        resolve(result);
      };
      const onAbort = (): void => {
        void this.terminate('Native host operation was cancelled').then((termination) => {
          if (!termination.ok) {
            // Do not report a clean cancellation while the helper may still be
            // alive. The caller needs the same termination-unverified signal as
            // every other managed-process boundary.
            finish(termination);
            return;
          }
          finish(err(appError('PROCESS_TIMEOUT', 'Native host operation was cancelled', true)));
        });
      };
      const timer = setTimeout(() => {
        void this.terminate('Native host operation timed out').then((termination) => {
          if (!termination.ok) {
            finish(termination);
            return;
          }
          finish(err(appError('PROCESS_TIMEOUT', 'Native host operation timed out', true)));
        });
      }, this.timeoutMs);
      this.pending.set(id, { resolve: finish, timer, signal, onAbort });
      signal?.addEventListener('abort', onAbort, { once: true });
      // AbortSignals do not replay an abort event for listeners attached after
      // the signal was aborted. Check again after registration so an abort
      // racing helper startup cannot leave a request pending until timeout.
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      try {
        stdin.write(`${serialized}\n`, 'utf8');
      } catch {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        finish(err(appError('PROCESS_NOT_FOUND', 'Native host input pipe is unavailable', true)));
      }
    });
  }

  public async close(): Promise<Result<void>> {
    return this.terminate('Native host was closed');
  }

  private async ensureStarted(): Promise<Result<void>> {
    if (this.terminationUnverified) {
      return err(appError('PROCESS_TIMEOUT', `${this.platform} native host termination is unverified; refusing to reuse the helper`, true));
    }
    // `ChildProcess.killed` means that a signal was requested, not that the
    // OS has reaped the process. Do not start a replacement while the old
    // helper is still live; otherwise two native providers could consume the
    // same ownership scope concurrently. The close handler is the only point
    // that clears the reference after an observed exit.
    if (this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null) return ok(undefined);
    if (this.starting !== undefined) return this.starting;
    this.starting = this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async start(): Promise<Result<void>> {
    const integrity = await this.verifyIntegrity();
    if (!integrity.ok) return integrity;
    let child: ChildProcess;
    try {
      child = this.spawnProcess(this.executablePath, [], {
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Native providers only need the host/session environment (PATH,
        // DISPLAY, DBUS, HOME, ...). Do not inherit credentials that happen
        // to be present in the Electron/CLI parent process.
        env: sanitizedNativeHostEnvironment(),
      });
    } catch {
      return err(appError('PROCESS_NOT_FOUND', `${this.platform} native host could not be started`, true));
    }
    this.child = child;
    this.stdoutBuffer = '';
    this.stdoutBytes = 0;
    // Keep incomplete UTF-8 sequences in this child's stream decoder until
    // the next chunk arrives, rather than replacing their individual bytes.
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.consumeStdout(chunk));
    child.stderr?.resume();
    child.once('error', () => this.failPending(err(appError('PROCESS_NOT_FOUND', `${this.platform} native host exited unexpectedly`, true))));
    child.once('close', () => {
      if (this.child === child) {
        this.child = undefined;
        this.terminationUnverified = false;
      }
      this.failPending(err(appError('PROCESS_NOT_FOUND', `${this.platform} native host stopped`, true)));
    });
    if (child.stdin === undefined || child.stdout === undefined) {
      await this.terminate(`${this.platform} native host did not expose stdio`);
      return err(appError('INTERNAL_ERROR', `${this.platform} native host stdio is unavailable`, true));
    }
    return ok(undefined);
  }

  private consumeStdout(text: string): void {
    // Bound the unfinished response currently buffered, not the lifetime
    // total. A long-lived helper is allowed to answer many small requests.
    this.stdoutBuffer += text;
    this.stdoutBytes = Buffer.byteLength(this.stdoutBuffer, 'utf8');
    if (this.stdoutBytes > this.maxPayloadBytes) {
      void this.terminate(`${this.platform} native host response exceeded the payload limit`);
      this.failPending(err(appError('FILE_TOO_LARGE', 'Native host response exceeds the payload limit', true)));
      return;
    }
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      this.consumeResponse(line);
    }
    this.stdoutBytes = Buffer.byteLength(this.stdoutBuffer, 'utf8');
  }

  private consumeResponse(line: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; } catch {
      void this.terminate(`${this.platform} native host returned malformed JSON`);
      this.failPending(err(appError('INTERNAL_ERROR', 'Native host returned malformed JSON', true)));
      return;
    }
    if (!isRecord(parsed) || typeof parsed.id !== 'string' || typeof parsed.ok !== 'boolean') {
      void this.terminate(`${this.platform} native host returned an invalid response`);
      this.failPending(err(appError('INTERNAL_ERROR', 'Native host returned an invalid response', true)));
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (pending === undefined) return;
    if (parsed.ok) {
      pending.resolve(ok(parsed.value));
      return;
    }
    const error = parseNativeHostError(parsed.error);
    pending.resolve(error === undefined ? err(appError('INTERNAL_ERROR', 'Native host returned an invalid error', true)) : err(error));
  }

  private failPending(result: Result<unknown>): void {
    for (const pending of this.pending.values()) pending.resolve(result);
  }

  private async terminate(reason: string): Promise<Result<void>> {
    if (this.terminationInFlight !== undefined) return this.terminationInFlight;
    const attempt = this.terminateOnce(reason);
    this.terminationInFlight = attempt;
    try {
      return await attempt;
    } finally {
      if (this.terminationInFlight === attempt) this.terminationInFlight = undefined;
    }
  }

  private async terminateOnce(reason: string): Promise<Result<void>> {
    const child = this.child;
    if (child === undefined) return ok(undefined);
    try {
      if (child.pid === undefined) {
        this.terminationUnverified = true;
        return err(appError('PROCESS_NOT_FOUND', `${reason}; native host PID is unavailable`, true));
      }
      await this.terminator.stop(child, child.pid);
      if (this.child === child) {
        this.child = undefined;
        this.terminationUnverified = false;
      }
      return ok(undefined);
    } catch {
      // Keep the child reference and quarantine it.  Reusing a helper after a
      // failed termination attempt could create two live native providers and
      // would make request ownership ambiguous.  The close event clears this
      // state only after the OS reports that the child really exited.
      this.terminationUnverified = true;
      return err(appError('PROCESS_TIMEOUT', `${reason}; native host termination could not be verified`, true));
    }
  }

  private async verifyIntegrity(): Promise<Result<void>> {
    if (this.expectedSha256 === undefined) {
      return this.requireIntegrity
        ? err(appError('INTERNAL_ERROR', `${this.platform} native host integrity manifest is missing`))
        : ok(undefined);
    }
    if (!/^[0-9a-f]{64}$/.test(this.expectedSha256)
      || (this.expectedSizeBytes !== undefined && (!Number.isSafeInteger(this.expectedSizeBytes) || this.expectedSizeBytes < 1))) {
      return err(appError('INTERNAL_ERROR', `${this.platform} native host integrity manifest is invalid`));
    }
    try {
      const info = await lstat(this.executablePath);
      if (!info.isFile() || info.isSymbolicLink()) return err(appError('INTERNAL_ERROR', `${this.platform} native host is not a trusted regular file`));
      const canonical = await realpath(this.executablePath);
      if (canonical !== this.executablePath) return err(appError('INTERNAL_ERROR', `${this.platform} native host path resolves through a link`));
      const bytes = await readFile(this.executablePath);
      if (this.expectedSizeBytes !== undefined && bytes.byteLength !== this.expectedSizeBytes) return err(appError('INTERNAL_ERROR', `${this.platform} native host size does not match its manifest`));
      const digest = createHash('sha256').update(bytes).digest('hex');
      return digest === this.expectedSha256
        ? ok(undefined)
        : err(appError('INTERNAL_ERROR', `${this.platform} native host hash does not match its manifest`));
    } catch {
      return err(appError('INTERNAL_ERROR', `${this.platform} native host integrity could not be verified`));
    }
  }
}

function parseNativeHostError(value: unknown): { readonly code: AppErrorCode; readonly message: string; readonly recoverable: boolean } | undefined {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string' || typeof value.recoverable !== 'boolean') return undefined;
  const code = APP_ERROR_CODES.find((candidate) => candidate === value.code) ?? 'INTERNAL_ERROR';
  return { code, message: value.message.slice(0, 2048), recoverable: value.recoverable };
}

function cryptoRandomId(): string {
  return randomUUID();
}

function sanitizedNativeHostEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:api[_-]?key|token|password|secret)/iu.test(key)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
