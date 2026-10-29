import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableShellTaskIndex, type ActiveTaskInspection } from './durable-shell-task-index.js';
import { SharedManagedWriterAdmission } from './shared-managed-writer-admission.js';
import { ShellCapabilityBackend } from './shell-backend.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-writer-capacity-'));
  roots.push(root);
  return root;
}
const request = { taskId: 'shell-probe', requestDigest: 'a'.repeat(64), ownerClientId: 'shell-client' };

describe('managed writer and durable shell admission', () => {
  it.skipIf(process.platform === 'darwin')('keeps unknown managed writers globally fenced without consuming the durable shell budget', async () => {
    const root = await fixture();
    const admission = new SharedManagedWriterAdmission(root);
    for (let i = 0; i < 17; i += 1) {
      expect(await admission.enter({ actorClientId: 'writer', workspaceId: `workspace-${i}`, kind: 'uncontained_process' })).toMatchObject({ ok: true });
    }
    const directory = path.join(root, '.index', 'v1', 'active');
    for (const filename of await readdir(directory)) {
      const target = path.join(directory, filename);
      const marker: unknown = JSON.parse(await readFile(target, 'utf8'));
      if (typeof marker === 'object' && marker !== null) {
        Reflect.deleteProperty(marker, 'capacityClass');
        await writeFile(target, JSON.stringify(marker));
      }
    }
    const index = new DurableShellTaskIndex(root, { maxConcurrentTasks: 1, inspectTask: async (): Promise<ActiveTaskInspection> => 'missing' });
    expect(await index.reserve(request)).toMatchObject({ ok: true, value: { activeTasks: 1 } });
    expect(await index.reserve({ ...request, taskId: 'second-shell', requestDigest: 'b'.repeat(64) })).toMatchObject({ ok: false, error: { code: 'CONFLICT', details: { durable_shell_reservations: 1, managed_writer_reservations: 17 } } });
    expect(await new SharedManagedWriterAdmission(root).holdExclusiveProbe('other-workspace')).toMatchObject({ ok: false });
    expect(await readdir(directory)).toHaveLength(18);
  });

  it.skipIf(process.platform === 'darwin').each([undefined, 1])('shows aggregate reservations even when the requested task page is empty (limit %s)', async (limit) => {
    const root = await fixture();
    const taskRoot = path.join(root, 'tasks');
    const held = await new SharedManagedWriterAdmission(taskRoot).enter({ actorClientId: 'private-client', actorSessionId: 'private-session', workspaceId: 'private-workspace', kind: 'uncontained_process' });
    expect(held.ok).toBe(true);
    const backend = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory: taskRoot });
    const response = await backend.execute({ operation: 'list', ...(limit === undefined ? {} : { limit }) });
    expect(response).toMatchObject({ ok: true, value: { tasks: [], admission: {
      capacity_population: 'durable_shell', durable_shell_limit: 16, durable_shell_reservations: 0,
      managed_writer_reservations: 1, unresolved_reservations: 1, exclusive_writer_blocked: true,
    } } });
    expect(JSON.stringify(response)).not.toMatch(/private-client|private-session|private-workspace|managed-writer-/);
  });

  it('retains a verified terminal marker if removal fails, and retries removal before granting capacity', async () => {
    const root = await fixture();
    const initial = new DurableShellTaskIndex(root, { maxConcurrentTasks: 1, inspectTask: async (): Promise<ActiveTaskInspection> => 'missing' });
    expect(await initial.reserve(request)).toMatchObject({ ok: true });
    const removeFile = vi.fn<typeof rm>().mockRejectedValueOnce(new Error('disk unavailable')).mockImplementation(rm);
    const reopened = new DurableShellTaskIndex(root, { maxConcurrentTasks: 1, inspectTask: async (): Promise<ActiveTaskInspection> => 'terminal', removeFile });
    expect(await reopened.reserve({ ...request, taskId: 'replacement', requestDigest: 'c'.repeat(64) })).toMatchObject({ ok: false });
    expect(await initial.hasReservation(request.taskId, request.requestDigest)).toBe(true);
    expect(await reopened.reserve({ ...request, taskId: 'replacement', requestDigest: 'c'.repeat(64) })).toMatchObject({ ok: true });
    expect(await initial.hasReservation(request.taskId, request.requestDigest)).toBe(false);
  });

  it.skipIf(process.platform === 'darwin')('never treats corrupt reservation readback as successful release', async () => {
    const root = await fixture();
    const admitted = await new SharedManagedWriterAdmission(root).enter({ actorClientId: 'writer', workspaceId: 'workspace', kind: 'uncontained_process' });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const directory = path.join(root, '.index', 'v1', 'active');
    const [filename] = await readdir(directory);
    expect(filename).toBeDefined();
    if (filename === undefined) return;
    await writeFile(path.join(directory, filename), '{corrupt');
    await expect(admitted.value.releaseAfterVerifiedTermination()).rejects.toThrow('MANAGED_WRITER_RELEASE_UNVERIFIED');
    expect(await new DurableShellTaskIndex(root, { maxConcurrentTasks: 16, inspectTask: async (): Promise<ActiveTaskInspection> => 'missing' }).diagnostics()).toMatchObject({ unreadable_reservations: 1, unresolved_reservations: 1, exclusive_writer_blocked: true });
  });

  it('fails closed when the active directory cannot be enumerated', async () => {
    const root = await fixture();
    const initial = new DurableShellTaskIndex(root, { maxConcurrentTasks: 16, inspectTask: async (): Promise<ActiveTaskInspection> => 'missing' });
    expect(await initial.reserve(request)).toMatchObject({ ok: true });
    const unavailable = new DurableShellTaskIndex(root, {
      maxConcurrentTasks: 16, inspectTask: async (): Promise<ActiveTaskInspection> => 'missing',
      listActiveFiles: async (): Promise<readonly string[]> => { throw new Error('directory listing denied'); },
    });
    expect(await unavailable.reserve({ ...request, taskId: 'import', mutationKind: 'repository_import' })).toMatchObject({ ok: false });
    await expect(unavailable.diagnostics()).rejects.toThrow('directory listing denied');
    expect(await initial.hasReservation(request.taskId, request.requestDigest)).toBe(true);
  });

  it('checks exclusive probe removal and never probes process liveness while listing diagnostics', async () => {
    const root = await fixture();
    const probe = await new SharedManagedWriterAdmission(root).holdExclusiveProbe('workspace');
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    const directory = path.join(root, '.index', 'v1', 'active');
    const [filename] = await readdir(directory);
    if (filename === undefined) throw new Error('Probe marker missing');
    const inspectTask = vi.fn<() => Promise<ActiveTaskInspection>>().mockImplementation(() => { throw new Error('Diagnostics must not inspect processes'); });
    const index = new DurableShellTaskIndex(root, { maxConcurrentTasks: 16, inspectTask });
    expect(await index.diagnostics()).toMatchObject({ managed_writer_reservations: 1, exclusive_writer_blocked: true, status_basis: 'held_reservations_not_process_liveness' });
    expect(inspectTask).not.toHaveBeenCalled();
    await writeFile(path.join(directory, filename), '{corrupt');
    await expect(probe.value.releaseAfterVerifiedTermination()).rejects.toThrow('MANAGED_WRITER_RELEASE_UNVERIFIED');
  });
});
