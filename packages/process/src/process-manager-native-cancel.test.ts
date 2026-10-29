import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ProcessManager } from './process-manager.js';
import type { NativeAttemptBinding, NativeAttemptHandle, NativeProcessObservation, WindowsNativeAuthority } from './windows-native-authority.js';

const binding: NativeAttemptBinding = {
  taskId: '00131f0c-0294-47d4-a04c-b9aa05c791ea', reservationId: 'reservation', attemptId: 'attempt',
  generation: 1, requestDigest: 'a'.repeat(64), ownerClientId: 'client', ownerSessionId: 'session', workspaceId: 'workspace',
};
const running: NativeProcessObservation = { state: 'running', binding, targetPid: 1234 };
const terminal: NativeProcessObservation = { state: 'terminal_verified', binding, outcome: 'cancelled', exitCode: 0, activeProcesses: 0 };
const unknown: NativeProcessObservation = { state: 'termination_unknown', binding, reason: 'proof unavailable' };

interface NativeCancellationFixture {
  readonly manager: ProcessManager;
  readonly processId: string;
  readonly launch: NativeAttemptHandle;
  readonly inspect: Mock<() => Promise<NativeProcessObservation>>;
  readonly fallback: Mock<() => Promise<void>>;
  readonly completed: Mock<() => Promise<void>>;
}

describe.skipIf(process.platform !== 'win32')('ProcessManager native cancellation', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.resetAllMocks(); });

  async function fixture(cancel: () => Promise<NativeProcessObservation>): Promise<NativeCancellationFixture> {
    const inspect = vi.fn<() => Promise<NativeProcessObservation>>().mockResolvedValue(running);
    const launch: NativeAttemptHandle = {
      binding, observe: inspect, cancel: vi.fn(cancel),
      abortBeforeDispatch: vi.fn(async () => unknown),
      readOutput: vi.fn(async (cursor) => ({
        state: 'available' as const, binding,
        stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
        stdoutTruncated: false, stderrTruncated: false, complete: true,
        nextCursor: cursor, finalCursor: cursor,
        persistence: { state: 'persisted' as const },
      })),
    };
    const nativeAuthority = {
      attachProcess: () => launch,
      submitProcess: async () => ({ handle: launch, observation: running }),
    } as unknown as WindowsNativeAuthority;
    const fallback = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const completed = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const manager = new ProcessManager({ stop: fallback }, undefined, undefined, undefined, process.cwd(), nativeAuthority);
    const result = await manager.start({ executable: process.execPath, args: [], cwd: process.cwd(), nativeBinding: binding }, undefined, undefined, completed);
    expect(result).toMatchObject({ ok: true, value: { state: 'running' } });
    if (!result.ok) throw new Error('Native fixture failed to start');
    return { manager, processId: result.value.processId, launch, inspect, fallback, completed };
  }

  it('accepts the cancellation receipt before resolving stop and never invokes the generic terminator', async () => {
    const test = await fixture(async () => terminal);
    await expect(test.manager.stop(test.processId)).resolves.toEqual({ ok: true, value: undefined });
    expect(test.launch.cancel).toHaveBeenCalledOnce();
    expect(test.fallback).not.toHaveBeenCalled();
    expect(test.completed).toHaveBeenCalledOnce();
    expect(test.manager.status(test.processId)).toMatchObject({ ok: true, value: { state: 'stopped', exitCode: 0 } });
  });

  it('polls for verified native completion when cancellation initially reports running', async () => {
    const test = await fixture(async () => running);
    test.inspect.mockResolvedValueOnce(running).mockResolvedValue(terminal);
    const stopping = test.manager.stop(test.processId);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(stopping).resolves.toMatchObject({ ok: true });
    expect(test.launch.cancel).toHaveBeenCalledOnce();
    expect(test.inspect).toHaveBeenCalledTimes(2);
    expect(test.fallback).not.toHaveBeenCalled();
    expect(test.completed).toHaveBeenCalledOnce();
  });

  it.each(['unknown', 'rejected'])('retains the stop waiter and reservation after %s cancellation until native proof arrives', async (outcome) => {
    const test = await fixture(async () => {
      if (outcome === 'rejected') throw new Error('native transport unavailable');
      return unknown;
    });
    test.inspect.mockResolvedValue(unknown);
    let settled = false;
    const stopping = test.manager.stop(test.processId).then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(test.launch.cancel).toHaveBeenCalledOnce();
    expect(test.manager.status(test.processId)).toMatchObject({ ok: true, value: { state: 'termination_unverified' } });
    expect(settled).toBe(false);
    expect(test.fallback).not.toHaveBeenCalled();
    expect(test.completed).not.toHaveBeenCalled();
    test.inspect.mockResolvedValue(terminal);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(stopping).resolves.toMatchObject({ ok: true });
    expect(test.completed).toHaveBeenCalledOnce();
    expect(test.manager.status(test.processId)).toMatchObject({ ok: true, value: { state: 'stopped' } });
  });
});
