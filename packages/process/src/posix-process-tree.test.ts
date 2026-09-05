import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { PosixProcessTree } from './posix-process-tree.js';

function fakeChild(pid = 4242): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}

function processSignalHarness() {
  const running = new Set<number>();
  const calls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
  const signalProcess = (pid: number, signal: NodeJS.Signals | 0): void => {
    calls.push({ pid, signal });
    const target = Math.abs(pid);
    if (signal === 0) {
      if (!running.has(target)) throw Object.assign(new Error('missing'), { code: 'ESRCH' });
      return;
    }
    if (!running.has(target)) throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    if (signal === 'SIGTERM' || signal === 'SIGKILL') running.delete(target);
  };
  return { running, calls, signalProcess };
}

describe('PosixProcessTree', () => {
  it('signals only an explicitly owned process group', async () => {
    const harness = processSignalHarness();
    harness.running.add(4242);
    const tree = new PosixProcessTree({ signalProcess: harness.signalProcess, wait: async () => undefined });

    await tree.stop(fakeChild(), 4242, { processGroupId: 4242 });

    expect(harness.calls).toContainEqual({ pid: -4242, signal: 'SIGTERM' });
    expect(harness.calls.some((call) => call.pid === -4242 && call.signal === 0)).toBe(true);
  });

  it('never guesses a negative PID when group ownership is absent', async () => {
    const harness = processSignalHarness();
    harness.running.add(4242);
    const tree = new PosixProcessTree({ signalProcess: harness.signalProcess, wait: async () => undefined });

    await tree.stop(fakeChild(), 4242);

    expect(harness.calls.some((call) => call.pid < 0)).toBe(false);
    expect(harness.calls).toContainEqual({ pid: 4242, signal: 'SIGTERM' });
  });

  it('escalates from SIGTERM to SIGKILL when the owned group remains live', async () => {
    let termSeen = false;
    let killSeen = false;
    const signalProcess = (pid: number, signal: NodeJS.Signals | 0): void => {
      if (Math.abs(pid) !== 4242) throw Object.assign(new Error('missing'), { code: 'ESRCH' });
      if (signal === 'SIGTERM') termSeen = true;
      if (signal === 'SIGKILL') killSeen = true;
      if (signal === 0 && killSeen) throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    };
    const tree = new PosixProcessTree({
      signalProcess,
      wait: async () => undefined,
      gracefulTimeoutMs: 0,
      forceTimeoutMs: 0,
    });

    await tree.stop(fakeChild(), 4242, { processGroupId: 4242 });

    expect(termSeen).toBe(true);
    expect(killSeen).toBe(true);
  });
});
