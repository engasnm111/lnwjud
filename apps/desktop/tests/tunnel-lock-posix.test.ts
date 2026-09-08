import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireTunnelLock, readTunnelLock, type TunnelLockOwner } from '../src/main/tunnel-lock.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function owner(pid: number, processStartedAt: string): TunnelLockOwner {
  return { pid, processStartedAt, acquiredAt: '2026-08-20T00:00:00.000Z' };
}

describe('POSIX tunnel ownership lock', () => {
  it('serializes Darwin/Linux lock publication and removes the mutex after release', async () => {
    const directory = await temporaryDirectory();
    const firstOwner = owner(1401, '2026-08-20T00:00:00.000Z');
    const secondOwner = owner(1402, '2026-08-20T00:01:00.000Z');
    const publishEntered = deferred<void>();
    const allowPublish = deferred<void>();

    const firstAttempt = acquireTunnelLock({
      profileDirectory: directory,
      platform: 'darwin',
      owner: firstOwner,
      inspectProcess: async () => ({ state: 'gone' }),
      hooks: {
        beforePublish: async () => {
          publishEntered.resolve();
          await allowPublish.promise;
        },
      },
    });
    await expect(publishEntered.promise).resolves.toBeUndefined();
    await expect(access(path.join(directory, 'lnwjud.tunnel.lock'))).rejects.toThrow();

    let secondSettled = false;
    const secondAttempt = acquireTunnelLock({
      profileDirectory: directory,
      platform: 'linux',
      owner: secondOwner,
      inspectProcess: async () => ({ state: 'live', processStartedAt: firstOwner.processStartedAt }),
    }).finally(() => { secondSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondSettled).toBe(false);

    allowPublish.resolve();
    const [first, second] = await Promise.all([firstAttempt, secondAttempt]);
    expect(first.acquired).toBe(true);
    expect(second).toEqual({ acquired: false, owner: firstOwner });
    expect(await readTunnelLock(directory)).toEqual(firstOwner);

    if (first.acquired) await expect(first.release()).resolves.toBe(true);
    await expect(access(path.join(directory, 'lnwjud.tunnel.lock'))).rejects.toThrow();
    await expect(access(path.join(directory, 'lnwjud.tunnel.mutex'))).rejects.toThrow();
    expect((await readdir(directory)).filter((name) => name.includes('.publish.') || name.includes('.released.'))).toEqual([]);
  });

  it('reclaims a stale POSIX critical-section mutex only after identity verification', async () => {
    const directory = await temporaryDirectory();
    const stale = owner(1501, '2026-08-20T00:00:00.000Z');
    await writeFile(
      path.join(directory, 'lnwjud.tunnel.mutex'),
      JSON.stringify({ version: 1, pid: stale.pid, processStartedAt: stale.processStartedAt }),
      'utf8',
    );

    const next = await acquireTunnelLock({
      profileDirectory: directory,
      platform: 'linux',
      owner: owner(1502, '2026-08-20T00:02:00.000Z'),
      inspectProcess: async (pid) => pid === stale.pid
        ? { state: 'gone' }
        : { state: 'live', processStartedAt: '2026-08-20T00:02:00.000Z' },
    });

    expect(next.acquired).toBe(true);
    expect(await readTunnelLock(directory)).toEqual(next.owner);
    if (next.acquired) await expect(next.release()).resolves.toBe(true);
    await expect(readFile(path.join(directory, 'lnwjud.tunnel.mutex'), 'utf8')).rejects.toThrow();
  });

  it('fails closed when a POSIX mutex owner cannot be verified', async () => {
    const directory = await temporaryDirectory();
    const stale = owner(1601, '2026-08-20T00:00:00.000Z');
    await writeFile(
      path.join(directory, 'lnwjud.tunnel.mutex'),
      JSON.stringify({ version: 1, pid: stale.pid, processStartedAt: stale.processStartedAt }),
      'utf8',
    );

    await expect(acquireTunnelLock({
      profileDirectory: directory,
      platform: 'darwin',
      owner: owner(1602, '2026-08-20T00:02:00.000Z'),
      inspectProcess: async () => ({ state: 'unverifiable', reason: 'probe_timeout' }),
    })).rejects.toThrow('critical section owner is unverifiable: probe_timeout');
    await expect(readFile(path.join(directory, 'lnwjud.tunnel.mutex'), 'utf8')).resolves.toContain(String(stale.pid));
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-lock-posix-'));
  temporaryRoots.push(directory);
  return directory;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}
