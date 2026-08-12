import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ok, type Result } from '@lnwjud/domain';
import { permissionProfiles } from '@lnwjud/permissions';
import type { Checkpoint, Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { FileService, type CheckpointServicePort } from './file-service.js';

const temporaryRoots: string[] = [];
const actor = { clientId: 'client-1', clientName: 'test' };

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-file-write-'));
  temporaryRoots.push(root);
  await mkdir(path.join(root, 'src'));
  return { id: 'workspace-1', displayName: 'Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
}

function repository(workspace: Workspace): WorkspaceRepository {
  return {
    async list(): Promise<Workspace[]> { return [workspace]; },
    async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
    async insert(): Promise<void> {},
    async delete(): Promise<void> {},
  };
}

function checkpointService(): CheckpointServicePort & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async createForFiles(_actor, _workspaceId, paths): Promise<Result<Checkpoint>> {
      calls.push([...paths]);
      return ok({ id: 'checkpoint-1', workspaceId: 'workspace-1', createdAt: new Date(0).toISOString(), files: [] });
    },
  };
}

describe('FileService writes', () => {
  it('returns PERMISSION_REQUIRED under Safe and leaves the file unchanged', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace.rootPath, 'src', 'file.txt'), 'before', 'utf8');
    const result = await new FileService(repository(workspace), undefined, undefined, {
      profile: permissionProfiles.safe,
      checkpointService: checkpointService(),
    }).writeFile(actor, workspace.id, { path: 'src\\file.txt', content: 'after' });

    expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(readFile(path.join(workspace.rootPath, 'src', 'file.txt'), 'utf8')).resolves.toBe('before');
  });

  it('captures a checkpoint before atomically overwriting an existing file', async () => {
    const workspace = await createWorkspace();
    const checkpoints = checkpointService();
    await writeFile(path.join(workspace.rootPath, 'src', 'file.txt'), 'before', 'utf8');
    const result = await new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpoints })
      .writeFile(actor, workspace.id, { path: 'src\\file.txt', content: 'after' });

    expect(result).toMatchObject({ ok: true, value: { path: 'src\\file.txt', checkpointId: 'checkpoint-1' } });
    expect(checkpoints.calls).toEqual([['src\\file.txt']]);
    await expect(readFile(path.join(workspace.rootPath, 'src', 'file.txt'), 'utf8')).resolves.toBe('after');
  });

  it('reads the current permission profile for later writes', async () => {
    const workspace = await createWorkspace();
    const checkpoints = checkpointService();
    let profile = permissionProfiles.safe;
    const service = new FileService(repository(workspace), undefined, undefined, {
      checkpointService: checkpoints,
      profileProvider: (): typeof profile => profile,
    });

    await expect(service.writeFile(actor, workspace.id, { path: 'src\\dynamic.txt', content: 'blocked' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    profile = permissionProfiles.balanced;
    await expect(service.writeFile(actor, workspace.id, { path: 'src\\dynamic.txt', content: 'allowed' }))
      .resolves.toMatchObject({ ok: true, value: { path: 'src\\dynamic.txt' } });
  });

  it('validates every patch path before changing the first file', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace.rootPath, 'src', 'file.txt'), 'before', 'utf8');
    const result = await new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpointService() })
      .applyPatch(actor, workspace.id, { files: [
        { path: 'src\\file.txt', content: 'changed' },
        { path: '..\\outside.txt', content: 'must not write' },
      ] });

    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    await expect(readFile(path.join(workspace.rootPath, 'src', 'file.txt'), 'utf8')).resolves.toBe('before');
  });

  it('rejects recursive deletion and non-empty directories', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace.rootPath, 'src', 'file.txt'), 'before', 'utf8');

    await expect(new FileService(repository(workspace), undefined, undefined, { profile: permissionProfiles.full })
      .deleteFile(actor, workspace.id, { path: 'src', userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(new FileService(repository(workspace), undefined, undefined, { profile: permissionProfiles.full })
      .deleteFile(actor, workspace.id, { path: '.', userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(new FileService(repository(workspace), undefined, undefined, { profile: permissionProfiles.full })
      .deleteFile(actor, workspace.id, { path: 'src/file.txt' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
  });
});
