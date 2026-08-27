import { randomUUID } from 'node:crypto';
import { err, ok, type AppError, type Result } from '@lnwjud/domain';
import type { FileActor, GitService, SearchService } from '@lnwjud/application';
import { classifyContextPath } from '@lnwjud/search';
import type { McpApplicationServices } from './tools/tool-types.js';
import { ContextEconomyRuntime, type ContextEconomyStats, type ContextDeliveryKind } from './context-economy.js';

export type ContextIntent = 'auto' | 'debug' | 'implement' | 'review' | 'trace' | 'explore';
export type ContextMode = 'optimized' | 'full' | 'exhaustive';

export interface WorkspaceContextRequest {
  readonly query: string;
  readonly workspaceId?: string;
  readonly path?: string;
  readonly intent?: ContextIntent;
  readonly mode?: ContextMode;
  readonly includeIgnored?: boolean;
  readonly responseTargetBytes?: number;
  readonly pageSize?: number;
}

export interface ContextSnippet {
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export interface ContextMatch {
  readonly workspaceId: string;
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface ContextFile {
  readonly workspaceId: string;
  readonly path: string;
  readonly reason: string;
  readonly snippets: readonly ContextSnippet[];
  readonly symbols: readonly string[];
  readonly gitRelevance: 'changed' | 'related' | 'none';
  readonly testRelevance: 'test' | 'source' | 'unknown';
  readonly byteLength?: number;
  readonly error?: { readonly code: string; readonly message: string };
  readonly delivery?: ContextDeliveryKind;
  readonly fingerprint?: string;
  readonly summary?: {
    readonly byteLength: number;
    readonly lineCount: number;
    readonly imports: readonly string[];
    readonly exports: readonly string[];
    readonly symbols: readonly string[];
  };
  readonly diff?: string;
  readonly referencePath?: string;
  readonly unchangedSince?: string;
}

export interface WorkspaceContextResult {
  readonly files: readonly ContextFile[];
  readonly symbols: readonly string[];
  readonly matches: readonly ContextMatch[];
  readonly scannedFiles: number;
  readonly matchedFiles: number;
  readonly totalMatches: number;
  readonly hasMore: boolean;
  readonly continuationToken?: string;
  readonly economy?: ContextEconomyStats;
}

export interface ContextContinueRequest {
  readonly continuationToken: string;
  readonly pageSize?: number;
}

export interface SearchAllRequest {
  readonly query: string;
  readonly workspaceId?: string;
  readonly path?: string;
  readonly glob?: string;
  readonly maxResults?: number;
  readonly includeIgnored?: boolean;
}

export interface SearchAllResult {
  readonly matches: readonly ContextMatch[];
  readonly paths: readonly { readonly workspaceId: string; readonly path: string }[];
  readonly scannedWorkspaces: number;
  readonly totalMatches: number;
  readonly hasMore: boolean;
}

export interface WorkspaceFullScanRequest {
  readonly workspaceId?: string;
  readonly path?: string;
  readonly glob?: string;
  readonly pageSize?: number;
  readonly includeIgnored?: boolean;
}

export interface WorkspaceFullScanResult {
  readonly files: readonly { readonly workspaceId: string; readonly path: string }[];
  readonly scannedWorkspaces: number;
  readonly scannedFiles: number;
  readonly hasMore: boolean;
  readonly continuationToken?: string;
}

export interface ReadManyFilesRequest {
  readonly workspaceId?: string;
  readonly files: readonly { readonly path: string; readonly startLine?: number; readonly endLine?: number }[];
}

export interface ReadManyFileResult {
  readonly workspaceId: string;
  readonly path: string;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface ReadManyFilesResult {
  readonly files: readonly ReadManyFileResult[];
  readonly totalFiles: number;
  readonly failedFiles: number;
}

export interface WorkspaceSnapshotResult {
  readonly workspace?: unknown;
  readonly project?: unknown;
}

interface Candidate {
  readonly workspaceId: string;
  readonly path: string;
  readonly matches: readonly ContextMatch[];
  readonly score: number;
  readonly reason: string;
  readonly gitRelevance: ContextFile['gitRelevance'];
  readonly testRelevance: ContextFile['testRelevance'];
}

interface WorkspaceCollection {
  readonly candidates: readonly Candidate[];
  readonly scannedFiles: number;
  readonly totalMatches: number;
  readonly searchTruncated: boolean;
}

interface Continuation {
  readonly candidates: readonly Candidate[];
  readonly request: WorkspaceContextRequest;
  readonly scannedFiles: number;
  readonly totalMatches: number;
  readonly searchTruncated: boolean;
}

interface ScanContinuation {
  readonly files: readonly { readonly workspaceId: string; readonly path: string }[];
  readonly scannedWorkspaces: number;
  readonly scannedFiles: number;
}

const DEFAULT_RESPONSE_TARGET_BYTES = 256 * 1024;
const MAX_RESPONSE_TARGET_BYTES = 8 * 1024 * 1024;
const DEFAULT_PAGE_SIZE: Record<ContextMode, number> = { optimized: 12, full: 50, exhaustive: 200 };
const SEARCH_LIMIT: Record<ContextMode, number> = { optimized: 100, full: 300, exhaustive: 500 };

export class ContextEngine {
  private readonly continuations = new Map<string, Continuation>();
  private readonly scanContinuations = new Map<string, ScanContinuation>();

  public constructor(
    private readonly services: McpApplicationServices,
    private readonly actor: FileActor,
    private readonly economy: ContextEconomyRuntime = new ContextEconomyRuntime(),
  ) {}

  public async collect(request: WorkspaceContextRequest): Promise<Result<WorkspaceContextResult>> {
    this.economy.beginRequest();
    const validation = validateRequest(request);
    if (!validation.ok) return validation;
    const workspaceIds = await this.resolveWorkspaceIds(request.workspaceId);
    if (!workspaceIds.ok) return workspaceIds;
    if (workspaceIds.value.length === 0) return err({ code: 'WORKSPACE_NOT_FOUND', message: 'No registered workspace is available', recoverable: false });

    const settled = await Promise.allSettled(workspaceIds.value.map((workspaceId) => this.collectWorkspace(workspaceId, request)));
    const successful: WorkspaceCollection[] = [];
    let firstError: AppError | undefined;
    for (const entry of settled) {
      if (entry.status === 'fulfilled' && entry.value.ok) successful.push(entry.value.value);
      else if (entry.status === 'fulfilled' && !entry.value.ok && firstError === undefined) firstError = entry.value.error;
    }
    if (successful.length === 0) {
      return err(firstError ?? { code: 'INTERNAL_ERROR', message: 'Context search failed', recoverable: true });
    }

    const merged = mergeCollections(successful);
    return this.materialize(merged.candidates, request, {
      scannedFiles: merged.scannedFiles,
      totalMatches: merged.totalMatches,
      searchTruncated: merged.searchTruncated,
    });
  }

  public async continue(token: string, pageSize?: number): Promise<Result<WorkspaceContextResult>> {
    const continuation = this.continuations.get(token);
    if (continuation === undefined) return err({ code: 'INVALID_INPUT', message: 'Continuation token is invalid or expired', recoverable: false });
    this.continuations.delete(token);
    return this.materialize(continuation.candidates, {
      ...continuation.request,
      ...(pageSize === undefined ? {} : { pageSize }),
    }, continuation);
  }

  public async searchAll(request: SearchAllRequest): Promise<Result<SearchAllResult>> {
    this.economy.beginRequest();
    if (request.query.trim().length === 0) return err({ code: 'INVALID_INPUT', message: 'Search query is required', recoverable: false });
    const workspaceIds = await this.resolveWorkspaceIds(request.workspaceId);
    if (!workspaceIds.ok) return workspaceIds;
    if (this.services.search === undefined) return err({ code: 'INTERNAL_ERROR', message: 'Search service is unavailable', recoverable: true });
    const maxResults = Math.max(1, Math.min(500, Math.floor(request.maxResults ?? 500)));
    const settled = await Promise.allSettled(workspaceIds.value.map(async (workspaceId) => {
      const [text, files] = await Promise.all([
        this.safeSearchText(workspaceId, { query: request.query, ...(request.includeIgnored === undefined ? {} : { includeIgnored: request.includeIgnored }), ...(request.path === undefined ? {} : { path: request.path }) }, maxResults),
        this.safeSearchFiles(workspaceId, { query: request.query, ...(request.includeIgnored === undefined ? {} : { includeIgnored: request.includeIgnored }), ...(request.path === undefined ? {} : { path: request.path }) }, maxResults, request.glob),
      ]);
      return { workspaceId, text, files };
    }));
    const matches: ContextMatch[] = [];
    const paths: Array<{ readonly workspaceId: string; readonly path: string }> = [];
    let hasMore = false;
    let successfulWorkspaces = 0;
    for (const entry of settled) {
      if (entry.status !== 'fulfilled') continue;
      successfulWorkspaces += 1;
      if (entry.value.text.ok) {
        matches.push(...entry.value.text.value.matches
          .filter((match) => {
            const allowed = request.includeIgnored === true || classifyContextPath(match.path, 'automatic').discoverable;
            if (!allowed) this.economy.recordSkipped(match.path);
            return allowed;
          })
          .map((match) => ({ workspaceId: entry.value.workspaceId, path: match.path, line: match.line, text: match.text })));
        hasMore ||= entry.value.text.value.truncated;
      }
      if (entry.value.files.ok) {
        paths.push(...entry.value.files.value.paths
          .filter((path) => {
            const allowed = request.includeIgnored === true || classifyContextPath(path, 'automatic').discoverable;
            if (!allowed) this.economy.recordSkipped(path);
            return allowed;
          })
          .map((path) => ({ workspaceId: entry.value.workspaceId, path })));
        hasMore ||= entry.value.files.value.truncated;
      }
    }
    return ok({
      matches,
      paths: dedupePaths(paths),
      scannedWorkspaces: successfulWorkspaces,
      totalMatches: matches.length,
      hasMore,
    });
  }

  public async fullScan(request: WorkspaceFullScanRequest): Promise<Result<WorkspaceFullScanResult>> {
    this.economy.beginRequest();
    const workspaceIds = await this.resolveWorkspaceIds(request.workspaceId);
    if (!workspaceIds.ok) return workspaceIds;
    if (request.includeIgnored === false && request.workspaceId !== undefined && this.services.workspaceIndex !== undefined) {
      const indexed = await this.fullScanFromIndex(request.workspaceId, request.path, request.pageSize);
      if (indexed !== null) return indexed;
    }
    if (this.services.search === undefined) return err({ code: 'INTERNAL_ERROR', message: 'Search service is unavailable', recoverable: true });
    const maxResults = 500;
    const settled = await Promise.allSettled(workspaceIds.value.map(async (workspaceId) => ({
      workspaceId,
      result: await this.safeSearchFiles(workspaceId, { query: '*', includeIgnored: request.includeIgnored !== false, ...(request.path === undefined ? {} : { path: request.path }) }, maxResults, request.glob),
    })));
    const files: Array<{ readonly workspaceId: string; readonly path: string }> = [];
    let hasMore = false;
    let scannedWorkspaces = 0;
    for (const entry of settled) {
      if (entry.status !== 'fulfilled') continue;
      scannedWorkspaces += 1;
      if (!entry.value.result.ok) continue;
      files.push(...entry.value.result.value.paths.map((path) => ({ workspaceId: entry.value.workspaceId, path })));
      hasMore ||= entry.value.result.value.truncated;
    }
    const deduped = dedupePaths(files);
    const pageSize = normalizePageSize(request.pageSize ?? 200);
    const page = deduped.slice(0, pageSize);
    const remaining = deduped.slice(page.length);
    hasMore ||= remaining.length > 0;
    let continuationToken: string | undefined;
    if (hasMore) {
      continuationToken = randomUUID();
      this.scanContinuations.set(continuationToken, { files: remaining, scannedWorkspaces, scannedFiles: deduped.length });
    }
    return ok({
      files: page,
      scannedWorkspaces,
      scannedFiles: deduped.length,
      hasMore,
      ...(continuationToken === undefined ? {} : { continuationToken }),
    });
  }

  public async continueFullScan(token: string, pageSize?: number): Promise<Result<WorkspaceFullScanResult>> {
    const continuation = this.scanContinuations.get(token);
    if (continuation === undefined) return err({ code: 'INVALID_INPUT', message: 'Scan continuation token is invalid or expired', recoverable: false });
    this.scanContinuations.delete(token);
    const size = normalizePageSize(pageSize ?? 200);
    const files = continuation.files.slice(0, size);
    const remaining = continuation.files.slice(files.length);
    let nextToken: string | undefined;
    if (remaining.length > 0) {
      nextToken = randomUUID();
      this.scanContinuations.set(nextToken, { ...continuation, files: remaining });
    }
    return ok({
      files,
      scannedWorkspaces: continuation.scannedWorkspaces,
      scannedFiles: continuation.scannedFiles,
      hasMore: remaining.length > 0,
      ...(nextToken === undefined ? {} : { continuationToken: nextToken }),
    });
  }

  public async readMany(request: ReadManyFilesRequest): Promise<Result<ReadManyFilesResult>> {
    if (this.services.file === undefined) return err({ code: 'INTERNAL_ERROR', message: 'File service is unavailable', recoverable: true });
    const workspaceIds = await this.resolveWorkspaceIds(request.workspaceId);
    if (!workspaceIds.ok) return workspaceIds;
    const workspaceId = request.workspaceId ?? workspaceIds.value[0];
    if (workspaceId === undefined) return err({ code: 'WORKSPACE_NOT_FOUND', message: 'No workspace is available', recoverable: false });
    const settled = await Promise.allSettled(request.files.map(async (file) => {
      try {
        const result = await this.services.file!.readFile(this.actor, workspaceId, file);
        return result.ok
          ? { workspaceId, path: file.path, result: result.value }
          : { workspaceId, path: file.path, error: { code: result.error.code, message: result.error.message } };
      } catch {
        return { workspaceId, path: file.path, error: { code: 'INTERNAL_ERROR', message: 'File read failed' } };
      }
    }));
    const files = settled.map((entry, index) => entry.status === 'fulfilled'
      ? entry.value
      : { workspaceId, path: request.files[index]?.path ?? '', error: { code: 'INTERNAL_ERROR', message: 'File read failed' } });
    return ok({ files, totalFiles: files.length, failedFiles: files.filter((file) => file.error !== undefined).length });
  }

  public async snapshot(workspaceId: string): Promise<Result<WorkspaceSnapshotResult>> {
    const workspace = this.services.workspaceInfo === undefined
      ? undefined
      : await this.services.workspaceInfo.info(this.actor, workspaceId);
    if (workspace !== undefined && !workspace.ok) return err(workspace.error);
    const project = this.services.projectSnapshot === undefined
      ? undefined
      : await this.services.projectSnapshot.snapshot(this.actor, workspaceId);
    if (project !== undefined && !project.ok) return err(project.error);
    if (workspace === undefined && project === undefined) return err({ code: 'INTERNAL_ERROR', message: 'Workspace snapshot service is unavailable', recoverable: true });
    return ok({
      ...(workspace?.ok === true ? { workspace: workspace.value } : {}),
      ...(project?.ok === true ? { project: project.value } : {}),
    });
  }

  private async fullScanFromIndex(workspaceId: string, requestedPath: string | undefined, pageSize: number | undefined): Promise<Result<WorkspaceFullScanResult> | null> {
    const status = await this.services.workspaceIndex!.status(workspaceId);
    if (!status.ok || status.value.snapshot === null) return null;
    const prefix = requestedPath === undefined ? '' : normalizePath(requestedPath).replace(/^\.\//, '').replace(/\/$/, '');
    const allFiles = status.value.snapshot.entries
      .filter((entry) => entry.kind === 'file' || entry.kind === 'symlink')
      .map((entry) => entry.relativePath)
      .filter((entry) => prefix.length === 0 || entry === prefix || entry.startsWith(`${prefix}/`))
      .sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)))
      .map((path) => ({ workspaceId, path }));
    const size = normalizePageSize(pageSize ?? 200);
    const files = allFiles.slice(0, size);
    const remaining = allFiles.slice(files.length);
    let continuationToken: string | undefined;
    if (remaining.length > 0) {
      continuationToken = randomUUID();
      this.scanContinuations.set(continuationToken, { files: remaining, scannedWorkspaces: 1, scannedFiles: allFiles.length });
    }
    return ok({ files, scannedWorkspaces: 1, scannedFiles: allFiles.length, hasMore: remaining.length > 0, ...(continuationToken === undefined ? {} : { continuationToken }) });
  }

  private async resolveWorkspaceIds(workspaceId: string | undefined): Promise<Result<readonly string[]>> {
    if (workspaceId !== undefined && workspaceId.trim().length > 0) return ok([workspaceId]);
    const list = this.services.workspaceInfo?.list;
    if (list === undefined) return err({ code: 'INVALID_INPUT', message: 'workspaceId is required when workspace listing is unavailable', recoverable: false });
    const result = await list(this.actor);
    if (!result.ok) return err(result.error);
    if (!Array.isArray(result.value)) return err({ code: 'INTERNAL_ERROR', message: 'Workspace list has an invalid shape', recoverable: true });
    const ids = result.value.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null || !('id' in entry)) return [];
      const id = (entry as { id?: unknown }).id;
      return typeof id === 'string' && id.trim().length > 0 ? [id] : [];
    });
    return ok(ids);
  }

  private async collectWorkspace(workspaceId: string, request: WorkspaceContextRequest): Promise<Result<WorkspaceCollection>> {
    if (this.services.search === undefined) return err({ code: 'INTERNAL_ERROR', message: 'Search service is unavailable', recoverable: true });
    const limit = SEARCH_LIMIT[request.mode ?? 'optimized'];
    const searchTextPromise = this.safeSearchText(workspaceId, request, limit);
    const searchFilesPromise = this.safeSearchFiles(workspaceId, request, limit);
    const gitPromise = this.safeGitStatus(workspaceId);
    const [textResult, filesResult, gitResult] = await Promise.all([searchTextPromise, searchFilesPromise, gitPromise]);
    if (!textResult.ok && !filesResult.ok) return err(textResult.error);

    const changed = new Set<string>();
    if (gitResult.ok) {
      for (const entry of gitResult.value.entries) {
        if (typeof entry.path === 'string') changed.add(normalizePath(entry.path));
      }
    }
    const candidates = new Map<string, {
      path: string;
      matches: ContextMatch[];
      score: number;
      fromFilename: boolean;
    }>();
    const query = request.query.toLowerCase();
    if (textResult.ok) {
      for (const match of textResult.value.matches) {
        const key = normalizePath(match.path);
        const current = candidates.get(key) ?? { path: match.path, matches: [], score: 0, fromFilename: false };
        current.matches.push({ workspaceId, path: match.path, line: match.line, text: match.text });
        current.score += 12 + (match.text.toLowerCase().includes(query) ? 8 : 0);
        candidates.set(key, current);
      }
    }
    if (filesResult.ok) {
      for (const pathValue of filesResult.value.paths) {
        const key = normalizePath(pathValue);
        const current = candidates.get(key) ?? { path: pathValue, matches: [], score: 0, fromFilename: false };
        current.fromFilename = true;
        if (pathValue.toLowerCase().includes(query)) current.score += 25;
        candidates.set(key, current);
      }
    }

    for (const changedPath of changed) {
      const current = candidates.get(changedPath) ?? { path: changedPath, matches: [], score: 0, fromFilename: false };
      current.score += 30;
      candidates.set(changedPath, current);
    }

    const ranked = [...candidates.values()]
      .filter((candidate) => {
        const allowed = request.includeIgnored === true || changed.has(normalizePath(candidate.path)) || classifyContextPath(candidate.path, 'automatic').discoverable;
        if (!allowed) this.economy.recordSkipped(candidate.path);
        return allowed;
      })
      .map((candidate): Candidate => {
      const normalized = normalizePath(candidate.path);
      const gitRelevance: ContextFile['gitRelevance'] = changed.has(normalized)
        ? 'changed'
        : candidate.matches.length > 0 ? 'related' : 'none';
      const testRelevance = isTestPath(candidate.path) ? 'test' : isSourcePath(candidate.path) ? 'source' : 'unknown';
      const score = candidate.score
        + (gitRelevance === 'changed' ? 20 : gitRelevance === 'related' ? 4 : 0)
        + (request.intent === 'review' && testRelevance === 'test' ? 8 : 0)
        + (request.intent === 'implement' && testRelevance === 'source' ? 5 : 0);
      const reasons = [
        ...(candidate.matches.length > 0 ? ['text match'] : []),
        ...(candidate.fromFilename ? ['filename match or workspace inventory'] : []),
        ...(gitRelevance === 'changed' ? ['changed in Git'] : gitRelevance === 'related' ? ['Git-related path'] : []),
        ...(testRelevance === 'test' ? ['test relevance'] : []),
      ];
      return {
        workspaceId,
        path: candidate.path,
        matches: candidate.matches,
        score,
        reason: reasons.join('; ') || 'workspace inventory candidate',
        gitRelevance,
        testRelevance,
      };
      });
    ranked.sort((left, right) => right.score - left.score || normalizePath(left.path).localeCompare(normalizePath(right.path)));
    return ok({
      candidates: ranked,
      scannedFiles: filesResult.ok ? filesResult.value.paths.length : ranked.length,
      totalMatches: textResult.ok ? textResult.value.matches.length : 0,
      searchTruncated: (textResult.ok && textResult.value.truncated) || (filesResult.ok && filesResult.value.truncated),
    });
  }

  private async safeSearchText(workspaceId: string, request: WorkspaceContextRequest, maxResults: number): Promise<Awaited<ReturnType<SearchService['searchText']>>> {
    try {
      return await this.services.search!.searchText(this.actor, workspaceId, {
        query: request.query,
        maxResults,
        discovery: request.includeIgnored === true ? 'explicit' : 'automatic',
        ...(request.path === undefined ? {} : { path: request.path }),
      });
    } catch {
      return err({ code: 'INTERNAL_ERROR', message: 'Context text search failed', recoverable: true });
    }
  }

  private async safeSearchFiles(workspaceId: string, request: WorkspaceContextRequest, maxResults: number, glob?: string): Promise<Awaited<ReturnType<SearchService['searchFiles']>>> {
    try {
      return await this.services.search!.searchFiles(this.actor, workspaceId, {
        maxResults,
        discovery: request.includeIgnored === true ? 'explicit' : 'automatic',
        ...(glob === undefined ? {} : { glob }),
        ...(request.path === undefined ? {} : { path: request.path }),
      });
    } catch {
      return err({ code: 'INTERNAL_ERROR', message: 'Context filename search failed', recoverable: true });
    }
  }

  private async safeGitStatus(workspaceId: string): Promise<Awaited<ReturnType<GitService['status']>>> {
    if (this.services.git === undefined) return ok({ entries: [] as never[] });
    try {
      return await this.services.git.status(this.actor, workspaceId);
    } catch {
      return err({ code: 'INTERNAL_ERROR', message: 'Context Git lookup failed', recoverable: true });
    }
  }

  private async materialize(
    candidates: readonly Candidate[],
    request: WorkspaceContextRequest,
    metadata: Pick<Continuation, 'scannedFiles' | 'totalMatches' | 'searchTruncated'>,
  ): Promise<Result<WorkspaceContextResult>> {
    if (this.services.file === undefined) return err({ code: 'INTERNAL_ERROR', message: 'File service is unavailable', recoverable: true });
    const mode = request.mode ?? 'optimized';
    const pageSize = normalizePageSize(request.pageSize ?? DEFAULT_PAGE_SIZE[mode]);
    const targetBytes = normalizeResponseTarget(request.responseTargetBytes);
    const selectedCandidates = candidates.slice(0, pageSize);
    const contextId = randomUUID();
    const selected = await Promise.all(selectedCandidates.map((candidate) => this.readCandidate(candidate, request, contextId)));
    let consumed = selected.length;
    let estimatedBytes = selected.reduce((total, file) => total + Buffer.byteLength(JSON.stringify(file), 'utf8'), 0);
    while (selected.length > 1 && estimatedBytes > targetBytes) {
      const removed = selected.pop();
      if (removed !== undefined) estimatedBytes -= Buffer.byteLength(JSON.stringify(removed), 'utf8');
      consumed -= 1;
    }
    const remaining = candidates.slice(consumed);
    const hasMore = remaining.length > 0 || metadata.searchTruncated;
    let continuationToken: string | undefined;
    if (hasMore) {
      continuationToken = randomUUID();
      this.continuations.set(continuationToken, {
        candidates: remaining,
        request,
        scannedFiles: metadata.scannedFiles,
        totalMatches: metadata.totalMatches,
        searchTruncated: false,
      });
    }
    const symbols = [...new Set(selected.flatMap((file) => file.symbols))];
    const matches = selectedCandidates.slice(0, consumed).flatMap((candidate) => candidate.matches);
    return ok({
      files: selected,
      symbols,
      matches,
      scannedFiles: metadata.scannedFiles,
      matchedFiles: candidates.length,
      totalMatches: metadata.totalMatches,
      hasMore,
      ...(continuationToken === undefined ? {} : { continuationToken }),
      economy: this.economy.snapshot(),
    });
  }

  private async readCandidate(candidate: Candidate, request: WorkspaceContextRequest, contextId: string): Promise<ContextFile> {
    try {
      const result = await this.services.file!.readFile(this.actor, candidate.workspaceId, { path: candidate.path });
      if (!result.ok) {
        return {
          workspaceId: candidate.workspaceId,
          path: candidate.path,
          reason: candidate.reason,
          snippets: [],
          symbols: [],
          gitRelevance: candidate.gitRelevance,
          testRelevance: candidate.testRelevance,
          error: { code: result.error.code, message: result.error.message },
        };
      }
      const prepared = this.economy.prepare({
        workspaceId: candidate.workspaceId,
        path: candidate.path,
        content: result.value.content,
        contextId,
        discovery: request.includeIgnored === true || candidate.gitRelevance === 'changed' ? 'explicit' : 'automatic',
      });
      const snippets = prepared.delivery === 'unchanged' || prepared.delivery === 'reference' || prepared.delivery === 'metadata'
        ? []
        : createSnippets(result.value.content, candidate.matches, request.mode ?? 'optimized');
      const file: ContextFile = {
        workspaceId: candidate.workspaceId,
        path: candidate.path,
        reason: candidate.reason,
        snippets,
        symbols: prepared.delivery === 'unchanged' || prepared.delivery === 'reference' || prepared.delivery === 'metadata'
          ? []
          : prepared.summary.symbols.length > 0 ? prepared.summary.symbols : extractSymbols(result.value.content),
        gitRelevance: candidate.gitRelevance,
        testRelevance: candidate.testRelevance,
        ...(result.value.byteLength === undefined ? {} : { byteLength: result.value.byteLength }),
        delivery: prepared.delivery,
        fingerprint: prepared.fingerprint,
        summary: prepared.summary,
        ...(prepared.diff === undefined ? {} : { diff: prepared.diff }),
        ...(prepared.referencePath === undefined ? {} : { referencePath: prepared.referencePath }),
        ...(prepared.unchangedSince === undefined ? {} : { unchangedSince: prepared.unchangedSince }),
      };
      this.economy.recordDelivery(prepared, Buffer.byteLength(JSON.stringify(file), 'utf8'));
      return file;
    } catch {
      return {
        workspaceId: candidate.workspaceId,
        path: candidate.path,
        reason: candidate.reason,
        snippets: [],
        symbols: [],
        gitRelevance: candidate.gitRelevance,
        testRelevance: candidate.testRelevance,
        error: { code: 'INTERNAL_ERROR', message: 'File read failed' },
      };
    }
  }
}

