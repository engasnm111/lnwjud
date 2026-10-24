import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WindowsNativeAuthority, type NativeAttemptBinding, type WindowsContainmentRpcRequest, type WindowsContainmentServiceClient } from './windows-native-authority.js';

const binding: NativeAttemptBinding = { taskId: 'task', reservationId: 'reservation', attemptId: 'attempt', generation: 1, requestDigest: 'a'.repeat(64), ownerClientId: 'client', ownerSessionId: 'session', workspaceId: 'workspace' };
const configuration = { helper: { executable: path.resolve('helper.exe'), sha256: 'a'.repeat(64), buildId: 'lnwjud-containment-v2' }, pin: { modulePath: path.resolve('pin.node'), sha256: 'b'.repeat(64) } };
const input = { binding, executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(), timeoutMs: 1000, environment: { FIXTURE: 'value' } };
const prepared = { identity: binding, phase: 0, reservationHeld: true };
const running = { identity: binding, phase: 3, reservationHeld: true, targetPid: 1234 };
const terminal = { identity: binding, phase: 4, reservationHeld: false, activeProcesses: 0, outcome: 0, exitCode: 0 };

function fixture(respond: (request: WindowsContainmentRpcRequest) => Promise<unknown>): { authority: WindowsNativeAuthority; request: ReturnType<typeof vi.fn>; startWatcher: ReturnType<typeof vi.fn> } {
  const request = vi.fn(respond);
  const startWatcher = vi.fn(async (): Promise<void> => { throw new Error('watcher must not be started'); });
  const client: WindowsContainmentServiceClient = { async request<T>(value): Promise<T> { return await request(value) as T; }, startWatcher };
  return { authority: new WindowsNativeAuthority(configuration, client), request, startWatcher };
}

