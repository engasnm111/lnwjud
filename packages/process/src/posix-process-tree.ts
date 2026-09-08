import type { ChildProcess } from 'node:child_process';
import type { ProcessTreeTerminator } from './process-tree.js';
import { createPosixProcessIdentityProbe, type PosixProcessIdentityProbe } from './posix-process-identity.js';

const DEFAULT_TERM_GRACE_MS = 1_500;
const DEFAULT_KILL_GRACE_MS = 1_500;

export interface PosixProcessTreeOptions {
  readonly platform?: NodeJS.Platform;
  readonly processKill?: (pid: number, signal: NodeJS.Signals | number) => void;
  readonly processIsAlive?: (pid: number) => boolean;
  /** Probe the detached process group separately from its root PID. */
  readonly processGroupIsAlive?: (pid: number) => boolean;
  /** Probe the process start identity immediately before each signal. */
  readonly processStartedAt?: PosixProcessIdentityProbe;
  readonly waitForExit?: (child: ChildProcess, timeoutMs: number) => Promise<boolean>;
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
}

/**
 * Terminates a process group created with `detached: true` on macOS/Linux.
 *
 * The group id is the root pid.  We never fall back to a name or a naked
 * `kill(pid)` for a live process: if the group cannot be addressed or does
 * not disappear after SIGTERM/SIGKILL, the caller receives an error and keeps
 * its durable state as `termination_unverified`.
 */
export class PosixProcessTree implements ProcessTreeTerminator {
  private readonly platform: NodeJS.Platform;
  private readonly processKill: (pid: number, signal: NodeJS.Signals | number) => void;
  private readonly processIsAlive: (pid: number) => boolean;
  private readonly processGroupIsAlive: (pid: number) => boolean;
  private readonly processStartedAt: PosixProcessIdentityProbe;
  private readonly waitForExit: (child: ChildProcess, timeoutMs: number) => Promise<boolean>;
  private readonly termGraceMs: number;
  private readonly killGraceMs: number;

  public constructor(options: PosixProcessTreeOptions = {}) {
    this.platform = options.platform ?? process.platform;
    if (this.platform === 'win32') throw new Error('PosixProcessTree cannot run on Windows');
    this.processKill = options.processKill ?? ((pid, signal): void => { process.kill(pid, signal); });
    this.processIsAlive = options.processIsAlive ?? isProcessAlive;
    this.processGroupIsAlive = options.processGroupIsAlive ?? isProcessGroupAlive;
    this.processStartedAt = options.processStartedAt ?? createPosixProcessIdentityProbe(this.platform);
    this.waitForExit = options.waitForExit ?? waitForChildExit;
    this.termGraceMs = boundedDelay(options.termGraceMs ?? DEFAULT_TERM_GRACE_MS);
    this.killGraceMs = boundedDelay(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
  }

  public async stop(child: ChildProcess, pid: number): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('POSIX process identity is invalid');
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Process root exited before group termination could be verified');
    }
    const rootAlive = this.processIsAlive(pid);
    const groupAlive = this.processGroupIsAlive(pid);
    if (!rootAlive && !groupAlive) return;
    if (!rootAlive && groupAlive) throw new Error('POSIX process group remains live after its root exited; targeted termination refused');
    if (!groupAlive) throw new Error('POSIX process group could not be verified; targeted termination refused');

    // A PID can be reused while a child record is still in memory.  Capture
    // the start identity before the first signal and check it again before
    // escalation.  If the probe is unavailable or changes, do not signal.
    const expectedStartedAt = await this.processStartedAt(pid);
    if (expectedStartedAt === null) {
      if (!this.processIsAlive(pid) && !this.processGroupIsAlive(pid)) return;
      throw new Error('POSIX process start identity could not be verified');
    }
    const verifyIdentity = async (): Promise<boolean> => {
      const currentStartedAt = await this.processStartedAt(pid);
      if (currentStartedAt === null) return !this.processIsAlive(pid) && !this.processGroupIsAlive(pid);
      if (currentStartedAt !== expectedStartedAt) throw new Error('POSIX process identity changed; targeted termination refused');
      return true;
    };

    // A detached child has its own process group whose id equals the root pid.
    // Refuse to target a reused/non-group pid rather than killing an unrelated
    // process.  ESRCH means the group disappeared between the probe and signal.
    await verifyIdentity();
    try {
      this.processKill(-pid, 'SIGTERM');
    } catch (error: unknown) {
      if (!isNoSuchProcess(error)) throw new Error('POSIX process-group termination could not be started', { cause: error });
    }
    if (await this.waitForExit(child, this.termGraceMs) && !this.processIsAlive(pid) && !this.processGroupIsAlive(pid)) return;

    await verifyIdentity();
    try {
      this.processKill(-pid, 'SIGKILL');
    } catch (error: unknown) {
      if (!isNoSuchProcess(error)) throw new Error('POSIX process-group escalation could not be started', { cause: error });
    }
    if (await this.waitForExit(child, this.killGraceMs) && !this.processIsAlive(pid) && !this.processGroupIsAlive(pid)) return;
    if (!this.processIsAlive(pid) && !this.processGroupIsAlive(pid)) return;
    throw new Error('POSIX process-group termination could not be verified');
  }
}

function boundedDelay(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(10_000, Math.floor(value))) : DEFAULT_TERM_GRACE_MS;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('close', onExit);
      resolve(value);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    child.once('close', onExit);
  });
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}
