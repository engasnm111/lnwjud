import { createHash, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { classifyContextPath, type ContextDiscoveryMode } from '@lnwjud/search';
import { hostPathApi, isHostPathWithin, resolveHostPath, type Workspace, type WorkspaceRepository } from '@lnwjud/workspace';
import { WorkspaceIndexQueue, type WorkspaceIndexQueueOptions, type WorkspaceIndexQueueStatus } from './workspace-index-queue.js';
import { WorkspaceIndexBusyError, withWorkspaceIndexMutex } from './workspace-index-mutex.js';

function waitForIndexOperation<T>(operation: Promise<T>, signal?: AbortSignal, hasStarted: () => boolean = () => false): Promise<T> {
  if (signal === undefined) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      if (!hasStarted()) {
        signal.removeEventListener('abort', abort);
        reject(signal.reason ?? new Error('Workspace index operation was cancelled'));
      }
    };
    const removeListener = (): void => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => { removeListener(); resolve(value); },
      (error: unknown) => { removeListener(); reject(error); },
    );
    if (signal.aborted) abort();
  });
}

export interface WorkspaceIndexEntry {
  readonly relativePath: string;
  readonly kind: 'file' | 'directory' | 'symlink';
  readonly size: number;
  readonly mtimeMs: number;
  readonly contentHash: string | null;
  readonly gitBlobSha: string | null;
  readonly language: string | null;
  readonly isTest: boolean;
  readonly packageMetadata?: Readonly<Record<string, unknown>>;
  readonly symbols: readonly string[];
  readonly imports: readonly string[];
  readonly exports: readonly string[];
  readonly functions: readonly string[];
  readonly classes: readonly string[];
  readonly interfaces: readonly string[];
  readonly indexedAt: string;
}

const WORKSPACE_INDEX_DISCOVERY_POLICY_REVISION = 1;
const MAX_INDEX_FILE_BYTES = 16 * 1024 * 1024;

export interface WorkspaceIndexSnapshot {
  readonly version: 1;
  readonly discoveryPolicyRevision: 1;
  readonly workspaceId: string;
  readonly rootPath: string;
  readonly indexedAt: string;
  readonly entries: readonly WorkspaceIndexEntry[];
}

export interface WorkspaceIndexMutation {
  load(): Promise<WorkspaceIndexSnapshot | null>;
  save(snapshot: WorkspaceIndexSnapshot): Promise<void>;
  delete(): Promise<void>;
}

export interface WorkspaceIndexStore {
  load(workspaceId: string): Promise<WorkspaceIndexSnapshot | null>;
  withMutation<T>(workspaceId: string, mutation: (store: WorkspaceIndexMutation) => Promise<T>, signal?: AbortSignal): Promise<T>;
  isInternalPath?(absolutePath: string): boolean;
}

export class JsonWorkspaceIndexStore implements WorkspaceIndexStore {
  public constructor(private readonly directory: string = path.join(os.tmpdir(), 'lnwjud', 'index')) {}

  public isInternalPath(absolutePath: string): boolean {
    return isHostPathWithin(path.resolve(this.directory), path.resolve(absolutePath));
  }

  public async load(workspaceId: string): Promise<WorkspaceIndexSnapshot | null> {
    try {
      const content = await readFile(this.filePath(workspaceId), 'utf8');
      const value: unknown = JSON.parse(content);
      if (isRecord(value) && value.version === 1 && (value.discoveryPolicyRevision === undefined || value.discoveryPolicyRevision === 0)) return null;
      if (!isSnapshot(value) || value.workspaceId !== workspaceId) throw new Error('Workspace index data is invalid; rebuild the index to recover');
      return value;
    } catch (error: unknown) {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    }
  }

  public withMutation<T>(workspaceId: string, mutation: (store: WorkspaceIndexMutation) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withWorkspaceIndexMutex(this.directory, workspaceId, () => mutation({
      load: () => this.load(workspaceId),
      save: async (snapshot) => {
        if (snapshot.workspaceId !== workspaceId) throw new Error('Workspace index mutation belongs to another workspace');
        await this.save(snapshot, signal);
      },
      delete: () => rm(this.filePath(workspaceId), { force: true }),
    }), { ...(signal === undefined ? {} : { signal }) });
  }

