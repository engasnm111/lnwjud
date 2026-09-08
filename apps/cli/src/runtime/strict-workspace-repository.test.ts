import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { StrictWorkspaceRepository, canonicalizeAllowedRoots, requestedPathInsideAllowedRoot } from './strict-workspace-repository.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('strict stdio workspace repository', () => {
  it('hides previously registered broad roots and exposes only explicit allowed roots', async () => {
    const allowed = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-strict-allowed-'));
    const broad = path.parse(allowed).root;
    roots.push(allowed);
    const allowedReal = await realpath(allowed);
    const rows: Workspace[] = [workspace('broad', broad, broad), workspace('allowed', allowed, allowedReal)];
    const repo = new MemoryRepo(rows);
    const strict = new StrictWorkspaceRepository(repo, [allowedReal]);
    expect((await strict.list()).map((entry) => entry.id)).toEqual(['allowed']);
    expect(await strict.get('broad')).toBeNull();
  });

  it('canonicalizes roots and rejects requested workspaces outside them', async () => {
    const allowed = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-strict-allowed-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-strict-outside-'));
    roots.push(allowed, outside);
    const canonical = await canonicalizeAllowedRoots([allowed]);
    await expect(requestedPathInsideAllowedRoot(allowed, canonical)).resolves.toBe(canonical[0]);
    await expect(requestedPathInsideAllowedRoot(outside, canonical)).rejects.toThrow(/outside strict allowed roots/);
  });

  it('rejects foreign roots and POSIX mount roots before they become trusted workspaces', async () => {
    await expect(canonicalizeAllowedRoots(['/'], 'linux')).rejects.toThrow(/POSIX mount root/);
    await expect(canonicalizeAllowedRoots(['C:\\Users\\alice\\project'], 'linux')).rejects.toThrow(/foreign host path/);
  });
});

function workspace(id: string, rootPath: string, realRootPath: string): Workspace {
  return { id, displayName: id, rootPath, realRootPath, createdAt: '2026-08-22T00:00:00.000Z' };
}

class MemoryRepo implements WorkspaceRepository {
  public constructor(private readonly rows: Workspace[]) {}
  public async list(): Promise<Workspace[]> { return [...this.rows]; }
  public async get(id: string): Promise<Workspace | null> { return this.rows.find((row) => row.id === id) ?? null; }
  public async insert(value: Workspace): Promise<void> { this.rows.push(value); }
  public async delete(id: string): Promise<void> { const index = this.rows.findIndex((row) => row.id === id); if (index >= 0) this.rows.splice(index, 1); }
}
