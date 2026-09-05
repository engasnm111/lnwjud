import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { probeProcessStart, type ProcessProbeResult } from '@lnwjud/mcp-server';

const LOCK_FILE = 'lnwjud.tunnel.lock';
const LOCK_VERSION = 1;
const MUTEX_WAIT_MS = 5_000;
const ISO_UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface TunnelLockOwner {
  readonly pid: number;
  readonly processStartedAt: string;
  readonly acquiredAt: string;
}

export interface TunnelLockHandle {
  readonly owner: TunnelLockOwner;
  release(): Promise<boolean>;
}

export interface TunnelLockAcquisition extends TunnelLockHandle {
  readonly acquired: true;
}

export interface TunnelLockAlreadyOwned {
  readonly acquired: false;
  readonly owner: TunnelLockOwner;
}

export interface TunnelLockOptions {
  readonly profileDirectory: string;
  readonly owner?: TunnelLockOwner;
  readonly inspectProcess?: (pid: number) => Promise<ProcessProbeResult>;
  readonly hooks?: {
    readonly beforePublish?: (temporaryPath: string) => Promise<void>;
    readonly beforeStaleQuarantine?: () => Promise<void>;
    readonly afterStaleQuarantine?: () => Promise<void>;
    readonly beforeReleaseQuarantine?: () => Promise<void>;
  };
}

export async function acquireTunnelLock(options: TunnelLockOptions): Promise<TunnelLockAcquisition | TunnelLockAlreadyOwned> {
  const lockPath = tunnelLockPath(options.profileDirectory);
  const owner = options.owner ?? await currentProcessOwner();
  const inspectProcess = options.inspectProcess ?? probeProcessStart;
  if (!isValidOwner(owner)) throw new Error('Tunnel lock owner metadata is invalid');
  await mkdir(options.profileDirectory, { recursive: true });

  return withTunnelLockCriticalSection(options.profileDirectory, async () => {
    const existing = await readLockState(lockPath);
    if (existing.state === 'invalid') throw new Error(`Tunnel lock has invalid owner metadata: ${lockPath}`);
    if (existing.state === 'missing') {
      await publishOwner(lockPath, owner, options.hooks);
      return acquiredClaim(lockPath, owner, options.hooks);
    }

    const probe = await inspectProcess(existing.owner.pid);
    if (probe.state === 'unverifiable') throw new Error(`Tunnel lock owner liveness is unverifiable: ${probe.reason}`);
    if (probe.state === 'live' && probe.processStartedAt === existing.owner.processStartedAt) {
      return { acquired: false, owner: existing.owner };
    }

    await replaceVerifiedStaleOwner(lockPath, existing.owner, owner, options.hooks);
    return acquiredClaim(lockPath, owner, options.hooks);
  });
}

export async function readTunnelLock(profileDirectory: string): Promise<TunnelLockOwner | null> {
  const state = await readLockState(tunnelLockPath(profileDirectory));
  return state.state === 'valid' ? state.owner : null;
}

export function tunnelLockPath(profileDirectory: string): string {
  return path.join(profileDirectory, LOCK_FILE);
}

async function replaceVerifiedStaleOwner(lockPath: string, staleOwner: TunnelLockOwner, owner: TunnelLockOwner, hooks: TunnelLockOptions['hooks']): Promise<void> {
  const publishPath = await prepareOwnerRecord(lockPath, owner);
  const quarantinePath = `${lockPath}.stale.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  try {
    await hooks?.beforePublish?.(publishPath);
    await hooks?.beforeStaleQuarantine?.();
    await rename(lockPath, quarantinePath);
    const movedOwner = parseOwner(await readFile(quarantinePath, 'utf8'));
    if (!sameOwner(movedOwner, staleOwner)) {
      await restoreQuarantinedRecord(lockPath, quarantinePath);
      throw new Error(`Tunnel lock changed while stale recovery was in progress: ${lockPath}`);
    }
    await hooks?.afterStaleQuarantine?.();
    await link(publishPath, lockPath);
  } catch (error: unknown) {
    await rm(publishPath, { force: true }).catch(() => undefined);
    await restoreQuarantinedRecord(lockPath, quarantinePath);
    throw error;
  }
  // Once the fixed owner is visible, cleanup failure must not strand a lock
  // owned by a caller that was told acquisition failed.
  await rm(publishPath, { force: true }).catch(() => undefined);
  await rm(quarantinePath, { force: true }).catch(() => undefined);
}

async function publishOwner(lockPath: string, owner: TunnelLockOwner, hooks: TunnelLockOptions['hooks']): Promise<void> {
  const temporaryPath = await prepareOwnerRecord(lockPath, owner);
  try {
    await hooks?.beforePublish?.(temporaryPath);
    await link(temporaryPath, lockPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function prepareOwnerRecord(lockPath: string, owner: TunnelLockOwner): Promise<string> {
  const temporaryPath = `${lockPath}.publish.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const lock = await open(temporaryPath, 'wx');
  try {
    await lock.writeFile(serializeOwner(owner), 'utf8');
    await lock.sync();
  } finally {
    await lock.close();
  }
  return temporaryPath;
}

