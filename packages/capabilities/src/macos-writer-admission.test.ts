import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacosNativeAuthority, type NativeAttemptBinding } from '@lnwjud/process';
import { SharedManagedWriterAdmission } from './shared-managed-writer-admission.js';
import { DurableShellTaskStore } from './durable-shell-task-store.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
interface Fixture {
  readonly root: string;
  readonly authority: MacosNativeAuthority;
  readonly calls: string[];
  setState(value: 'prepared' | 'running' | 'terminal' | 'unknown' | 'aborted'): void;
  setAvailable(value: boolean): void;
}
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-macos-owner-'));
  roots.push(root);
  let state: 'prepared' | 'running' | 'terminal' | 'unknown' | 'aborted' = 'prepared';
  let available = true;
  const calls: string[] = [];
  let registered: NativeAttemptBinding | undefined;
  const authority = new MacosNativeAuthority({ request: async (request): Promise<unknown> => {
    calls.push(request.command);
    if (request.command === 'health') return { state: available ? 'available' : 'unavailable', contract: 'lnwjud-macos-process-owner-v1' };
    if (request.command === 'prepare') registered ??= request.binding;
    if (request.command === 'run') state = 'running';
    if (request.command === 'abort' && state === 'prepared') state = 'aborted';
    if (request.command === 'read_output') return { state: 'available', binding: registered,
      stdout: Buffer.from('native output').toString('base64'), stderr: '', stdoutTruncated: false, stderrTruncated: false,
      complete: state === 'terminal', nextCursor: { stdoutOffset: 13, stderrOffset: 0 },
      finalCursor: state === 'terminal' ? { stdoutOffset: 13, stderrOffset: 0 } : null, persistence: { state: 'persisted' } };
    return state === 'running' ? { state: 'running', binding: registered, targetPid: 42 }
      : state === 'terminal' ? { state: 'terminal_verified', binding: registered, outcome: 'completed', exitCode: 0, activeProcesses: 0 }
        : state === 'aborted' ? { state: 'launch_not_started', binding: registered }
          : { state: 'termination_unknown', binding: registered, reason: state === 'prepared' ? 'MACOS_ATTEMPT_PREPARED' : 'MACOS_EVENT_STREAM_GAP' };
  } });
  return { root, authority, calls, setState: (value: typeof state): void => { state = value; }, setAvailable: (value: boolean): void => { available = value; } };
}

describe('macOS managed and durable native admission', () => {
  it('refuses an unenrolled owner before writing a reservation', async () => {
    const f = await fixture(); f.setAvailable(false);
    const admission = new SharedManagedWriterAdmission(f.root, undefined, 'darwin', f.authority);
    const result = await admission.enter({ actorClientId: 'client', actorSessionId: 'session', workspaceId: 'workspace', kind: 'contained_process',
      nativeTaskId: randomUUID(), nativeReceiptPath: path.join(f.root, 'native', 'containment.receipt.json') });
    expect(result.ok).toBe(false);
    expect(await readdir(f.root)).toEqual([]);
  });

  it('registers an owner-bound native attempt and releases it on native prelaunch abort', async () => {
    const f = await fixture();
    const taskId = randomUUID();
    const admission = new SharedManagedWriterAdmission(f.root, undefined, 'darwin', f.authority);
    const result = await admission.enter({ actorClientId: 'client', actorSessionId: 'session', workspaceId: 'workspace', kind: 'contained_process',
      nativeTaskId: taskId, nativeReceiptPath: path.join(f.root, taskId, 'containment.receipt.json') });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.nativeBinding).toMatchObject({ taskId, reservationId: result.value.id, ownerSessionId: 'session' });
    expect(f.calls).toEqual(['health', 'prepare']);
    await result.value.abortBeforeLaunch?.();
    expect(await readdir(path.join(f.root, '.index', 'v1', 'active'))).toEqual([]);
  });

  it('runs durable work in the native daemon and reconciles final output without a Node coordinator', async () => {
    const f = await fixture();
    const probe = vi.fn(async () => { throw new Error('A PID probe is not native termination proof'); });
    const store = new DurableShellTaskStore(f.root, { platform: 'darwin', macosNativeAuthority: f.authority, posixProcessIdentityProbe: probe });
    const request = { taskId: randomUUID(), executable: '/bin/echo', arguments: ['native output'], cwd: '/tmp', timeoutSeconds: 30,
      maxOutputBytes: 1024, includeStdout: true, includeStderr: true, owner: { clientId: 'client', sessionId: 'session', workspaceId: 'workspace' } };
    const launched = await store.launch(request);
    expect(launched.ok).toBe(true); if (!launched.ok) return;
    expect(launched.value).toMatchObject({ state: 'running', child_pid: 42, durable: true });
    expect(launched.value.worker_pid).toBeUndefined();
    f.setState('terminal');
    const complete = await store.snapshot(request.taskId, undefined, request.owner);
    expect(complete.ok).toBe(true); if (!complete.ok) return;
    expect(complete.value).toMatchObject({ state: 'completed', exit_code: 0, stdout: 'native output' });
    expect(await readdir(path.join(f.root, '.index', 'v1', 'active'))).toHaveLength(0);
    await store.launch(request);
    expect(f.calls.filter(command => command === 'run')).toHaveLength(1);
    expect(probe).not.toHaveBeenCalled();
  });

  it('keeps the native reservation after an event stream gap instead of inferring safety from missing PIDs', async () => {
    const f = await fixture();
    const probe = vi.fn(async () => ({ state: 'gone' as const }));
    const store = new DurableShellTaskStore(f.root, { platform: 'darwin', macosNativeAuthority: f.authority, posixProcessIdentityProbe: probe });
    const owner = { clientId: 'client', sessionId: 'session', workspaceId: 'workspace' };
    const taskId = randomUUID();
    await store.launch({ taskId, executable: '/bin/echo', arguments: [], cwd: '/tmp', timeoutSeconds: 30,
      maxOutputBytes: 1024, includeStdout: true, includeStderr: true, owner });
    f.setState('unknown');
    const result = await store.snapshot(taskId, undefined, owner);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.state).toBe('termination_unverified');
    expect(await readdir(path.join(f.root, '.index', 'v1', 'active'))).toHaveLength(1);
    expect(probe).not.toHaveBeenCalled();
  });
});
