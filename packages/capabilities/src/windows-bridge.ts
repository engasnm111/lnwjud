import { spawn } from 'node:child_process';
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
}

const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 14_400;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
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

  public constructor(options: PowerShellWindowsBridgeOptions) {
    this.scriptPath = path.resolve(options.scriptPath);
    this.powershellPath = options.powershellPath ?? powershellExecutable();
    this.platform = options.platform ?? process.platform;
    this.maxOutputBytes = Math.max(1, Math.min(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES));
    this.terminator = options.terminator ?? new WindowsProcessTree();
  }

  public execute(request: { readonly capability: WindowsCapabilityName; readonly input: unknown }): Promise<Result<unknown>> {
    if (this.platform !== 'win32') return Promise.resolve(err(appError('INTERNAL_ERROR', 'Windows bridge is unavailable on this platform', true)));
    if (!path.isAbsolute(this.scriptPath)) return Promise.resolve(err(appError('INVALID_INPUT', 'Windows bridge script path must be absolute')));
    let serialized: string;
    try {
      serialized = JSON.stringify(request);
    } catch {
      return Promise.resolve(err(appError('INVALID_INPUT', 'Windows bridge input could not be serialized')));
    }

    return new Promise((resolve) => {
      let stdout = '';
      let timedOut = false;
      let settled = false;
      const child = spawn(this.powershellPath, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath], {
        shell: false,
        windowsHide: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const timeoutSeconds = readTimeout(request.input);
      const timer = setTimeout(() => {
        timedOut = true;
        const pid = child.pid;
        if (pid === undefined) child.kill();
        else void this.terminator.stop(child, pid);
      }, timeoutSeconds * 1000);
      const append = (current: string, value: Buffer | string): string => {
        const chunk = Buffer.isBuffer(value) ? value.toString('utf8') : value;
        const remaining = this.maxOutputBytes - Buffer.byteLength(current, 'utf8');
        return remaining <= 0 ? current : current + chunk.slice(0, remaining);
      };
      child.stdout?.on('data', (chunk: Buffer | string) => { stdout = append(stdout, chunk); });
      child.stderr?.resume();
      child.once('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(err(appError('INTERNAL_ERROR', 'Windows bridge process could not start', true)));
      });
      child.once('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (timedOut) {
          resolve(err(appError('PROCESS_TIMEOUT', 'Windows bridge timed out', true)));
          return;
        }
        const result = parseBridgeResult(stdout);
        if (result !== undefined) {
          resolve(result);
          return;
        }
        resolve(err(appError('INTERNAL_ERROR', 'Windows bridge returned an invalid response', true)));
      });
      child.stdin?.end(serialized, 'utf8');
    });
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
  return process.platform === 'win32' && process.env.SystemRoot !== undefined
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