function acquiredClaim(lockPath: string, owner: TunnelLockOwner, hooks: TunnelLockOptions['hooks']): TunnelLockAcquisition {
  return {
    acquired: true,
    owner,
    release: async (): Promise<boolean> => withTunnelLockCriticalSection(path.dirname(lockPath), () => releaseTunnelLock(lockPath, owner, hooks)),
  };
}

async function releaseTunnelLock(lockPath: string, owner: TunnelLockOwner, hooks: TunnelLockOptions['hooks']): Promise<boolean> {
  const current = await readLockState(lockPath);
  if (current.state !== 'valid' || !sameOwner(current.owner, owner)) return false;
  const releasePath = `${lockPath}.released.${owner.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  try {
    await hooks?.beforeReleaseQuarantine?.();
    await rename(lockPath, releasePath);
    const moved = parseOwner(await readFile(releasePath, 'utf8'));
    if (!sameOwner(moved, owner)) {
      await restoreQuarantinedRecord(lockPath, releasePath);
      return false;
    }
    await rm(releasePath, { force: false });
    return true;
  } catch {
    await restoreQuarantinedRecord(lockPath, releasePath);
    return false;
  }
}

async function restoreQuarantinedRecord(lockPath: string, quarantinePath: string): Promise<void> {
  try {
    await link(quarantinePath, lockPath);
    await rm(quarantinePath, { force: false });
  } catch (error: unknown) {
    if (!isAlreadyExists(error) && !isNotFound(error)) throw error;
  }
}

type LockState = { readonly state: 'missing' } | { readonly state: 'invalid' } | { readonly state: 'valid'; readonly owner: TunnelLockOwner };

async function readLockState(lockPath: string): Promise<LockState> {
  try {
    const owner = parseOwner(await readFile(lockPath, 'utf8'));
    return owner === null ? { state: 'invalid' } : { state: 'valid', owner };
  } catch (error: unknown) {
    return isNotFound(error) ? { state: 'missing' } : { state: 'invalid' };
  }
}

function parseOwner(raw: string): TunnelLockOwner | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.version !== LOCK_VERSION || !Number.isInteger(record.pid) || typeof record.processStartedAt !== 'string' || typeof record.acquiredAt !== 'string') return null;
    if ((record.pid as number) <= 0 || (record.pid as number) > 2_147_483_647 || !isUtcMillisecondTimestamp(record.processStartedAt) || !isUtcMillisecondTimestamp(record.acquiredAt)) return null;
    return { pid: record.pid as number, processStartedAt: record.processStartedAt, acquiredAt: record.acquiredAt };
  } catch {
    return null;
  }
}

function isValidOwner(owner: TunnelLockOwner): boolean {
  return Number.isInteger(owner.pid)
    && owner.pid > 0
    && owner.pid <= 2_147_483_647
    && isUtcMillisecondTimestamp(owner.processStartedAt)
    && isUtcMillisecondTimestamp(owner.acquiredAt);
}

function isUtcMillisecondTimestamp(value: string): boolean {
  if (!ISO_UTC_MILLISECONDS.test(value) || value.startsWith('0000-')) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function serializeOwner(owner: TunnelLockOwner): string {
  return JSON.stringify({ version: LOCK_VERSION, pid: owner.pid, processStartedAt: owner.processStartedAt, acquiredAt: owner.acquiredAt });
}

function sameOwner(left: TunnelLockOwner | null, right: TunnelLockOwner): boolean {
  return left !== null
    && left.pid === right.pid
    && left.processStartedAt === right.processStartedAt
    && left.acquiredAt === right.acquiredAt;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function currentProcessOwner(): Promise<TunnelLockOwner> {
  const probe = await probeProcessStart(process.pid);
  if (probe.state !== 'live') throw new Error(`Could not verify this process for the tunnel lock: ${probe.state === 'unverifiable' ? probe.reason : 'gone'}`);
  return { pid: process.pid, processStartedAt: probe.processStartedAt, acquiredAt: new Date().toISOString() };
}

async function withTunnelLockCriticalSection<T>(profileDirectory: string, action: () => Promise<T>): Promise<T> {
  const mutexName = tunnelLockMutexName(profileDirectory);
  const script = [
    "$ErrorActionPreference='Stop'",
    `$mutex=[Threading.Mutex]::new($false,'${mutexName}')`,
    '$held=$false',
    'try {',
    `  try { $held=$mutex.WaitOne(${MUTEX_WAIT_MS}) } catch [Threading.AbandonedMutexException] { $held=$true }`,
    "  if(-not $held){ throw 'Timed out waiting for the lnwjud tunnel lock critical section' }",
    "  [Console]::Out.WriteLine('READY')",
    '  [Console]::Out.Flush()',
    '  [void][Console]::In.ReadToEnd()',
    '} finally {',
    '  if($held){ $mutex.ReleaseMutex() }',
    '  $mutex.Dispose()',
    '}',
  ].join('; ');
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  holder.stderr.setEncoding('utf8');
  holder.stderr.on('data', (chunk: string) => { stderr += chunk; });
  try {
    await waitForMutexReady(holder, () => stderr);
  } catch (error: unknown) {
    holder.stdin.end();
    if (holder.exitCode === null) holder.kill();
    await waitForMutexExit(holder, () => stderr).catch(() => undefined);
    throw error;
  }
  let actionFailed = false;
  let actionError: unknown;
  let actionResult!: T;
  try {
    actionResult = await action();
  } catch (error: unknown) {
    actionFailed = true;
    actionError = error;
  }
  holder.stdin.end();
  let cleanupError: unknown = null;
  try {
    await waitForMutexExit(holder, () => stderr);
  } catch (error: unknown) {
    cleanupError = error;
    if (holder.exitCode === null) {
      holder.kill();
      await waitForMutexExit(holder, () => stderr).catch(() => undefined);
    }
  }
  if (actionFailed) throw actionError;
  if (cleanupError !== null) {
    // The authoritative action already completed while the mutex was held.
    // Do not misreport that mutation as failed because only helper cleanup failed.
    console.warn('Tunnel lock mutex cleanup failed after the authoritative action completed');
  }
  return actionResult;
}

function tunnelLockMutexName(profileDirectory: string): string {
  const normalized = path.resolve(profileDirectory).replace(/[\\/]+$/, '').toLowerCase();
  const identity = createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 24);
  return `Local\\lnwjud-tunnel-lock-${identity}`;
}

function waitForMutexReady(holder: ReturnType<typeof spawn>, stderr: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (holder.stdout === null) { reject(new Error('Tunnel lock mutex helper stdout is unavailable')); return; }
    const stdoutStream = holder.stdout;
    let stdout = '';
    const timer = setTimeout(() => finish(new Error('Timed out waiting for the lnwjud tunnel lock critical section')), MUTEX_WAIT_MS + 2_000);
    const onData = (chunk: string): void => {
      stdout += chunk;
      if (/(?:^|\r?\n)READY(?:\r?\n|$)/.test(stdout)) finish();
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null): void => finish(new Error(stderr() || `Tunnel lock mutex helper exited ${code ?? 'unknown'} before acquisition`));
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      stdoutStream.off('data', onData);
      holder.off('error', onError);
      holder.off('exit', onExit);
      if (error === undefined) resolve(); else reject(error);
    };
    stdoutStream.setEncoding('utf8');
    stdoutStream.on('data', onData);
    holder.once('error', onError);
    holder.once('exit', onExit);
  });
}

function waitForMutexExit(holder: ReturnType<typeof spawn>, stderr: () => string): Promise<void> {
  if (holder.exitCode !== null) return holder.exitCode === 0 ? Promise.resolve() : Promise.reject(new Error(stderr() || `Tunnel lock mutex helper exited ${holder.exitCode}`));
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null): void => {
      finish(code === 0 ? undefined : new Error(stderr() || `Tunnel lock mutex helper exited ${code ?? 'unknown'}`));
    };
    const onError = (error: Error): void => finish(error);
    const timer = setTimeout(() => finish(new Error('Tunnel lock mutex helper did not exit')), 3_000);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      holder.off('exit', onExit);
      holder.off('error', onError);
      if (error === undefined) resolve(); else reject(error);
    };
    holder.once('exit', onExit);
    holder.once('error', onError);
  });
}
