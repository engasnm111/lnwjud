import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { WindowsNativeAuthority, type NativeAttemptBinding, type WindowsContainmentServiceClient } from './windows-native-authority.js';

const binding: NativeAttemptBinding = { taskId: 'task', reservationId: 'reservation', attemptId: 'attempt', generation: 1,
  requestDigest: 'a'.repeat(64), ownerClientId: 'client', ownerSessionId: 'session', workspaceId: 'workspace' };
const configuration = { helper: { executable: path.resolve('helper.exe'), sha256: 'a'.repeat(64), buildId: 'lnwjud-containment-v2' },
  pin: { modulePath: path.resolve('pin.node'), sha256: 'b'.repeat(64) } };
const receipt = { version: 2, state: 'prepared', nativeIdentity: '0000000000000001-' + 'A'.repeat(32), commit: 'c'.repeat(40) };

function fixture(response: unknown): { authority: WindowsNativeAuthority; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async () => response);
  const client: WindowsContainmentServiceClient = { async request<T>(input): Promise<T> { return await request(input) as T; }, async startWatcher() {} };
  return { authority: new WindowsNativeAuthority(configuration, client), request };
}

describe('Windows service interrupted restart contract', () => {
  it('releases proven-zero process admission without fabricating a successful target exit', async () => {
    const response = { identity: binding, phase: 4, outcome: 3, exitCode: 125, activeProcesses: 0, reservationHeld: false };
    const valid = fixture(response);
    expect(await valid.authority.inspect({ binding })).toEqual({ state: 'terminal_verified', binding, outcome: 'interrupted', exitCode: 125, activeProcesses: 0 });
    const invalid = fixture({ ...response, exitCode: 0 });
    expect(await invalid.authority.inspect({ binding })).toMatchObject({ state: 'termination_unknown' });
    const retained = fixture({ ...response, reservationHeld: true });
    expect(await retained.authority.inspect({ binding })).toMatchObject({ state: 'termination_unknown' });
  });
});

describe('Windows service start diagnostics remain fail-closed', () => {
  it.each([
    { message: 'PIPE_LAUNCH_SESSION_UNVERIFIED', reason: 'PIPE_LAUNCH_SESSION_UNVERIFIED' },
    { message: 'SERVICE_OWNER_MISMATCH', reason: 'SERVICE_OWNER_MISMATCH' },
    { message: 'C:\\Users\\secret\\private-file.txt', reason: 'NATIVE_SERVICE_START_UNRESOLVED' },
  ])('returns only a bounded symbolic failure code without releasing the native reservation: $message', async ({ message, reason }) => {
    const client: WindowsContainmentServiceClient = {
      async request<T>(request): Promise<T> {
        if (request.command === 'prepare') return { phase: 0, identity: binding, reservationHeld: true } as T;
        throw new Error(message);
      },
      async startWatcher() {},
    };
    const authority = new WindowsNativeAuthority(configuration, client);
    const launch = await authority.prepare({ directory: path.resolve('attempt'), binding,
      executable: path.resolve('task.exe'), args: [], cwd: path.resolve('workspace'), timeoutMs: 10_000 });
    const destroy = vi.fn();
    const fakeChild = { stdin: { destroy, end: vi.fn() } } as unknown as ChildProcess;
    expect(await launch.connect(fakeChild)).toEqual({ state: 'termination_unknown', binding, reason });
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe('Windows service import control boundary', () => {
  it('sends import control to the service and verifies the full identity, command, and native receipt', async () => {
    const f = fixture({ identity: binding, command: 'prepare_import', verified: true, result: receipt });
    const request = { commit: receipt.commit, workspaceRoot: path.resolve('workspace'), destination: 'repo', stagePath: path.resolve('stage'), privateHome: path.resolve('home') };
    expect(await f.authority.control({ directory: path.resolve('attempt'), binding, command: 'prepare_import', request }))
      .toEqual({ state: 'control_verified', binding, command: 'prepare_import', result: receipt });
    expect(f.request).toHaveBeenCalledWith({ protocol: 3, command: 'control', identity: binding, controlCommand: 'prepare_import', controlRequest: request });
  });

  it.each([
    { identity: { ...binding, ownerSessionId: 'other-session' }, command: 'prepare_import', verified: true, result: receipt },
    { identity: binding, command: 'publish_import', verified: true, result: receipt },
    { identity: binding, command: 'prepare_import', verified: false, result: receipt },
    { identity: binding, command: 'prepare_import', verified: true, result: { ...receipt, state: 'published' } },
    { identity: binding, command: 'prepare_import', verified: true, result: { ...receipt, nativeIdentity: 'forged' } },
    { identity: binding, command: 'prepare_import', verified: true, result: { ...receipt, commit: 'd'.repeat(40) } },
  ])('refuses mismatched or incomplete service evidence %#', async (response) => {
    const f = fixture(response);
    expect(await f.authority.control({ directory: path.resolve('attempt'), binding, command: 'prepare_import', request: { commit: receipt.commit } }))
      .toMatchObject({ state: 'termination_unknown' });
  });

  it('reads service-owned publication evidence without trusting an attempt-directory file', async () => {
    const published = { ...receipt, state: 'published' };
    const f = fixture({ identity: binding, command: 'publish_import', verified: true, result: published });
    expect(await f.authority.inspectControl({ directory: path.resolve('caller-controlled-missing-directory'), binding, command: 'publish_import' }))
      .toEqual({ state: 'control_verified', binding, command: 'publish_import', result: published });
    expect(f.request).toHaveBeenCalledWith({ protocol: 3, command: 'inspect_control', identity: binding, controlCommand: 'publish_import' });
  });
});
