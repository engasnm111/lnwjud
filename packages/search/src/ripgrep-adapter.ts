import { spawn } from 'node:child_process';
import { DEFAULT_SEARCH_RESULTS, err, MAX_PROCESS_LOG_BYTES, MAX_SEARCH_RESULTS, ok, type Result } from '@lnwjud/domain';
import { PathExecutableResolver, type ExecutableResolver } from './executable-resolver.js';
import {
  classifyContextPath,
  DEFAULT_CONTEXT_IGNORE_GLOBS,
  type ContextDiscoveryMode,
} from './context-economy.js';

export interface ProcessRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
}

export interface ProcessRunOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ProcessRunner {
  run(command: string, args: readonly string[], cwd: string, options?: ProcessRunOptions): Promise<ProcessRunResult>;
}

export class DirectProcessRunner implements ProcessRunner {
  public run(command: string, args: readonly string[], cwd: string, options: ProcessRunOptions = {}): Promise<ProcessRunResult> {
    return new Promise((resolve) => {
      const child = spawn(command, [...args], { cwd, shell: false, windowsHide: true });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const abort = (): void => {
        timedOut = true;
        child.kill();
      };
      const append = (current: string, chunk: Buffer): string => Buffer.from(`${current}${chunk.toString('utf8')}`, 'utf8').subarray(-MAX_PROCESS_LOG_BYTES).toString('utf8');
      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        resolve({ exitCode, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) });
      };
      const timeoutMs = options.timeoutMs;
      const timer = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
          abort();
        }, timeoutMs)
        : undefined;
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.on('error', (error: Error) => {
        stderr = `${stderr}${error.message}`;
        finish(-1);
      });
      child.on('close', (exitCode) => finish(exitCode ?? -1));
    });
  }
}

export interface SearchTextRequest {
  readonly rootPath: string;
  readonly query: string;
  readonly glob?: string;
  readonly maxResults?: number;
  readonly discovery?: ContextDiscoveryMode;
  readonly signal?: AbortSignal;
}

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface SearchTextResult {
  readonly matches: readonly SearchMatch[];
  readonly truncated: boolean;
}

export interface SearchFilesRequest {
  readonly rootPath: string;
  readonly glob?: string;
  readonly maxResults?: number;
  readonly discovery?: ContextDiscoveryMode;
  readonly signal?: AbortSignal;
}

export interface SearchFilesResult {
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

const SEARCH_PROCESS_TIMEOUT_MS = 45_000;

export class RipgrepAdapter {
  public constructor(
    private readonly resolver: ExecutableResolver = new PathExecutableResolver(),
    private readonly runner: ProcessRunner = new DirectProcessRunner(),
  ) {}

