import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileService } from './file-service.js';
import type { WorkspaceRepository } from '@lnwjud/workspace';
import type { Workspace } from '@lnwjud/workspace';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function repository(workspace: Workspace): WorkspaceRepository {
  return {
    async list(): Promise<Workspace[]> { return [workspace]; },
    async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
    async insert(): Promise<void> {},
    async delete(): Promise<void> {},
  };
}

describe('FileService', () => {
  it('reads only through the workspace guard and enforces the 4 MiB aggregate cap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-files-'));
    temporaryRoots.push(root);
    const workspace: Workspace = { id: 'workspace-1', displayName: 'Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
    await writeFile(path.join(root, 'one.txt'), Buffer.alloc(1.5 * 1024 * 1024, 0x61));
    await writeFile(path.join(root, 'two.txt'), Buffer.alloc(1.5 * 1024 * 1024, 0x62));
    await writeFile(path.join(root, 'three.txt'), Buffer.alloc(1.5 * 1024 * 1024, 0x63));

    const result = await new FileService(repository(workspace)).readFiles(
      { clientId: 'test', clientName: 'test' },
      workspace.id,
      { files: [{ path: 'one.txt' }, { path: 'two.txt' }, { path: 'three.txt' }] },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'FILE_TOO_LARGE' } });
  });

  it('rejects a secret file before reading it outside E:', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-files-'));
    temporaryRoots.push(root);
    const workspace: Workspace = { id: 'workspace-1', displayName: 'Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
    await writeFile(path.join(root, '.env'), 'TOKEN=secret', 'utf8');

    const result = await new FileService(repository(workspace)).readFile(
      { clientId: 'test', clientName: 'test' },
      workspace.id,
      { path: '.env' },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'SECRET_ACCESS_DENIED' } });
  });

  it('allows secret and binary reads for workspaces under E:', async () => {
    const root = await mkdtemp(path.join('E:\\', 'lnwjud-files-'));
    temporaryRoots.push(root);
    const workspace: Workspace = { id: 'workspace-e', displayName: 'E Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
    await writeFile(path.join(root, '.env'), 'TOKEN=secret', 'utf8');
    await writeFile(path.join(root, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));

    const service = new FileService(repository(workspace));
    const envResult = await service.readFile({ clientId: 'test', clientName: 'test' }, workspace.id, { path: '.env' });
    expect(envResult).toMatchObject({ ok: true, value: { content: 'TOKEN=secret', encoding: 'utf8' } });

    const imageResult = await service.readFile({ clientId: 'test', clientName: 'test' }, workspace.id, { path: 'pixel.png' });
    expect(imageResult.ok).toBe(true);
    if (imageResult.ok) {
      expect(imageResult.value.encoding).toBe('base64');
      expect(imageResult.value.mimeType).toBe('image/png');
    }
  });
});
