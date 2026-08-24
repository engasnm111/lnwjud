import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-file-write-'));
  temporaryRoots.push(rawRoot);
  const root = await realpath(rawRoot);
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
  it('does not write after cancellation wins during checkpoint creation', async () => {
    const workspace = await createWorkspace();
    const target = path.join(workspace.rootPath, 'src', 'file.txt');
    await writeFile(target, 'before', 'utf8');
    let releaseCheckpoint!: () => void;
    let enterCheckpoint!: () => void;
    const checkpointEntered = new Promise<void>((resolve) => { enterCheckpoint = resolve; });
    const checkpointGate = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    const checkpoints: CheckpointServicePort = {
      async createForFiles(): Promise<Result<Checkpoint>> {
        enterCheckpoint();
        await checkpointGate;
        return ok({ id: 'checkpoint-1', workspaceId: workspace.id, createdAt: new Date(0).toISOString(), files: [] });
      },
    };
    const service = new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpoints });
    const controller = new AbortController();

    const writing = service.writeFile(actor, workspace.id, { path: 'src\\file.txt', content: 'after' }, controller.signal);
    await checkpointEntered;
    controller.abort();
    releaseCheckpoint();

    await expect(writing).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    await expect(readFile(target, 'utf8')).resolves.toBe('before');
  });

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

    expect(result).toMatchObject({ ok: true, value: { path: path.join('src', 'file.txt'), checkpointId: 'checkpoint-1' } });
    expect(checkpoints.calls).toEqual([[path.join('src', 'file.txt')]]);
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
      .resolves.toMatchObject({ ok: true, value: { path: path.join('src', 'dynamic.txt') } });
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

  it('allows scoped deletion without per-call confirmation when the configured AI delete policy is enabled', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace.rootPath, 'src', 'policy-delete.txt'), 'delete me', 'utf8');
    const service = new FileService(repository(workspace), undefined, undefined, {
      profile: permissionProfiles.balanced,
      allowDeleteWithoutConfirmation: (): boolean => true,
    });

    await expect(service.deleteFile(actor, workspace.id, { path: 'src/policy-delete.txt' })).resolves.toMatchObject({ ok: true });
    await expect(readFile(path.join(workspace.rootPath, 'src', 'policy-delete.txt'), 'utf8')).rejects.toThrow();
    await expect(service.deleteFile(actor, workspace.id, { path: '.' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });

  it('keeps protected critical files approval-gated even when AI delete is enabled', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace.rootPath, 'package.json'), '{"name":"critical"}', 'utf8');
    const service = new FileService(repository(workspace), undefined, undefined, {
      profile: permissionProfiles.balanced,
      allowDeleteWithoutConfirmation: (): boolean => true,
      protectCriticalFiles: (): boolean => true,
    });

    await expect(service.deleteFile(actor, workspace.id, { path: 'package.json' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(readFile(path.join(workspace.rootPath, 'package.json'), 'utf8')).resolves.toContain('critical');
  });

  it('creates a checkpoint and moves delete_file targets into recovery trash', async () => {
    const workspace = await createWorkspace();
    const recoveryRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-recovery-'));
    temporaryRoots.push(recoveryRoot);
    const checkpoints = checkpointService();
    const source = path.join(workspace.rootPath, 'src', 'recover-me.txt');
    await writeFile(source, 'recoverable payload', 'utf8');
    const service = new FileService(repository(workspace), undefined, undefined, {
      profile: permissionProfiles.balanced,
      checkpointService: checkpoints,
      allowDeleteWithoutConfirmation: (): boolean => true,
      protectCriticalFiles: (): boolean => true,
      recoverableDelete: (): boolean => true,
      recoveryTrashRoot: recoveryRoot,
    });

    const result = await service.deleteFile(actor, workspace.id, { path: 'src/recover-me.txt' });
    expect(result).toMatchObject({ ok: true, value: { recoverable: true, checkpointId: 'checkpoint-1' } });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.recoveryId).toBeTypeOf('string');
    expect(result.value.recoveryPath).toBeTypeOf('string');
    await expect(readFile(source, 'utf8')).rejects.toThrow();
    await expect(readFile(result.value.recoveryPath!, 'utf8')).resolves.toBe('recoverable payload');
    const metadata = JSON.parse(await readFile(path.join(path.dirname(result.value.recoveryPath!), 'metadata.json'), 'utf8')) as Record<string, unknown>;
    expect(metadata).toMatchObject({ workspaceId: workspace.id, relativePath: path.join('src', 'recover-me.txt') });
    expect(checkpoints.calls).toEqual([[path.join('src', 'recover-me.txt')]]);

    const restored = await service.restoreDeletedFile(actor, workspace.id, { recoveryId: result.value.recoveryId! });
    expect(restored).toMatchObject({ ok: true, value: { recoveryId: result.value.recoveryId, path: path.join('src', 'recover-me.txt') } });
    await expect(readFile(source, 'utf8')).resolves.toBe('recoverable payload');
    await expect(readFile(result.value.recoveryPath!, 'utf8')).rejects.toThrow();
  });

  it('writes a nested file by creating missing parent directories', async () => {

    const workspace = await createWorkspace();
    const result = await new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpointService() })
      .writeFile(actor, workspace.id, { path: 'docs\\superpowers\\plans\\plan.md', content: 'hello' });

    expect(result).toMatchObject({ ok: true, value: { path: path.join('docs', 'superpowers', 'plans', 'plan.md') } });
    await expect(readFile(path.join(workspace.rootPath, 'docs', 'superpowers', 'plans', 'plan.md'), 'utf8')).resolves.toBe('hello');
  });

  it('patches a nested file that does not exist yet', async () => {
    const workspace = await createWorkspace();
    const result = await new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpointService() })
      .applyPatch(actor, workspace.id, { files: [{ path: 'nested\\a\\b.txt', content: 'patched' }] });

    expect(result).toMatchObject({ ok: true, value: { paths: [path.join('nested', 'a', 'b.txt')] } });
    await expect(readFile(path.join(workspace.rootPath, 'nested', 'a', 'b.txt'), 'utf8')).resolves.toBe('patched');
  });

  it('moves a file into a nested destination that does not exist yet', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace.rootPath, 'src', 'file.txt'), 'payload', 'utf8');
    const result = await new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpointService() })
      .moveFile(actor, workspace.id, { sourcePath: 'src\\file.txt', destinationPath: 'docs\\moved\\file.txt' });

    expect(result).toEqual({ ok: true, value: undefined });
    await expect(readFile(path.join(workspace.rootPath, 'docs', 'moved', 'file.txt'), 'utf8')).resolves.toBe('payload');
  });

  it('copies files and directories into missing destination parents', async () => {
    const workspace = await createWorkspace();
    await mkdir(path.join(workspace.rootPath, 'src', 'pkg'));
    await writeFile(path.join(workspace.rootPath, 'src', 'pkg', 'a.ts'), 'export const a = 1;\n', 'utf8');
    const service = new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpointService() });

    await expect(service.copyFile(actor, workspace.id, { sourcePath: 'src\\pkg\\a.ts', destinationPath: 'out\\copy\\a.ts' }))
      .resolves.toMatchObject({ ok: true, value: { destinationPath: path.join('out', 'copy', 'a.ts') } });
    await expect(readFile(path.join(workspace.rootPath, 'src', 'pkg', 'a.ts'), 'utf8')).resolves.toBe('export const a = 1;\n');
    await expect(readFile(path.join(workspace.rootPath, 'out', 'copy', 'a.ts'), 'utf8')).resolves.toBe('export const a = 1;\n');

    await expect(service.copyFile(actor, workspace.id, { sourcePath: 'src\\pkg', destinationPath: 'out\\pkg-copy' }))
      .resolves.toMatchObject({ ok: true });
    await expect(readFile(path.join(workspace.rootPath, 'out', 'pkg-copy', 'a.ts'), 'utf8')).resolves.toBe('export const a = 1;\n');

    await expect(service.moveFile(actor, workspace.id, { sourcePath: 'src\\pkg', destinationPath: 'relocated\\pkg' }))
      .resolves.toEqual({ ok: true, value: undefined });
    await expect(readFile(path.join(workspace.rootPath, 'relocated', 'pkg', 'a.ts'), 'utf8')).resolves.toBe('export const a = 1;\n');
  });

  it('writes using an absolute path without a workspaceId', async () => {
    const workspace = await createWorkspace();
    const absolute = path.join(workspace.rootPath, 'docs', 'abs.md');
    const result = await new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpointService() })
      .writeFile(actor, undefined, { path: absolute, content: 'absolute' });

    expect(result.ok).toBe(true);
    await expect(readFile(absolute, 'utf8')).resolves.toBe('absolute');
  });

  it('returns INVALID_INPUT when a write parent exists as a file', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace.rootPath, 'docs'), 'not-a-dir', 'utf8');
    const result = await new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpointService() })
      .writeFile(actor, workspace.id, { path: 'docs\\plan.md', content: 'nope' });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
