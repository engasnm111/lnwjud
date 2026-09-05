import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivityTracker } from './activity-tracker.js';
import {
  SharedActivitySnapshotLease,
  parseProcessProbeOutput,
  probeProcessStart,
  readSharedActivitySnapshot,
  sharedActivityLeaseDirectoryPath,
  sharedActivityLeasePath,
  sharedActivitySnapshotPath,
  type ProcessProbeResult,
  type SharedActivityOwner,
} from './shared-activity-snapshot.js';

const roots: string[] = [];
const owner: SharedActivityOwner = { pid: 7001, processStartedAt: '2026-08-20T00:00:00.000Z' };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('process start probe output', () => {
  it('treats empty stdout as unverifiable instead of proving the process is gone', () => {
    expect(parseProcessProbeOutput('')).toEqual({ state: 'unverifiable', reason: 'invalid_probe_response' });
    expect(parseProcessProbeOutput('GONE')).toEqual({ state: 'gone' });
    expect(parseProcessProbeOutput('LIVE|2026-08-20T00:00:00.000Z')).toEqual({ state: 'live', processStartedAt: '2026-08-20T00:00:00.000Z' });
  });

  it('retries a killed Windows process probe and accepts the next trustworthy result', async () => {
    let attempts = 0;
    const runProbe = async (): Promise<string> => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('probe exceeded timeout'), { killed: true, signal: 'SIGTERM' });
      return 'LIVE|2026-08-20T00:00:00.000Z';
    };

    await expect(probeProcessStart(7001, { runProbe, attempts: 2, timeoutMs: 5_000 })).resolves.toEqual({
      state: 'live',
      processStartedAt: '2026-08-20T00:00:00.000Z',
    });
    expect(attempts).toBe(2);
  });

  it('classifies Node execFile timeout errors after bounded retries', async () => {
    let attempts = 0;
    const runProbe = async (): Promise<string> => {
      attempts += 1;
      throw Object.assign(new Error('probe exceeded timeout'), { killed: true, signal: 'SIGTERM' });
    };

    await expect(probeProcessStart(7001, { runProbe, attempts: 2, timeoutMs: 5_000 })).resolves.toEqual({
      state: 'unverifiable',
      reason: 'probe_timeout',
    });
    expect(attempts).toBe(2);
  });

  it('keeps the default retry budget below the caller five-second test deadline', async () => {
    const timeouts: number[] = [];
    const runProbe = async (_pid: number, timeoutMs: number): Promise<string> => {
      timeouts.push(timeoutMs);
      throw Object.assign(new Error('probe exceeded timeout'), { killed: true, signal: 'SIGTERM' });
    };

    await expect(probeProcessStart(7001, { runProbe })).resolves.toEqual({ state: 'unverifiable', reason: 'probe_timeout' });
    expect(timeouts).toHaveLength(2);
    expect(timeouts.reduce((total, timeout) => total + timeout, 0)).toBeLessThan(4_000);
  });
});