function mergeCollections(collections: readonly WorkspaceCollection[]): WorkspaceCollection {
  const byKey = new Map<string, Candidate>();
  let scannedFiles = 0;
  let totalMatches = 0;
  let searchTruncated = false;
  for (const collection of collections) {
    scannedFiles += collection.scannedFiles;
    totalMatches += collection.totalMatches;
    searchTruncated ||= collection.searchTruncated;
    for (const candidate of collection.candidates) {
      const key = `${candidate.workspaceId}\0${normalizePath(candidate.path)}`;
      const existing = byKey.get(key);
      if (existing === undefined) byKey.set(key, candidate);
      else byKey.set(key, {
        ...existing,
        matches: [...existing.matches, ...candidate.matches],
        score: existing.score + candidate.score,
        reason: `${existing.reason}; ${candidate.reason}`,
      });
    }
  }
  const candidates = [...byKey.values()];
  candidates.sort((left, right) => right.score - left.score || `${left.workspaceId}:${normalizePath(left.path)}`.localeCompare(`${right.workspaceId}:${normalizePath(right.path)}`));
  return { candidates, scannedFiles, totalMatches, searchTruncated };
}

function validateRequest(request: WorkspaceContextRequest): Result<void> {
  if (typeof request.query !== 'string' || request.query.trim().length === 0) return err({ code: 'INVALID_INPUT', message: 'Context query is required', recoverable: false });
  if (request.pageSize !== undefined && (!Number.isInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > 500)) {
    return err({ code: 'INVALID_INPUT', message: 'Context pageSize is invalid', recoverable: false });
  }
  if (request.responseTargetBytes !== undefined && (!Number.isInteger(request.responseTargetBytes) || request.responseTargetBytes < 1024 || request.responseTargetBytes > MAX_RESPONSE_TARGET_BYTES)) {
    return err({ code: 'INVALID_INPUT', message: 'Context responseTargetBytes is invalid', recoverable: false });
  }
  return ok(undefined);
}

