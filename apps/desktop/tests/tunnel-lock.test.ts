import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
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

describe('lnwjud tunnel ownership lock', () => {
  it('reports the current owner to a simultaneous second starter', async () => {
    const directory = await temporaryDirectory();
    const firstOwner = owner(101, '2026-08-20T00:00:00.000Z');
    const [first, second] = await Promise.all([
      acquireTunnelLock({ profileDirectory: directory, owner: firstOwner, inspectProcess: async (pid) => ({ state: 'live', processStartedAt: pid === firstOwner.pid ? firstOwner.processStartedAt : '2026-08-20T00:01:00.000Z' }) }),
      acquireTunnelLock({ profileDirectory: directory, owner: owner(202, '2026-08-20T00:01:00.000Z'), inspectProcess: async (pid) => ({ state: 'live', processStartedAt: pid === 101 ? firstOwner.processStartedAt : '2026-08-20T00:01:00.000Z' }) }),
    ]);

    const acquired = first.acquired ? first : second;
    const rejected = first.acquired ? second : first;
    expect(acquired.acquired).toBe(true);
    expect(rejected).toEqual({ acquired: false, owner: acquired.owner });
    if (acquired.acquired) await acquired.release();
  });

  it('publishes no partial fixed record and gives a delayed writer no second ownership', async () => {
    const directory = await temporaryDirectory();
    const firstOwner = owner(111, '2026-08-20T00:00:00.000Z');
    const secondOwner = owner(222, '2026-08-20T00:01:00.000Z');
    const publishEntered = deferred<void>();
    const allowPublish = deferred<void>();
    const firstAttempt = acquireTunnelLock({
      profileDirectory: directory,
      owner: firstOwner,
      inspectProcess: async (pid) => pid === secondOwner.pid ? { state: 'live', processStartedAt: secondOwner.processStartedAt } : { state: 'gone' },
      hooks: {
        beforePublish: async () => {
          publishEntered.resolve();
          await allowPublish.promise;
        },
      },
    });
    await expect(Promise.race([publishEntered.promise, rejectAfter(2_000, 'beforePublish hook was not called')])).resolves.toBeUndefined();
    await expect(access(path.join(directory, 'lnwjud.tunnel.lock'))).rejects.toThrow();

    let secondSettled = false;
    const secondPending = acquireTunnelLock({ profileDirectory: directory, owner: secondOwner, inspectProcess: async () => ({ state: 'live', processStartedAt: firstOwner.processStartedAt }) }).finally(() => { secondSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secondSettled).toBe(false);
    allowPublish.resolve();
    const [first, second] = await Promise.all([firstAttempt, secondPending]);

    expect(first.acquired).toBe(true);
    expect(second).toEqual({ acquired: false, owner: firstOwner });
    expect(await readTunnelLock(directory)).toEqual(firstOwner);
    expect((await readdir(directory)).filter((name) => name.includes('.publish.'))).toEqual([]);
    if (first.acquired) await first.release();
  });

  it('reclaims a lock only after the recorded owner is gone or has a mismatched start time', async () => {
    const directory = await temporaryDirectory();
    const staleOwner = owner(303, '2026-08-20T00:00:00.000Z');
    await writeFile(path.join(directory, 'lnwjud.tunnel.lock'), JSON.stringify({ version: 1, ...staleOwner }), 'utf8');

    const claim = await acquireTunnelLock({
      profileDirectory: directory,
      owner: owner(404, '2026-08-20T00:02:00.000Z'),
      inspectProcess: async (pid) => ({ state: 'live', processStartedAt: pid === 303 ? '2026-08-20T00:03:00.000Z' : '2026-08-20T00:02:00.000Z' }),
    });

    expect(claim.acquired).toBe(true);
    expect(await readTunnelLock(directory)).toEqual(owner(404, '2026-08-20T00:02:00.000Z'));
    await claim.release();
  });

  it('reclaims a lock when the recorded owner process is gone', async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, 'lnwjud.tunnel.lock'), JSON.stringify({ version: 1, ...owner(707, '2026-08-20T00:00:00.000Z') }), 'utf8');

    const claim = await acquireTunnelLock({
      profileDirectory: directory,
      owner: owner(808, '2026-08-20T00:05:00.000Z'),
      inspectProcess: async (pid) => pid === 707 ? { state: 'gone' } : { state: 'live', processStartedAt: '2026-08-20T00:05:00.000Z' },
    });

    expect(claim.acquired).toBe(true);
    if (claim.acquired) await claim.release();
  });

  it('keeps the newly published owner acquired when stale quarantine cleanup is obstructed', async () => {
    const directory = await temporaryDirectory();
    const staleOwner = owner(717, '2026-08-20T00:00:00.000Z');
    const nextOwner = owner(818, '2026-08-20T00:05:00.000Z');
    await writeFile(path.join(directory, 'lnwjud.tunnel.lock'), JSON.stringify({ version: 1, ...staleOwner }), 'utf8');

    const claim = await acquireTunnelLock({
      profileDirectory: directory,
      owner: nextOwner,
      inspectProcess: async () => ({ state: 'gone' }),
      hooks: {
        afterStaleQuarantine: async () => {
          const quarantine = (await readdir(directory)).find((name) => name.includes('.stale.'));
          if (quarantine === undefined) throw new Error('stale quarantine fixture was not published');
          const quarantinePath = path.join(directory, quarantine);
          await rm(quarantinePath);
          await mkdir(quarantinePath);
          await writeFile(path.join(quarantinePath, 'obstruction'), 'fixture', 'utf8');
        },
      },
    });

    expect(claim.acquired).toBe(true);
    expect(await readTunnelLock(directory)).toEqual(nextOwner);
    if (claim.acquired) await expect(claim.release()).resolves.toBe(true);
  });

  it('only releases a lock that still belongs to its owner', async () => {
    const directory = await temporaryDirectory();
    const firstOwner = owner(505, '2026-08-20T00:00:00.000Z');
    const claim = await acquireTunnelLock({ profileDirectory: directory, owner: firstOwner, inspectProcess: async () => ({ state: 'live', processStartedAt: firstOwner.processStartedAt }) });
    const replacement = owner(606, '2026-08-20T00:04:00.000Z');
    await writeFile(path.join(directory, 'lnwjud.tunnel.lock'), JSON.stringify({ version: 1, ...replacement }), 'utf8');

    await expect(claim.release()).resolves.toBe(false);
    expect(await readTunnelLock(directory)).toEqual(replacement);
  });

  it('restores a replacement moved by an owner-release race instead of deleting it', async () => {
    const directory = await temporaryDirectory();
    const firstOwner = owner(515, '2026-08-20T00:00:00.000Z');
    const replacement = owner(616, '2026-08-20T00:04:00.000Z');
    const releaseEntered = deferred<void>();
    const allowRelease = deferred<void>();
    const claim = await acquireTunnelLock({
      profileDirectory: directory,
      owner: firstOwner,
      inspectProcess: async () => ({ state: 'live', processStartedAt: firstOwner.processStartedAt }),
      hooks: {
        beforeReleaseQuarantine: async () => {
          releaseEntered.resolve();
          await allowRelease.promise;
        },
      },
    });
    expect(claim.acquired).toBe(true);
    if (!claim.acquired) return;

    const releasing = claim.release();
    await expect(Promise.race([releaseEntered.promise, rejectAfter(2_000, 'release quarantine hook was not called')])).resolves.toBeUndefined();
    await rename(path.join(directory, 'lnwjud.tunnel.lock'), path.join(directory, 'original-owner-record'));
    await writeFile(path.join(directory, 'lnwjud.tunnel.lock'), JSON.stringify({ version: 1, ...replacement }), 'utf8');
    allowRelease.resolve();

    await expect(releasing).resolves.toBe(false);
    expect(await readTunnelLock(directory)).toEqual(replacement);
    const validQuarantines = await Promise.all((await readdir(directory))
      .filter((name) => name.includes('.released.'))
      .map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8')) as unknown));
    expect(validQuarantines).toEqual([]);
  });

  it('never guesses ownership from an invalid fixed lock record', async () => {
    const directory = await temporaryDirectory();
    const lockPath = path.join(directory, 'lnwjud.tunnel.lock');
    await writeFile(lockPath, '', 'utf8');
    await expect(acquireTunnelLock({ profileDirectory: directory, owner: owner(909, '2026-08-20T00:00:00.000Z') })).rejects.toThrow('invalid owner metadata');
    expect(await readFile(lockPath, 'utf8')).toBe('');
    expect((await readdir(directory)).filter((name) => name.includes('.publish.'))).toEqual([]);
  });

  it.each(['access_denied', 'probe_timeout'])('fails closed and preserves ownership when owner liveness is unverifiable: %s', async (reason) => {
    const directory = await temporaryDirectory();
    const existing = owner(929, '2026-08-20T00:00:00.000Z');
    const lockPath = path.join(directory, 'lnwjud.tunnel.lock');
    await writeFile(lockPath, JSON.stringify({ version: 1, ...existing }), 'utf8');

    await expect(acquireTunnelLock({
      profileDirectory: directory,
      owner: owner(939, '2026-08-20T00:01:00.000Z'),
      inspectProcess: async () => ({ state: 'unverifiable', reason }),
    })).rejects.toThrow(`Tunnel lock owner liveness is unverifiable: ${reason}`);
    expect(await readTunnelLock(directory)).toEqual(existing);
  });

  it('serializes stale replacement so two reclaimers and a third publisher cannot fill the fixed-path gap', async () => {
    const directory = await temporaryDirectory();
    const stale = owner(941, '2026-08-20T00:00:00.000Z');
    await writeFile(path.join(directory, 'lnwjud.tunnel.lock'), JSON.stringify({ version: 1, ...stale }), 'utf8');
    const quarantined = deferred<void>();
    const allowPublish = deferred<void>();
    const firstOwner = owner(942, '2026-08-20T00:01:00.000Z');
    const first = acquireTunnelLock({
      profileDirectory: directory,
      owner: firstOwner,
      inspectProcess: async (pid) => pid === stale.pid ? { state: 'gone' } : { state: 'live', processStartedAt: firstOwner.processStartedAt },
      hooks: { afterStaleQuarantine: async () => { quarantined.resolve(); await allowPublish.promise; } },
    });
    await expect(Promise.race([quarantined.promise, rejectAfter(2_000, 'stale quarantine hook was not called')])).resolves.toBeUndefined();

    let secondSettled = false;
    let thirdSettled = false;
    const second = acquireTunnelLock({ profileDirectory: directory, owner: owner(943, '2026-08-20T00:02:00.000Z'), inspectProcess: async (pid) => pid === firstOwner.pid ? { state: 'live', processStartedAt: firstOwner.processStartedAt } : { state: 'gone' } }).finally(() => { secondSettled = true; });
    const third = acquireTunnelLock({ profileDirectory: directory, owner: owner(944, '2026-08-20T00:03:00.000Z'), inspectProcess: async (pid) => pid === firstOwner.pid ? { state: 'live', processStartedAt: firstOwner.processStartedAt } : { state: 'gone' } }).finally(() => { thirdSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(secondSettled).toBe(false);
    expect(thirdSettled).toBe(false);

    allowPublish.resolve();
    const firstClaim = await first;
    expect(firstClaim.acquired).toBe(true);
    await expect(Promise.all([second, third])).resolves.toEqual([
      { acquired: false, owner: firstOwner },
      { acquired: false, owner: firstOwner },
    ]);
    if (firstClaim.acquired) await firstClaim.release();
  });

  it.each([
    ['string version', { version: '1', pid: 7, processStartedAt: '2026-08-20T00:00:00.000Z', acquiredAt: '2026-08-20T00:00:00.000Z' }],
    ['nonpositive version', { version: 0, pid: 7, processStartedAt: '2026-08-20T00:00:00.000Z', acquiredAt: '2026-08-20T00:00:00.000Z' }],
    ['string PID', { version: 1, pid: '7', processStartedAt: '2026-08-20T00:00:00.000Z', acquiredAt: '2026-08-20T00:00:00.000Z' }],
    ['zero PID', { version: 1, pid: 0, processStartedAt: '2026-08-20T00:00:00.000Z', acquiredAt: '2026-08-20T00:00:00.000Z' }],
    ['negative PID', { version: 1, pid: -1, processStartedAt: '2026-08-20T00:00:00.000Z', acquiredAt: '2026-08-20T00:00:00.000Z' }],
    ['overflow PID', { version: 1, pid: 2_147_483_648, processStartedAt: '2026-08-20T00:00:00.000Z', acquiredAt: '2026-08-20T00:00:00.000Z' }],
    ['missing milliseconds', { version: 1, pid: 7, processStartedAt: '2026-08-20T00:00:00Z', acquiredAt: '2026-08-20T00:00:00.000Z' }],
    ['non-UTC timestamp', { version: 1, pid: 7, processStartedAt: '2026-08-20T00:00:00.000+00:00', acquiredAt: '2026-08-20T00:00:00.000Z' }],
    ['impossible date', { version: 1, pid: 7, processStartedAt: '2026-02-30T00:00:00.000Z', acquiredAt: '2026-08-20T00:00:00.000Z' }],
  ])('matches the PowerShell schema by rejecting %s', async (_name, record) => {
    const directory = await temporaryDirectory();
    const lockPath = path.join(directory, 'lnwjud.tunnel.lock');
    const raw = JSON.stringify(record);
    await writeFile(lockPath, raw, 'utf8');

    expect(await readTunnelLock(directory)).toBeNull();
    await expect(acquireTunnelLock({ profileDirectory: directory, owner: owner(919, '2026-08-20T00:00:00.000Z') })).rejects.toThrow('invalid owner metadata');
    expect(await readFile(lockPath, 'utf8')).toBe(raw);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-lock-'));
  temporaryRoots.push(directory);
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
