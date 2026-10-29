import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WindowsNativeAuthority } from '@lnwjud/process';
import { DurableShellTaskStore, durableShellNativeBinding } from './durable-shell-task-store.js';
import { SecureRepositoryImportRuntime } from './repository-import-runtime.js';
import { repositoryImportWorkerSource } from './repository-import-worker-source.js';

const owner = { clientId: 'client', sessionId: 'session', workspaceId: 'workspace' };
const requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const taskId = 'repository-import-' + requestId;
const commit = 'a'.repeat(40);
const identity = '0123456789ABCDEF-0123456789ABCDEF0123456789ABCDEF';
const binding = { taskId, reservationId: taskId, attemptId: taskId, generation: 1, requestDigest: 'b'.repeat(64), ownerClientId: owner.clientId, ownerSessionId: owner.sessionId, workspaceId: owner.workspaceId };

async function fixture(version = 2): Promise<{
  root: string; directory: string; manifest: Record<string, unknown>;
  inspectControl: ReturnType<typeof vi.fn>; control: ReturnType<typeof vi.fn>; runtime: SecureRepositoryImportRuntime;
}> {
  // Hosted Windows runners can expose the TEMP parent through an 8.3 alias.
  // The production import correctly refuses noncanonical workspace roots.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-import-recovery-')));
  const directory = path.join(root, 'repository-imports', requestId); await mkdir(directory, { recursive: true });
  const originalInput = { request: { workspaceId: owner.workspaceId, requestId, url: 'https://example.invalid/repo.git', destination: 'published', commit }, owner, workspaceRoot: root };
  const requestDigest = createHash('sha256').update(JSON.stringify({ input: originalInput })).digest('hex');
  const core = { version, requestId, owner, commit, workspaceRoot: root, destination: 'published', url: originalInput.request.url, requestDigest, originalInput };
  const manifestDigest = createHash('sha256').update(JSON.stringify(core)).digest('hex');
  const actualBinding = durableShellNativeBinding({
    mutationKind: 'repository_import', taskId, executable: process.execPath,
    arguments: [path.join(directory, 'worker.cjs'), path.join(directory, 'spec.json'), requestDigest, manifestDigest], cwd: directory,
    timeoutSeconds: 900, maxOutputBytes: 4096, includeStdout: true, includeStderr: false, owner,
  });
  const manifest = { ...core, manifestDigest, binding: actualBinding };
  await writeFile(path.join(directory, 'spec.json'), JSON.stringify(manifest));
  const inspectControl = vi.fn().mockResolvedValue({ state: 'termination_unknown', binding, reason: 'missing' });
  const control = vi.fn().mockResolvedValue({ state: 'termination_unknown', binding, reason: 'missing' });
  const authority = { inspectControl, control, config: {} } as unknown as WindowsNativeAuthority;
  return { root, directory, manifest, inspectControl, control, runtime: new SecureRepositoryImportRuntime(root, authority) };
}
function proof(state: 'prepared' | 'published' = 'published'): {
  state: string; binding: typeof binding; command: string;
  result: { version: number; state: 'prepared' | 'published'; nativeIdentity: string; commit: string };
} {
  return { state: 'control_verified', binding, command: state === 'prepared' ? 'prepare_import' : 'publish_import', result: { version: 2, state, nativeIdentity: identity, commit } };
}