function normalizePageSize(value: number): number {
  return Math.max(1, Math.min(500, Math.floor(value)));
}

function normalizeResponseTarget(value: number | undefined): number {
  return Math.max(1024, Math.min(MAX_RESPONSE_TARGET_BYTES, Math.floor(value ?? DEFAULT_RESPONSE_TARGET_BYTES)));
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function dedupePaths(paths: readonly { readonly workspaceId: string; readonly path: string }[]): readonly { readonly workspaceId: string; readonly path: string }[] {
  const seen = new Set<string>();
  const result: Array<{ readonly workspaceId: string; readonly path: string }> = [];
  for (const entry of paths) {
    const key = `${entry.workspaceId}\0${normalizePath(entry.path)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function isTestPath(value: string): boolean {
  return /(^|[\\/])(test|tests)([\\/]|$)|\.(test|spec)\.[^.]+$/i.test(value);
}

function isSourcePath(value: string): boolean {
  return /\.(c|m)?(t|j)sx?$|\.py$|\.go$|\.rs$|\.java$|\.cs$/i.test(value);
}

function extractSymbols(content: string): readonly string[] {
  const symbols = new Set<string>();
  const pattern = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of content.matchAll(pattern)) {
    const symbol = match[1];
    if (symbol !== undefined) symbols.add(symbol);
  }
  return [...symbols];
}

function createSnippets(content: string, matches: readonly ContextMatch[], mode: ContextMode): readonly ContextSnippet[] {
  const lines = content.split(/\r?\n/);
  const radius = mode === 'exhaustive' ? 4 : mode === 'full' ? 2 : 1;
  const ranges = matches.length === 0
    ? [{ start: 1, end: Math.min(lines.length, mode === 'exhaustive' ? 40 : 12) }]
    : matches.map((match) => ({ start: Math.max(1, match.line - radius), end: Math.min(lines.length, match.line + radius) }));
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges.sort((left, right) => left.start - right.start)) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged.map((range) => ({
    startLine: range.start,
    endLine: range.end,
    text: lines.slice(range.start - 1, range.end).join('\n'),
  }));
}
