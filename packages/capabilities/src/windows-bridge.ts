import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type AppErrorCode, type Result } from '@lnwjud/domain';
import { WindowsProcessTree, type ProcessTreeTerminator } from '@lnwjud/process';
import type { WindowsCapabilityBridge, WindowsCapabilityName } from './windows-native-backend.js';

export interface PowerShellWindowsBridgeOptions {
  readonly scriptPath: string;
  readonly powershellPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly maxOutputBytes?: number;
  readonly terminator?: ProcessTreeTerminator;
  readonly terminationRetryMs?: number;
  readonly expectedScriptSha256?: string;
}

const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 14_400;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TERMINATION_RETRY_MS = 250;
const APP_ERROR_CODES: readonly AppErrorCode[] = [
  'INVALID_INPUT', 'WORKSPACE_NOT_FOUND', 'PATH_OUTSIDE_WORKSPACE', 'SECRET_ACCESS_DENIED', 'PERMISSION_DENIED',
  'PERMISSION_REQUIRED', 'FILE_NOT_FOUND', 'FILE_TOO_LARGE', 'BINARY_FILE', 'PROCESS_NOT_FOUND', 'PROCESS_TIMEOUT',
  'EXECUTABLE_NOT_FOUND', 'GIT_NOT_REPOSITORY', 'CODEX_NOT_AVAILABLE', 'INTERNAL_ERROR',
];

export class PowerShellWindowsCapabilityBridge implements WindowsCapabilityBridge {
  private readonly scriptPath: string;
  private readonly powershellPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly maxOutputBytes: number;
  private readonly terminator: ProcessTreeTerminator;
  private readonly terminationRetryMs: number;
  private readonly expectedScriptSha256: string | undefined;

  public constructor(options: PowerShellWindowsBridgeOptions) {
    this.scriptPath = path.resolve(options.scriptPath);
    this.powershellPath = options.powershellPath ?? powershellExecutable();
    this.platform = options.platform ?? process.platform;
    this.maxOutputBytes = Math.max(1, Math.min(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES));
    this.terminator = options.terminator ?? new WindowsProcessTree();
    this.terminationRetryMs = Math.max(1, options.terminationRetryMs ?? DEFAULT_TERMINATION_RETRY_MS);
    this.expectedScriptSha256 = options.expectedScriptSha256?.trim().toLowerCase();
  }

  public async execute(request: { readonly capability: WindowsCapabilityName; readonly input: unknown }, signal?: AbortSignal): Promise<Result<unknown>> {
    if (this.platform !== 'win32') return Promise.resolve(err(appError('INTERNAL_ERROR', 'Windows bridge is unavailable on this platform', true)));
    if (!path.isAbsolute(this.scriptPath)) return Promise.resolve(err(appError('INVALID_INPUT', 'Windows bridge script path must be absolute')));
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Windows bridge operation was cancelled', true));
    const integrity = await this.verifyIntegrity();
    if (!integrity.ok) return err(integrity.error);
    let serialized: string;
    try {
      serialized = JSON.stringify(request);
    } catch {
      return err(appError('INVALID_INPUT', 'Windows bridge input could not be serialized'));
    }

    return new Promise((resolve) => {
      let stdout = '';
      let stopReason: 'timed_out' | 'cancelled' | null = null;
      let stopPromise: Promise<void> | null = null;
      let settled = false;
      let spawnFailed = false;
      const child = spawn(this.powershellPath, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const timeoutSeconds = readTimeout(request.input);
      const requestStop = (reason: 'timed_out' | 'cancelled'): void => {
        if (stopReason !== null) return;
        stopReason = reason;
        stopPromise = stopUntilVerified(child, this.terminator, this.terminationRetryMs, () => spawnFailed);
      };
      const onAbort = (): void => requestStop('cancelled');
      const timer = setTimeout(() => requestStop('timed_out'), timeoutSeconds * 1000);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const append = (current: string, value: Buffer | string): string => {
        const chunk = Buffer.isBuffer(value) ? value.toString('utf8') : value;
        const remaining = this.maxOutputBytes - Buffer.byteLength(current, 'utf8');
        return remaining <= 0 ? current : current + chunk.slice(0, remaining);
      };
      child.stdout?.on('data', (chunk: Buffer | string) => { stdout = append(stdout, chunk); });
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
          const reason = stopReason === 'cancelled' ? 'Windows bridge operation was cancelled' : 'Windows bridge timed out';
          resolve(err(appError('PROCESS_TIMEOUT', reason, true)));
          return;
        }
        if (failedToStart) {
          resolve(err(appError('INTERNAL_ERROR', 'Windows bridge process could not start', true)));
          return;
        }
        const result = parseBridgeResult(stdout);
        if (result !== undefined) {
          resolve(result);
          return;
        }
        resolve(err(appError('INTERNAL_ERROR', 'Windows bridge returned an invalid response', true)));
      };
      child.stdin?.end(serialized, 'utf8');
    });
  }

  private async verifyIntegrity(): Promise<Result<void>> {
    if (this.expectedScriptSha256 === undefined) return ok(undefined);
    if (!/^[0-9a-f]{64}$/.test(this.expectedScriptSha256)) {
      return err(appError('INTERNAL_ERROR', 'Windows bridge integrity manifest is missing or invalid'));
    }
    try {
      const info = await lstat(this.scriptPath);
      if (!info.isFile() || info.isSymbolicLink()) return err(appError('INTERNAL_ERROR', 'Windows bridge script is not a trusted regular file'));
      const canonical = await realpath(this.scriptPath);
      if (process.platform === 'win32'
        ? canonical.toLowerCase() !== this.scriptPath.toLowerCase()
        : canonical !== this.scriptPath) {
        return err(appError('INTERNAL_ERROR', 'Windows bridge script path resolves through a link or reparse point'));
      }
      const digest = createHash('sha256').update(await readFile(this.scriptPath)).digest('hex');
      if (digest !== this.expectedScriptSha256) return err(appError('INTERNAL_ERROR', 'Windows bridge script integrity check failed'));
      return ok(undefined);
    } catch (error) {
      return err(appError('INTERNAL_ERROR', error instanceof Error ? error.message : 'Windows bridge integrity check failed'));
    }
  }
}

function parseBridgeResult(value: string): Result<unknown> | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(value.trim()) as unknown; } catch { return undefined; }
  if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') return undefined;
  if (parsed.ok) return ok(parsed.value);
  const error = parsed.error;
  if (!isRecord(error) || typeof error.code !== 'string' || typeof error.message !== 'string' || typeof error.recoverable !== 'boolean') return undefined;
  const code = APP_ERROR_CODES.find((candidate) => candidate === error.code) ?? 'INTERNAL_ERROR';
  return err(appError(code, error.message, error.recoverable));
}

function readTimeout(value: unknown): number {
  if (!isRecord(value) || typeof value.timeout_seconds !== 'number' || !Number.isFinite(value.timeout_seconds)) return DEFAULT_TIMEOUT_SECONDS;
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(0.1, value.timeout_seconds));
}

function powershellExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  return process.platform === 'win32' && systemRoot !== undefined
    ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
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
        // Keep the caller's activity lease alive until a later retry verifies the whole tree.
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