describe('shared cross-process MCP activity snapshot', () => {
  it('publishes a v2 owner lease and begin/end revisions atomically', async () => {
    const profileDirectory = await temporaryDirectory();
    let now = new Date('2026-08-20T00:00:01.000Z');
    const lease = new SharedActivitySnapshotLease({ profileDirectory, owner, leaseId: 'lease-a', now: (): Date => now, heartbeatMs: 0 });
    await lease.initialize();
    const leasePath = sharedActivityLeasePath(profileDirectory, owner, 'lease-a');

    expect(JSON.parse(await readFile(leasePath, 'utf8'))).toEqual({
      version: 2, leaseId: 'lease-a', owner, activeCount: 0, revision: 0, updatedAt: '2026-08-20T00:00:01.000Z',
    });

    const tracker = new ActivityTracker(lease);
    now = new Date('2026-08-20T00:00:02.000Z');
    const callId = await tracker.begin('read_file', { path: 'E:\\fixture.txt' });
    expect(JSON.parse(await readFile(leasePath, 'utf8'))).toMatchObject({ activeCount: 1, revision: 1 });
    now = new Date('2026-08-20T00:00:03.000Z');
    await tracker.end(callId, 'SUCCESS', 1);
    expect(JSON.parse(await readFile(leasePath, 'utf8'))).toMatchObject({ activeCount: 0, revision: 2 });
    expect((await readdir(sharedActivityLeaseDirectoryPath(profileDirectory))).filter((name) => name.includes('.publish.'))).toEqual([]);
  });

  it('aggregates two live leases and closing one removes only that owner', async () => {
    const profileDirectory = await temporaryDirectory();
    const ownerA: SharedActivityOwner = { pid: 7001, processStartedAt: '2026-08-20T00:00:00.000Z' };
    const ownerB: SharedActivityOwner = { pid: 7002, processStartedAt: '2026-08-20T00:00:01.000Z' };
    const leaseA = new SharedActivitySnapshotLease({ profileDirectory, owner: ownerA, leaseId: 'lease-a', heartbeatMs: 0 });
    const leaseB = new SharedActivitySnapshotLease({ profileDirectory, owner: ownerB, leaseId: 'lease-b', heartbeatMs: 0 });
    await Promise.all([leaseA.initialize(), leaseB.initialize()]);
    const trackerA = new ActivityTracker(leaseA);
    const trackerB = new ActivityTracker(leaseB);
    await trackerA.begin('read_file', { workspaceId: 'a', path: 'a.txt' });
    await trackerB.begin('read_file', { workspaceId: 'b', path: 'b.txt' });
    const inspectProcess = async (pid: number): Promise<ProcessProbeResult> => pid === ownerA.pid
      ? { state: 'live', processStartedAt: ownerA.processStartedAt }
      : { state: 'live', processStartedAt: ownerB.processStartedAt };

    await expect(readSharedActivitySnapshot({ profileDirectory, inspectProcess })).resolves.toMatchObject({
      state: 'available', activeCount: 2, revision: 2, owners: [expect.objectContaining({ leaseId: 'lease-a' }), expect.objectContaining({ leaseId: 'lease-b' })],
    });
    await expect(leaseA.close()).resolves.toBe(true);
    await expect(readSharedActivitySnapshot({ profileDirectory, inspectProcess })).resolves.toMatchObject({
      state: 'available', activeCount: 1, revision: 1, owners: [expect.objectContaining({ leaseId: 'lease-b' })],
    });
    await expect(access(sharedActivityLeasePath(profileDirectory, ownerB, 'lease-b'))).resolves.toBeUndefined();
    await leaseB.close();
  });

  it('keeps legacy v1 fixed snapshots readable during migration', async () => {
    const profileDirectory = await temporaryDirectory();
    await writeFile(sharedActivitySnapshotPath(profileDirectory), JSON.stringify({
      version: 1, owner, activeCount: 2, revision: 7, updatedAt: '2026-08-20T00:00:01.000Z',
    }), 'utf8');
    await expect(readSharedActivitySnapshot({
      profileDirectory,
      now: (): Date => new Date('2026-08-20T00:00:02.000Z'),
      inspectProcess: async (): Promise<ProcessProbeResult> => ({ state: 'live', processStartedAt: owner.processStartedAt }),
    })).resolves.toMatchObject({
      state: 'available', activeCount: 2, revision: 7, owners: [{ ...owner, leaseId: 'legacy-v1' }],
    });
  });

  it('cleans stale leases and treats malformed snapshots as unverifiable', async () => {
    const profileDirectory = await temporaryDirectory();
    await expect(readSharedActivitySnapshot({ profileDirectory })).resolves.toMatchObject({ state: 'missing' });
    await writeFile(sharedActivitySnapshotPath(profileDirectory), '{broken', 'utf8');
    await expect(readSharedActivitySnapshot({ profileDirectory })).resolves.toMatchObject({ state: 'unverifiable', reason: 'invalid_snapshot' });
    await rm(sharedActivitySnapshotPath(profileDirectory), { force: true });

    const lease = new SharedActivitySnapshotLease({ profileDirectory, owner, leaseId: 'stale-lease', now: (): Date => new Date('2026-08-20T00:00:01.000Z'), heartbeatMs: 0 });
    await lease.initialize();
    await expect(readSharedActivitySnapshot({
      profileDirectory, now: (): Date => new Date('2026-08-20T00:00:10.000Z'), staleAfterMs: 2_000,
      inspectProcess: async (): Promise<ProcessProbeResult> => ({ state: 'live', processStartedAt: owner.processStartedAt }),
    })).resolves.toMatchObject({ state: 'stale', reason: 'snapshot_expired' });
    await expect(access(sharedActivityLeasePath(profileDirectory, owner, 'stale-lease'))).rejects.toThrow();
  });

  it('fails closed instead of deleting a fresh heartbeat that wins a stale-owner cleanup race', async () => {
    const profileDirectory = await temporaryDirectory();
    const leaseId = 'race-lease';
    const lease = new SharedActivitySnapshotLease({ profileDirectory, owner, leaseId, now: (): Date => new Date('2026-08-20T00:00:01.000Z'), heartbeatMs: 0 });
    await lease.initialize();
    const leasePath = sharedActivityLeasePath(profileDirectory, owner, leaseId);
    const replacement = { version: 2, leaseId, owner, activeCount: 1, revision: 99, updatedAt: '2026-08-20T00:00:02.000Z' };
    const result = await readSharedActivitySnapshot({
      profileDirectory,
      now: (): Date => new Date('2026-08-20T00:00:02.500Z'),
      inspectProcess: async (): Promise<ProcessProbeResult> => {
        await writeFile(leasePath, JSON.stringify(replacement), 'utf8');
        return { state: 'gone' };
      },
    });
    expect(result).toMatchObject({ state: 'unverifiable', reason: 'stale_snapshot_cleanup_race' });
    expect(JSON.parse(await readFile(leasePath, 'utf8'))).toEqual(replacement);
  });

  it('cannot remove a replacement published while its own lease is quarantined for close', async () => {
    const profileDirectory = await temporaryDirectory();
    const leaseId = 'close-race';
    const leasePath = sharedActivityLeasePath(profileDirectory, owner, leaseId);
    const replacement = { version: 2, leaseId, owner, activeCount: 1, revision: 9, updatedAt: '2026-08-20T00:02:01.000Z' };
    const lease = new SharedActivitySnapshotLease({
      profileDirectory, owner, leaseId, heartbeatMs: 0,
      hooks: { afterCloseQuarantine: async (): Promise<void> => writeFile(leasePath, JSON.stringify(replacement), 'utf8') },
    });
    await lease.initialize();
    await expect(lease.close()).resolves.toBe(true);
    expect(JSON.parse(await readFile(leasePath, 'utf8'))).toEqual(replacement);
  });
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-shared-activity-'));
  roots.push(root);
  return root;
}
