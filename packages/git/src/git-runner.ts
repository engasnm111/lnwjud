import { spawn, type ChildProcess } from 'node:child_process';
import { createProcessTreeTerminator, type ProcessTreeTerminator } from '@lnwjud/process';

export interface GitRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitRunOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface GitRunner {
  run(args: readonly string[], cwd: string, options?: GitRunOptions): Promise<GitRunResult>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TERMINATION_RETRY_MS = 250;

export class DirectGitRunner implements GitRunner {
  public constructor(
    private readonly processTree: ProcessTreeTerminator = createProcessTreeTerminator(),
    private readonly terminationRetryMs = DEFAULT_TERMINATION_RETRY_MS,
  ) {}

  public run(args: readonly string[], cwd: string, options: GitRunOptions = {}): Promise<GitRunResult> {
    if (options.signal?.aborted === true) {
      return Promise.resolve({ exitCode: -1, stdout: '', stderr: 'Git command cancelled' });
    }
    const timeoutMs = clampTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn('git', [...args], {
          cwd,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          shell: false,
          detached: process.platform !== 'win32',
          windowsHide: true,
        });
      } catch (error: unknown) {
        resolve({ exitCode: -1, stdout: '', stderr: errorMessage(error) });
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      let terminationRequested = false;
      let terminationReason = '';
      let terminationFailureReported = false;
      const append = (current: string, chunk: Buffer): string => `${current}${chunk.toString('utf8')}`.slice(-MAX_CAPTURE_BYTES);
      const finish = (exitCode: number, extraStderr = ''): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        child.stdout?.removeListener('data', captureStdout);
        child.stderr?.removeListener('data', captureStderr);
        child.removeListener('error', handleError);
        child.removeListener('close', handleClose);
        resolve({ exitCode, stdout, stderr: extraStderr.length === 0 ? stderr : `${stderr}${extraStderr}` });
      };
      const terminate = (reason: string): void => {
        if (settled || terminationRequested) return;
        terminationRequested = true;
        terminationReason = reason;
        clearTimeout(timer);
        void (async (): Promise<void> => {
          while (!settled) {
            const pid = child.pid;
            if (pid !== undefined) {
              try {
                await this.processTree.stop(child, pid);
                finish(-1, reason);
                return;
              } catch (error: unknown) {
                if (!terminationFailureReported) {
                  terminationFailureReported = true;
                  stderr = append(stderr, Buffer.from(`\n${errorMessage(error)}`, 'utf8'));
                }
                if (!isChildLive(child)) await neverSettles();
              }
            }
            await delay(this.terminationRetryMs);
          }
        })();
      };
      const abort = (): void => terminate('Git command cancelled');
      const captureStdout = (chunk: Buffer): void => { stdout = append(stdout, chunk); };
      const captureStderr = (chunk: Buffer): void => { stderr = append(stderr, chunk); };
      const handleError = (error: Error): void => {
        stderr = `${stderr}${error.message}`;
        if (!terminationRequested) finish(-1);
        else if (child.pid === undefined) finish(-1, terminationReason);
      };
      const handleClose = (exitCode: number | null): void => {
        if (!terminationRequested) finish(exitCode ?? -1);
      };
      const timer = setTimeout(() => terminate('Git command timed out'), timeoutMs);
      child.stdout?.on('data', captureStdout);
      child.stderr?.on('data', captureStderr);
      child.on('error', handleError);
      child.on('close', handleClose);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted === true) abort();
    });
  }
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(100, Math.floor(value)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, milliseconds)));
}

function isChildLive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function neverSettles(): Promise<never> {
  return new Promise<never>(() => undefined);
}
