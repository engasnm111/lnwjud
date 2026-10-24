import { describe, expect, it, vi } from 'vitest';
import { PosixProcessTree, parsePosixProcessGroup, inspectPosixProcessGroup, classifyPosixGroupCompletion, type PosixProcessGroupObservation } from './posix-process-tree.js';
import { createSpawnInvocationFactory, toSpawnInvocation } from './spawn-invocation.js';

describe('portable process contracts', () => {
  it('observes descendants after the root disappears and excludes zombies from live group proof', () => {
    const table = '1 1 Ss Sun Oct 18 00:00:00 2026\n4243 4242 S Sun Oct 18 00:01:00 2026\n4244 4242 Z Sun Oct 18 00:01:00 2026';
    expect(parsePosixProcessGroup(table, 4242)).toEqual({ state: 'live', livePids: [4243] });
    expect(parsePosixProcessGroup(table.replace('4243 4242 S', '4243 4242 Z'), 4242)).toEqual({ state: 'empty' });
  });

  it('never treats an empty macOS process group as proof that escaped descendants terminated', async () => {
    expect(classifyPosixGroupCompletion({ state: 'empty' }, 'darwin')).toEqual({
      state: 'unknown', reason: 'darwin_escaped_descendants_not_contained',
    });
    expect(classifyPosixGroupCompletion({ state: 'empty' }, 'linux')).toEqual({ state: 'empty' });
    const signal = vi.fn();
    const tree = new PosixProcessTree({
      platform: 'darwin', inspectGroup: async (): Promise<PosixProcessGroupObservation> => ({ state: 'empty' }), processKill: signal,
    });
    await expect(tree.stopPid(4242)).rejects.toThrow('identity');
    expect(signal).not.toHaveBeenCalled();
  });

  it('keeps malformed, unreadable and reused group identities unknown', async () => {
    expect(parsePosixProcessGroup('', 4242).state).toBe('unknown');
    expect(parsePosixProcessGroup('1 1 Ss Sun Oct 18 00:00:00 2026\ntruncated', 4242).state).toBe('unknown');
    expect(parsePosixProcessGroup('4242 4242 S Sun Oct 18 00:00:00 2026', 4242, '2000-01-01T00:00:00.000Z'))
      .toMatchObject({ state: 'unknown', reason: 'root_identity_changed' });
    expect(parsePosixProcessGroup('4242 5000 S Sun Oct 18 00:00:00 2026', 4242).state).toBe('unknown');
    expect(await inspectPosixProcessGroup(4242, { platform: 'win32' })).toEqual({ state: 'unknown', reason: 'unsupported_platform' });
  });

  it('never signals an orphaned or reused group and accepts later observed zero', async () => {
    let observation: PosixProcessGroupObservation = { state: 'live', livePids: [4243] };
    const signal = vi.fn();
    const tree = new PosixProcessTree({ platform: 'linux', processKill: signal, inspectGroup: async (): Promise<PosixProcessGroupObservation> => observation });
    await expect(tree.stopPid(4242)).rejects.toThrow('identity');
    observation = { state: 'unknown', reason: 'root_identity_changed' };
    await expect(tree.stopPid(4242, '2026-10-18T00:00:00.000Z')).rejects.toThrow('identity');
    expect(signal).not.toHaveBeenCalled();
    observation = { state: 'empty' };
    await expect(tree.stopPid(4242)).resolves.toBeUndefined();
  });
  it('passes POSIX arguments literally without constructing a shell command', () => {
    expect(toSpawnInvocation('/usr/bin/tool', ['a&b', '$(touch should-not-run)', '"quoted"'], {}, 'linux')).toEqual({
      ok: true,
      value: { executable: '/usr/bin/tool', args: ['a&b', '$(touch should-not-run)', '"quoted"'] },
    });
    expect(createSpawnInvocationFactory('darwin').create('/bin/echo', ['hello|world'])).toMatchObject({
      ok: true,
      value: { executable: '/bin/echo', args: ['hello|world'] },
    });
  });

  it('uses SIGTERM then SIGKILL for an owned POSIX group and rejects an unverified final state', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    let alive = true;
    const child = { exitCode: null, signalCode: null, once: vi.fn(), removeListener: vi.fn() } as never;
    const tree = new PosixProcessTree({
      platform: 'linux',
      processIsAlive: (): boolean => alive,
      processGroupIsAlive: (): boolean => alive,
      processStartedAt: async (): Promise<string> => '2026-08-20T00:00:00.000Z',
      processKill: (pid, signal): void => {
        signals.push({ pid, signal });
      },
      waitForExit: async (_child, timeout): Promise<boolean> => {
        if (timeout < 2_000) return false;
        alive = false;
        return true;
      },
      termGraceMs: 5,
      killGraceMs: 5,
    });
    await expect(tree.stop(child, 4242)).rejects.toThrow('could not be verified');
    expect(signals).toEqual([
      { pid: -4242, signal: 'SIGTERM' },
      { pid: -4242, signal: 'SIGKILL' },
    ]);
  });

  it('refuses every signal when the process start identity is unavailable', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    const child = { exitCode: null, signalCode: null } as never;
    const tree = new PosixProcessTree({
      platform: 'linux',
      processIsAlive: (): boolean => true,
      processGroupIsAlive: (): boolean => true,
      processStartedAt: async (): Promise<null> => null,
      processKill: (pid, signal): void => { signals.push({ pid, signal }); },
    });
    await expect(tree.stop(child, 4242)).rejects.toThrow('start identity could not be verified');
    expect(signals).toEqual([]);
  });

  it('refuses escalation when a reused PID changes its start identity', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    let probes = 0;
    const child = { exitCode: null, signalCode: null } as never;
    const tree = new PosixProcessTree({
      platform: 'darwin',
      processIsAlive: (): boolean => true,
      processGroupIsAlive: (): boolean => true,
      processStartedAt: async (): Promise<string> => {
        probes += 1;
        return probes === 1 ? '2026-08-20T00:00:00.000Z' : '2026-08-20T00:00:01.000Z';
      },
      processKill: (pid, signal): void => { signals.push({ pid, signal }); },
      waitForExit: async (): Promise<boolean> => false,
      termGraceMs: 5,
      killGraceMs: 5,
    });
    await expect(tree.stop(child, 4242)).rejects.toThrow('identity changed');
    expect(signals).toEqual([]);
  });

  it('does not treat a closed root as proof that its detached descendants are gone', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    const child = { exitCode: null, signalCode: null } as never;
    const tree = new PosixProcessTree({
      platform: 'linux',
      processIsAlive: (): boolean => false,
      processGroupIsAlive: (): boolean => true,
      processKill: (pid, signal): void => { signals.push({ pid, signal }); },
      processStartedAt: async (): Promise<string> => '2026-08-20T00:00:00.000Z',
    });
    await expect(tree.stop(child, 4242)).rejects.toThrow('group remains live');
    expect(signals).toEqual([]);
  });

  it('terminates an externally owned POSIX process group after the root handle is gone', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    let alive = true;
    const tree = new PosixProcessTree({
      platform: 'linux',
      processIsAlive: (): boolean => alive,
      processGroupIsAlive: (): boolean => alive,
      processStartedAt: async (): Promise<string> => '2026-08-20T00:00:00.000Z',
      processKill: (pid, signal): void => {
        signals.push({ pid, signal });
        if (signal === 'SIGTERM') alive = false;
      },
      termGraceMs: 5,
      killGraceMs: 5,
    });
    await expect(tree.stopPid?.(4_242)).resolves.toBeUndefined();
    expect(signals).toEqual([{ pid: -4_242, signal: 'SIGTERM' }]);
  });

  it('terminates a non-detached external POSIX root when no group wrapper exists', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    let alive = true;
    const tree = new PosixProcessTree({
      platform: 'darwin',
      processIsAlive: (): boolean => alive,
      processGroupIsAlive: (): boolean => false,
      processStartedAt: async (): Promise<string> => '2026-08-20T00:00:00.000Z',
      processKill: (pid, signal): void => {
        signals.push({ pid, signal });
        if (signal === 'SIGTERM') alive = false;
      },
      termGraceMs: 5,
      killGraceMs: 5,
    });
    await expect(tree.stopPid?.(4_243)).resolves.toBeUndefined();
    expect(signals).toEqual([{ pid: 4_243, signal: 'SIGTERM' }]);
  });
});
