import type { ChildProcess } from 'node:child_process';
import type { ProcessTerminationOwnership, ProcessTreeTerminator } from './process-tree.js';

export interface PosixProcessTreeOptions {
  readonly signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly gracefulTimeoutMs?: number;
  readonly forceTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

/**
 * POSIX process-tree terminator.
 *
 * Group signalling is allowed only when the caller proves that lnwjud created
 * the exact group for this child (`processGroupId === pid`). Otherwise it fails
 * closed to the exact child PID and never guesses a negative PID target.
 */
export class PosixProcessTree implements ProcessTreeTerminator {
  private readonly signalProcess: (pid: number, signal: NodeJS.Signals | 0) => void;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly gracefulTimeoutMs: number;
  private readonly forceTimeoutMs: number;
  private readonly pollIntervalMs: number;

  public constructor(options: PosixProcessTreeOptions = {}) {
    this.signalProcess = options.signalProcess ?? ((pid, signal): void => { process.kill(pid, signal); });
    this.wait = options.wait ?? ((milliseconds): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    this.gracefulTimeoutMs = Math.max(0, options.gracefulTimeoutMs ?? 1_000);
    this.forceTimeoutMs = Math.max(0, options.forceTimeoutMs ?? 1_000);
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 25);
  }

  public async stop(child: ChildProcess, pid: number, ownership?: ProcessTerminationOwnership): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Process PID is invalid');
    const processGroupId = ownership?.processGroupId;
    const ownsProcessGroup = processGroupId !== undefined && processGroupId === pid;
    const targetPid = ownsProcessGroup ? -processGroupId : pid;

    if (!this.targetRunning(targetPid)) return;
    this.signal(targetPid, 'SIGTERM', child, ownsProcessGroup);
    if (await this.waitUntilStopped(targetPid, this.gracefulTimeoutMs)) return;

    this.signal(targetPid, 'SIGKILL', child, ownsProcessGroup);
    if (await this.waitUntilStopped(targetPid, this.forceTimeoutMs)) return;
    throw new Error('POSIX process termination could not be verified');
  }

  public isRunning(pid: number): boolean {
    return this.targetRunning(pid);
  }

  private signal(targetPid: number, signal: NodeJS.Signals, child: ChildProcess, group: boolean): void {
    try {
      this.signalProcess(targetPid, signal);
      return;
    } catch (error: unknown) {
      if (nodeErrorCode(error) === 'ESRCH') return;
      if (!group) {
        try {
          if (child.kill(signal)) return;
        } catch {
          // fall through to the original verification error
        }
      }
      throw error;
    }
  }

  private targetRunning(targetPid: number): boolean {
    try {
      this.signalProcess(targetPid, 0);
      return true;
    } catch (error: unknown) {
      return nodeErrorCode(error) === 'EPERM';
    }
  }

  private async waitUntilStopped(targetPid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.targetRunning(targetPid)) return true;

      await this.wait(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
    return !this.targetRunning(targetPid);
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
