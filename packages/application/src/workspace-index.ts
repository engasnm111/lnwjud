import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { classifyContextPath, type ContextDiscoveryMode } from '@lnwjud/search';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { WorkspaceIndexQueue, type WorkspaceIndexQueueOptions, type WorkspaceIndexQueueStatus } from './workspace-index-queue.js';

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

export interface WorkspaceIndexSnapshot {
  readonly version: 1;
  readonly workspaceId: string;
  readonly rootPath: string;
  readonly indexedAt: string;
  readonly entries: readonly WorkspaceIndexEntry[];
}

export interface WorkspaceIndexStore {
  load(workspaceId: string): Promise<WorkspaceIndexSnapshot | null>;
  save(snapshot: WorkspaceIndexSnapshot): Promise<void>;
  delete?(workspaceId: string): Promise<void>;
}

export class JsonWorkspaceIndexStore implements WorkspaceIndexStore {
  public constructor(private readonly directory: string = path.join(os.tmpdir(), 'lnwjud', 'index')) {}

  public async load(workspaceId: string): Promise<WorkspaceIndexSnapshot | null> {
    try {
      const content = await readFile(this.filePath(workspaceId), 'utf8');
      const value: unknown = JSON.parse(content);
      return isSnapshot(value) ? value : null;
    } catch (error: unknown) {
      if (isNodeError(error, 'ENOENT')) return null;
      return null;
    }
  }

