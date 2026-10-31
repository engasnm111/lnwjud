import { watch, type FSWatcher } from 'node:fs';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { JsonWorkspaceIndexStore, WorkspaceIndexService, type WorkspaceIndexSnapshot, type WorkspaceIndexStore, type WorkspaceIndexMutation } from './workspace-index.js';

vi.mock('node:fs', { spy: true });

function fixtureRepository(workspace: Workspace): WorkspaceRepository {
  return {
    async list(): Promise<Workspace[]> { return [workspace]; },
    async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
    async insert(): Promise<void> { return undefined; },
    async delete(): Promise<void> { return undefined; },
  };
}

function memoryStore(beforeCommit?: () => Promise<void>): WorkspaceIndexStore {
  let snapshot: WorkspaceIndexSnapshot | null = null;
  return {
    async load(): Promise<WorkspaceIndexSnapshot | null> { return snapshot; },
    async withMutation<T>(_workspaceId: string, mutation: (store: WorkspaceIndexMutation) => Promise<T>): Promise<T> {
      return mutation({
        async load(): Promise<WorkspaceIndexSnapshot | null> { return snapshot; },
        async save(next) { await beforeCommit?.(); snapshot = next; },
        async delete() { snapshot = null; },
      });
    },
  };
}

describe('WorkspaceIndexService', () => {
  it('skips AI model files and indexes oversized unknown files as metadata without reading contents', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-index-model-'));
    const workspace: Workspace = { id: 'model-size', displayName: 'fixture', rootPath: root, realRootPath: root, createdAt: new Date().toISOString() };
    const service = new WorkspaceIndexService(fixtureRepository(workspace), memoryStore());
    try {
      await writeFile(path.join(root, 'source.ts'), 'export const regularSource = 1;\n');
      await writeFile(path.join(root, 'model.onnx'), 'small model fixture');
      const largeFile = path.join(root, 'large.custom');
      await writeFile(largeFile, 'start');
      await truncate(largeFile, 17 * 1024 * 1024);
      const result = await service.indexWorkspace(workspace.id, { rebuild: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const entries = result.value.entries;
      expect(entries.find((entry) => entry.relativePath === 'model.onnx')).toBeUndefined();
      const large = entries.find((entry) => entry.relativePath === 'large.custom');
      expect(large).toMatchObject({ kind: 'file', size: 17 * 1024 * 1024, contentHash: null, gitBlobSha: null, symbols: [] });
      expect(entries.find((entry) => entry.relativePath === 'source.ts')?.symbols).toContain('regularSource');
      const explicit = await service.indexPath(workspace.id, 'model.onnx', { discovery: 'explicit' });
      expect(explicit.ok).toBe(true);
      if (explicit.ok) expect(explicit.value.entries.find((entry) => entry.relativePath === 'model.onnx')?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves both distinct path updates when snapshot commits overlap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-index-concurrent-'));
    const workspace: Workspace = {
      id: 'concurrent', displayName: 'fixture', rootPath: root, realRootPath: root, createdAt: new Date().toISOString(),
    };
    const commitStarted = Promise.withResolvers<void>();
    const releaseCommit = Promise.withResolvers<void>();
    let holdNextCommit = false;
    const store = memoryStore(async () => {
        if (holdNextCommit) {
          holdNextCommit = false;
          commitStarted.resolve();
          await releaseCommit.promise;
        }
    });
    const service = new WorkspaceIndexService(fixtureRepository(workspace), store);
    try {
      await writeFile(path.join(root, 'a.ts'), 'export const oldA = 1;');
      await writeFile(path.join(root, 'b.ts'), 'export const oldB = 1;');
      expect((await service.indexWorkspace(workspace.id)).ok).toBe(true);
      await writeFile(path.join(root, 'a.ts'), 'export const updatedA = 2;');
      await writeFile(path.join(root, 'b.ts'), 'export const updatedB = 2;');
      holdNextCommit = true;
      const updates = Promise.all([service.indexPath(workspace.id, 'a.ts'), service.indexPath(workspace.id, 'b.ts')]);
      await commitStarted.promise;
      releaseCommit.resolve();
      expect((await updates).every((result) => result.ok)).toBe(true);
      const persisted = await store.load(workspace.id);
      expect(persisted?.entries.find((entry) => entry.relativePath === 'a.ts')?.symbols).toContain('updatedA');
      expect(persisted?.entries.find((entry) => entry.relativePath === 'b.ts')?.symbols).toContain('updatedB');
    } finally {
      releaseCommit.resolve();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a persistence ENOENT without treating it as a deleted source path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-index-write-fault-'));
    const workspace: Workspace = {
      id: 'write-fault', displayName: 'fixture', rootPath: root, realRootPath: root, createdAt: new Date().toISOString(),
    };
    let failNextCommit = false;
    const store = memoryStore(async () => {
        if (failNextCommit) {
          failNextCommit = false;
          throw Object.assign(new Error('Fixture missing temporary file'), { code: 'ENOENT' });
        }
    });
    const service = new WorkspaceIndexService(fixtureRepository(workspace), store);
    try {
      await writeFile(path.join(root, 'a.ts'), 'export const original = 1;');
      expect((await service.indexWorkspace(workspace.id)).ok).toBe(true);
      await writeFile(path.join(root, 'a.ts'), 'export const updated = 2;');
      failNextCommit = true;
      await expect(service.indexPath(workspace.id, 'a.ts')).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
      const retained = await store.load(workspace.id);
      expect(retained?.entries.find((entry) => entry.relativePath === 'a.ts')?.symbols).toContain('original');
      expect((await service.indexPath(workspace.id, 'a.ts')).ok).toBe(true);
      const recovered = await store.load(workspace.id);
      expect(recovered?.entries.find((entry) => entry.relativePath === 'a.ts')?.symbols).toContain('updated');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes complete snapshots through separate atomic temporary files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-index-atomic-'));
    const store = new JsonWorkspaceIndexStore(root);
    const snapshot: WorkspaceIndexSnapshot = {
      version: 1, discoveryPolicyRevision: 1, workspaceId: 'atomic', rootPath: root, indexedAt: new Date().toISOString(), entries: [],
    };
    try {
      const first = { ...snapshot, indexedAt: '2026-10-12T00:00:00.000Z' };
      const second = { ...snapshot, indexedAt: '2026-10-12T00:01:00.000Z' };
      await Promise.all([
        store.withMutation(snapshot.workspaceId, (mutation) => mutation.save(first)),
        store.withMutation(snapshot.workspaceId, (mutation) => mutation.save(second)),
      ]);
      expect([first, second]).toContainEqual(await store.load(snapshot.workspaceId));
      expect((await readdir(root)).sort()).toEqual(['.locks', 'atomic.json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports unreadable persisted data and recovers through an explicit rebuild', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-index-read-fault-'));
    const workspace: Workspace = {
      id: 'read-fault', displayName: 'fixture', rootPath: root, realRootPath: root, createdAt: new Date().toISOString(),
    };
    const directory = path.join(root, '.index-store');
    await mkdir(directory);
    const store = new JsonWorkspaceIndexStore(directory);
    const service = new WorkspaceIndexService(fixtureRepository(workspace), store);
    try {
      await writeFile(path.join(directory, 'read-fault.json'), '{unreadable JSON');
      await writeFile(path.join(root, 'a.ts'), 'export const original = 1;');
      await expect(service.status(workspace.id)).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
      await expect(service.indexPath(workspace.id, 'a.ts')).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
      expect((await service.indexWorkspace(workspace.id, { rebuild: true })).ok).toBe(true);
      await expect(service.status(workspace.id)).resolves.toMatchObject({ ok: true, value: { indexed: true } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['missing root', 'invalid entry'])('reports corrupt current-format %s instead of discarding the index', async (kind) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-index-invalid-shape-'));
    const workspace: Workspace = { id: 'invalid', displayName: 'fixture', rootPath: root, realRootPath: root, createdAt: new Date().toISOString() };
    const directory = path.join(root, '.index-store');
    await mkdir(directory);
    const value = { version: 1, discoveryPolicyRevision: 1, workspaceId: workspace.id, indexedAt: new Date().toISOString(),
      ...(kind === 'missing root' ? {} : { rootPath: root }), entries: kind === 'invalid entry' ? [null] : [] };
    await writeFile(path.join(directory, 'invalid.json'), JSON.stringify(value));
    const service = new WorkspaceIndexService(fixtureRepository(workspace), new JsonWorkspaceIndexStore(directory));
    try {
      await expect(service.status(workspace.id)).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
      expect((await service.indexWorkspace(workspace.id, { rebuild: true })).ok).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refreshes an unwatched snapshot before reporting a newly started watcher clean', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-index-watch-baseline-'));
    const workspace: Workspace = { id: 'watch-baseline', displayName: 'fixture', rootPath: root, realRootPath: root, createdAt: new Date().toISOString() };
    const service = new WorkspaceIndexService(fixtureRepository(workspace), memoryStore());
    try {
      await writeFile(path.join(root, 'a.ts'), 'export const old = 1;');
      expect((await service.indexWorkspace(workspace.id)).ok).toBe(true);
      await writeFile(path.join(root, 'a.ts'), 'export const current = 2;');
      const started = await service.startWatch(workspace.id);
      expect(started).toMatchObject({ ok: true, value: { freshness: 'watching_clean', stale: false } });
      if (started.ok) expect(started.value.snapshot?.entries.find((entry) => entry.relativePath === 'a.ts')?.symbols).toContain('current');
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('counts a failed watcher commit as degraded rather than completed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-index-watch-fault-'));
    const workspace: Workspace = {
      id: 'watch-fault', displayName: 'fixture', rootPath: root, realRootPath: root, createdAt: new Date().toISOString(),
    };
    let rejectCommits = false;
    const store = memoryStore(async () => {
        if (rejectCommits) throw new Error('Fixture failed commit');
    });
    const service = new WorkspaceIndexService(fixtureRepository(workspace), store);
    let notify: ((event: 'change' | 'rename', filename: string | null) => void) | undefined;
    const watcher = new EventEmitter() as FSWatcher;
    watcher.close = (): void => { watcher.emit('close'); };
    vi.mocked(watch).mockImplementation((_root, _options, callback) => { notify = callback; return watcher; });
    try {
      await writeFile(path.join(root, 'a.ts'), 'export const original = 1;');
      expect((await service.indexWorkspace(workspace.id)).ok).toBe(true);
      expect((await service.startWatch(workspace.id, { debounceMs: 0 })).ok).toBe(true);
      rejectCommits = true;
      await writeFile(path.join(root, 'a.ts'), 'export const updated = 2;');
      expect(notify).toBeDefined();
      notify?.('change', 'a.ts');
      await vi.waitFor(async () => {
        const status = await service.status(workspace.id);
        expect(status).toMatchObject({ ok: true, value: { freshness: 'watching_degraded', watcher: { completedEvents: 0, failedEvents: expect.any(Number) } } });
        if (status.ok) expect(status.value.watcher?.failedEvents).toBeGreaterThan(0);
      });
      rejectCommits = false;
      expect((await service.indexWorkspace(workspace.id, { rebuild: true })).ok).toBe(true);
      const recovered = await store.load(workspace.id);
      expect(recovered?.entries.find((entry) => entry.relativePath === 'a.ts')?.symbols).toContain('updated');
      // Native file watchers can enqueue additional events while the manual rebuild finishes.
      // Recovery must become clean once those events have drained; failure history stays visible.
      await vi.waitFor(async () => {
        await expect(service.status(workspace.id)).resolves.toMatchObject({ ok: true, value: { freshness: 'watching_clean', stale: false, watcher: { failedEvents: expect.any(Number) } } });
      }, { timeout: 3_000, interval: 20 });
    } finally {
      rejectCommits = false;
      await service.close();
      vi.mocked(watch).mockReset();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('invalidates a persisted snapshot that predates the discovery-policy revision', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-index-policy-'));
    const storeDir = path.join(root, 'index-store');
    await mkdir(storeDir, { recursive: true });
    await writeFile(path.join(storeDir, `${encodeURIComponent('workspace-policy')}.json`), `${JSON.stringify({
      version: 1,
      workspaceId: 'workspace-policy',
      rootPath: root,
      indexedAt: '2026-09-18T00:00:00.000Z',
      entries: [],
    })}\n`, 'utf8');
    const store = new JsonWorkspaceIndexStore(storeDir);
    await expect(store.load('workspace-policy')).resolves.toBeNull();
  });

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