  public async searchText(request: SearchTextRequest): Promise<Result<SearchTextResult>> {
    const maxResults = request.maxResults ?? DEFAULT_SEARCH_RESULTS;
    if (request.query.length === 0 || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_SEARCH_RESULTS) {
      return err({ code: 'INVALID_INPUT', message: 'Search query or result limit is invalid', recoverable: false });
    }
    const executable = await this.resolver.resolve('rg');
    if (!executable.ok) return executable;
    const discovery = request.discovery ?? 'automatic';
    const args = ['--json', '--no-heading', '--color', 'never', '--hidden', '--no-ignore'];
    if (discovery === 'automatic') this.appendDefaultGlobs(args);
    if (request.glob !== undefined) args.push('--glob', request.glob);
    args.push('--', request.query, '.');
    const processResult = await this.runner.run(executable.value, args, request.rootPath, { timeoutMs: SEARCH_PROCESS_TIMEOUT_MS, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (!processResult.timedOut && processResult.exitCode !== 0 && processResult.exitCode !== 1) {
      if (processResult.exitCode === 2) return err({ code: 'INVALID_INPUT', message: searchArgumentError(processResult.stderr), recoverable: false });
      return err({ code: 'INTERNAL_ERROR', message: searchProcessError(processResult.stderr), recoverable: true });
    }
    const matches: SearchMatch[] = [];
    for (const line of processResult.stdout.split(/\r?\n/)) {
      const match = this.parseMatch(line);
      if (match === null) continue;
      if (discovery === 'automatic' && !classifyContextPath(match.path, discovery).discoverable) continue;
      matches.push(match);
      if (matches.length >= maxResults) break;
    }
    return ok({ matches, truncated: processResult.timedOut === true || matches.length >= maxResults && processResult.stdout.includes('"type":"match"') });
  }

  public async searchFiles(request: SearchFilesRequest): Promise<Result<SearchFilesResult>> {
    const maxResults = request.maxResults ?? DEFAULT_SEARCH_RESULTS;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_SEARCH_RESULTS) {
      return err({ code: 'INVALID_INPUT', message: 'Search result limit is invalid', recoverable: false });
    }
    const executable = await this.resolver.resolve('rg');
    if (!executable.ok) return executable;
    const discovery = request.discovery ?? 'automatic';
    const args = ['--files', '--hidden', '--no-ignore'];
    if (discovery === 'automatic') this.appendDefaultGlobs(args);
    if (request.glob !== undefined) args.push('--glob', request.glob);
    args.push('--');
    const processResult = await this.runner.run(executable.value, args, request.rootPath, { timeoutMs: SEARCH_PROCESS_TIMEOUT_MS, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (!processResult.timedOut && processResult.exitCode !== 0 && processResult.exitCode !== 1) {
      if (processResult.exitCode === 2) return err({ code: 'INVALID_INPUT', message: searchArgumentError(processResult.stderr), recoverable: false });
      return err({ code: 'INTERNAL_ERROR', message: searchProcessError(processResult.stderr), recoverable: true });
    }
    const discoveredPaths = processResult.stdout
      .split(/\r?\n/)
      .filter((entry) => entry.length > 0)
      .filter((entry) => discovery === 'explicit' || classifyContextPath(entry, discovery).discoverable);
    const paths = discoveredPaths.slice(0, maxResults);
    return ok({ paths, truncated: processResult.timedOut === true || discoveredPaths.length > maxResults });
  }

  private parseMatch(line: string): SearchMatch | null {
    try {
      const value: unknown = JSON.parse(line);
      if (!this.isMatchRecord(value)) return null;
      return { path: value.data.path.text, line: value.data.line_number, text: value.data.lines.text.replace(/\r?\n$/, '') };
    } catch {
      return null;
    }
  }

  private appendDefaultGlobs(args: string[]): void {
    for (const glob of DEFAULT_CONTEXT_IGNORE_GLOBS) args.push('--glob', glob);
  }

  private isMatchRecord(value: unknown): value is MatchRecord {
    if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'match' || !('data' in value)) return false;
    const data = value.data;
    if (typeof data !== 'object' || data === null || !('path' in data) || !('line_number' in data) || !('lines' in data)) return false;
    if (typeof data.path !== 'object' || data.path === null || !('text' in data.path) || typeof data.path.text !== 'string') return false;
    if (typeof data.line_number !== 'number' || typeof data.lines !== 'object' || data.lines === null || !('text' in data.lines) || typeof data.lines.text !== 'string') return false;
    return true;
  }
}

function searchArgumentError(stderr: string): string {
  const detail = boundedSearchError(stderr);
  return detail.length === 0 ? 'Search pattern or glob is invalid' : `Search pattern or glob is invalid: ${detail}`;
}

function searchProcessError(stderr: string): string {
  const detail = boundedSearchError(stderr);
  return detail.length === 0 ? 'Search process failed' : `Search process failed: ${detail}`;
}

function boundedSearchError(stderr: string): string {
  return stderr.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 512);
}

interface MatchRecord {
  readonly type: 'match';
  readonly data: {
    readonly path: { readonly text: string };
    readonly line_number: number;
    readonly lines: { readonly text: string };
  };
}
