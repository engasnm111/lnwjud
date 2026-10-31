import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mutexHelper = vi.hoisted(() => ({ exitCodes: [] as number[], spawnCalls: 0, readyDelayMs: 0, onSpawn: null as (() => void) | null }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      mutexHelper.spawnCalls += 1;
      mutexHelper.onSpawn?.();
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        exitCode: number | null;
        kill: () => boolean;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      const exitCode = mutexHelper.exitCodes.shift() ?? 0;
      child.kill = (): boolean => {
        if (child.exitCode === null) {
          child.exitCode = 1;
          child.emit('exit', 1);
        }
        return true;
      };
      child.stdin.once('finish', () => {
        queueMicrotask(() => {
          if (child.exitCode !== null) return;
          child.exitCode = exitCode;
          child.emit('exit', exitCode);
        });
      });
      if (mutexHelper.readyDelayMs > 0) setTimeout(() => child.stdout.write('READY\n'), mutexHelper.readyDelayMs);
      else queueMicrotask(() => child.stdout.write('READY\n'));
      return child;
    }),
  };
});

import { acquireTunnelLock, readTunnelLock, type TunnelLockOwner } from '../src/main/tunnel-lock.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  mutexHelper.exitCodes = [];
  mutexHelper.spawnCalls = 0;
  mutexHelper.readyDelayMs = 0;
  mutexHelper.onSpawn = null;
  vi.useRealTimers();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('tunnel lock mutex cleanup semantics', () => {
  it.skipIf(process.platform !== 'win32')('waits for a slow helper startup without publishing an owner before READY', async () => {
    const directory = await temporaryDirectory();
    const expectedOwner = owner(1199, '2026-08-20T00:00:00.000Z');
    mutexHelper.readyDelayMs = 16_000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const spawned = new Promise<void>((resolve) => { mutexHelper.onSpawn = resolve; });

    const result = acquireTunnelLock({
      profileDirectory: directory,
      owner: expectedOwner,
      inspectProcess: async () => ({ state: 'gone' }),
    }).then(
      (value) => ({ success: true as const, value }),
      (error: unknown) => ({ success: false as const, error }),
    );
    await spawned;
    expect(mutexHelper.spawnCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await readTunnelLock(directory)).toBeNull();
    await vi.advanceTimersByTimeAsync(999);

    const completed = await result;
    expect(completed.success).toBe(true);
    if (!completed.success) return;
    expect(completed.value.acquired).toBe(true);
    expect(await readTunnelLock(directory)).toEqual(expectedOwner);
    mutexHelper.readyDelayMs = 0;
    if (completed.value.acquired) await expect(completed.value.release()).resolves.toBe(true);
  });

  it('reports acquisition success when the authoritative lock was published before mutex cleanup failed', async () => {
    const directory = await temporaryDirectory();
    const expectedOwner = owner(1201, '2026-08-20T00:00:00.000Z');
    mutexHelper.exitCodes = [1];

    const claim = await acquireTunnelLock({
      profileDirectory: directory,
      owner: expectedOwner,
      inspectProcess: async () => ({ state: 'gone' }),
    });

    expect(claim.acquired).toBe(true);
    expect(await readTunnelLock(directory)).toEqual(expectedOwner);
  });

  it('reports release success when the authoritative lock was removed before mutex cleanup failed', async () => {
    const directory = await temporaryDirectory();
    const expectedOwner = owner(1202, '2026-08-20T00:00:00.000Z');
    mutexHelper.exitCodes = [0, 1];
    const claim = await acquireTunnelLock({
      profileDirectory: directory,
      owner: expectedOwner,
      inspectProcess: async () => ({ state: 'live', processStartedAt: expectedOwner.processStartedAt }),
    });
    expect(claim.acquired).toBe(true);
    if (!claim.acquired) return;

    await expect(claim.release()).resolves.toBe(true);
    expect(await readTunnelLock(directory)).toBeNull();
  });

  it('rejects a second starter from a verified live owner without spawning the Windows mutex helper', async () => {
    const directory = await temporaryDirectory();
    const expectedOwner = owner(1203, '2026-08-20T00:00:00.000Z');
    const first = await acquireTunnelLock({
      profileDirectory: directory,
      owner: expectedOwner,
      inspectProcess: async () => ({ state: 'gone' }),
    });
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;

    mutexHelper.spawnCalls = 0;
    const second = await acquireTunnelLock({
      profileDirectory: directory,
      owner: owner(1204, '2026-08-20T00:01:00.000Z'),
      inspectProcess: async (pid) => pid === expectedOwner.pid
        ? { state: 'live', processStartedAt: expectedOwner.processStartedAt }
        : { state: 'gone' },
    });

    expect(second).toEqual({ acquired: false, owner: expectedOwner });
    expect(mutexHelper.spawnCalls).toBe(0);
    await expect(first.release()).resolves.toBe(true);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-lock-mutex-'));
  temporaryRoots.push(directory);
  return directory;
}

function owner(pid: number, processStartedAt: string): TunnelLockOwner {
  return { pid, processStartedAt, acquiredAt: '2026-08-20T00:00:00.000Z' };
}