  private async save(snapshot: WorkspaceIndexSnapshot, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await mkdir(this.directory, { recursive: true });
    const temporaryPath = `${this.filePath(snapshot.workspaceId)}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', flag: 'wx', ...(signal === undefined ? {} : { signal }) });
      signal?.throwIfAborted();
      await rename(temporaryPath, this.filePath(snapshot.workspaceId));
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private filePath(workspaceId: string): string {
    return path.join(this.directory, `${encodeURIComponent(workspaceId)}.json`);
  }
}

export type WorkspaceIndexWatchOptions = WorkspaceIndexQueueOptions & { readonly signal?: AbortSignal };

export interface WorkspaceIndexOptions {
  readonly discovery?: ContextDiscoveryMode;
  readonly rebuild?: boolean;
  readonly signal?: AbortSignal;
}

export interface WorkspaceIndexStatus {
  readonly indexed: boolean;
  readonly snapshot: WorkspaceIndexSnapshot | null;
  readonly watcher: WorkspaceIndexQueueStatus | null;
  readonly generation: string | null;
  readonly freshness: 'missing' | 'unverified' | 'watching_clean' | 'watching_pending' | 'watching_degraded';
  readonly stale: boolean | null;
  readonly watcherError: string | null;
}

interface IndexWatcher {
  readonly fileWatcher: FSWatcher;
  readonly queue: WorkspaceIndexQueue;
  recoveredFailures: number;
  baselineVerified: boolean;
  error: string | null;
}

interface WatchStartAttempt {
  watcher: IndexWatcher | null;
  completed: boolean;
}

export class WorkspaceIndexService {
  private readonly watchers = new Map<string, IndexWatcher>();
  private readonly mutations = new Map<string, Promise<void>>();
  private readonly watchLifecycles = new Map<string, Promise<void>>();
  private watchingClosed = false;

  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly store: WorkspaceIndexStore = new JsonWorkspaceIndexStore(),
  ) {}

  public async indexWorkspace(workspaceId: string, options: WorkspaceIndexOptions = {}): Promise<Result<WorkspaceIndexSnapshot>> {
    const watcher = this.watchers.get(workspaceId);
    let useWatchedSnapshot = false;
    if (options.rebuild !== true && options.discovery !== 'explicit' && watcher?.baselineVerified === true) {
      try {
        const snapshot = await this.store.load(workspaceId);
        useWatchedSnapshot = snapshot !== null && this.isAutomaticallyObservable(snapshot);
        if (useWatchedSnapshot) await waitForIndexOperation(watcher.queue.drain(), options.signal);
      } catch {
        if (options.signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Workspace index refresh was cancelled', true));
        return err(appError('INTERNAL_ERROR', 'Workspace index refresh failed'));
      }
    }
    return this.mutateSnapshot(workspaceId, async (workspace, store) => {
      if (useWatchedSnapshot && this.watchers.get(workspaceId) === watcher) {
        const refreshed = await store.load();
        if (refreshed !== null && this.isAutomaticallyObservable(refreshed)) return ok(refreshed);
      }
      return this.rebuildSnapshot(workspace, store, options);
    }, options.signal);
  }

  public async indexPath(workspaceId: string, relativePath: string, options: WorkspaceIndexOptions = {}): Promise<Result<WorkspaceIndexSnapshot>> {
    const normalized = normalizeRelativePath(relativePath);
    if (normalized === '') return this.indexWorkspace(workspaceId, options);
    return this.mutateSnapshot(workspaceId, async (workspace, store) => {
      const rootPath = resolveHostPath(workspace.realRootPath);
      const absolutePath = rootPath === null ? null : resolveHostPath(hostPathApi(process.platform).join(rootPath, normalized));
      if (rootPath === null || absolutePath === null) return err(appError('INVALID_INPUT', 'Index path uses a foreign host path syntax'));
      if (!isHostPathWithin(rootPath, absolutePath)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Index path is outside workspace'));
      const current = await store.load();
      if (current === null) return this.rebuildSnapshot(workspace, store, options);
      const discovery = options.discovery ?? 'automatic';
      if (!classifyContextPath(normalized, discovery).discoverable || (discovery === 'automatic' && this.store.isInternalPath?.(absolutePath))) return ok(current);
      const remaining = current.entries.filter((entry) => entry.relativePath !== normalized && !entry.relativePath.startsWith(`${normalized}/`));
      const additions: WorkspaceIndexEntry[] = [];
      try {
        const metadata = await stat(absolutePath);
        if (metadata.isDirectory()) await this.scanDirectory(rootPath, absolutePath, additions, discovery, options.signal);
        else additions.push(await this.describePath(rootPath, absolutePath, metadata, options.signal));
      } catch (error: unknown) {
        if (!isNodeError(error, 'ENOENT')) throw error;
        additions.length = 0;
      }
      const snapshot = this.snapshotValue(workspace, [...remaining, ...additions]);
      await store.save(snapshot);
      return ok(snapshot);
    }, options.signal);
  }

  public async removePath(workspaceId: string, relativePath: string): Promise<Result<WorkspaceIndexSnapshot>> {
    const normalized = normalizeRelativePath(relativePath);
    return this.mutateSnapshot(workspaceId, async (workspace, store) => {
      const current = await store.load();
      if (current === null) return err(appError('CONFLICT', 'Workspace index is missing; rebuild before removing entries', true));
      const entries = current.entries.filter((entry) => entry.relativePath !== normalized && !entry.relativePath.startsWith(`${normalized}/`));
      const snapshot = this.snapshotValue(workspace, entries);
      await store.save(snapshot);
      return ok(snapshot);
    });
  }

  public async snapshot(workspaceId: string): Promise<Result<WorkspaceIndexSnapshot | null>> {
    const workspace = await this.resolve(workspaceId);
    if (!workspace.ok) return workspace;
    try {
      return ok(await this.store.load(workspace.value.id));
    } catch {
      return err(appError('INTERNAL_ERROR', 'Workspace index could not be read; rebuild the index to recover'));
    }
  }

  public async status(workspaceId: string): Promise<Result<WorkspaceIndexStatus>> {
    const snapshot = await this.snapshot(workspaceId);
    if (!snapshot.ok) return snapshot;
    const watchState = this.watchers.get(workspaceId);
    const watcher = watchState?.queue.status() ?? null;
    const freshness = indexFreshness(snapshot.value, watcher, watchState, snapshot.value === null || this.isAutomaticallyObservable(snapshot.value));
    return ok({
      indexed: snapshot.value !== null,
      snapshot: snapshot.value,
      watcher,
      generation: snapshot.value === null ? null : snapshotGeneration(snapshot.value),
      freshness: freshness.state,
      stale: freshness.stale,
      watcherError: watchState?.error ?? null,
    });
  }

  public async startWatch(workspaceId: string, options: WorkspaceIndexWatchOptions = {}): Promise<Result<WorkspaceIndexStatus>> {
    const attempt: WatchStartAttempt = { watcher: null, completed: false };
    const cancel = (): void => {
      if (attempt.completed || attempt.watcher === null) return;
      attempt.watcher.fileWatcher.close();
      if (this.watchers.get(workspaceId) === attempt.watcher) this.watchers.delete(workspaceId);
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    const starting = this.serialize(this.watchLifecycles, workspaceId, async () => {
      const result = await this.startWatchNow(workspaceId, options, attempt);
      attempt.completed = result.ok;
      return result;
    }, options.signal);
    try {
      return await waitForIndexOperation(starting, options.signal, () => attempt.completed);
    } catch (error: unknown) {
      if (options.signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Workspace watcher start was cancelled', true));
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      if (options.signal?.aborted) cancel();
    }
  }

  private async startWatchNow(workspaceId: string, options: WorkspaceIndexWatchOptions, attempt: WatchStartAttempt): Promise<Result<WorkspaceIndexStatus>> {
    options.signal?.throwIfAborted();
    if (this.watchingClosed) return err(appError('CONFLICT', 'Workspace watcher service is closed'));
    const workspace = await this.resolve(workspaceId);
    if (!workspace.ok) return workspace;
    options.signal?.throwIfAborted();
    await this.stopWatchNow(workspaceId);
    options.signal?.throwIfAborted();
    let bootstrapping = true;
    const queue = new WorkspaceIndexQueue(async (event) => {
      const mutationOptions = bootstrapping && options.signal !== undefined ? { signal: options.signal } : {};
      const result = event.kind === 'rescan'
        ? await this.mutateSnapshot(workspaceId, (resolved, store) => this.rebuildSnapshot(resolved, store, mutationOptions, true), mutationOptions.signal)
        : await this.indexPath(workspaceId, event.relativePath, mutationOptions);
      if (!result.ok) throw new Error(result.error.message, { cause: result.error });
    }, options);
    let fileWatcher: FSWatcher;
    try {
      fileWatcher = watch(workspace.value.realRootPath, { recursive: true }, (_eventType, filename) => {
        if (filename === null || filename.length === 0) {
          queue.enqueue({ relativePath: '', kind: 'rescan' });
          return;
        }
        const relativePath = filename;
        if (this.store.isInternalPath?.(path.resolve(workspace.value.realRootPath, relativePath))) return;
        if (!classifyContextPath(relativePath, 'automatic').discoverable) return;
        queue.enqueue({ relativePath, kind: 'change' });
      });
    } catch {
      return err(appError('INTERNAL_ERROR', 'Workspace watcher could not be started'));
    }
    const watcher: IndexWatcher = { fileWatcher, queue, recoveredFailures: 0, baselineVerified: false, error: null };
    attempt.watcher = watcher;
    fileWatcher.on('error', () => {
      watcher.error = 'Workspace watcher failed; restart watching to recover';
      fileWatcher.close();
    });
    this.watchers.set(workspaceId, watcher);
    let completed = false;
    try {
      options.signal?.throwIfAborted();
      const indexed = await this.indexWorkspace(workspaceId, { rebuild: true, ...(options.signal === undefined ? {} : { signal: options.signal }) });
      if (!indexed.ok) return indexed;
      await waitForIndexOperation(queue.drain(), options.signal);
      const status = await this.status(workspaceId);
      options.signal?.throwIfAborted();
      completed = status.ok;
      bootstrapping = false;
      return status;
    } catch (error: unknown) {
      if (options.signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Workspace watcher start was cancelled', true));
      throw error;
    } finally {
      if (!completed) {
        fileWatcher.close();
        if (this.watchers.get(workspaceId) === watcher) this.watchers.delete(workspaceId);
        await queue.drain();
      }
    }
  }

  public stopWatch(workspaceId: string): Promise<Result<{ readonly stopped: boolean }>> {
    return this.serialize(this.watchLifecycles, workspaceId, () => this.stopWatchNow(workspaceId));
  }

  private async stopWatchNow(workspaceId: string): Promise<Result<{ readonly stopped: boolean }>> {
    const watcher = this.watchers.get(workspaceId);
    if (watcher === undefined) return ok({ stopped: false });
    watcher.fileWatcher.close();
    await watcher.queue.drain();
    if (this.watchers.get(workspaceId) === watcher) this.watchers.delete(workspaceId);
    return ok({ stopped: true });
  }

  public async forgetWorkspace(workspaceId: string): Promise<void> {
    await this.serialize(this.watchLifecycles, workspaceId, async () => {
      await this.stopWatchNow(workspaceId);
      await this.serialize(this.mutations, workspaceId, () => this.store.withMutation(workspaceId, (store) => store.delete()));
    });
  }

  public async close(): Promise<void> {
    this.watchingClosed = true;
    await Promise.all([...this.watchLifecycles.values()]);
    for (const workspaceId of [...this.watchers.keys()]) await this.stopWatch(workspaceId);
    await Promise.all([...this.mutations.values()]);
  }

  private async resolve(workspaceId: string): Promise<Result<Workspace>> {
    const workspace = await this.workspaces.get(workspaceId);
    return workspace === null ? err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found')) : ok(workspace);
  }

  private isAutomaticallyObservable(snapshot: WorkspaceIndexSnapshot): boolean {
    const root = resolveHostPath(snapshot.rootPath);
    return root !== null && snapshot.entries.every((entry) => classifyContextPath(entry.relativePath, 'automatic').discoverable && !this.store.isInternalPath?.(path.resolve(root, entry.relativePath)));
  }

  private async rebuildSnapshot(workspace: Workspace, store: WorkspaceIndexMutation, options: WorkspaceIndexOptions, skipUnchangedPublication = false): Promise<Result<WorkspaceIndexSnapshot>> {
    const entries: WorkspaceIndexEntry[] = [];
    const rootPath = resolveHostPath(workspace.realRootPath);
    if (rootPath === null) return err(appError('INVALID_INPUT', 'Workspace root uses a foreign host path syntax'));
    const watcher = this.watchers.get(workspace.id);
    const failureWatermark = watcher?.queue.status().failedEvents ?? 0;
    await this.scanDirectory(rootPath, rootPath, entries, options.discovery ?? 'automatic', options.signal);
    const snapshot = this.snapshotValue(workspace, entries);
    options.signal?.throwIfAborted();
    const previous = skipUnchangedPublication ? await store.load().catch(() => null) : null;
    const unchanged = previous !== null && isDeepStrictEqual(previous.entries.map(indexEntryContent), snapshot.entries.map(indexEntryContent));
    options.signal?.throwIfAborted();
    if (!unchanged) await store.save(snapshot);
    if (watcher !== undefined && this.watchers.get(workspace.id) === watcher) {
      watcher.recoveredFailures = Math.max(watcher.recoveredFailures, failureWatermark);
      watcher.baselineVerified = true;
    }
    return ok(unchanged ? previous : snapshot);
  }

  private async mutateSnapshot(
    workspaceId: string,
    mutation: (workspace: Workspace, store: WorkspaceIndexMutation) => Promise<Result<WorkspaceIndexSnapshot>>,
    signal?: AbortSignal,
  ): Promise<Result<WorkspaceIndexSnapshot>> {
    try {
      return await this.serialize(this.mutations, workspaceId, async () => {
        return await this.store.withMutation(workspaceId, async (store) => {
          signal?.throwIfAborted();
          const workspace = await this.resolve(workspaceId);
          return workspace.ok ? mutation(workspace.value, store) : workspace;
        }, signal);
      }, signal);
    } catch (error: unknown) {
      if (signal?.aborted) return err(appError('PROCESS_TIMEOUT', 'Workspace index update was cancelled', true));
      if (error instanceof WorkspaceIndexBusyError) return err(appError('CONFLICT', error.message, true));
      return err(appError('INTERNAL_ERROR', 'Workspace index update failed'));
    }
  }

  private async serialize<T>(operations: Map<string, Promise<void>>, workspaceId: string, mutation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = operations.get(workspaceId) ?? Promise.resolve();
    let started = false;
    const operation = previous.then(() => {
      signal?.throwIfAborted();
      started = true;
      return mutation();
    });
    const settled = operation.then(() => undefined, () => undefined);
    operations.set(workspaceId, settled);
    void settled.then(() => {
      if (operations.get(workspaceId) === settled) operations.delete(workspaceId);
    });
    return waitForIndexOperation(operation, signal, () => started);
  }

  private async scanDirectory(rootPath: string, directoryPath: string, entries: WorkspaceIndexEntry[], discovery: ContextDiscoveryMode, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (discovery === 'automatic' && this.store.isInternalPath?.(directoryPath)) return;
    const api = hostPathApi(process.platform);
    const directoryRelativePath = normalizeRelativePath(api.relative(rootPath, directoryPath));
    if (directoryRelativePath !== '' && !classifyContextPath(directoryRelativePath, discovery).discoverable) return;
    if (directoryRelativePath !== '') entries.push(await this.describePath(rootPath, directoryPath, await stat(directoryPath), signal));
    const children = await readdir(directoryPath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      signal?.throwIfAborted();
      const childPath = api.join(directoryPath, child.name);
      if (discovery === 'automatic' && this.store.isInternalPath?.(childPath)) continue;
      const childRelativePath = normalizeRelativePath(api.relative(rootPath, childPath));
      if (!classifyContextPath(childRelativePath, discovery).discoverable) continue;
      const beforeChild = entries.length;
      try {
        if (child.isDirectory()) await this.scanDirectory(rootPath, childPath, entries, discovery, signal);
        else if (child.isSymbolicLink()) entries.push(await this.describePath(rootPath, childPath, await statOrLstat(childPath, true), signal));
        else entries.push(await this.describePath(rootPath, childPath, await stat(childPath), signal));
      } catch (error: unknown) {
        if (!isNodeError(error, 'ENOENT')) throw error;
        entries.splice(beforeChild);
      }
    }
  }

  private async describePath(rootPath: string, absolutePath: string, metadata: Awaited<ReturnType<typeof stat>>, signal?: AbortSignal): Promise<WorkspaceIndexEntry> {
    const relativePath = normalizeRelativePath(hostPathApi(process.platform).relative(rootPath, absolutePath));
    const indexedAt = new Date().toISOString();
    if (metadata.isDirectory()) return { relativePath, kind: 'directory', size: 0, mtimeMs: Number(metadata.mtimeMs), contentHash: null, gitBlobSha: null, language: null, isTest: false, symbols: [], imports: [], exports: [], functions: [], classes: [], interfaces: [], indexedAt };
    if (metadata.isSymbolicLink()) return { relativePath, kind: 'symlink', size: Number(metadata.size), mtimeMs: Number(metadata.mtimeMs), contentHash: null, gitBlobSha: null, language: languageFor(relativePath), isTest: isTestPath(relativePath), symbols: [], imports: [], exports: [], functions: [], classes: [], interfaces: [], indexedAt };
    // Oversized files remain visible by metadata but never load their bytes into memory.
    if (metadata.size > MAX_INDEX_FILE_BYTES) return { relativePath, kind: 'file', size: Number(metadata.size), mtimeMs: Number(metadata.mtimeMs), contentHash: null, gitBlobSha: null, language: languageFor(relativePath), isTest: isTestPath(relativePath), symbols: [], imports: [], exports: [], functions: [], classes: [], interfaces: [], indexedAt };
    const content = await readFile(absolutePath, { ...(signal === undefined ? {} : { signal }) });
    const contentHash = createHash('sha256').update(content).digest('hex');
    const gitBlobSha = createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex');
    const text = content.includes(0) ? null : content.toString('utf8');
    const symbols = text === null ? [] : unique([...matchAll(text, /\b(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g)]);
    const functions = text === null ? [] : unique([...matchAll(text, /\bfunction\s+([A-Za-z_$][\w$]*)/g), ...matchAll(text, /\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g)]);
    const classes = text === null ? [] : unique([...matchAll(text, /\bclass\s+([A-Za-z_$][\w$]*)/g)]);
    const interfaces = text === null ? [] : unique([...matchAll(text, /\binterface\s+([A-Za-z_$][\w$]*)/g)]);
    const imports = text === null ? [] : unique([...matchAll(text, /\bimport[^'"\n]*from\s*['"]([^'"]+)['"]/g), ...matchAll(text, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]);
    const exports = text === null ? [] : unique([...matchAll(text, /\bexport\s+(?:default\s+)?(?:function|class|const|let|var|interface|type)?\s*([A-Za-z_$][\w$]*)?/g)].filter((value) => value.length > 0));
    const packageMetadata = path.basename(relativePath).toLowerCase() === 'package.json' && text !== null ? parsePackageMetadata(text) : undefined;
    return {
      relativePath,
      kind: 'file',
      size: Number(metadata.size),
      mtimeMs: Number(metadata.mtimeMs),
      contentHash,
      gitBlobSha,
      language: languageFor(relativePath),
      isTest: isTestPath(relativePath),
      ...(packageMetadata === undefined ? {} : { packageMetadata }),
      symbols,
      imports,
      exports,
      functions,
      classes,
      interfaces,
      indexedAt,
    };
  }

  private snapshotValue(workspace: Workspace, entries: readonly WorkspaceIndexEntry[]): WorkspaceIndexSnapshot {
    return { version: 1, discoveryPolicyRevision: WORKSPACE_INDEX_DISCOVERY_POLICY_REVISION, workspaceId: workspace.id, rootPath: workspace.realRootPath, indexedAt: new Date().toISOString(), entries: [...entries].sort((left, right) => left.relativePath.localeCompare(right.relativePath)) };
  }
}

function snapshotGeneration(snapshot: WorkspaceIndexSnapshot): string {
  const identity = [snapshot.discoveryPolicyRevision, snapshot.entries.map((entry) => [entry.relativePath, entry.kind, entry.mtimeMs, entry.size, entry.contentHash])];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function indexEntryContent(entry: WorkspaceIndexEntry): Omit<WorkspaceIndexEntry, 'indexedAt'> {
  const { indexedAt, ...content } = entry;
  void indexedAt;
  return content;
}

function indexFreshness(
  snapshot: WorkspaceIndexSnapshot | null,
  watcher: WorkspaceIndexQueueStatus | null,
  watchState?: IndexWatcher,
  automaticCoverage = true,
): { readonly state: WorkspaceIndexStatus['freshness']; readonly stale: boolean | null } {
  if (snapshot === null) return { state: 'missing', stale: null };
  if (watcher === null) return { state: 'unverified', stale: null };
  if (watchState?.error !== null && watchState?.error !== undefined) return { state: 'watching_degraded', stale: true };
  if (watcher.failedEvents > (watchState?.recoveredFailures ?? 0)) return { state: 'watching_degraded', stale: true };
  if (watchState?.baselineVerified !== true || !automaticCoverage) return { state: 'unverified', stale: null };
  if (watcher.pendingEvents > 0 || watcher.activeWorkers > 0) return { state: 'watching_pending', stale: true };
  return { state: 'watching_clean', stale: false };
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function languageFor(relativePath: string): string | null {
  const extension = path.extname(relativePath).toLowerCase();
  const languages: Readonly<Record<string, string>> = { '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx', '.mjs': 'javascript', '.cjs': 'javascript', '.py': 'python', '.json': 'json', '.md': 'markdown', '.yml': 'yaml', '.yaml': 'yaml' };
  return languages[extension] ?? null;
}

function isTestPath(relativePath: string): boolean {
  return /(^|[/\\])(__tests__|tests?)([/\\]|$)|\.(test|spec)\.[^.]+$/i.test(relativePath);
}

function matchAll(text: string, expression: RegExp): string[] {
  return [...text.matchAll(expression)].map((match) => match[1]).filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function parsePackageMetadata(text: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
      ...(typeof record.version === 'string' ? { version: record.version } : {}),
      ...(typeof record.scripts === 'object' && record.scripts !== null ? { scripts: record.scripts } : {}),
      ...(typeof record.dependencies === 'object' && record.dependencies !== null ? { dependencies: record.dependencies } : {}),
      ...(typeof record.devDependencies === 'object' && record.devDependencies !== null ? { devDependencies: record.devDependencies } : {}),
    };
  } catch {
    return undefined;
  }
}

async function statOrLstat(filePath: string, lstat: boolean): Promise<Awaited<ReturnType<typeof stat>>> {
  if (!lstat) return stat(filePath);
  const { lstat: readLinkStats } = await import('node:fs/promises');
  return readLinkStats(filePath);
}

function isSnapshot(value: unknown): value is WorkspaceIndexSnapshot {
  return isRecord(value) && value.version === 1
    && value.discoveryPolicyRevision === WORKSPACE_INDEX_DISCOVERY_POLICY_REVISION
    && typeof value.workspaceId === 'string' && value.workspaceId.length > 0
    && typeof value.rootPath === 'string' && value.rootPath.length > 0
    && isTimestamp(value.indexedAt)
    && Array.isArray(value.entries) && value.entries.every(isIndexEntry);
}

function isIndexEntry(value: unknown): value is WorkspaceIndexEntry {
  return isRecord(value) && typeof value.relativePath === 'string' && value.relativePath.length > 0
    && (value.kind === 'file' || value.kind === 'directory' || value.kind === 'symlink')
    && typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0
    && typeof value.mtimeMs === 'number' && Number.isFinite(value.mtimeMs)
    && (value.contentHash === null || typeof value.contentHash === 'string' && /^[a-f0-9]{64}$/.test(value.contentHash))
    && (value.gitBlobSha === null || typeof value.gitBlobSha === 'string' && /^[a-f0-9]{40}$/.test(value.gitBlobSha))
    && (value.language === null || typeof value.language === 'string')
    && typeof value.isTest === 'boolean'
    && (value.packageMetadata === undefined || isRecord(value.packageMetadata))
    && [value.symbols, value.imports, value.exports, value.functions, value.classes, value.interfaces].every(isStringArray)
    && isTimestamp(value.indexedAt);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}