afterEach(() => vi.restoreAllMocks());
describe('authenticated repository import recovery', () => {
  it('keeps launch admission starting until native acknowledgement instead of reporting failure', async () => {
    const f = await fixture();
    try {
      vi.spyOn(DurableShellTaskStore.prototype, 'snapshot').mockResolvedValue({ ok: true, value: { state: 'starting' } });
      expect(await f.runtime.status({ taskId, owner })).toMatchObject({ ok: true, value: { state: 'starting' } });
      expect(f.inspectControl).not.toHaveBeenCalled(); expect(f.control).not.toHaveBeenCalled();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it('leaves legacy unsigned publication unresolved without replay or native inspection', async () => {
    const f = await fixture(1);
    try {
      const launch = vi.spyOn(DurableShellTaskStore.prototype, 'launch');
      const snapshot = vi.spyOn(DurableShellTaskStore.prototype, 'snapshot');
      expect(await f.runtime.status({ taskId, owner })).toMatchObject({ ok: true, value: { state: 'unresolved', detail: expect.stringContaining('Legacy') } });
      expect(snapshot).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled(); expect(f.control).not.toHaveBeenCalled();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('never trusts a shape-compatible unsigned receipt even after worker success', async () => {
    const f = await fixture();
    try {
      vi.spyOn(DurableShellTaskStore.prototype, 'snapshot').mockResolvedValue({ ok: true, value: { state: 'completed', exit_code: 0 } });
      await writeFile(path.join(f.directory, 'publication.json'), JSON.stringify(proof().result));
      expect(await f.runtime.status({ taskId, owner })).toMatchObject({ ok: true, value: { state: 'unresolved', detail: 'Native publication proof is incomplete' } });
      expect(f.control).not.toHaveBeenCalled();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('keeps a stopped worker unresolved if authenticated preparation may precede a crashed rename', async () => {
    const f = await fixture();
    try {
      vi.spyOn(DurableShellTaskStore.prototype, 'snapshot').mockResolvedValue({ ok: true, value: { state: 'failed', exit_code: 7 } });
      f.inspectControl.mockImplementation(async (input: { command: string }) => input.command === 'prepare_import' ? proof('prepared') : { state: 'termination_unknown' });
      expect(await f.runtime.status({ taskId, owner })).toMatchObject({ ok: true, value: { state: 'unresolved', detail: expect.stringContaining('publication may have occurred') } });
      expect(f.control).not.toHaveBeenCalled();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('requires authenticated live native identity and successful worker cessation before completion', async () => {
    const f = await fixture();
    try {
      const snapshot = vi.spyOn(DurableShellTaskStore.prototype, 'snapshot').mockResolvedValue({ ok: true, value: { state: 'completed', exit_code: 0 } });
      f.inspectControl.mockResolvedValue(proof()); f.control.mockResolvedValue(proof());
      expect(await f.runtime.status({ taskId, owner })).toMatchObject({ ok: true, value: { state: 'completed', native_identity: identity } });
      f.control.mockResolvedValue({ ...proof(), result: { ...proof().result, nativeIdentity: '0'.repeat(16) + '-' + '0'.repeat(32) } });
      expect(await f.runtime.status({ taskId, owner })).toMatchObject({ ok: true, value: { state: 'unresolved' } });
      snapshot.mockResolvedValue({ ok: true, value: { state: 'termination_unverified' } });
      f.control.mockClear();
      expect(await f.runtime.status({ taskId, owner })).toMatchObject({ ok: true, value: { state: 'unresolved' } });
      expect(f.control).not.toHaveBeenCalled();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('does not expose another owner manifest', async () => {
    const f = await fixture();
    try {
      expect(await f.runtime.status({ taskId, owner: { ...owner, sessionId: 'other' } })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('rejects a manifest whose receipt binding is copied from another attempt or owner', async () => {
    const f = await fixture();
    try {
      for (const changed of [{ attemptId: 'other' }, { reservationId: 'other' }, { ownerSessionId: 'other' }, { workspaceId: 'other' }, { generation: 2 }]) {
        await writeFile(path.join(f.directory, 'spec.json'), JSON.stringify({ ...f.manifest, binding: { ...binding, ...changed } }));
        expect(await f.runtime.status({ taskId, owner })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      }
      expect(f.inspectControl).not.toHaveBeenCalled();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('rejects changed manifest content before trusting any publication or launching a helper', async () => {
    const f = await fixture();
    try {
      for (const changed of [{ destination: 'foreign' }, { workspaceRoot: f.root + '-foreign' }, { url: 'https://example.invalid/other.git' }, { stagePath: 'C:\\foreign' }, { processModule: 'C:\\foreign.js' }]) {
        await writeFile(path.join(f.directory, 'spec.json'), JSON.stringify({ ...f.manifest, ...changed }));
        expect(await f.runtime.status({ taskId, owner })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      }
      expect(f.inspectControl).not.toHaveBeenCalled(); expect(f.control).not.toHaveBeenCalled();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('observes a repeated request without cloning or publishing again after interrupted admission', async () => {
    const f = await fixture();
    try {
      const input = { request: { workspaceId: owner.workspaceId, requestId, url: 'https://example.invalid/repo.git', destination: 'published', commit }, owner, workspaceRoot: f.root };
      const requestDigest = createHash('sha256').update(JSON.stringify({ input })).digest('hex');
      await writeFile(path.join(f.directory, 'spec.json'), JSON.stringify({ ...f.manifest, requestDigest }));
      vi.spyOn(DurableShellTaskStore.prototype, 'snapshot').mockResolvedValue({ ok: false, error: { code: 'PROCESS_NOT_FOUND', message: 'missing', recoverable: false } });
      const launch = vi.spyOn(DurableShellTaskStore.prototype, 'launch');
      expect(await f.runtime.start(input)).toMatchObject({ ok: true, value: { state: 'unresolved' } });
      expect(launch).not.toHaveBeenCalled(); expect(f.control).not.toHaveBeenCalled();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('removes executable PowerShell control assets from the worker and verifies durable authenticated readback', () => {
    expect(repositoryImportWorkerSource).not.toMatch(/powershell|ExecutionPolicy|Bypass|stage-acl\.ps1|publish\.ps1/i);
    expect(repositoryImportWorkerSource).toContain('authority.inspectControl');
    expect(repositoryImportWorkerSource).toContain("JSON.stringify({ input: spec.originalInput })");
  });
});
