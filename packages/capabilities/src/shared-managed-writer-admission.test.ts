import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WindowsNativeAuthority } from '@lnwjud/process';
import type { NativeAttemptBinding, WindowsContainmentServiceClient, WindowsContainmentRpcRequest } from '../../process/src/windows-native-authority.js';
import { SharedManagedWriterAdmission } from './shared-managed-writer-admission.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{
  root: string; authority: WindowsNativeAuthority; taskDirectory: string; admission: SharedManagedWriterAdmission;
  taskId: string; receiptPath: string;
  input: { actorClientId: string; actorSessionId: string; workspaceId: string; kind: 'contained_process'; nativeTaskId: string; nativeReceiptPath: string };
}> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'managed-writer-proof-')));
  roots.push(root);
  const aborted = new Map<string, NativeAttemptBinding>();
  const client: WindowsContainmentServiceClient = {
    async request<T>(request: WindowsContainmentRpcRequest): Promise<T> {
      const existing = aborted.get(request.identity.attemptId);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(request.identity)) throw new Error('SERVICE_IDENTITY_MISMATCH');
      if (request.command === 'abort') aborted.set(request.identity.attemptId, request.identity);
      else if (request.command !== 'inspect' || existing === undefined) throw new Error('SERVICE_ATTEMPT_UNAVAILABLE');
      const response: unknown = { identity: request.identity, phase: 2, reservationHeld: false };
      return response as T;
    },
    async startWatcher(): Promise<void> { throw new Error('Unit fixture never launches a process'); },
  };
  const authority = new WindowsNativeAuthority({ helper: { executable: path.join(root, 'helper.exe'), sha256: 'a'.repeat(64), buildId: 'lnwjud-containment-v2' }, pin: { modulePath: path.join(root, 'pin.node'), sha256: 'a'.repeat(64) }, profileDirectory: path.join(root, 'profile') }, client);
  const taskDirectory = path.join(root, 'tasks');
  const admission = new SharedManagedWriterAdmission(taskDirectory, authority);
  const taskId = randomUUID();
  const receiptPath = path.join(root, 'native', taskId, 'containment.receipt.json');
  const input = { actorClientId: 'client', actorSessionId: 'session', workspaceId: 'workspace', kind: 'contained_process' as const, nativeTaskId: taskId, nativeReceiptPath: receiptPath };
  return { root, authority, taskDirectory, admission, taskId, receiptPath, input };
}

describe('SharedManagedWriterAdmission authenticated release', () => {
  it.skipIf(process.platform === 'darwin')('persists distinct process and reservation identity and the actual owner session', async () => {
    const f = await fixture();
    const admitted = await f.admission.enter(f.input);
    expect(admitted.ok).toBe(true); if (!admitted.ok) return;
    expect(admitted.value.nativeBinding).toMatchObject({ taskId: f.taskId, reservationId: admitted.value.id, ownerSessionId: 'session' });
    expect(admitted.value.id).not.toBe(f.taskId);
    const markers = path.join(f.taskDirectory, '.index', 'v1', 'active');
    const files = await readdir(markers);
    expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(markers, files[0]!), 'utf8'))).toMatchObject({ nativeBinding: admitted.value.nativeBinding });
  });

  it.skipIf(process.platform === 'darwin')('retains forged terminal proof across restart and releases only after an exclusive authenticated abort', async () => {
    const f = await fixture(); const admitted = await f.admission.enter(f.input);
    expect(admitted.ok).toBe(true); if (!admitted.ok) return;
    await mkdir(path.dirname(f.receiptPath), { recursive: true });
    await writeFile(f.receiptPath, JSON.stringify({ kind: 'windows_job_v1', activeProcesses: 0, outcome: 'completed', exitCode: 0 }));
    await expect(admitted.value.releaseAfterVerifiedTermination()).rejects.toThrow('MANAGED_WRITER_RELEASE_UNVERIFIED');
    const reopened = new SharedManagedWriterAdmission(f.taskDirectory, f.authority);
    expect(await reopened.holdExclusiveProbe('workspace')).toMatchObject({ ok: false });
    await admitted.value.abortBeforeLaunch?.();
    const probe = await reopened.holdExclusiveProbe('workspace');
    expect(probe.ok).toBe(true); if (probe.ok) await probe.value.releaseAfterVerifiedTermination();
  });

  it.skipIf(process.platform === 'darwin')('refuses another session proof even when process and reservation IDs match', async () => {
    const f = await fixture(); const admitted = await f.admission.enter(f.input);
    expect(admitted.ok).toBe(true); if (!admitted.ok || admitted.value.nativeBinding === undefined) return;
    await f.authority.abortBeforeLaunch({ directory: path.dirname(f.receiptPath), binding: { ...admitted.value.nativeBinding, ownerSessionId: 'other-session' } });
    await expect(admitted.value.releaseAfterVerifiedTermination()).rejects.toThrow('MANAGED_WRITER_RELEASE_UNVERIFIED');
    expect(await new SharedManagedWriterAdmission(f.taskDirectory, f.authority).holdExclusiveProbe('workspace')).toMatchObject({ ok: false });
  });

  it.skipIf(process.platform === 'darwin')('requires full native identity and canonical receipt path before reserving', async () => {
    const f = await fixture();
    const missingSession = { ...f.input };
    Reflect.deleteProperty(missingSession, 'actorSessionId');
    expect(await f.admission.enter(missingSession)).toMatchObject({ ok: false, error: {
      code: 'INVALID_INPUT', message: 'Contained writer native attempt or session identity is invalid',
    } });
    expect(await f.admission.enter({ ...f.input, nativeReceiptPath: path.join(f.root, 'receipt.json') })).toMatchObject({ ok: false, error: {
      code: 'INVALID_INPUT', message: 'Contained writer receipt path does not match native attempt identity',
    } });
    expect(await new SharedManagedWriterAdmission(f.taskDirectory).enter(f.input)).toMatchObject({ ok: false, error: {
      code: 'INVALID_INPUT', message: 'Contained writer trusted native authority is unavailable',
    } });
  });

  it('denies new macOS process writers before reservation but still permits bounded synchronous mutations', async () => {
    const f = await fixture();
    const admission = new SharedManagedWriterAdmission(f.taskDirectory, f.authority, 'darwin');
    for (const input of [f.input, { actorClientId: 'owner', workspaceId: 'workspace', kind: 'uncontained_process' as const }]) {
      expect(await admission.enter(input)).toMatchObject({
        ok: false, error: { code: 'CONFLICT' },
      });
    }
    const synchronous = await admission.enter({ actorClientId: 'owner', workspaceId: 'workspace', kind: 'synchronous_mutation' });
    expect(synchronous.ok).toBe(true);
    if (synchronous.ok) await synchronous.value.releaseAfterVerifiedTermination();
    const probe = await admission.holdExclusiveProbe('workspace');
    expect(probe.ok).toBe(true);
    if (probe.ok) await probe.value.releaseAfterVerifiedTermination();
  });

  it.skipIf(process.platform === 'darwin')('retains an old uncontained reservation after restart rather than inferring descendants are gone', async () => {
    const f = await fixture();
    expect(await f.admission.enter({ actorClientId: 'old-host', workspaceId: 'workspace', kind: 'uncontained_process' })).toMatchObject({ ok: true });
    expect(await new SharedManagedWriterAdmission(f.taskDirectory, f.authority).holdExclusiveProbe('workspace')).toMatchObject({ ok: false });
  });
});
