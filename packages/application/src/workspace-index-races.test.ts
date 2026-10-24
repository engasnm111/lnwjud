import { watch, type FSWatcher } from 'node:fs';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { JsonWorkspaceIndexStore, WorkspaceIndexService, type WorkspaceIndexStore } from './workspace-index.js';

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });

async function fixture(): Promise<{ directory: string; root: string; workspace: Workspace; repository: WorkspaceRepository; store: JsonWorkspaceIndexStore }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-index-race-'));
  const root = path.join(directory, 'workspace');
  await mkdir(root);
  const workspace: Workspace = { id: 'shared', displayName: 'fixture', rootPath: root, realRootPath: root, createdAt: new Date().toISOString() };
  let registered = true;
  const repository: WorkspaceRepository = {
    async list() { return registered ? [workspace] : []; },
    async get(id) { return registered && id === workspace.id ? workspace : null; },
    async insert() { registered = true; },
    async delete() { registered = false; },
  };
  return { directory, root, workspace, repository, store: new JsonWorkspaceIndexStore(path.join(directory, 'index')) };
}

describe('workspace index races', () => {
  it('quiesces filename-free notifications caused by its own snapshot publication', async () => {
    const setup = await fixture();
    let notify: ((event: 'change' | 'rename', filename: string | null) => void) | undefined;
    const watcher = new EventEmitter() as FSWatcher;
    watcher.close = (): void => { watcher.emit('close'); };
    vi.mocked(watch).mockImplementation((_root, _options, callback) => { notify = callback; return watcher; });
    let saves = 0;
    const store: WorkspaceIndexStore = {
      load: (workspaceId) => setup.store.load(workspaceId),
      withMutation: (workspaceId, mutation, signal) => setup.store.withMutation(workspaceId, (scope) => mutation({
        ...scope,
        async save(snapshot) {
          saves += 1;
          if (saves > 4) throw new Error('Self-publication loop');
          await scope.save(snapshot);
          notify?.('change', null);
        },
      }), signal),
    };
    const service = new WorkspaceIndexService(setup.repository, store);
    try {
      await writeFile(path.join(setup.root, 'a.ts'), 'export const original = 1;');
      const started = await service.startWatch(setup.workspace.id, { debounceMs: 0 });
      expect(started).toMatchObject({ ok: true, value: { freshness: 'watching_clean', watcher: { failedEvents: 0 } } });
      expect(saves).toBe(1);
      await writeFile(path.join(setup.root, 'a.ts'), 'export const updated = 2;');
      notify?.('change', null);
      await vi.waitFor(async () => {
        const status = await service.status(setup.workspace.id);
        expect(status.ok && status.value.snapshot?.entries.find((entry) => entry.relativePath === 'a.ts')?.symbols).toContain('updated');
        expect(status).toMatchObject({ ok: true, value: { freshness: 'watching_clean', watcher: { pendingEvents: 0, activeWorkers: 0, failedEvents: 0 } } });
      });
      expect(saves).toBe(2);
    } finally {
      await service.close();
      vi.mocked(watch).mockReset();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });
  it('rebuilds after a native event without a filename instead of retaining a false clean baseline', async () => {
    const setup = await fixture();
    const service = new WorkspaceIndexService(setup.repository, setup.store);
    let notify: ((event: 'change' | 'rename', filename: string | null) => void) | undefined;
    const watcher = new EventEmitter() as FSWatcher;
    watcher.close = (): void => { watcher.emit('close'); };
    vi.mocked(watch).mockImplementation((_root, _options, callback) => { notify = callback; return watcher; });
    try {
      await writeFile(path.join(setup.root, 'a.ts'), 'export const original = 1;');
      expect((await service.startWatch(setup.workspace.id, { debounceMs: 0 })).ok).toBe(true);
      await writeFile(path.join(setup.root, 'a.ts'), 'export const updated = 2;');
      notify?.('change', null);
      await vi.waitFor(async () => {
        const status = await service.status(setup.workspace.id);
        expect(status.ok && status.value.snapshot?.entries.find((entry) => entry.relativePath === 'a.ts')?.symbols).toContain('updated');
        expect(status.ok && status.value.freshness).toBe('watching_clean');
      });
    } finally {
      await service.close();
      vi.mocked(watch).mockReset();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });
  it('preserves an existing watcher when a replacement is cancelled during lookup', async () => {
    const setup = await fixture();
    const service = new WorkspaceIndexService(setup.repository, setup.store);
    const watcher = new EventEmitter() as FSWatcher;
    const closeWatcher = vi.fn((): void => { watcher.emit('close'); });
    watcher.close = closeWatcher;
    vi.mocked(watch).mockImplementation(() => watcher);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const actualGet = setup.repository.get.bind(setup.repository);
    let hold = false;
    setup.repository.get = async (id): ReturnType<WorkspaceRepository['get']> => {
      if (hold) { hold = false; entered.resolve(); await release.promise; }
      return actualGet(id);
    };
    try {
      await writeFile(path.join(setup.root, 'a.ts'), 'export const original = 1;');
      expect(await service.startWatch(setup.workspace.id)).toMatchObject({ ok: true, value: { freshness: 'watching_clean' } });
      hold = true;
      const replacing = service.startWatch(setup.workspace.id, { signal: controller.signal });
      await entered.promise;
      controller.abort();
      await expect(replacing).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
      release.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      const status = await service.status(setup.workspace.id);
      expect(status.ok && status.value.watcher).not.toBeNull();
      expect(status.ok && status.value.freshness).toBe('watching_clean');
      expect(watch).toHaveBeenCalledTimes(1);
      expect(closeWatcher).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await service.close();
      vi.mocked(watch).mockReset();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it.each(['watcher', 'other-runtime'] as const)('recovers a complete lost snapshot through %s updates', async (provider) => {
    const setup = await fixture();
    const service = new WorkspaceIndexService(setup.repository, setup.store);
    const other = new WorkspaceIndexService(setup.repository, new JsonWorkspaceIndexStore(path.join(setup.directory, 'index')));
    try {
      await writeFile(path.join(setup.root, 'a.ts'), 'export const originalA = 1;');
      await writeFile(path.join(setup.root, 'b.ts'), 'export const preservedB = 1;');
      expect((await service.startWatch(setup.workspace.id, { debounceMs: 5 })).ok).toBe(true);
      await setup.store.withMutation(setup.workspace.id, (scope) => scope.delete());
      await writeFile(path.join(setup.root, 'a.ts'), 'export const updatedA = 2;');
      if (provider === 'other-runtime') expect((await other.indexPath(setup.workspace.id, 'a.ts')).ok).toBe(true);
      await vi.waitFor(async () => {
        const status = await service.status(setup.workspace.id);
        expect(status.ok && status.value.snapshot?.entries.find((entry) => entry.relativePath === 'a.ts')?.symbols).toContain('updatedA');
        expect(status.ok && status.value.snapshot?.entries.find((entry) => entry.relativePath === 'b.ts')?.symbols).toContain('preservedB');
        expect(status.ok && status.value.freshness).toBe('watching_clean');
      });
    } finally {
      await Promise.all([service.close(), other.close()]);
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it('scans explicit discovery even when an automatic watcher snapshot is ready', async () => {
    const setup = await fixture();
    const service = new WorkspaceIndexService(setup.repository, setup.store);
    try {
      await mkdir(path.join(setup.root, 'node_modules'));
      await writeFile(path.join(setup.root, 'node_modules', 'fixture.ts'), 'export const explicit = 1;');
      expect((await service.startWatch(setup.workspace.id)).ok).toBe(true);
      const snapshot = await service.indexWorkspace(setup.workspace.id, { discovery: 'explicit' });
      expect(snapshot.ok && snapshot.value.entries.some((entry) => entry.relativePath === 'node_modules/fixture.ts')).toBe(true);
    } finally {
      await service.close();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it('does not claim a clean watched snapshot for explicitly included unwatched paths', async () => {
    const setup = await fixture();
    const service = new WorkspaceIndexService(setup.repository, setup.store);
    const source = path.join(setup.root, 'node_modules', 'fixture.ts');
    try {
      await mkdir(path.dirname(source));
      await writeFile(source, 'export const old = 1;');
      expect((await service.startWatch(setup.workspace.id)).ok).toBe(true);
      expect((await service.indexPath(setup.workspace.id, 'node_modules/fixture.ts', { discovery: 'explicit' })).ok).toBe(true);
      await writeFile(source, 'export const unobserved = 2;');
      await expect(service.status(setup.workspace.id)).resolves.toMatchObject({ ok: true, value: { freshness: 'unverified', stale: null } });
      const refreshed = await service.indexWorkspace(setup.workspace.id);
      expect(refreshed.ok && refreshed.value.entries.some((entry) => entry.relativePath === 'node_modules/fixture.ts')).toBe(false);
      await vi.waitFor(async () => {
        await expect(service.status(setup.workspace.id)).resolves.toMatchObject({ ok: true, value: { freshness: 'watching_clean', stale: false } });
      }, { timeout: 3_000, interval: 20 });
    } finally {
      await service.close();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it('closes a new watcher when startup is cancelled during its final status read', async () => {
    const setup = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    let closed = false;
    vi.mocked(watch).mockImplementation((...args) => {
      const watcher = actual.watch(...args);
      watcher.on('close', () => { closed = true; });
      return watcher;
    });
    const store: WorkspaceIndexStore = {
      async load(workspaceId) { entered.resolve(); await release.promise; return setup.store.load(workspaceId); },
      withMutation: (workspaceId, mutation, signal) => setup.store.withMutation(workspaceId, mutation, signal),
    };
    const service = new WorkspaceIndexService(setup.repository, store);
    const starting = service.startWatch(setup.workspace.id, { signal: controller.signal });
    try {
      await entered.promise;
      controller.abort();
      await expect(starting).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 300, interval: 5 });
      release.resolve();
      await service.close();
      await expect(service.status(setup.workspace.id)).resolves.toMatchObject({ ok: true, value: { watcher: null } });
    } finally {
      release.resolve();
      await starting;
      await service.close();
      vi.mocked(watch).mockReset();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it('ignores its owned cache during automatic discovery and watching inside the root', async () => {
    const setup = await fixture();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const nativeEvents: { event: string; filename: string | null }[] = [];
    vi.mocked(watch).mockImplementation((root, options, callback) => actual.watch(root, options, (event, filename) => {
      nativeEvents.push({ event, filename: filename === null ? null : filename.toString() });
      if (nativeEvents.length > 128) nativeEvents.shift();
      callback?.(event, filename);
    }));
    const cachePath = path.join(setup.root, '.index-store');
    const store = new JsonWorkspaceIndexStore(cachePath);
    const service = new WorkspaceIndexService(setup.repository, store);
    try {
      await writeFile(path.join(setup.root, 'a.ts'), 'export const original = 1;');
      expect((await service.indexWorkspace(setup.workspace.id)).ok).toBe(true);
      const refreshed = await service.indexWorkspace(setup.workspace.id, { rebuild: true });
      expect(refreshed.ok).toBe(true);
      if (refreshed.ok) expect(refreshed.value.entries.some((entry) => entry.relativePath.startsWith('.index-store'))).toBe(false);
      expect((await service.startWatch(setup.workspace.id, { debounceMs: 5 })).ok).toBe(true);
      await writeFile(path.join(setup.root, 'a.ts'), 'export const updated = 2;');
      await vi.waitFor(async () => {
        const status = await service.status(setup.workspace.id);
        expect(status.ok && status.value.snapshot?.entries.find((entry) => entry.relativePath === 'a.ts')?.symbols,
          status.ok ? JSON.stringify({ nativeEvents, watcher: status.value.watcher, freshness: status.value.freshness, watcherError: status.value.watcherError }) : JSON.stringify(status.error)).toContain('updated');
        expect(status.ok && status.value.freshness).toBe('watching_clean');
      });
      const snapshot = await store.load(setup.workspace.id);
      if (snapshot === null) throw new Error('Fixture snapshot missing');
      await store.withMutation(setup.workspace.id, (scope) => scope.save(snapshot));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const after = await service.status(setup.workspace.id);
      // Native watcher notifications for the earlier a.ts write can arrive
      // after watching_clean, changing event counters on slower macOS CI.
      // Check the owned-cache exclusion contract, not unrelated event totals.
      expect(after).toMatchObject({ ok: true, value: {
        freshness: 'watching_clean', watcher: { activeWorkers: 0, pendingEvents: 0, failedEvents: 0 },
      } });
      expect(after.ok && after.value.snapshot?.entries.some((entry) => entry.relativePath.startsWith('.index-store'))).toBe(false);
      const explicit = await service.indexPath(setup.workspace.id, '.index-store/shared.json', { discovery: 'explicit' });
      expect(explicit.ok && explicit.value.entries.some((entry) => entry.relativePath === '.index-store/shared.json')).toBe(true);
    } finally {
      await service.close();
      vi.mocked(watch).mockReset();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it('cancels a locally queued mutation before an earlier commit is released', async () => {
    const setup = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    let hold = false;
    let saves = 0;
    const store: WorkspaceIndexStore = {
      load: (workspaceId) => setup.store.load(workspaceId),
      withMutation: (workspaceId, mutation, signal) => setup.store.withMutation(workspaceId, (scope) => mutation({
        ...scope,
        async save(snapshot) {
          saves += 1;
          if (hold) { hold = false; entered.resolve(); await release.promise; }
          await scope.save(snapshot);
        },
      }), signal),
    };
    const service = new WorkspaceIndexService(setup.repository, store);
    let first: ReturnType<WorkspaceIndexService['indexPath']> | undefined;
    let second: ReturnType<WorkspaceIndexService['indexPath']> | undefined;
    try {
      await writeFile(path.join(setup.root, 'a.ts'), 'export const originalA = 1;');
      await writeFile(path.join(setup.root, 'b.ts'), 'export const originalB = 1;');
      expect((await service.indexWorkspace(setup.workspace.id)).ok).toBe(true);
      await writeFile(path.join(setup.root, 'a.ts'), 'export const updatedA = 2;');
      await writeFile(path.join(setup.root, 'b.ts'), 'export const cancelledB = 2;');
      hold = true;
      first = service.indexPath(setup.workspace.id, 'a.ts');
      await entered.promise;
      let settled = false;
      second = service.indexPath(setup.workspace.id, 'b.ts', { signal: controller.signal }).finally(() => { settled = true; });
      controller.abort();
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 300, interval: 5 });
      await expect(second).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
      expect(saves).toBe(2);
      release.resolve();
      await expect(first).resolves.toMatchObject({ ok: true });
      await service.close();
      const retained = await setup.store.load(setup.workspace.id);
      expect(retained?.entries.find((entry) => entry.relativePath === 'a.ts')?.symbols).toContain('updatedA');
      expect(retained?.entries.find((entry) => entry.relativePath === 'b.ts')?.symbols).toContain('originalB');
      expect(saves).toBe(2);
    } finally {
      release.resolve();
      await Promise.all([first, second]);
      await service.close();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it.each(['refresh', 'start'] as const)('cancels %s while watcher work is draining', async (operation) => {
    const setup = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    let hold = false;
    let saves = 0;
    let cancelledWrites = 0;
    const store: WorkspaceIndexStore = {
      load: (workspaceId) => setup.store.load(workspaceId),
      withMutation: (workspaceId, mutation, signal) => setup.store.withMutation(workspaceId, (scope) => mutation({
        ...scope,
        async save(snapshot) {
          saves += 1;
          if (signal?.aborted) cancelledWrites += 1;
          if (hold) { hold = false; entered.resolve(); await release.promise; }
          await scope.save(snapshot);
        },
      }), signal),
    };
    const service = new WorkspaceIndexService(setup.repository, store);
    try {
      await writeFile(path.join(setup.root, 'a.ts'), 'export const original = 1;');
      expect((await service.startWatch(setup.workspace.id, { debounceMs: 5 })).ok).toBe(true);
      hold = true;
      await writeFile(path.join(setup.root, 'a.ts'), 'export const updated = 2;');
      await entered.promise;
      let settled = false;
      const pending = operation === 'refresh'
        ? service.indexWorkspace(setup.workspace.id, { signal: controller.signal })
        : service.startWatch(setup.workspace.id, { signal: controller.signal });
      void pending.finally(() => { settled = true; });
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 300, interval: 5 });
      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
      release.resolve();
      await service.close();
      // FS watchers can deliver duplicate events; no cancelled index operation may commit a snapshot.
      expect(saves).toBeGreaterThanOrEqual(2);
      expect(cancelledWrites).toBe(0);
      const retained = await setup.store.load(setup.workspace.id);
      expect(retained?.entries.find((entry) => entry.relativePath === 'a.ts')?.symbols).toContain('updated');
    } finally {
      release.resolve();
      await service.close();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it('skips a vanished descendant without erasing its surviving siblings', async () => {
    const setup = await fixture();
    const service = new WorkspaceIndexService(setup.repository, setup.store);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const source = path.join(setup.root, 'src');
    const victim = path.join(source, 'a.ts');
    let faulted = false;
    try {
      await mkdir(source);
      await writeFile(victim, 'export const vanished = 1;');
      await writeFile(path.join(source, 'b.ts'), 'export const old = 1;');
      expect((await service.indexWorkspace(setup.workspace.id)).ok).toBe(true);
      await writeFile(path.join(source, 'b.ts'), 'export const surviving = 2;');
      vi.mocked(readFile).mockImplementation(async (...args) => {
        if (args[0] === victim && !faulted) {
          faulted = true;
          await rm(victim);
          throw Object.assign(new Error('Fixture file vanished after enumeration'), { code: 'ENOENT' });
        }
        return actual.readFile(...args);
      });
      const indexed = await service.indexPath(setup.workspace.id, 'src');
      expect(indexed.ok).toBe(true);
      expect(faulted).toBe(true);
      if (indexed.ok) {
        expect(indexed.value.entries.find((entry) => entry.relativePath === 'src/b.ts')?.symbols).toContain('surviving');
        expect(indexed.value.entries.some((entry) => entry.relativePath === 'src/a.ts')).toBe(false);
      }
    } finally {
      vi.mocked(readFile).mockReset();
      await service.close();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it('closes every concurrent watcher start and handles a broken native watcher', async () => {
    const setup = await fixture();
    const service = new WorkspaceIndexService(setup.repository, setup.store);
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const created: FSWatcher[] = [];
    const closed = new Set<FSWatcher>();
    vi.mocked(watch).mockImplementation((...args) => {
      const watcher = actual.watch(...args);
      watcher.on('close', () => closed.add(watcher));
      created.push(watcher);
      return watcher;
    });
    try {
      await writeFile(path.join(setup.root, 'a.ts'), 'export const current = 1;');
      const started = await Promise.all([service.startWatch(setup.workspace.id), service.startWatch(setup.workspace.id)]);
      expect(started.every((result) => result.ok)).toBe(true);
      expect(created).toHaveLength(2);
      const retained = created[1];
      if (retained === undefined) throw new Error('Native watcher missing');
      retained.emit('error', new Error('Fixture native watcher failed'));
      await expect(service.status(setup.workspace.id)).resolves.toMatchObject({ ok: true, value: { freshness: 'watching_degraded', watcherError: expect.any(String) } });
      expect((await service.indexWorkspace(setup.workspace.id, { rebuild: true })).ok).toBe(true);
      await expect(service.status(setup.workspace.id)).resolves.toMatchObject({ ok: true, value: { freshness: 'watching_degraded' } });
      expect((await service.startWatch(setup.workspace.id)).ok).toBe(true);
      await expect(service.status(setup.workspace.id)).resolves.toMatchObject({ ok: true, value: { freshness: 'watching_clean', watcherError: null } });
      await service.close();
      await vi.waitFor(() => expect(closed.size).toBe(created.length));
      await expect(service.startWatch(setup.workspace.id)).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    } finally {
      await service.close();
      for (const watcher of created) watcher.close();
      vi.mocked(watch).mockReset();
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it('serializes two services against one directory and deletion after admitted work', async () => {
    const setup = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let holdCommit = false;
    const store: WorkspaceIndexStore = {
      load: (workspaceId) => setup.store.load(workspaceId),
      withMutation: (workspaceId, mutation) => setup.store.withMutation(workspaceId, (scope) => mutation({
        ...scope,
        async save(snapshot) {
          if (holdCommit) { holdCommit = false; entered.resolve(); await release.promise; }
          await scope.save(snapshot);
        },
      })),
    };
    const first = new WorkspaceIndexService(setup.repository, store);
    const second = new WorkspaceIndexService(setup.repository, new JsonWorkspaceIndexStore(path.join(setup.directory, 'index')));
    try {
      await writeFile(path.join(setup.root, 'a.ts'), 'export const oldA = 1;');
      await writeFile(path.join(setup.root, 'b.ts'), 'export const oldB = 1;');
      expect((await first.indexWorkspace(setup.workspace.id)).ok).toBe(true);
      await writeFile(path.join(setup.root, 'a.ts'), 'export const updatedA = 2;');
      await writeFile(path.join(setup.root, 'b.ts'), 'export const updatedB = 2;');
      holdCommit = true;
      const updateA = first.indexPath(setup.workspace.id, 'a.ts');
      await entered.promise;
      const updateB = second.indexPath(setup.workspace.id, 'b.ts');
      release.resolve();
      expect((await Promise.all([updateA, updateB])).every((result) => result.ok)).toBe(true);
      const snapshot = await setup.store.load(setup.workspace.id);
      expect(snapshot?.entries.find((entry) => entry.relativePath === 'a.ts')?.symbols).toContain('updatedA');
      expect(snapshot?.entries.find((entry) => entry.relativePath === 'b.ts')?.symbols).toContain('updatedB');
      await setup.repository.delete(setup.workspace.id);
      const forgetting = first.forgetWorkspace(setup.workspace.id);
      await expect(second.indexPath(setup.workspace.id, 'b.ts')).resolves.toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } });
      await forgetting;
      expect(await setup.store.load(setup.workspace.id)).toBeNull();
    } finally {
      release.resolve();
      await Promise.all([first.close(), second.close()]);
      await rm(setup.directory, { recursive: true, force: true });
    }
  });

  it('preserves the committed snapshot when cancellation arrives before publication', async () => {
    const setup = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const initial = new WorkspaceIndexService(setup.repository, setup.store);
    const store: WorkspaceIndexStore = {
      load: (workspaceId) => setup.store.load(workspaceId),
      withMutation: (workspaceId, mutation, signal) => setup.store.withMutation(workspaceId, (scope) => mutation({
        ...scope,
        async save(snapshot) { entered.resolve(); await release.promise; await scope.save(snapshot); },
      }), signal),
    };
    const service = new WorkspaceIndexService(setup.repository, store);
    try {
      await writeFile(path.join(setup.root, 'a.ts'), 'export const original = 1;');
      expect((await initial.indexWorkspace(setup.workspace.id)).ok).toBe(true);
      await writeFile(path.join(setup.root, 'a.ts'), 'export const cancelled = 2;');
      const updating = service.indexPath(setup.workspace.id, 'a.ts', { signal: controller.signal });
      await entered.promise;
      controller.abort();
      release.resolve();
      await expect(updating).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
      const retained = await setup.store.load(setup.workspace.id);
      expect(retained?.entries.find((entry) => entry.relativePath === 'a.ts')?.symbols).toContain('original');
    } finally {
      release.resolve();
      await Promise.all([initial.close(), service.close()]);
      await rm(setup.directory, { recursive: true, force: true });
    }
  });
});
