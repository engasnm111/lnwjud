import { spawn } from 'node:child_process';
import { DEFAULT_SEARCH_RESULTS, err, MAX_PROCESS_LOG_BYTES, MAX_SEARCH_RESULTS, ok, type Result } from '@lnwjud/domain';
import { PathExecutableResolver, type ExecutableResolver } from './executable-resolver.js';

export interface ProcessRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunner {
  run(command: string, args: readonly string[], cwd: string): Promise<ProcessRunResult>;
}

export class DirectProcessRunner implements ProcessRunner {
  public run(command: string, args: readonly string[], cwd: string): Promise<ProcessRunResult> {
    return new Promise((resolve) => {
      const child = spawn(command, [...args], { cwd, shell: false, windowsHide: true });
      let stdout = '';
      let stderr = '';
      const append = (current: string, chunk: Buffer): string => Buffer.from(`${current}${chunk.toString('utf8')}`, 'utf8').subarray(-MAX_PROCESS_LOG_BYTES).toString('utf8');
      child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.on('error', (error: Error) => resolve({ exitCode: -1, stdout, stderr: `${stderr}${error.message}` }));
      child.on('close', (exitCode) => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
    });
  }
}

export interface SearchTextRequest {
  readonly rootPath: string;
  readonly query: string;
  readonly glob?: string;
  readonly maxResults?: number;
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
}

export interface SearchFilesResult {
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

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
    const args = ['--json', '--no-heading', '--color', 'never', '--hidden'];
    if (request.glob !== undefined) args.push('--glob', request.glob);
    args.push('--', request.query, '.');
    const processResult = await this.runner.run(executable.value, args, request.rootPath);
    if (processResult.exitCode !== 0 && processResult.exitCode !== 1) {
      return err({ code: 'INTERNAL_ERROR', message: 'Search process failed', recoverable: true });
    }
    const matches: SearchMatch[] = [];
    for (const line of processResult.stdout.split(/\r?\n/)) {
      const match = this.parseMatch(line);
      if (match === null) continue;
      matches.push(match);
      if (matches.length >= maxResults) break;
    }
    return ok({ matches, truncated: matches.length >= maxResults && processResult.stdout.includes('"type":"match"') });
  }

  public async searchFiles(request: SearchFilesRequest): Promise<Result<SearchFilesResult>> {
    const maxResults = request.maxResults ?? DEFAULT_SEARCH_RESULTS;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_SEARCH_RESULTS) {
      return err({ code: 'INVALID_INPUT', message: 'Search result limit is invalid', recoverable: false });
    }
    const executable = await this.resolver.resolve('rg');
    if (!executable.ok) return executable;
    const args = ['--files', '--hidden'];
    if (request.glob !== undefined) args.push('--glob', request.glob);
    args.push('--');
    const processResult = await this.runner.run(executable.value, args, request.rootPath);
    if (processResult.exitCode !== 0 && processResult.exitCode !== 1) {
      return err({ code: 'INTERNAL_ERROR', message: 'Search process failed', recoverable: true });
    }
    const paths = processResult.stdout.split(/\r?\n/).filter((entry) => entry.length > 0).slice(0, maxResults);
    return ok({ paths, truncated: paths.length >= maxResults && processResult.stdout.split(/\r?\n/).filter(Boolean).length > maxResults });
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

  private isMatchRecord(value: unknown): value is MatchRecord {
    if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'match' || !('data' in value)) return false;
    const data = value.data;
    if (typeof data !== 'object' || data === null || !('path' in data) || !('line_number' in data) || !('lines' in data)) return false;
    if (typeof data.path !== 'object' || data.path === null || !('text' in data.path) || typeof data.path.text !== 'string') return false;
    if (typeof data.line_number !== 'number' || typeof data.lines !== 'object' || data.lines === null || !('text' in data.lines) || typeof data.lines.text !== 'string') return false;
    return true;
  }
}

interface MatchRecord {
  readonly type: 'match';
  readonly data: {
    readonly path: { readonly text: string };
    readonly line_number: number;
    readonly lines: { readonly text: string };
  };
}
