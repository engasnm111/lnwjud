import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SQLITE_LIFECYCLE_LOCK_FILENAME = 'sqlite-lifecycle.lock';

const LOCK_WAIT_INTERVAL_MS = 25;
const LOCK_WAIT_TIMEOUT_MS = 120_000;
const MAX_LOCK_AGE_MS = 30 * 60 * 1000;
const sleepCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export function withSqliteLifecycleLockSync<T>(directory: string, operation: () => T): T {
  mkdirSync(directory, { recursive: true });
  const lockPath = path.join(directory, SQLITE_LIFECYCLE_LOCK_FILENAME);
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  let descriptor: number | undefined;

  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, 'wx');
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
      if (reclaimStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for SQLite lifecycle lock: ${lockPath}`);
      Atomics.wait(sleepCell, 0, 0, LOCK_WAIT_INTERVAL_MS);
    }
  }

  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), 'utf8');
    return operation();
  } finally {
    closeSync(descriptor);
    rmSync(lockPath, { force: true });
  }
}

function reclaimStaleLock(lockPath: string): boolean {
  try {
    const info = statSync(lockPath);
    if (Date.now() - info.mtimeMs > MAX_LOCK_AGE_MS) {
      rmSync(lockPath, { force: true });
      return true;
    }

    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown };
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return false;
    if (processIsAlive(parsed.pid)) return false;
    rmSync(lockPath, { force: true });
    return true;
  } catch (error: unknown) {
    return isMissingFile(error);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !hasErrorCode(error, 'ESRCH');
  }
}

function isAlreadyExists(error: unknown): boolean {
  return hasErrorCode(error, 'EEXIST');
}

function isMissingFile(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
