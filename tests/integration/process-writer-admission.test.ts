import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SharedManagedWriterAdmission } from '../../packages/capabilities/src/shared-managed-writer-admission.js';
import { DurableShellTaskStore } from '../../packages/capabilities/src/durable-shell-task-store.js';
import { nativeFixture } from '../../packages/process/test/native-fixture.js';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { ProcessService } from '@lnwjud/application';

describe.skipIf(process.platform !== 'win32')('cross-workspace native ProcessService writer lifetime', () => {
  it('blocks repository import while a detached process descendant still holds the native Job', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-writer-lifetime-')));
    const workspaceRoot = path.join(root, 'project');
    const jobRoot = path.join(root, 'native-jobs');
    const indexRoot = path.join(root, 'background-tasks');
    const childScript = path.join(root, 'spawn-descendant.cjs');
    const sentinel = path.join(root, 'descendant-done.txt');
    try {
      await mkdir(workspaceRoot);
      await writeFile(childScript, [
        "const cp=require('node:child_process');",
        "cp.spawn(process.execPath,['-e',`setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'done'),2000)`,process.argv[2]],{detached:true,stdio:'ignore'}).unref();",
      ].join('\n'));
      const workspace: Workspace = {
        id: 'writer-workspace', displayName: 'Writer', rootPath: workspaceRoot,
        realRootPath: workspaceRoot, createdAt: new Date(0).toISOString(),
      };
      const repository: WorkspaceRepository = {
        async list() { return [workspace]; },
        async get(workspaceId) { return workspaceId === workspace.id ? workspace : null; },
        async insert() {}, async delete() {},
      };
      const { authority } = await nativeFixture(root);
      const admission = new SharedManagedWriterAdmission(indexRoot, authority);
      const processes = new ProcessService(repository, {
        writerAdmission: admission,
        nativeContainmentRoot: jobRoot,
        nativeAuthority: authority,
      });
      const actor = { clientId: 'external-writer', clientName: 'test', sessionId: 'writer-session' };
      const started = await processes.start(actor, workspace.id, {
        executable: process.execPath, args: [childScript, sentinel], userConfirmed: true,
      }, undefined, { mode: 'standard', applicationApproved: true, bypassApplicationAuthorization: false, source: 'host_approval' });
      expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
      if (!started.ok) return;
      const tasks = new DurableShellTaskStore(indexRoot, { windowsNativeAuthority: authority });
      const importRequest = {
        taskId: 'other-workspace-import-' + randomUUID(), mutationKind: 'repository_import' as const,
        executable: process.execPath, arguments: ['-e', 'process.exit(0)'], cwd: root,
        timeoutSeconds: process.env.CI ? 110 : 20, maxOutputBytes: 1024, includeStdout: false, includeStderr: false,
        owner: { clientId: 'importer', sessionId: 'importer', workspaceId: 'different-workspace' },
      };
      const blockedImport = await tasks.launch(importRequest);
      expect(blockedImport, JSON.stringify(blockedImport)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      await expect.poll(async () => {
        try { return await readFile(sentinel, 'utf8'); } catch { return ''; }
      }, { timeout: process.env.CI ? 90000 : 15000 }).toBe('done');
      await expect.poll(async () => (await tasks.launch(importRequest)).ok, { timeout: process.env.CI ? 90000 : 15000 }).toBe(true);
      await expect.poll(async () => {
        const result = await tasks.snapshot(importRequest.taskId, undefined, importRequest.owner);
        return result.ok ? result.value.state : 'unavailable';
      }, { timeout: process.env.CI ? 90000 : 15000 }).toBe('completed');
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  }, process.env.CI ? 200000 : 50000);
});
