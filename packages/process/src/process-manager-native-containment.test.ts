import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessManager } from './process-manager.js';
import { WindowsNativeAuthority, type NativeAttemptBinding, type WindowsContainmentRpcRequest, type WindowsContainmentServiceClient } from './windows-native-authority.js';

const spawn = vi.hoisted(() => vi.fn(() => { throw new Error('Service attempts must not spawn an observer'); }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawn }));
const binding: NativeAttemptBinding = { taskId: '00131f0c-0294-47d4-a04c-b9aa05c791ea', reservationId: 'reservation', attemptId: 'attempt',
  generation: 1, requestDigest: 'a'.repeat(64), ownerClientId: 'client', ownerSessionId: 'session', workspaceId: 'workspace' };
const running = { identity: binding, phase: 3, targetPid: 1234, reservationHeld: true };
const terminal = { identity: binding, phase: 4, outcome: 0, exitCode: 0, activeProcesses: 0, reservationHeld: false };
const unknown = { identity: binding, phase: 5, reason: 'proof_unavailable', reservationHeld: true };
const spec = { executable: process.execPath, args: [], cwd: process.cwd(), nativeBinding: binding, timeoutMs: 100 };

interface ProcessManagerFixture {
  manager: ProcessManager;
  authority: WindowsNativeAuthority;
  request: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
  output: ReturnType<typeof vi.fn>;
  watcher: ReturnType<typeof vi.fn>;
  genericStop: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function fixture(): ProcessManagerFixture {
  const observe = vi.fn<() => Promise<unknown>>().mockResolvedValue(running);
  const output = vi.fn<(request: WindowsContainmentRpcRequest) => Promise<unknown>>().mockImplementation(async request => {
    const cursor = request.command === 'read_output' ? request.outputCursor : undefined;
    return { identity: binding, stdoutBase64: '', stderrBase64: '', stdoutTruncated: false, stderrTruncated: false,
      nextCursor: cursor, finalCursor: cursor, complete: true, persisted: true, persistenceStatus: 'persisted', incompleteReason: null };
  });
  const request = vi.fn(async (input: WindowsContainmentRpcRequest): Promise<unknown> => {
    if (input.command === 'prepare') return { identity: binding, phase: 0, reservationHeld: true };
    if (input.command === 'run') return running;
    if (input.command === 'read_output') return output(input);
    return observe();
  });
  const watcher = vi.fn();
  const client: WindowsContainmentServiceClient = { async request<T>(input): Promise<T> { return await request(input) as T; }, startWatcher: watcher };
  const authority = new WindowsNativeAuthority({ helper: { executable: path.resolve('unused-helper.exe'), sha256: 'a'.repeat(64), buildId: 'lnwjud-containment-v2' },
    pin: { modulePath: path.resolve('unused-pin.node'), sha256: 'b'.repeat(64) } }, client);
  const release = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const genericStop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const manager = new ProcessManager({ stop: genericStop }, undefined, undefined, undefined, process.cwd(), authority);
  return { manager, authority, request, observe, output, watcher, genericStop, release };
}

// These exercise the RPC parser and caller contract; installed SCM/native acceptance is separate.
describe.skipIf(process.platform !== 'win32')('ProcessManager service observation and output', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });

  it('never reports restarted Job zero-process proof with unknown exit status as success', async () => {
    const f = fixture();
    await f.manager.start(spec, undefined, undefined, f.release);
    f.observe.mockResolvedValue({ ...terminal, outcome: 3, exitCode: 125 });
    await vi.advanceTimersByTimeAsync(500);
    expect(f.manager.status(binding.taskId)).toMatchObject({ ok: true, value: { state: 'failed', exitCode: 125 } });
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('observes native timeout without a watcher child or a competing host cancellation timer', async () => {
    const f = fixture();
    expect(await f.manager.start(spec, undefined, undefined, f.release)).toMatchObject({ ok: true, value: { state: 'running', pid: 1234 } });
    f.observe.mockResolvedValue({ ...terminal, outcome: 2, exitCode: 124 });
    await vi.advanceTimersByTimeAsync(500);
    expect(f.manager.status(binding.taskId)).toMatchObject({ ok: true, value: { state: 'timed_out', exitCode: 124 } });
    expect(f.request.mock.calls.some(([r]) => r.command === 'cancel')).toBe(false);
    expect(spawn).not.toHaveBeenCalled(); expect(f.watcher).not.toHaveBeenCalled(); expect(f.genericStop).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('reads final output before release and decodes UTF-8 across byte cursors without duplication', async () => {
    const f = fixture(); const text = Buffer.from('hello ภาษาไทย 😀');
    f.output.mockImplementation(async request => {
      const cursor = request.command === 'read_output' ? request.outputCursor : undefined;
      const offset = cursor?.stdoutOffset ?? 0;
      const next = offset === 0 ? 8 : text.length;
      return { identity: binding, stdoutBase64: text.subarray(offset, next).toString('base64'), stderrBase64: '',
        stdoutTruncated: false, stderrTruncated: false, nextCursor: { stdoutOffset: next, stderrOffset: 0 },
        finalCursor: next === text.length ? { stdoutOffset: next, stderrOffset: 0 } : null, complete: next === text.length,
        persisted: true, persistenceStatus: 'persisted', incompleteReason: null };
    });
    await f.manager.start(spec, undefined, undefined, f.release);
    f.observe.mockResolvedValue(terminal);
    f.release.mockImplementation(async () => {
      const logs = f.manager.logs(binding.taskId, {});
      expect(logs.ok && logs.value.entries.map(entry => entry.text).join('')).toBe(text.toString());
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(f.manager.status(binding.taskId)).toMatchObject({ ok: true, value: { state: 'exited' } });
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.manager.logs(binding.taskId, {})).toMatchObject({ ok: true, value: { truncated: false } });
  });

  it.each(['unavailable', 'incomplete', 'truncated', 'hung'])('preserves terminal proof and reports %s output separately', async mode => {
    const f = fixture();
    await f.manager.start(spec, undefined, undefined, f.release);
    f.observe.mockResolvedValue(terminal);
    f.output.mockImplementation(async request => {
      if (mode === 'unavailable') throw new Error('output lost');
      if (mode === 'hung') return new Promise(() => undefined);
      const cursor = request.command === 'read_output' ? request.outputCursor : undefined;
      return { identity: binding, stdoutBase64: '', stderrBase64: '', stdoutTruncated: mode === 'truncated', stderrTruncated: false,
        nextCursor: cursor, finalCursor: mode === 'incomplete' ? null : cursor, complete: mode !== 'incomplete',
        persisted: true, persistenceStatus: 'persisted', incompleteReason: null };
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.manager.status(binding.taskId)).toMatchObject({ ok: true, value: { state: 'exited', exitCode: 0, error: expect.stringMatching(/output/i) } });
    expect(f.manager.logs(binding.taskId, {})).toMatchObject({ ok: true, value: { truncated: true, entries: expect.arrayContaining([expect.objectContaining({ stream: 'stderr', text: expect.stringMatching(/output/i) })]) } });
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('retains unknown admission and later recovers without replaying prepare or run', async () => {
    const f = fixture(); await f.manager.start(spec, undefined, undefined, f.release);
    f.observe.mockResolvedValue(unknown); await vi.advanceTimersByTimeAsync(500);
    expect(f.manager.status(binding.taskId)).toMatchObject({ ok: true, value: { state: 'termination_unverified' } });
    expect(f.release).not.toHaveBeenCalled();
    f.observe.mockResolvedValue(terminal); await vi.advanceTimersByTimeAsync(1500);
    expect(f.manager.status(binding.taskId)).toMatchObject({ ok: true, value: { state: 'exited' } });
    expect(f.request.mock.calls.filter(([r]) => r.command === 'prepare')).toHaveLength(1);
    expect(f.request.mock.calls.filter(([r]) => r.command === 'run')).toHaveLength(1);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('attaches recovery without executable resolution, preparation or submission', async () => {
    const f = fixture(); f.observe.mockResolvedValue(terminal);
    expect(await f.manager.attach({ ...spec, executable: 'missing-program' }, undefined, f.release)).toMatchObject({ ok: true, value: { state: 'exited' } });
    expect(f.request.mock.calls.some(([r]) => r.command === 'prepare' || r.command === 'run')).toBe(false);
    expect(f.release).toHaveBeenCalledOnce(); expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['ownerSessionId', 'attemptId', 'generation', 'requestDigest'])('retains reservation on mismatched terminal %s', async field => {
    const f = fixture(); await f.manager.start(spec, undefined, undefined, f.release);
    f.observe.mockResolvedValue({ ...terminal, identity: { ...binding, [field]: field === 'generation' ? 2 : 'wrong' } });
    await vi.advanceTimersByTimeAsync(500);
    expect(f.manager.status(binding.taskId)).toMatchObject({ ok: true, value: { state: 'termination_unverified' } });
    expect(f.release).not.toHaveBeenCalled();
  });

  it('coalesces callbacks and retries an idempotent release only after its rejected attempt settles', async () => {
    const f = fixture(); f.release.mockRejectedValueOnce(new Error('readback unavailable'));
    await f.manager.start(spec, undefined, undefined, f.release); f.observe.mockResolvedValue(terminal);
    await vi.advanceTimersByTimeAsync(300);
    expect(f.manager.status(binding.taskId)).toMatchObject({ ok: true, value: { state: 'termination_unverified' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.manager.status(binding.taskId)).toMatchObject({ ok: true, value: { state: 'exited' } });
    expect(f.release).toHaveBeenCalledTimes(2);
    await f.manager.stop(binding.taskId); expect(f.release).toHaveBeenCalledTimes(2);
  });
});