  public async save(snapshot: WorkspaceIndexSnapshot): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporaryPath = `${this.filePath(snapshot.workspaceId)}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(temporaryPath, this.filePath(snapshot.workspaceId));
  }

  public async delete(workspaceId: string): Promise<void> {
    await rm(this.filePath(workspaceId), { force: true });
  }

  private filePath(workspaceId: string): string {
    return path.join(this.directory, `${encodeURIComponent(workspaceId)}.json`);
  }
}

export type WorkspaceIndexWatchOptions = WorkspaceIndexQueueOptions;

export interface WorkspaceIndexOptions {
  readonly discovery?: ContextDiscoveryMode;
}

export interface WorkspaceIndexStatus {
  readonly indexed: boolean;
  readonly snapshot: WorkspaceIndexSnapshot | null;
  readonly watcher: WorkspaceIndexQueueStatus | null;
}

export class WorkspaceIndexService {
  private readonly watchers = new Map<string, { readonly fileWatcher: FSWatcher; readonly queue: WorkspaceIndexQueue }>();

  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly store: WorkspaceIndexStore = new JsonWorkspaceIndexStore(),
  ) {}

  public async indexWorkspace(workspaceId: string, options: WorkspaceIndexOptions = {}): Promise<Result<WorkspaceIndexSnapshot>> {
    const workspace = await this.resolve(workspaceId);
    if (!workspace.ok) return workspace;
    const entries: WorkspaceIndexEntry[] = [];
    await this.scanDirectory(workspace.value.realRootPath, workspace.value.realRootPath, entries, options.discovery ?? 'automatic');
    const snapshot = this.snapshotValue(workspace.value, entries);
    await this.store.save(snapshot);
    return ok(snapshot);
  }

  public async indexPath(workspaceId: string, relativePath: string, options: WorkspaceIndexOptions = {}): Promise<Result<WorkspaceIndexSnapshot>> {
    const workspace = await this.resolve(workspaceId);
    if (!workspace.ok) return workspace;
    const normalized = normalizeRelativePath(relativePath);
    if (normalized === '') return this.indexWorkspace(workspaceId, options);
    const absolutePath = path.resolve(workspace.value.realRootPath, normalized);
    if (!isWithin(workspace.value.realRootPath, absolutePath)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Index path is outside workspace'));
    const current = await this.store.load(workspaceId) ?? this.snapshotValue(workspace.value, []);
    const discovery = options.discovery ?? 'automatic';
    if (!classifyContextPath(normalized, discovery).discoverable) return ok(current);
    const remaining = current.entries.filter((entry) => entry.relativePath !== normalized && !entry.relativePath.startsWith(`${normalized}/`));
    try {
      const metadata = await stat(absolutePath);
      const additions: WorkspaceIndexEntry[] = [];
      if (metadata.isDirectory()) await this.scanDirectory(workspace.value.realRootPath, absolutePath, additions, discovery);
      else additions.push(await this.describePath(workspace.value.realRootPath, absolutePath, metadata));
      const snapshot = this.snapshotValue(workspace.value, [...remaining, ...additions]);
      await this.store.save(snapshot);
      return ok(snapshot);
    } catch (error: unknown) {
      if (!isNodeError(error, 'ENOENT')) return err(appError('INTERNAL_ERROR', 'Workspace index update failed'));
      const snapshot = this.snapshotValue(workspace.value, remaining);
      await this.store.save(snapshot);
      return ok(snapshot);
    }
  }

  public async removePath(workspaceId: string, relativePath: string): Promise<Result<WorkspaceIndexSnapshot>> {
    const workspace = await this.resolve(workspaceId);
    if (!workspace.ok) return workspace;
    const normalized = normalizeRelativePath(relativePath);
    const current = await this.store.load(workspaceId) ?? this.snapshotValue(workspace.value, []);
    const entries = current.entries.filter((entry) => entry.relativePath !== normalized && !entry.relativePath.startsWith(`${normalized}/`));
    const snapshot = this.snapshotValue(workspace.value, entries);
    await this.store.save(snapshot);
    return ok(snapshot);
  }

  public async snapshot(workspaceId: string): Promise<Result<WorkspaceIndexSnapshot | null>> {
    const workspace = await this.resolve(workspaceId);
    if (!workspace.ok) return workspace;
    return ok(await this.store.load(workspace.value.id));
  }

  public async status(workspaceId: string): Promise<Result<WorkspaceIndexStatus>> {
    const snapshot = await this.snapshot(workspaceId);
    if (!snapshot.ok) return snapshot;
    return ok({
      indexed: snapshot.value !== null,
      snapshot: snapshot.value,
      watcher: this.watchers.get(workspaceId)?.queue.status() ?? null,
    });
  }

  public async startWatch(workspaceId: string, options: WorkspaceIndexWatchOptions = {}): Promise<Result<WorkspaceIndexStatus>> {
    const workspace = await this.resolve(workspaceId);
    if (!workspace.ok) return workspace;
    await this.stopWatch(workspaceId);
    const queue = new WorkspaceIndexQueue(async (event) => {
      if (event.kind === 'delete') await this.removePath(workspaceId, event.relativePath);
      else await this.indexPath(workspaceId, event.relativePath);
    }, options);
    let fileWatcher: FSWatcher;
    try {
      fileWatcher = watch(workspace.value.realRootPath, { recursive: true }, (_eventType, filename) => {
        if (filename === null) return;
        const relativePath = filename;
        if (!classifyContextPath(relativePath, 'automatic').discoverable) return;
        queue.enqueue({ relativePath, kind: 'change' });
      });
    } catch {
      return err(appError('INTERNAL_ERROR', 'Workspace watcher could not be started'));
    }
    this.watchers.set(workspaceId, { fileWatcher, queue });
    return this.status(workspaceId);
  }

  public async stopWatch(workspaceId: string): Promise<Result<{ readonly stopped: boolean }>> {
    const watcher = this.watchers.get(workspaceId);
    if (watcher === undefined) return ok({ stopped: false });
    watcher.fileWatcher.close();
    await watcher.queue.drain();
    this.watchers.delete(workspaceId);
    return ok({ stopped: true });
  }

  public async forgetWorkspace(workspaceId: string): Promise<void> {
    await this.stopWatch(workspaceId);
    await this.store.delete?.(workspaceId);
  }

  public async close(): Promise<void> {
    for (const workspaceId of [...this.watchers.keys()]) await this.stopWatch(workspaceId);
  }

  private async resolve(workspaceId: string): Promise<Result<Workspace>> {
    const workspace = await this.workspaces.get(workspaceId);
    return workspace === null ? err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found')) : ok(workspace);
  }

  private async scanDirectory(rootPath: string, directoryPath: string, entries: WorkspaceIndexEntry[], discovery: ContextDiscoveryMode): Promise<void> {
    const directoryRelativePath = normalizeRelativePath(path.relative(rootPath, directoryPath));
    if (directoryRelativePath !== '' && !classifyContextPath(directoryRelativePath, discovery).discoverable) return;
    if (directoryRelativePath !== '') entries.push(await this.describePath(rootPath, directoryPath, await stat(directoryPath)));
    const children = await readdir(directoryPath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const childPath = path.join(directoryPath, child.name);
      const childRelativePath = normalizeRelativePath(path.relative(rootPath, childPath));
      if (!classifyContextPath(childRelativePath, discovery).discoverable) continue;
      if (child.isDirectory()) await this.scanDirectory(rootPath, childPath, entries, discovery);
      else if (child.isSymbolicLink()) entries.push(await this.describePath(rootPath, childPath, await statOrLstat(childPath, true)));
      else entries.push(await this.describePath(rootPath, childPath, await stat(childPath)));
    }
  }

  private async describePath(rootPath: string, absolutePath: string, metadata: Awaited<ReturnType<typeof stat>>): Promise<WorkspaceIndexEntry> {
    const relativePath = normalizeRelativePath(path.relative(rootPath, absolutePath));
    const indexedAt = new Date().toISOString();
    if (metadata.isDirectory()) return { relativePath, kind: 'directory', size: 0, mtimeMs: Number(metadata.mtimeMs), contentHash: null, gitBlobSha: null, language: null, isTest: false, symbols: [], imports: [], exports: [], functions: [], classes: [], interfaces: [], indexedAt };
    if (metadata.isSymbolicLink()) return { relativePath, kind: 'symlink', size: Number(metadata.size), mtimeMs: Number(metadata.mtimeMs), contentHash: null, gitBlobSha: null, language: languageFor(relativePath), isTest: isTestPath(relativePath), symbols: [], imports: [], exports: [], functions: [], classes: [], interfaces: [], indexedAt };
    const content = await readFile(absolutePath);
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
    return { version: 1, workspaceId: workspace.id, rootPath: workspace.realRootPath, indexedAt: new Date().toISOString(), entries: [...entries].sort((left, right) => left.relativePath.localeCompare(right.relativePath)) };
  }
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  const [firstSegment] = relative.split(path.sep);
  return firstSegment !== '..';
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
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && typeof record.workspaceId === 'string' && typeof record.rootPath === 'string' && Array.isArray(record.entries);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}
