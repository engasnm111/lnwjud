import { describe, expect, it, vi } from 'vitest';
import { PosixProcessTree } from './posix-process-tree.js';
import { createSpawnInvocationFactory, toSpawnInvocation } from './spawn-invocation.js';

describe('portable process contracts', () => {
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
});