describe('service-owned attempt handles', () => {
  it('submits once without a watcher and coalesces concurrent identical submissions', async () => {
    const f = fixture(async (request) => request.command === 'prepare' ? prepared : running);
    const [first, second] = await Promise.all([f.authority.submitProcess(input), f.authority.submitProcess(input)]);
    expect(first.handle).toBe(second.handle);
    expect(first.observation).toMatchObject({ state: 'running', targetPid: 1234 });
    expect(f.request.mock.calls.map(([request]) => request.command)).toEqual(['prepare', 'run']);
    expect(f.startWatcher).not.toHaveBeenCalled();
    await expect(f.authority.submitProcess({ ...input, args: ['different'] })).rejects.toThrow('NATIVE_ATTEMPT_CONFLICT');
    await expect(f.authority.submitProcess({ ...input, binding: { ...binding, ownerSessionId: 'other' } })).rejects.toThrow('NATIVE_ATTEMPT_CONFLICT');
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { message: 'PIPE_LAUNCH_SESSION_CHANGE_FAILED_WIN32_5', reason: 'PIPE_LAUNCH_SESSION_CHANGE_FAILED_WIN32_5' },
    { message: 'C:\\\\Users\\\\private\\\\secret.txt', reason: 'NATIVE_SERVICE_SUBMISSION_UNRESOLVED' },
  ])('preserves only safe service diagnostics while retaining unknown dispatch: $message', async ({ message, reason }) => {
    const f = fixture(async (request) => {
      if (request.command === 'prepare') return prepared;
      throw new Error(message);
    });
    const submission = await f.authority.submitProcess(input);
    expect(submission.observation).toEqual({ state: 'termination_unknown', binding, reason });
    expect(f.request.mock.calls.map(([request]) => request.command)).toEqual(['prepare', 'run']);
  });

  it('keeps a recoverable handle after ambiguous dispatch without replaying it', async () => {
    let inspected = false;
    const f = fixture(async (request) => {
      if (request.command === 'prepare') return prepared;
      if (request.command === 'run') throw new Error('response lost');
      inspected = true;
      return terminal;
    });
    const submission = await f.authority.submitProcess(input);
    expect(submission.observation).toMatchObject({ state: 'termination_unknown' });
    expect(inspected).toBe(false);
    expect(await submission.handle.observe()).toMatchObject({ state: 'terminal_verified' });
    await f.authority.submitProcess(input);
    expect(f.request.mock.calls.filter(([request]) => request.command === 'run')).toHaveLength(1);
  });

  it.each([running, terminal, { identity: binding, phase: 1, reservationHeld: true }, { identity: binding, phase: 2, reservationHeld: false }])('does not dispatch an existing attempt %#', async (observation) => {
    const f = fixture(async () => observation);
    await f.authority.submitProcess(input);
    expect(f.request.mock.calls.map(([request]) => request.command)).toEqual(['prepare']);
  });

  it('refuses wrong native identity and does not run or cancel the foreign attempt', async () => {
    const f = fixture(async () => ({ ...prepared, identity: { ...binding, generation: 2 } }));
    expect((await f.authority.submitProcess(input)).observation).toMatchObject({ state: 'termination_unknown' });
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it('attaches after observer loss using inspect only', async () => {
    const f = fixture(async () => terminal);
    const handle = f.authority.attachProcess(binding);
    expect(await handle.observe()).toMatchObject({ state: 'terminal_verified' });
    expect(f.request.mock.calls.map(([request]) => request.command)).toEqual(['inspect']);
  });

  it('records abort before prepare when the caller is already cancelled', async () => {
    const f = fixture(async () => ({ identity: binding, phase: 2, reservationHeld: false }));
    const controller = new AbortController(); controller.abort();
    expect((await f.authority.submitProcess({ ...input, signal: controller.signal })).observation).toMatchObject({ state: 'launch_not_started' });
    expect(f.request.mock.calls.map(([request]) => request.command)).toEqual(['abort']);
  });

  it('keeps output errors separate from verified process completion', async () => {
    const f = fixture(async (request) => {
      if (request.command === 'read_output') throw new Error('output unavailable');
      return terminal;
    });
    const handle = f.authority.attachProcess(binding);
    expect(await handle.readOutput({ stdoutOffset: 0, stderrOffset: 0 })).toMatchObject({ state: 'unavailable' });
    expect(await handle.observe()).toMatchObject({ state: 'terminal_verified' });
  });

  it('preserves byte deltas and validates cursor, final and persistence evidence', async () => {
    const f = fixture(async () => ({ identity: binding, stdoutBase64: 'gJA=', stderrBase64: '', stdoutTruncated: false, stderrTruncated: true, complete: true, nextCursor: { stdoutOffset: 6, stderrOffset: 0 }, finalCursor: { stdoutOffset: 6, stderrOffset: 0 }, persisted: true, persistenceStatus: 'persisted', incompleteReason: null }));
    const output = await f.authority.attachProcess(binding).readOutput({ stdoutOffset: 4, stderrOffset: 0 });
    expect(output).toMatchObject({ state: 'available', stdout: Buffer.from([0x80, 0x90]), nextCursor: { stdoutOffset: 6, stderrOffset: 0 }, persistence: { state: 'persisted' } });
    expect(f.request).toHaveBeenCalledWith({ protocol: 3, command: 'read_output', identity: binding, outputCursor: { stdoutOffset: 4, stderrOffset: 0 } });
  });

  it.each([
    { stdoutBase64: '!!!!' }, { nextCursor: { stdoutOffset: 0, stderrOffset: 0 } },
    { finalCursor: null }, { persisted: false }, { stdoutTruncated: 'yes' },
    { identity: { ...binding, generation: 2 } }, { identity: undefined },
  ])('refuses malformed or contradictory output %#', async (invalid) => {
    const f = fixture(async () => ({ identity: binding, stdoutBase64: 'YQ==', stderrBase64: '', stdoutTruncated: false, stderrTruncated: false, complete: true, nextCursor: { stdoutOffset: 1, stderrOffset: 0 }, finalCursor: { stdoutOffset: 1, stderrOffset: 0 }, persisted: true, persistenceStatus: 'persisted', incompleteReason: null, ...invalid }));
    expect(await f.authority.attachProcess(binding).readOutput({ stdoutOffset: 0, stderrOffset: 0 })).toMatchObject({ state: 'unavailable' });
  });
});
