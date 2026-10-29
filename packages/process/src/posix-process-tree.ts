import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProcessTreeTerminator } from './process-tree.js';
import { createPosixProcessIdentityProbe, type PosixProcessIdentityProbe } from './posix-process-identity.js';

const DEFAULT_TERM_GRACE_MS = 1_500;
const DEFAULT_KILL_GRACE_MS = 1_500;

export type PosixProcessGroupObservation =
  | { readonly state: 'empty' }
  | { readonly state: 'live'; readonly livePids: readonly number[]; readonly rootStartedAt?: string }
  | { readonly state: 'unknown'; readonly reason: string };

/** macOS process groups cannot prove termination of setsid/double-fork descendants. */
export function classifyPosixGroupCompletion(
  observation: PosixProcessGroupObservation, platform: NodeJS.Platform,
): PosixProcessGroupObservation {
  return platform === 'darwin' && observation.state === 'empty'
    ? { state: 'unknown', reason: 'darwin_escaped_descendants_not_contained' } : observation;
}

export type PosixProcessGroupInspector = (groupId: number, options?: {
  readonly platform?: NodeJS.Platform;
  readonly expectedRootStartedAt?: string;
}) => Promise<PosixProcessGroupObservation>;

const execFileAsync = promisify(execFile);

/** A process-group guarantee excludes children that deliberately create a new session/group. */
export const inspectPosixProcessGroup: PosixProcessGroupInspector = async (groupId, options = {}) => {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'darwin') return { state: 'unknown', reason: 'unsupported_platform' };
  if (!Number.isSafeInteger(groupId) || groupId <= 1 || groupId > 2_147_483_647) return { state: 'unknown', reason: 'invalid_group_identity' };
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-ax', '-o', 'pid=,pgid=,stat=,lstart='], {
      encoding: 'utf8', timeout: 1_750, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    return parsePosixProcessGroup(stdout, groupId, options.expectedRootStartedAt);
  } catch {
    return { state: 'unknown', reason: 'process_table_unavailable' };
  }
};

/** Invalid or partial process tables must never become zero-live proof. */
export function parsePosixProcessGroup(table: string, groupId: number, expectedRootStartedAt?: string): PosixProcessGroupObservation {
  const lines = table.trim().split(/\r?\n/);
  if (!table.trim()) return { state: 'unknown', reason: 'empty_process_table' };
  const livePids: number[] = [];
  const seen = new Set<number>();
  let rootStartedAt: string | undefined;
  for (const line of lines) {
    const row = /^\s*(\d+)\s+(\d+)\s+([A-Za-z<+NsXxLlEsWw-]+)\s+(.+?)\s*$/.exec(line);
    if (row === null) return { state: 'unknown', reason: 'malformed_process_table' };
    const pid = Number(row[1]);
    const pgid = Number(row[2]);
    const started = Date.parse(row[4]!);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(pgid) || pgid < 0 || !Number.isFinite(started) || seen.has(pid)) {
      return { state: 'unknown', reason: 'malformed_process_table' };
    }
    seen.add(pid);
    if (pid === groupId) {
      rootStartedAt = new Date(started).toISOString();
      if (pgid !== groupId || expectedRootStartedAt !== undefined && rootStartedAt !== expectedRootStartedAt) {
        return { state: 'unknown', reason: 'root_identity_changed' };
      }
    }
    if (pgid === groupId && !row[3]!.startsWith('Z')) livePids.push(pid);
  }
  return livePids.length === 0 ? { state: 'empty' } : {
    state: 'live', livePids, ...(rootStartedAt === undefined ? {} : { rootStartedAt }),
  };
}

export interface PosixProcessTreeOptions {
  readonly inspectGroup?: PosixProcessGroupInspector;
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
  private readonly inspectGroup: PosixProcessGroupInspector | undefined;
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
    this.inspectGroup = options.inspectGroup ?? (options.processGroupIsAlive === undefined ? inspectPosixProcessGroup : undefined);
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
    if (this.inspectGroup !== undefined) return this.stopObservedGroup(pid, child);
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

  public async stopPid(pid: number, expectedRootStartedAt?: string): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('POSIX process identity is invalid');
    if (this.inspectGroup !== undefined) return this.stopObservedGroup(pid, undefined, expectedRootStartedAt);
    const rootAlive = this.processIsAlive(pid);
    const groupAlive = this.processGroupIsAlive(pid);
    if (!rootAlive && !groupAlive) return;
    if (!rootAlive && groupAlive) throw new Error('POSIX process group remains live after its root exited; targeted termination refused');

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
    const waitForGone = async (timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      do {
        if (!this.processIsAlive(pid) && !this.processGroupIsAlive(pid)) return true;
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
      } while (Date.now() < deadline);
      return !this.processIsAlive(pid) && !this.processGroupIsAlive(pid);
    };

    const targetPid = groupAlive ? -pid : pid;
    await verifyIdentity();
    try {
      this.processKill(targetPid, 'SIGTERM');
    } catch (error: unknown) {
      if (!isNoSuchProcess(error)) throw new Error('POSIX process termination could not be started', { cause: error });
    }
    if (await waitForGone(this.termGraceMs)) return;
    await verifyIdentity();
    try {
      this.processKill(targetPid, 'SIGKILL');
    } catch (error: unknown) {
      if (!isNoSuchProcess(error)) throw new Error('POSIX process escalation could not be started', { cause: error });
    }
    if (await waitForGone(this.killGraceMs)) return;
    throw new Error('POSIX process termination could not be verified');
  }

  private async stopObservedGroup(pid: number, child?: ChildProcess, expectedStart?: string): Promise<void> {
    const inspect = this.inspectGroup!;
    const initial = classifyPosixGroupCompletion(await inspect(pid, { platform: this.platform, ...(expectedStart === undefined ? {} : { expectedRootStartedAt: expectedStart }) }), this.platform);
    if (initial.state === 'empty') return;
    if (initial.state !== 'live' || initial.rootStartedAt === undefined
      || child !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error('POSIX process group identity could not be verified; targeted termination refused');
    }
    const expectedRootStartedAt = initial.rootStartedAt;
    for (const [signal, grace] of [['SIGTERM', this.termGraceMs], ['SIGKILL', this.killGraceMs]] as const) {
      const before = classifyPosixGroupCompletion(await inspect(pid, { platform: this.platform, expectedRootStartedAt }), this.platform);
      if (before.state === 'empty') return;
      if (before.state !== 'live' || before.rootStartedAt !== expectedRootStartedAt) {
        throw new Error('POSIX process identity changed or root exited; targeted termination refused');
      }
      try { this.processKill(-pid, signal); }
      catch (error) { if (!isNoSuchProcess(error)) throw error; }
      const deadline = Date.now() + grace;
      do {
        if (classifyPosixGroupCompletion(await inspect(pid, { platform: this.platform, expectedRootStartedAt }), this.platform).state === 'empty') return;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
    }
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
