import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceService, type WorkspaceRepository } from './workspace-service.js';
import type { Workspace } from './workspace-types.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function repositorySpy(): WorkspaceRepository & { inserted: Workspace[] } {
  const inserted: Workspace[] = [];
  return {
    inserted,
    async list(): Promise<Workspace[]> { return [...inserted]; },
    async get(id: string): Promise<Workspace | null> { return inserted.find((workspace) => workspace.id === id) ?? null; },
    async insert(workspace: Workspace): Promise<void> { inserted.push(workspace); },
    async delete(id: string): Promise<void> { const index = inserted.findIndex((workspace) => workspace.id === id); if (index >= 0) inserted.splice(index, 1); },
  };
}

describe('WorkspaceService', () => {
  it('stores the canonical realRootPath when adding a directory', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-service-'));
    temporaryRoots.push(parent);
    const rootPath = path.join(parent, 'project');
    await mkdir(rootPath);
    const repository = repositorySpy();
    const result = await new WorkspaceService(repository).add('Project', rootPath);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rootPath).toBe(path.resolve(rootPath));
      expect(result.value.realRootPath).toBe(await import('node:fs/promises').then(({ realpath }) => realpath(rootPath)));
      expect(repository.inserted).toEqual([result.value]);
    }
  });

  it('rejects a nonexistent or file root without writing to the repository', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-service-'));
    temporaryRoots.push(parent);
    const filePath = path.join(parent, 'not-a-directory.txt');
    await writeFile(filePath, 'fixture', 'utf8');
    const repository = repositorySpy();
    const service = new WorkspaceService(repository);

    const missing = await service.add('Missing', path.join(parent, 'missing'));
    const file = await service.add('File', filePath);

    expect(missing).toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } });
    expect(file).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(repository.inserted).toEqual([]);
  });

  it('rejects POSIX mount roots and foreign persisted paths before touching the repository', async () => {
    const repository = repositorySpy();
    const service = new WorkspaceService(repository, { platform: 'linux' });

    await expect(service.add('Root', '/')).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(service.add('Windows path', 'C:\\Users\\alice\\project')).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(repository.inserted).toEqual([]);
  });
});
