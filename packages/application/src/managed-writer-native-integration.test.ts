import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { permissionProfiles } from '@lnwjud/permissions';
import { ProcessManager } from '@lnwjud/process';
import { CodexAdapter } from '@lnwjud/codex';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { SharedManagedWriterAdmission } from '../../capabilities/src/shared-managed-writer-admission.js';
import { nativeFixture } from '../../process/test/native-fixture.js';
import { ProcessService } from './process-service.js';
import { CodexService } from './codex-service.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }))); });
const actor = { clientId: 'writer-client', sessionId: 'real-session', clientName: 'test' };
const authorization = { mode: 'standard', applicationApproved: true, bypassApplicationAuthorization: false, source: 'host_approval' } as const;
async function fixture(): Promise<{
  root: string; workspace: Workspace; repository: WorkspaceRepository;
  authority: Awaited<ReturnType<typeof nativeFixture>>['authority']; taskDirectory: string; nativeRoot: string; admission: SharedManagedWriterAdmission;
}> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'managed-native-services-'))); roots.push(root);
  const workspace: Workspace = { id: 'workspace', displayName: 'test', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
  const repository: WorkspaceRepository = { async list() { return [workspace]; }, async get(id) { return id === workspace.id ? workspace : null; }, async insert() {}, async delete() {} };
  const { authority } = await nativeFixture(root);
  const taskDirectory = path.join(root, 'tasks'); const nativeRoot = path.join(root, 'native');
  const admission = new SharedManagedWriterAdmission(taskDirectory, authority);
  return { root, workspace, repository, authority, taskDirectory, nativeRoot, admission };
}
async function waitTerminal(manager: ProcessManager, processId: string): Promise<ReturnType<ProcessManager['status']>> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = manager.status(processId);
    if (!state.ok || !['starting', 'running'].includes(state.value.state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Managed process did not become terminal');
}

describe.skipIf(process.platform !== 'win32')('native managed writer service integration', () => {
  it('ProcessService exposes terminal success only after its bound reservation is removed', async () => {
    const f = await fixture();
    const manager = new ProcessManager(undefined, undefined, undefined, undefined, f.nativeRoot, f.authority);
    const service = new ProcessService(f.repository, { writerAdmission: f.admission, nativeContainmentRoot: f.nativeRoot, nativeAuthority: f.authority, processManager: manager, profile: permissionProfiles.full });
    const result = await service.start(actor, f.workspace.id, { executable: process.execPath, args: ['-e', 'process.stdout.write("native-ok")'], userConfirmed: true }, undefined, authorization);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(await waitTerminal(manager, result.value.processId)).toMatchObject({ ok: true, value: { state: 'exited', exitCode: 0 } });
    expect(await readdir(path.join(f.taskDirectory, '.index', 'v1', 'active'))).toEqual([]);
  }, 30_000);

  it('CodexService uses shared admission and native containment for the adapter invocation', async () => {
    const f = await fixture();
    const manager = new ProcessManager(undefined, undefined, undefined, undefined, f.nativeRoot, f.authority);
    const adapter = new CodexAdapter({ async discover(): ReturnType<NonNullable<ConstructorParameters<typeof CodexAdapter>[0]>['discover']> { return ok({ status: { installed: true, executablePath: process.execPath, version: 'test', capabilities: ['exec'] }, capabilities: { instructionMode: 'exec-argument', names: ['exec'] } }); } }, manager,
      { build(): ReturnType<NonNullable<ConstructorParameters<typeof CodexAdapter>[2]>['build']> { return ok({ executable: process.execPath, args: ['-e', 'process.stdout.write("codex-contained")'] }); } });
    const service = new CodexService(f.repository, { adapter, writerAdmission: f.admission, nativeContainmentRoot: f.nativeRoot, nativeAuthority: f.authority, profile: permissionProfiles.full });
    const result = await service.run(actor, f.workspace.id, 'bounded fixture', undefined, true, authorization);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(await waitTerminal(manager, result.value.processId)).toMatchObject({ ok: true, value: { state: 'exited', exitCode: 0 } });
    expect(await readdir(path.join(f.taskDirectory, '.index', 'v1', 'active'))).toEqual([]);
  }, 30_000);

  it('Codex discovery rejection performs an exclusive abort instead of leaking a writer reservation', async () => {
    const f = await fixture();
    const adapter = new CodexAdapter({ async discover(): ReturnType<NonNullable<ConstructorParameters<typeof CodexAdapter>[0]>['discover']> { return ok({ status: { installed: false, version: 'test', capabilities: [] }, capabilities: { instructionMode: 'exec-argument', names: [] } }); } });
    const service = new CodexService(f.repository, { adapter, writerAdmission: f.admission, nativeContainmentRoot: f.nativeRoot, nativeAuthority: f.authority, profile: permissionProfiles.full });
    expect(await service.run(actor, f.workspace.id, 'fixture', undefined, true, authorization)).toMatchObject({ ok: false, error: { code: 'CODEX_NOT_AVAILABLE' } });
    expect(await readdir(path.join(f.taskDirectory, '.index', 'v1', 'active'))).toEqual([]);
  });
});
