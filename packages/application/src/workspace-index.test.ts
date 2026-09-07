import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { JsonWorkspaceIndexStore, WorkspaceIndexService } from './workspace-index.js';

function fixtureRepository(workspace: Workspace): WorkspaceRepository {
  return {
    async list(): Promise<Workspace[]> { return [workspace]; },
    async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
    async insert(): Promise<void> { return undefined; },
    async delete(): Promise<void> { return undefined; },
  };
}

describe('WorkspaceIndexService', () => {
  it('indexes source and metadata paths by default while allowing an explicit ignored subtree', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-index-'));
    await mkdir(path.join(root, '.git'), { recursive: true });
    await mkdir(path.join(root, 'dist'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'fixture'), { recursive: true });
    await writeFile(path.join(root, '.env'), 'TOKEN=fixture\n');
    await writeFile(path.join(root, '.git', 'config'), '[core]\n');
    await writeFile(path.join(root, 'dist', 'app.js'), 'export const built = true;\n');
    await writeFile(path.join(root, 'node_modules', 'fixture', 'index.js'), 'module.exports = 1;\n');
    await writeFile(path.join(root, 'src.ts'), 'export function answer(): number { return 42; }\n');
    const workspace: Workspace = {
      id: 'workspace-1', displayName: 'fixture', rootPath: root, realRootPath: root, createdAt: new Date().toISOString(),
    };
    const store = new JsonWorkspaceIndexStore(path.join(root, 'index-store'));
    const service = new WorkspaceIndexService(fixtureRepository(workspace), store);

    const result = await service.indexWorkspace(workspace.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.entries.map((entry) => entry.relativePath);
    expect(paths).toEqual(expect.arrayContaining(['.env', 'src.ts']));
    expect(paths).not.toEqual(expect.arrayContaining(['.git', '.git/config', 'dist', 'dist/app.js', 'node_modules', 'node_modules/fixture/index.js']));
    expect(result.value.entries.find((entry) => entry.relativePath === 'src.ts')?.functions).toContain('answer');
    expect((await service.snapshot(workspace.id)).ok).toBe(true);
    const initialStatus = await service.status(workspace.id);
    expect(initialStatus.ok).toBe(true);
    if (initialStatus.ok) {
      expect(initialStatus.value).toMatchObject({
        indexed: true,
        freshness: 'unverified',
        stale: null,
        watcher: null,
      });
      expect(initialStatus.value.generation).toMatch(/^[a-f0-9]{64}$/);
    }

    await writeFile(path.join(root, 'src.ts'), 'export function updated(): string { return "ok"; }\n');
    const update = await service.indexPath(workspace.id, 'src.ts');
    expect(update.ok).toBe(true);
    if (!update.ok) return;
    expect(update.value.entries.find((entry) => entry.relativePath === 'src.ts')?.functions).toContain('updated');
    expect(update.value.entries.find((entry) => entry.relativePath === 'src.ts')?.functions).not.toContain('answer');

    const explicit = await service.indexPath(workspace.id, 'node_modules', { discovery: 'explicit' });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(explicit.value.entries.map((entry) => entry.relativePath)).toEqual(expect.arrayContaining(['node_modules', 'node_modules/fixture/index.js']));
  });
});
