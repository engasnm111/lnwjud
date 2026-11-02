import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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

  it('does not treat an empty Linux group as proof that its observed child exited', async () => {
    const signal = vi.fn();
    const child = { exitCode: null, signalCode: null } as never;
    const tree = new PosixProcessTree({
      platform: 'linux', inspectGroup: async (): Promise<PosixProcessGroupObservation> => ({ state: 'empty' }), processKill: signal,
      waitForExit: async (): Promise<boolean> => false, termGraceMs: 5, killGraceMs: 5,
    });
    await expect(tree.stop(child, 4242)).rejects.toThrow('child');
    expect(signal).not.toHaveBeenCalled();
  });

  it('does not treat missing fallback probes as proof that the child exited', async () => {
    const child = { exitCode: null, signalCode: null } as never;
    const tree = new PosixProcessTree({
      platform: 'linux', processIsAlive: (): boolean => false, processGroupIsAlive: (): boolean => false,
      waitForExit: async (): Promise<boolean> => false, termGraceMs: 5,
    });
    await expect(tree.stop(child, 4242)).rejects.toThrow('child');
  });

  it('accepts an already-exited child after fresh PID and group probes are empty', async () => {
    const signal = vi.fn();
    const processIsAlive = vi.fn((): boolean => false);
    const processGroupIsAlive = vi.fn((): boolean => false);
    const tree = new PosixProcessTree({ platform: 'linux', processIsAlive, processGroupIsAlive, processKill: signal });
    await expect(tree.stop({ exitCode: 0, signalCode: null } as never, 4242)).resolves.toBeUndefined();
    expect(processIsAlive).toHaveBeenCalledTimes(2);
    expect(processGroupIsAlive).toHaveBeenCalledTimes(2);
    expect(signal).not.toHaveBeenCalled();
  });

  it('does not treat an empty group as proof that an unowned root PID exited', async () => {
    const signal = vi.fn();
    const tree = new PosixProcessTree({
      platform: 'linux', inspectGroup: async (): Promise<PosixProcessGroupObservation> => ({ state: 'empty' }),
      processIsAlive: (): boolean => true, processKill: signal,
    });
    await expect(tree.stopPid(4242, '2026-10-29T00:00:00.000Z')).rejects.toThrow('root');
    expect(signal).not.toHaveBeenCalled();
  });

  it('rechecks the root PID and group before accepting an unowned empty group', async () => {
    const alive = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const tree = new PosixProcessTree({ platform: 'linux', inspectGroup: async (): Promise<PosixProcessGroupObservation> => ({ state: 'empty' }), processIsAlive: alive });
    await expect(tree.stopPid(4242)).rejects.toThrow('group completion');
    expect(alive).toHaveBeenCalledTimes(2);
  });

  it('does not treat an unexpected PID probe error as absence', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((): never => { throw Object.assign(new Error('probe failed'), { code: 'EIO' }); });
    try {
      const tree = new PosixProcessTree({ platform: 'linux', inspectGroup: async (): Promise<PosixProcessGroupObservation> => ({ state: 'empty' }) });
      await expect(tree.stopPid(4242)).rejects.toThrow('root');
    } finally { kill.mockRestore(); }
  });

  it('reports an unverified stop when an empty snapshot hides a live owned child', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    try {
      await once(child, 'spawn');
      const tree = new PosixProcessTree({
        platform: 'linux', inspectGroup: async (): Promise<PosixProcessGroupObservation> => ({ state: 'empty' }), waitForExit: async (): Promise<boolean> => false,
      });
      await expect(tree.stop(child, child.pid!)).rejects.toThrow('child');
      expect(child.exitCode).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    }
  }, 10_000);

  it('does not report a successful stop when the group disappears but the child exit is unverified', async () => {
    const signal = vi.fn();
    const child = { exitCode: null, signalCode: null } as never;
    let probes = 0;
    const tree = new PosixProcessTree({
      platform: 'linux', inspectGroup: async (): Promise<PosixProcessGroupObservation> => ++probes < 3
        ? { state: 'live', livePids: [4242], rootStartedAt: '2026-10-29T00:00:00.000Z' }
        : { state: 'empty' },
      processKill: signal, waitForExit: async (): Promise<boolean> => false, termGraceMs: 5, killGraceMs: 5,
    });
    await expect(tree.stop(child, 4242)).rejects.toThrow('child');
    expect(signal).toHaveBeenCalledWith(-4242, 'SIGTERM');
  });

  it('refuses an empty final pre-signal probe while child exit is unverified', async () => {
    const child = { exitCode: null, signalCode: null } as never;
    const signal = vi.fn();
    let probes = 0;
    const tree = new PosixProcessTree({
      platform: 'linux', inspectGroup: async (): Promise<PosixProcessGroupObservation> => ++probes === 1
        ? { state: 'live', livePids: [4242], rootStartedAt: '2026-10-29T00:00:00.000Z' }
        : { state: 'empty' },
      processKill: signal, waitForExit: async (): Promise<boolean> => false, termGraceMs: 5,
    });
    await expect(tree.stop(child, 4242)).rejects.toThrow('child');
    expect(signal).not.toHaveBeenCalled();
  });

  it('requires a fresh empty group check after the delayed child exit', async () => {
    const child = { exitCode: null, signalCode: null } as never;
    const inspect = vi.fn<() => Promise<PosixProcessGroupObservation>>().mockResolvedValue({ state: 'empty' });
    const tree = new PosixProcessTree({ platform: 'linux', inspectGroup: inspect, waitForExit: async (): Promise<boolean> => true, termGraceMs: 5 });
    await expect(tree.stop(child, 4242)).resolves.toBeUndefined();
    expect(inspect).toHaveBeenCalledTimes(2);
    inspect.mockReset().mockResolvedValueOnce({ state: 'empty' }).mockResolvedValueOnce({ state: 'unknown', reason: 'changed' });
    await expect(tree.stop(child, 4242)).rejects.toThrow('group completion');
  });

  it('does not signal a group if the child exits during the final identity probe', async () => {
    const child = { exitCode: null as number | null, signalCode: null };
    const signal = vi.fn();
    let probes = 0;
    const tree = new PosixProcessTree({
      platform: 'linux', inspectGroup: async (): Promise<PosixProcessGroupObservation> => {
        if (++probes === 2) child.exitCode = 0;
        return { state: 'live', livePids: [4242], rootStartedAt: '2026-10-29T00:00:00.000Z' };
      }, processKill: signal,
    });
    await expect(tree.stop(child as never, 4242)).rejects.toThrow('root exited');
    expect(signal).not.toHaveBeenCalled();
  });

  it('reprobes malformed and unobserved macOS group snapshots before signaling', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    const child = { exitCode: null, signalCode: null } as never;
    let probes = 0;
    const tree = new PosixProcessTree({
      platform: 'darwin',
      inspectGroup: async (): Promise<PosixProcessGroupObservation> => {
        probes += 1;
        return probes === 1
          ? { state: 'unknown', reason: 'malformed_process_table' }
          : probes === 2
            ? { state: 'empty' }
            : { state: 'live', livePids: [4242], rootStartedAt: '2026-10-29T00:00:00.000Z' };
      },
      processKill: (pid, signal): void => { signals.push({ pid, signal }); },
      termGraceMs: 5,
      killGraceMs: 5,
    });
    await expect(tree.stop(child, 4242)).rejects.toThrow('could not be verified');
    expect(probes).toBeGreaterThan(2);
    expect(signals).toEqual([
      { pid: -4242, signal: 'SIGTERM' },
      { pid: -4242, signal: 'SIGKILL' },
    ]);
  });

  it('waits for a freshly spawned macOS root start identity when only descendants are initially observable', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    const child = { exitCode: null, signalCode: null } as never;
    let probes = 0;
    const tree = new PosixProcessTree({
      platform: 'darwin',
      inspectGroup: async (): Promise<PosixProcessGroupObservation> => {
        probes += 1;
        return probes <= 2
          ? { state: 'live', livePids: [4243] }
          : { state: 'live', livePids: [4242], rootStartedAt: '2026-10-29T00:00:00.000Z' };
      },
      processKill: (pid, signal): void => { signals.push({ pid, signal }); },
      termGraceMs: 5,
      killGraceMs: 5,
    });
    await expect(tree.stop(child, 4242)).rejects.toThrow('could not be verified');
    expect(probes).toBeGreaterThan(2);
    expect(signals).toEqual([
      { pid: -4242, signal: 'SIGTERM' },
      { pid: -4242, signal: 'SIGKILL' },
    ]);
  });

  it('ignores unrelated macOS process metadata while preserving strict target-group proof', () => {
    const target = '4242 4242 Ss Sun Oct 18 00:00:00 2026';
    const unrelated = '1 1 ?? unavailable';
    expect(parsePosixProcessGroup(`${unrelated}\n${target}`, 4242)).toEqual({
      state: 'live', livePids: [4242], rootStartedAt: new Date('Sun Oct 18 00:00:00 2026').toISOString(),
    });
    // ps may omit STAT/lstart on unrelated rows; their PID/PGID still prove they are not the target.
    expect(parsePosixProcessGroup(`1 1\n${target}`, 4242)).toEqual({
      state: 'live', livePids: [4242], rootStartedAt: new Date('Sun Oct 18 00:00:00 2026').toISOString(),
    });
    expect(parsePosixProcessGroup(`4242 4242\n${unrelated}`, 4242))
      .toMatchObject({ state: 'unknown', reason: 'malformed_process_table' });
    expect(parsePosixProcessGroup(`${unrelated}\n4242 4242 Ss unavailable`, 4242))
      .toMatchObject({ state: 'unknown', reason: 'malformed_process_table' });
    expect(parsePosixProcessGroup(`bad-prefix\n${target}`, 4242))
      .toMatchObject({ state: 'unknown', reason: 'malformed_process_table' });
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
    const tree = new PosixProcessTree({ platform: 'linux', processKill: signal, processIsAlive: (): boolean => false, inspectGroup: async (): Promise<PosixProcessGroupObservation> => observation });
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

  it('does not signal when a fallback identity probe becomes unavailable while the process remains live', async () => {
    const signal = vi.fn();
    const probe = vi.fn().mockResolvedValueOnce('2026-08-20T00:00:00.000Z').mockResolvedValueOnce(null);
    const tree = new PosixProcessTree({ platform: 'linux', processIsAlive: (): boolean => true, processGroupIsAlive: (): boolean => true,
      processStartedAt: probe, processKill: signal });
    await expect(tree.stop({ exitCode: null, signalCode: null } as never, 4242)).rejects.toThrow('identity');
    expect(signal).not.toHaveBeenCalled();
  });

  it('does not signal a fallback group when an external root identity differs', async () => {
    const signal = vi.fn();
    const tree = new PosixProcessTree({ platform: 'linux', processIsAlive: (): boolean => true, processGroupIsAlive: (): boolean => true,
      processStartedAt: async (): Promise<string> => '2026-08-20T00:00:01.000Z', processKill: signal });
    await expect(tree.stopPid(4242, '2026-08-20T00:00:00.000Z')).rejects.toThrow('identity');
    expect(signal).not.toHaveBeenCalled();
  });

  it('does not signal a fallback group after its identity probe reports the process gone', async () => {
    const signal = vi.fn();
    let alive = true;
    const probe = vi.fn().mockImplementationOnce(async (): Promise<string | null> => '2026-08-20T00:00:00.000Z')
      .mockImplementationOnce(async (): Promise<string | null> => { alive = false; return null; });
    const tree = new PosixProcessTree({ platform: 'linux', processIsAlive: (): boolean => alive, processGroupIsAlive: (): boolean => alive,
      processStartedAt: probe, processKill: signal, waitForExit: async (): Promise<boolean> => true });
    await expect(tree.stop({ exitCode: null, signalCode: null } as never, 4242)).resolves.toBeUndefined();
    expect(signal).not.toHaveBeenCalled();
  });

  it('refuses a live unowned group when no prior root identity was supplied', async () => {
    const signal = vi.fn();
    const tree = new PosixProcessTree({ platform: 'linux', inspectGroup: async (): Promise<PosixProcessGroupObservation> => ({
      state: 'live', livePids: [4242], rootStartedAt: '2026-08-20T00:00:00.000Z',
    }), processKill: signal });
    await expect(tree.stopPid(4242)).rejects.toThrow('identity');
    expect(signal).not.toHaveBeenCalled();
  });

  it('refuses a live group when an inspector returns a different stored root identity', async () => {
    const signal = vi.fn();
    const tree = new PosixProcessTree({ platform: 'linux', inspectGroup: async (): Promise<PosixProcessGroupObservation> => ({
      state: 'live', livePids: [4242], rootStartedAt: '2026-08-20T00:00:01.000Z',
    }), processKill: signal, termGraceMs: 5, killGraceMs: 5 });
    await expect(tree.stopPid(4242, '2026-08-20T00:00:00.000Z')).rejects.toThrow('identity');
    expect(signal).not.toHaveBeenCalled();
  });

  it('does not signal a fallback group when the child exits during identity verification', async () => {
    const signal = vi.fn();
    const child = { exitCode: null as number | null, signalCode: null };
    let probes = 0;
    const tree = new PosixProcessTree({ platform: 'linux', processIsAlive: (): boolean => true, processGroupIsAlive: (): boolean => true,
      processStartedAt: async (): Promise<string> => { if (++probes === 2) child.exitCode = 0; return '2026-08-20T00:00:00.000Z'; }, processKill: signal });
    await expect(tree.stop(child as never, 4242)).rejects.toThrow('root exited');
    expect(signal).not.toHaveBeenCalled();
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
    await expect(tree.stopPid?.(4_242, '2026-08-20T00:00:00.000Z')).resolves.toBeUndefined();
    expect(signals).toEqual([{ pid: -4_242, signal: 'SIGTERM' }]);
  });

  it('refuses to signal a non-detached external root without a group wrapper', async () => {
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
    await expect(tree.stopPid?.(4_243, '2026-08-20T00:00:00.000Z')).rejects.toThrow('group');
    expect(signals).toEqual([]);
  });
});
