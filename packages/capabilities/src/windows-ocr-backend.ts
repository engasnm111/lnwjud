import { spawn } from 'node:child_process';
import path from 'node:path';
import { appError, err, ok, type AppErrorCode, type Result } from '@lnwjud/domain';
import { WindowsProcessTree, type ProcessTreeTerminator } from '@lnwjud/process';
import type { CapabilityBackend } from './local-capability-service.js';

export type WindowsOcrHelper = CapabilityBackend;

export interface WindowsOcrCapabilityOptions {
  readonly platform?: NodeJS.Platform;
  /** A sparse-package/shell check. The helper performs a second authoritative check. */
  readonly packageIdentity?: () => Promise<Result<boolean>>;
  readonly helper?: WindowsOcrHelper;
}

export interface WindowsOcrProcessBridgeOptions {
  readonly helperPath: string;
  readonly platform?: NodeJS.Platform;
  readonly maxOutputBytes?: number;
  readonly timeoutSeconds?: number;
  readonly terminator?: ProcessTreeTerminator;
  readonly terminationRetryMs?: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 600;
const DEFAULT_TERMINATION_RETRY_MS = 250;
const APP_ERROR_CODES: readonly AppErrorCode[] = [
  'INVALID_INPUT', 'WORKSPACE_NOT_FOUND', 'PATH_OUTSIDE_WORKSPACE', 'SECRET_ACCESS_DENIED', 'PERMISSION_DENIED',
  'PERMISSION_REQUIRED', 'FILE_NOT_FOUND', 'FILE_TOO_LARGE', 'BINARY_FILE', 'PROCESS_NOT_FOUND', 'PROCESS_TIMEOUT',
  'EXECUTABLE_NOT_FOUND', 'GIT_NOT_REPOSITORY', 'CODEX_NOT_AVAILABLE', 'UNSUPPORTED_PLATFORM', 'INTERNAL_ERROR',
];

/**
 * Builds a host-side package-identity probe that asks the helper itself
 * (`{"op":"probe"}`) instead of assuming identity from the exe's presence.
 * Successful probes are cached for the process lifetime; failures are not,
 * so a transient helper error cannot permanently disable OCR.
 */
export function createOcrPackageIdentityProbe(helper: WindowsOcrHelper, timeoutSeconds = 10): () => Promise<Result<boolean>> {
  let cached: Result<boolean> | undefined;
  return async (): Promise<Result<boolean>> => {
    if (cached !== undefined) return cached;
    const probe = await Promise.race([
      helper.execute({ op: 'probe' }),
      new Promise<Result<never>>((resolve) => setTimeout(() => resolve(err(appError('PROCESS_TIMEOUT', 'Windows OCR identity probe timed out', true))), Math.max(1, timeoutSeconds) * 1_000)),
    ]);
    if (!probe.ok) return probe;
    const identity = isRecord(probe.value) && probe.value.package_identity === true;
    cached = ok(identity);
    return cached;
  };
}

export class WindowsOcrCapabilityBackend implements CapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly packageIdentity: (() => Promise<Result<boolean>>) | undefined;
  private readonly helper: WindowsOcrHelper | undefined;

  public constructor(options: WindowsOcrCapabilityOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.packageIdentity = options.packageIdentity;
    this.helper = options.helper;
  }

  public async execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.platform !== 'win32') return ok(this.unavailable('platform_unavailable', 'Windows.Media.Ocr is only available on Windows'));
    if (!isRecord(input) || input.action !== 'ocr') return err(appError('INVALID_INPUT', 'Windows OCR requires action: ocr'));
    if (isSignalAborted(signal)) return cancelledOcr();
    if (this.packageIdentity === undefined) return ok(this.unavailable('package_identity_required', 'Windows.Media.Ocr requires a package identity; the NSIS app is not identity-enabled'));

    const identity = await this.packageIdentity();
    if (isSignalAborted(signal)) return cancelledOcr();
    if (!identity.ok) return ok(this.unavailable('package_identity_check_failed', 'Windows package identity could not be verified'));
    if (identity.value !== true) return ok(this.unavailable('package_identity_required', 'Windows.Media.Ocr requires a package identity'));
    if (this.helper === undefined) return ok(this.unavailable('native_helper_not_configured', 'The packaged Windows OCR helper is not configured'));

    const result = await this.helper.execute(input, signal);
    if (!result.ok) return result;
    if (isRecord(result.value)) return ok({ ...result.value, backend: 'Windows.Media.Ocr', available: result.value.available !== false });
    return ok({ backend: 'Windows.Media.Ocr', available: true, value: result.value });
  }

  private unavailable(reason: string, message: string): Record<string, unknown> {
    return { available: false, ready: false, local: true, backend: 'Windows.Media.Ocr', reason, message };
  }
}

export class VisionCapabilityBackend implements CapabilityBackend {
  public constructor(
    private readonly nativeVision: CapabilityBackend,
    private readonly ocr: CapabilityBackend,
  ) {}

