import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ok, type Result } from '@lnwjud/domain';
import { permissionProfiles } from '@lnwjud/permissions';
import { WorkspacePathGuard, type Checkpoint, type Workspace, type WorkspaceRepository } from '@lnwjud/workspace';
import { FileService, type CheckpointServicePort } from './file-service.js';

const W = (value: string): string => value.split('\\').join(path.sep);

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

    const writing = service.writeFile(actor, workspace.id, {
      path: 'src' + path.sep + 'file.txt', content: 'after', overwriteExisting: true, userConfirmed: true,
    }, controller.signal);
    await checkpointEntered;
    controller.abort();
    releaseCheckpoint();

    await expect(writing).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    await expect(readFile(target, 'utf8')).resolves.toBe('before');
  });

  it('accepts an explicit human confirmation when the Safe profile asks before a replacement', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace.rootPath, 'src', 'file.txt'), 'before', 'utf8');
    const result = await new FileService(repository(workspace), undefined, undefined, {
      profile: permissionProfiles.safe,
      checkpointService: checkpointService(),
    }).writeFile(actor, workspace.id, {
      path: 'src' + path.sep + 'file.txt', content: 'after', overwriteExisting: true, userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true, value: { checkpointId: 'checkpoint-1' } });
    await expect(readFile(path.join(workspace.rootPath, 'src', 'file.txt'), 'utf8')).resolves.toBe('after');
  });

  it('lets Full overwrite an existing file without overwriteExisting or userConfirmed while still checkpointing', async () => {
    const workspace = await createWorkspace();
    const checkpoints = checkpointService();
    await writeFile(path.join(workspace.rootPath, 'src', 'file.txt'), 'before', 'utf8');
    const service = new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpoints, profile: permissionProfiles.full });
    const result = await service.writeFile(actor, workspace.id, { path: 'src' + path.sep + 'file.txt', content: 'after' });
    expect(result).toMatchObject({ ok: true, value: { checkpointId: 'checkpoint-1' } });
    expect(checkpoints.calls).toEqual([['src' + path.sep + 'file.txt']]);
    await expect(readFile(path.join(workspace.rootPath, 'src', 'file.txt'), 'utf8')).resolves.toBe('after');
  });

  it('captures a checkpoint before atomically overwriting an existing file', async () => {
    const workspace = await createWorkspace();
    const checkpoints = checkpointService();
    await writeFile(path.join(workspace.rootPath, 'src', 'file.txt'), 'before', 'utf8');
    const result = await new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpoints })
      .writeFile(actor, workspace.id, {
        path: 'src' + path.sep + 'file.txt', content: 'after', overwriteExisting: true, userConfirmed: true,
      });

    expect(result).toMatchObject({ ok: true, value: { path: 'src' + path.sep + 'file.txt', checkpointId: 'checkpoint-1' } });
    expect(checkpoints.calls).toEqual([['src' + path.sep + 'file.txt']]);
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

    await expect(service.writeFile(actor, workspace.id, { path: 'xdynamic.txt', content: 'blocked' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    profile = permissionProfiles.balanced;
    await expect(service.writeFile(actor, workspace.id, { path: 'xdynamic.txt', content: 'allowed' }))
      .resolves.toMatchObject({ ok: true, value: { path: 'xdynamic.txt' } });
  });

  it('validates every patch path before changing the first file', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace.rootPath, 'src', 'file.txt'), 'before', 'utf8');
    const result = await new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpointService() })
      .applyPatch(actor, workspace.id, { files: [
        { path: 'src' + path.sep + 'file.txt', content: 'changed' },
        { path: ['..','outside.txt'].join(path.sep), content: 'must not write' },
      ] });

    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    await expect(readFile(path.join(workspace.rootPath, 'src', 'file.txt'), 'utf8')).resolves.toBe('before');
  });

  it('requires explicit confirmation before apply_patch replaces existing file content', async () => {
    const workspace = await createWorkspace();
    const target = path.join(workspace.rootPath, 'src', 'file.txt');
    await writeFile(target, 'before', 'utf8');
    const service = new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpointService() });

    await expect(service.applyPatch(actor, workspace.id, { files: [{ path: 'src' + path.sep + 'file.txt', content: 'after' }] }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(readFile(target, 'utf8')).resolves.toBe('before');
    await expect(service.applyPatch(actor, workspace.id, {
      files: [{ path: 'src' + path.sep + 'file.txt', content: 'after' }], userConfirmed: true,
    })).resolves.toMatchObject({ ok: true, value: { checkpointId: 'checkpoint-1' } });
    await expect(readFile(target, 'utf8')).resolves.toBe('after');
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
    const service = new FileService(repository(workspace), new WorkspacePathGuard(undefined, { trustedWorkspaceAccess: true }), undefined, {
      profile: permissionProfiles.balanced,
      allowDeleteWithoutConfirmation: (): boolean => true,
      protectCriticalFiles: (): boolean => true,
    });

    await expect(service.deleteFile(actor, workspace.id, { path: 'package.json' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(readFile(path.join(workspace.rootPath, 'package.json'), 'utf8')).resolves.toContain('critical');
  });

  it('requires explicit confirmation before narrowly editing a protected critical file', async () => {
    const workspace = await createWorkspace();
    const checkpoints = checkpointService();
    const target = path.join(workspace.rootPath, '.env');
    await writeFile(target, 'API_URL=before\n', 'utf8');
    const service = new FileService(repository(workspace), new WorkspacePathGuard(undefined, { trustedWorkspaceAccess: true }), undefined, {
      checkpointService: checkpoints,
      protectCriticalFiles: (): boolean => true,
    });

    await expect(service.editFile(actor, workspace.id, {
      path: '.env', oldText: 'before', newText: 'after',
    })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(checkpoints.calls).toEqual([]);
    await expect(readFile(target, 'utf8')).resolves.toBe('API_URL=before\n');

    await expect(service.editFile(actor, workspace.id, {
      path: '.env', oldText: 'before', newText: 'after', userConfirmed: true,
    })).resolves.toMatchObject({ ok: true, value: { checkpointId: 'checkpoint-1' } });
    expect(checkpoints.calls).toEqual([['.env']]);
    await expect(readFile(target, 'utf8')).resolves.toBe('API_URL=after\n');
  });

  it('requires explicit confirmation before moving a protected critical file', async () => {
    const workspace = await createWorkspace();
    const source = path.join(workspace.rootPath, '.env');
    const destination = path.join(workspace.rootPath, 'config', '.env');
    await writeFile(source, 'SECRET=kept\n', 'utf8');
    const service = new FileService(repository(workspace), new WorkspacePathGuard(undefined, { trustedWorkspaceAccess: true }), undefined, {
      checkpointService: checkpointService(),
      protectCriticalFiles: (): boolean => true,
    });

    await expect(service.moveFile(actor, workspace.id, {
      sourcePath: '.env', destinationPath: W('config/.env'),
    })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(readFile(source, 'utf8')).resolves.toBe('SECRET=kept\n');

    await expect(service.moveFile(actor, workspace.id, {
      sourcePath: '.env', destinationPath: W('config/.env'), userConfirmed: true,
    })).resolves.toEqual({ ok: true, value: undefined });
    await expect(readFile(destination, 'utf8')).resolves.toBe('SECRET=kept\n');
  });

  it('refuses to replace an existing file unless overwrite and confirmation are both explicit', async () => {
    const workspace = await createWorkspace();
    const target = path.join(workspace.rootPath, 'src', 'file.txt');
    await writeFile(target, 'before', 'utf8');
    const service = new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpointService() });

    await expect(service.writeFile(actor, workspace.id, { path: 'src' + path.sep + 'file.txt', content: 'after' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(service.writeFile(actor, workspace.id, { path: 'src' + path.sep + 'file.txt', content: 'after', overwriteExisting: true }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(readFile(target, 'utf8')).resolves.toBe('before');
  });

  it('applies a conflict-checked exact edit with a checkpoint instead of replacing the whole file', async () => {
    const workspace = await createWorkspace();
    const checkpoints = checkpointService();
    const target = path.join(workspace.rootPath, 'src', 'file.txt');
    await writeFile(target, 'alpha\nbeta\ngamma\n', 'utf8');
    const service = new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpoints });

    const result = await service.editFile(actor, workspace.id, {
      path: 'src' + path.sep + 'file.txt', oldText: 'beta', newText: 'fixed', expectedOccurrences: 1,
    });

    expect(result).toMatchObject({ ok: true, value: { path: 'src' + path.sep + 'file.txt', replacements: 1, checkpointId: 'checkpoint-1' } });
    expect(checkpoints.calls).toEqual([['src' + path.sep + 'file.txt']]);
    await expect(readFile(target, 'utf8')).resolves.toBe('alpha\nfixed\ngamma\n');
  });

  it('leaves the file unchanged when an exact edit precondition does not match', async () => {
    const workspace = await createWorkspace();
    const checkpoints = checkpointService();
    const target = path.join(workspace.rootPath, 'src', 'file.txt');
    await writeFile(target, 'same same', 'utf8');
    const service = new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpoints });

    await expect(service.editFile(actor, workspace.id, {
      path: 'src' + path.sep + 'file.txt', oldText: 'same', newText: 'changed', expectedOccurrences: 1,
    })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(checkpoints.calls).toEqual([]);
    await expect(readFile(target, 'utf8')).resolves.toBe('same same');
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
    const expectedRelative = ['src', 'recover-me.txt'].join(path.sep);
    expect(metadata).toMatchObject({ workspaceId: workspace.id, relativePath: expectedRelative });
    expect(checkpoints.calls).toEqual([[expectedRelative]]);

    await expect(service.listRecoveryItems(workspace.id)).resolves.toMatchObject({ ok: true, value: {
      recoveryTrashRoot: recoveryRoot,
      items: [{ recoveryId: result.value.recoveryId, workspaceId: workspace.id, relativePath: expectedRelative, payloadAvailable: true }],
    } });

    const restored = await service.restoreDeletedFile(actor, workspace.id, { recoveryId: result.value.recoveryId!, userConfirmed: true });
    expect(restored).toMatchObject({ ok: true, value: { recoveryId: result.value.recoveryId, path: expectedRelative } });
    await expect(readFile(source, 'utf8')).resolves.toBe('recoverable payload');
    await expect(readFile(result.value.recoveryPath!, 'utf8')).rejects.toThrow();
  });

  it('backs up binary replacement targets and keeps the replaced version as rollback when restored', async () => {
    const workspace = await createWorkspace();
    const recoveryRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-replacement-recovery-'));
    temporaryRoots.push(recoveryRoot);
    const target = path.join(workspace.rootPath, 'src', 'report.docx');
    const original = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x10]);
    const replaced = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x20]);
    await writeFile(target, original);
    const service = new FileService(repository(workspace), undefined, undefined, {
      recoveryTrashRoot: recoveryRoot,
      protectCriticalFiles: (): boolean => true,
    });

    await expect(service.prepareExternalFileMutation(actor, workspace.id, {
      targetPath: W('src/report.docx'),
    })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });

    const prepared = await service.prepareExternalFileMutation(actor, workspace.id, {
      targetPath: W('src/report.docx'), userConfirmed: true,
    });
    expect(prepared).toMatchObject({
      ok: true,
      value: {
        targetPath: target,
        targetRelativePath: W('src/report.docx'),
        replacementBackup: { recoveryId: expect.any(String), recoveryPath: expect.any(String) },
      },
    });
    if (!prepared.ok || prepared.value.replacementBackup === undefined) throw new Error('replacement backup was not created');
    expect((await readFile(prepared.value.replacementBackup.recoveryPath)).equals(original)).toBe(true);

    await writeFile(target, replaced);
    const restored = await service.restoreDeletedFile(actor, workspace.id, {
      recoveryId: prepared.value.replacementBackup.recoveryId,
      userConfirmed: true,
    });
    expect(restored).toMatchObject({ ok: true, value: { rollbackRecoveryId: expect.any(String) } });
    expect((await readFile(target)).equals(original)).toBe(true);

    const recovery = await service.listRecoveryItems(workspace.id);
    expect(recovery).toMatchObject({ ok: true, value: { items: [{
      recoveryId: restored.ok ? restored.value.rollbackRecoveryId : undefined,
      kind: 'replacement_backup',
      relativePath: W('src/report.docx'),
      payloadAvailable: true,
    }] } });
    if (!recovery.ok) throw new Error(recovery.error.message);
    const rollback = recovery.value.items[0];
    if (rollback === undefined) throw new Error('rollback backup was not created');
    expect((await readFile(path.join(recoveryRoot, workspace.id, rollback.recoveryId, 'payload'))).equals(replaced)).toBe(true);
  });

  it('writes a nested file by creating missing parent directories', async () => {

    const workspace = await createWorkspace();
    const result = await new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpointService() })
      .writeFile(actor, workspace.id, { path: W('docs/superpowers/plans/plan.md'), content: 'hello' });

    expect(result).toMatchObject({ ok: true, value: { path: W('docs/superpowers/plans/plan.md') } });
    await expect(readFile(path.join(workspace.rootPath, 'docs', 'superpowers', 'plans', 'plan.md'), 'utf8')).resolves.toBe('hello');
  });

  it('patches a nested file that does not exist yet', async () => {
    const workspace = await createWorkspace();
    const result = await new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpointService() })
      .applyPatch(actor, workspace.id, { files: [{ path: W('nested/a/b.txt'), content: 'patched' }] });

    expect(result).toMatchObject({ ok: true, value: { paths: [W('nested/a/b.txt')] } });
    await expect(readFile(path.join(workspace.rootPath, 'nested', 'a', 'b.txt'), 'utf8')).resolves.toBe('patched');
  });

  it('moves a file into a nested destination that does not exist yet', async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace.rootPath, 'src', 'file.txt'), 'payload', 'utf8');
    const result = await new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpointService() })
      .moveFile(actor, workspace.id, { sourcePath: 'src' + path.sep + 'file.txt', destinationPath: W('docs/moved/file.txt'), userConfirmed: true });

    expect(result).toEqual({ ok: true, value: undefined });
    await expect(readFile(path.join(workspace.rootPath, 'docs', 'moved', 'file.txt'), 'utf8')).resolves.toBe('payload');
  });

  it('copies files and directories into missing destination parents', async () => {
    const workspace = await createWorkspace();
    await mkdir(path.join(workspace.rootPath, 'src', 'pkg'));
    await writeFile(path.join(workspace.rootPath, 'src', 'pkg', 'a.ts'), 'export const a = 1;\n', 'utf8');
    const service = new FileService(repository(workspace), undefined, undefined, { checkpointService: checkpointService() });

    await expect(service.copyFile(actor, workspace.id, { sourcePath: W('src/pkg/a.ts'), destinationPath: W('out/copy/a.ts') }))
      .resolves.toMatchObject({ ok: true, value: { destinationPath: W('out/copy/a.ts') } });
    await expect(readFile(path.join(workspace.rootPath, 'src', 'pkg', 'a.ts'), 'utf8')).resolves.toBe('export const a = 1;\n');
    await expect(readFile(path.join(workspace.rootPath, 'out', 'copy', 'a.ts'), 'utf8')).resolves.toBe('export const a = 1;\n');

    await expect(service.copyFile(actor, workspace.id, { sourcePath: W('src/pkg'), destinationPath: W('out/pkg-copy') }))
      .resolves.toMatchObject({ ok: true });
    await expect(readFile(path.join(workspace.rootPath, 'out', 'pkg-copy', 'a.ts'), 'utf8')).resolves.toBe('export const a = 1;\n');

    await expect(service.moveFile(actor, workspace.id, { sourcePath: W('src/pkg'), destinationPath: W('relocated/pkg'), userConfirmed: true }))
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
      .writeFile(actor, workspace.id, { path: W('docs/plan.md'), content: 'nope' });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
