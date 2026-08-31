import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireTunnelLock, readTunnelLock, type TunnelLockOwner } from '../src/main/tunnel-lock.js';

const POSIX_MUTEX_FILE = '.lnwjud.tunnel.lock.mutex';
const POSIX_MUTEX_STALE_MS = 30_000;

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function owner(pid: number, processStartedAt: string): TunnelLockOwner {
  return { pid, processStartedAt, acquiredAt: '2026-08-20T00:00:00.000Z' };
}

async function seedMutexFile(directory: string, ageMs: number): Promise<void> {
  const mutexPath = path.join(directory, POSIX_MUTEX_FILE);
  await writeFile(mutexPath, '', 'utf8');
  const stale = new Date(Date.now() - ageMs);
  await utimes(mutexPath, stale, stale);
}

describe.runIf(process.platform !== 'win32')('lnwjud tunnel ownership lock (POSIX file mutex)', () => {
  it('serialises concurrent acquisitions through the file mutex', async () => {
    const directory = await temporaryDirectory();
    const firstOwner = owner(101, '2026-08-20T00:00:00.000Z');
    const secondOwner = owner(202, '2026-08-20T00:01:00.000Z');
    const events: string[] = [];
    const publishEntered = deferred<void>();
    const allowPublish = deferred<void>();
    const firstAttempt = acquireTunnelLock({
      profileDirectory: directory,
      owner: firstOwner,
      inspectProcess: async (pid) => (pid === firstOwner.pid
        ? { state: 'live', processStartedAt: firstOwner.processStartedAt }
        : { state: 'gone' }),
      hooks: {
        beforePublish: async () => {
          events.push('first-enter');
          publishEntered.resolve();
          await allowPublish.promise;
          events.push('first-exit');
        },
      },
    });
    await expect(Promise.race([publishEntered.promise, rejectAfter(2_000, 'beforePublish hook was not called')])).resolves.toBeUndefined();

    const secondPending = acquireTunnelLock({
      profileDirectory: directory,
      owner: secondOwner,
      inspectProcess: async (pid) => (pid === firstOwner.pid
        ? { state: 'live', processStartedAt: firstOwner.processStartedAt }
        : { state: 'gone' }),
      hooks: {
        beforePublish: async () => {
          events.push('second-enter');
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(events).toEqual(['first-enter']);

    allowPublish.resolve();
    const [first, second] = await Promise.all([firstAttempt, secondPending]);

    // The second starter observed the first owner live and returned acquired:
    // false without publishing — its beforePublish hook is a tripwire that
    // must never fire, so exact equality proves both exclusion and no re-publish.
    expect(events).toEqual(['first-enter', 'first-exit']);
    expect(first.acquired).toBe(true);
    expect(second).toEqual({ acquired: false, owner: firstOwner });
  });

  it('takes over a stale mutex file left by a crashed holder instead of timing out', async () => {
    const directory = await temporaryDirectory();
    await seedMutexFile(directory, POSIX_MUTEX_STALE_MS + 1_000);
    const firstOwner = owner(111, '2026-08-20T00:00:00.000Z');

    const startedAt = Date.now();
    const acquired = await acquireTunnelLock({
      profileDirectory: directory,
      owner: firstOwner,
      inspectProcess: async () => ({ state: 'gone' }),
    });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(acquired.acquired).toBe(true);
    await expect(readTunnelLock(directory)).resolves.toMatchObject({ pid: firstOwner.pid });
    if (acquired.acquired) await acquired.release();
    await expect(stat(path.join(directory, POSIX_MUTEX_FILE))).rejects.toThrow();
  });

  it('lets exactly one of two simultaneous waiters take over a stale mutex', async () => {
    const directory = await temporaryDirectory();
    await seedMutexFile(directory, POSIX_MUTEX_STALE_MS + 1_000);
    const firstOwner = owner(301, '2026-08-20T00:00:00.000Z');
    const secondOwner = owner(302, '2026-08-20T00:01:00.000Z');
    const events: string[] = [];
    const publishEntered = deferred<void>();
    const allowPublish = deferred<void>();
    const firstAttempt = acquireTunnelLock({
      profileDirectory: directory,
      owner: firstOwner,
      inspectProcess: async () => ({ state: 'gone' }),
      hooks: {
        beforePublish: async () => {
          events.push('first-enter');
          publishEntered.resolve();
          await allowPublish.promise;
        },
      },
    });
    await expect(Promise.race([publishEntered.promise, rejectAfter(2_000, 'stale takeover did not happen')])).resolves.toBeUndefined();

    const secondPending = acquireTunnelLock({
      profileDirectory: directory,
      owner: secondOwner,
      inspectProcess: async (pid) => (pid === firstOwner.pid
        ? { state: 'live', processStartedAt: firstOwner.processStartedAt }
        : { state: 'gone' }),
      hooks: {
        beforePublish: async () => {
          events.push('second-enter');
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(events).toEqual(['first-enter']);

    allowPublish.resolve();
    const [first, second] = await Promise.all([firstAttempt, secondPending]);

    expect(first.acquired).toBe(true);
    expect(second).toEqual({ acquired: false, owner: firstOwner });
  });

  it('times out when a young mutex file is never released', async () => {
    const directory = await temporaryDirectory();
    await seedMutexFile(directory, 1_000);
    const firstOwner = owner(401, '2026-08-20T00:00:00.000Z');

    await expect(acquireTunnelLock({
      profileDirectory: directory,
      owner: firstOwner,
      inspectProcess: async () => ({ state: 'gone' }),
    })).rejects.toThrow('Timed out waiting for the lnwjud tunnel lock critical section');
  }, 10_000);
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-lock-posix-'));
  temporaryRoots.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

function rejectAfter(timeoutMs: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs));
}