  public execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    return isRecord(input) && input.action === 'ocr'
      ? this.ocr.execute(input, signal)
      : this.nativeVision.execute(input, signal);
  }
}

export class WindowsOcrProcessBridge implements WindowsOcrHelper {
  private readonly helperPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly maxOutputBytes: number;
  private readonly timeoutSeconds: number;
  private readonly terminator: ProcessTreeTerminator;
  private readonly terminationRetryMs: number;

  public constructor(options: WindowsOcrProcessBridgeOptions) {
    this.helperPath = path.resolve(options.helperPath);
    this.platform = options.platform ?? process.platform;
    this.maxOutputBytes = Math.max(1, Math.min(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES));
    this.timeoutSeconds = Math.min(MAX_TIMEOUT_SECONDS, Math.max(0.1, options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS));
    this.terminator = options.terminator ?? new WindowsProcessTree();
    this.terminationRetryMs = Math.max(1, options.terminationRetryMs ?? DEFAULT_TERMINATION_RETRY_MS);
  }

  public execute(input: unknown, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.platform !== 'win32') return Promise.resolve(err(appError('INTERNAL_ERROR', 'Windows OCR helper is unavailable on this platform', true)));
    if (!path.isAbsolute(this.helperPath)) return Promise.resolve(err(appError('INVALID_INPUT', 'Windows OCR helper path must be absolute')));
    if (signal?.aborted === true) return Promise.resolve(cancelledOcr());
    let serialized: string;
    try { serialized = JSON.stringify(input); } catch { return Promise.resolve(err(appError('INVALID_INPUT', 'Windows OCR input could not be serialized'))); }

    return new Promise((resolve) => {
      let stdout = '';
      let settled = false;
      let stopReason: 'timed_out' | 'cancelled' | null = null;
      let stopPromise: Promise<void> | null = null;
      let spawnFailed = false;
      const child = spawn(this.helperPath, [], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const requestStop = (reason: 'timed_out' | 'cancelled'): void => {
        if (stopReason !== null) return;
        stopReason = reason;
        stopPromise = stopUntilVerified(child, this.terminator, this.terminationRetryMs, () => spawnFailed);
      };
      const onAbort = (): void => requestStop('cancelled');
      const timer = setTimeout(() => requestStop('timed_out'), this.timeoutSeconds * 1_000);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const append = (value: Buffer | string): void => {
        const chunk = Buffer.isBuffer(value) ? value.toString('utf8') : value;
        const remaining = this.maxOutputBytes - Buffer.byteLength(stdout, 'utf8');
        if (remaining > 0) stdout += chunk.slice(0, remaining);
      };
      child.stdout?.on('data', append);
      child.stderr?.resume();
      child.once('error', () => {
        spawnFailed = child.pid === undefined;
        void settleAfterExit(true);
      });
      child.once('close', () => { void settleAfterExit(false); });
      const settleAfterExit = async (failedToStart: boolean): Promise<void> => {
        if (settled) return;
        settled = true;
        cleanup();
        if (stopPromise !== null) await stopPromise;
        if (stopReason !== null) {
          const reason = stopReason === 'cancelled' ? 'Windows OCR helper was cancelled' : 'Windows OCR helper timed out';
          resolve(err(appError('PROCESS_TIMEOUT', reason, true)));
          return;
        }
        if (failedToStart) {
          resolve(err(appError('INTERNAL_ERROR', 'Windows OCR helper could not start', true)));
          return;
        }
        const result = parseHelperResult(stdout);
        resolve(result ?? err(appError('INTERNAL_ERROR', 'Windows OCR helper returned an invalid response', true)));
      };
      child.stdin?.end(serialized, 'utf8');
    });
  }
}

function cancelledOcr(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Windows OCR operation was cancelled', true));
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function parseHelperResult(value: string): Result<unknown> | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(value.trim()) as unknown; } catch { return undefined; }
  if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') return undefined;
  if (parsed.ok) return ok(parsed.value);
  const error = parsed.error;
  if (!isRecord(error) || typeof error.code !== 'string' || typeof error.message !== 'string' || typeof error.recoverable !== 'boolean') return undefined;
  const code = APP_ERROR_CODES.find((candidate) => candidate === error.code) ?? 'INTERNAL_ERROR';
  return err(appError(code, error.message, error.recoverable));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function stopUntilVerified(
  child: ReturnType<typeof spawn>,
  terminator: ProcessTreeTerminator,
  retryMs: number,
  spawnFailed: () => boolean,
): Promise<void> {
  while (true) {
    const pid = child.pid;
    if (pid === undefined) {
      if (spawnFailed()) return;
    } else {
      try {
        await terminator.stop(child, pid);
        return;
      } catch {
        // Retain the operation until a retry verifies that the whole helper tree stopped.
        if (child.exitCode !== null || child.signalCode !== null) await neverSettles();
      }
    }
    await delay(retryMs);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function neverSettles(): Promise<never> {
  return new Promise<never>(() => undefined);
}
