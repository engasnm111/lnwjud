import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { permissionProfiles, type PermissionProfile, type PermissionProfileName } from '@lnwjud/permissions';
import type { Checkpoint, CheckpointRepository, Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { CheckpointService } from './checkpoint-service.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{ workspace: Workspace; checkpoints: MemoryCheckpointRepository }> {
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-checkpoint-'));
  temporaryRoots.push(rawRoot);
  const root = await realpath(rawRoot);
  await mkdir(path.join(root, 'src'));
  const workspace: Workspace = { id: 'workspace-1', displayName: 'Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
  return { workspace, checkpoints: new MemoryCheckpointRepository() };
}

function workspaces(workspace: Workspace): WorkspaceRepository {
  return { async list(): Promise<Workspace[]> { return [workspace]; }, async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; }, async insert(): Promise<void> {}, async delete(): Promise<void> {} };
}

class MemoryCheckpointRepository implements CheckpointRepository {
  private readonly checkpoints: Checkpoint[] = [];
  public async insert(value: Checkpoint): Promise<void> { this.checkpoints.push(value); }
  public async get(id: string): Promise<Checkpoint | null> { return this.checkpoints.find((entry) => entry.id === id) ?? null; }
  public async list(workspaceId: string, limit = 100): Promise<Checkpoint[]> {
    return this.checkpoints.filter((entry) => entry.workspaceId === workspaceId).slice(0, limit);
  }
}

describe('CheckpointService', () => {
  it('captures and restores file content through the workspace guard', async () => {
    const { workspace, checkpoints } = await setup();
    const target = path.join(workspace.rootPath, 'src', 'file.txt');
    await writeFile(target, 'before', 'utf8');
    const service = new CheckpointService(workspaces(workspace), checkpoints);
    const actor = { clientId: 'client-1', clientName: 'test' };

    const created = await service.createForFiles(actor, workspace.id, ['src' + path.sep + 'file.txt']);
    await writeFile(target, 'after', 'utf8');
    if (!created.ok) throw new Error('checkpoint creation failed');
    const restored = await service.restore(actor, workspace.id, created.value.id, { profile: permissionProfiles.full, userConfirmed: true });

    expect(restored).toMatchObject({ ok: true, value: { restoredPaths: ['src' + path.sep + 'file.txt'], rollbackCheckpointId: expect.any(String) } });
    await expect(readFile(target, 'utf8')).resolves.toBe('before');
    if (!restored.ok || restored.value.rollbackCheckpointId === undefined) throw new Error('rollback checkpoint missing');
    await expect(service.restore(actor, workspace.id, restored.value.rollbackCheckpointId, { profile: permissionProfiles.full, userConfirmed: true }))
      .resolves.toMatchObject({ ok: true });
    await expect(readFile(target, 'utf8')).resolves.toBe('after');
  });

  it('lists recovery-safe checkpoint metadata without returning file content', async () => {
    const { workspace, checkpoints } = await setup();
    const target = path.join(workspace.rootPath, 'src', 'file.txt');
    await writeFile(target, 'secret-before-content', 'utf8');
    const service = new CheckpointService(workspaces(workspace), checkpoints);
    const actor = { clientId: 'client-1', clientName: 'test' };
    const created = await service.createForFiles(actor, workspace.id, ['src' + path.sep + 'file.txt']);
    if (!created.ok) throw new Error('checkpoint creation failed');

    const listed = await service.list(workspace.id);

    expect(listed).toMatchObject({ ok: true, value: [{
      id: created.value.id,
      workspaceId: workspace.id,
      files: [{ path: 'src' + path.sep + 'file.txt', size: Buffer.byteLength('secret-before-content'), contentSha256: expect.any(String) }],
    }] });
    expect(JSON.stringify(listed)).not.toContain('secret-before-content');
  });

  it('uses the current permission profile when restoring without an explicit override', async () => {
    const { workspace, checkpoints } = await setup();
    const target = path.join(workspace.rootPath, 'src', 'profile.txt');
    await writeFile(target, 'before', 'utf8');
    let profileName: PermissionProfileName = 'safe';
    const service = new CheckpointService(workspaces(workspace), checkpoints, {
      profileProvider: (): PermissionProfile => permissionProfiles[profileName],
    });
    const actor = { clientId: 'client-1', clientName: 'test' };
    const created = await service.createForFiles(actor, workspace.id, ['src' + path.sep + 'profile.txt']);
    if (!created.ok) throw new Error('checkpoint creation failed');
    await writeFile(target, 'after', 'utf8');

    await expect(service.restore(actor, workspace.id, created.value.id)).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_REQUIRED' },
    });
    profileName = 'balanced';
    await expect(service.restore(actor, workspace.id, created.value.id, { userConfirmed: true })).resolves.toMatchObject({ ok: true });
    await expect(readFile(target, 'utf8')).resolves.toBe('before');
  });

  it('rejects a checkpoint path that no longer resolves inside the workspace', async () => {
    const { workspace, checkpoints } = await setup();
    await checkpoints.insert({ id: 'checkpoint-1', workspaceId: workspace.id, createdAt: new Date(0).toISOString(), files: [{ path: ['..','outside.txt'].join(path.sep), content: 'secret', contentSha256: 'hash', size: 6 }] });
    const result = await new CheckpointService(workspaces(workspace), checkpoints).restore(
      { clientId: 'client-1', clientName: 'test' }, workspace.id, 'checkpoint-1', { profile: permissionProfiles.full, userConfirmed: true },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });
});
