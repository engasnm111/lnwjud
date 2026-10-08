import { appError, err, ok, type Result } from '@lnwjud/domain';
import { DirectGitRunner, type GitRunOptions, type GitRunResult, type GitRunner } from './git-runner.js';
import { parsePorcelainStatus, type GitStatusEntry } from './parsers/status-parser.js';

export interface GitStatusResult {
  readonly entries: readonly GitStatusEntry[];
}

export interface GitDiffRequest {
  readonly path?: string;
  readonly staged?: boolean;
  readonly maxBytes?: number;
}

export interface GitDiffResult {
  readonly patch: string;
  readonly truncated: boolean;
}

export interface GitLogRequest {
  readonly maxCommits?: number;
  readonly maxBytes?: number;
}

export interface GitLogEntry {
  readonly hash: string;
  readonly author: string;
  readonly date: string;
  readonly subject: string;
}

export interface GitLogResult {
  readonly entries: readonly GitLogEntry[];
  readonly truncated: boolean;
}

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const MAX_GIT_ARGS = 128;
const MAX_GIT_ARG_LENGTH = 32_768;
const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const MAX_GIT_TIMEOUT_MS = 300_000;

export class GitAdapter {
  public constructor(private readonly runner: GitRunner = new DirectGitRunner()) {}

  public async status(cwd: string, signal?: AbortSignal): Promise<Result<GitStatusResult>> {
    const result = await this.runner.run(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      cwd,
      this.signalOptions(signal),
    );
    const error = this.mapError(result);
    if (error !== null) return error;
    return ok({ entries: parsePorcelainStatus(result.stdout) });
  }


  /**
   * UI status must enumerate every untracked file, including nested new folders.
   * Git itself honors .gitignore; the caller bounds rendering and caches polling.
   */
  public async statusSummary(cwd: string, signal?: AbortSignal): Promise<Result<GitStatusResult>> {
    const result = await this.runner.run(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      cwd,
      this.signalOptions(signal),
    );
    const error = this.mapError(result);
    if (error !== null) return error;
    return ok({ entries: parsePorcelainStatus(result.stdout) });
  }

  public async branch(cwd: string): Promise<Result<string | null>> {
    const result = await this.runner.run(['branch', '--show-current'], cwd);
    if (result.exitCode === 0 && result.stdout.trim().length > 0) {
      return ok(result.stdout.trim());
    }
    const revResult = await this.runner.run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    if (revResult.exitCode === 0) {
      const name = revResult.stdout.trim();
      return ok(name === 'HEAD' || name.length === 0 ? null : name);
    }
    const error = this.mapError(result);
    if (error !== null) return error;
    return ok(null);
  }

  public async diff(cwd: string, request: GitDiffRequest = {}, signal?: AbortSignal): Promise<Result<GitDiffResult>> {
    const maxBytes = request.maxBytes ?? 1024 * 1024;
    if (!this.isLimit(maxBytes, 4 * 1024 * 1024)) return err(appError('INVALID_INPUT', 'Git diff byte limit is invalid'));
    const args = ['diff', '--no-ext-diff', '--no-color'];
    if (request.staged === true) args.push('--cached');
    args.push('--');
    if (request.path !== undefined) args.push(request.path);
    const result = await this.runner.run(args, cwd, this.signalOptions(signal));
    const error = this.mapError(result);
    if (error !== null) return error;
    const bounded = this.bound(result.stdout, maxBytes);
    return ok({ patch: bounded.text, truncated: bounded.truncated });
  }

  public async log(cwd: string, request: GitLogRequest = {}, signal?: AbortSignal): Promise<Result<GitLogResult>> {
    const maxCommits = request.maxCommits ?? 20;
    const maxBytes = request.maxBytes ?? 1024 * 1024;
    if (!this.isLimit(maxCommits, 100) || !this.isLimit(maxBytes, 4 * 1024 * 1024)) {
      return err(appError('INVALID_INPUT', 'Git log limit is invalid'));
    }
    const args = ['log', '--no-color', '--format=%H%x1f%an%x1f%aI%x1f%s%x1e', '-n', String(maxCommits), '--'];
    const result = await this.runner.run(args, cwd, this.signalOptions(signal));
    const error = this.mapError(result);
    if (error !== null) return error;
    const bounded = this.bound(result.stdout, maxBytes);
    const entries = bounded.text.split('\u001e').flatMap((record) => {
      const fields = record.split('\u001f');
      return fields.length === 4 && fields.every((field) => field.length > 0)
        ? [{ hash: fields[0] ?? '', author: fields[1] ?? '', date: fields[2] ?? '', subject: fields[3] ?? '' }]
        : [];
    });
    return ok({ entries, truncated: bounded.truncated });
  }

  public async run(
    cwd: string,
    args: readonly string[],
    timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<Result<GitCommandResult>> {
    const validation = this.validateArgs(args, timeoutMs);
    if (!validation.ok) return validation;
    const result = await this.runner.run(args, cwd, {
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.exitCode === -1 && /ENOENT/i.test(result.stderr)) {
      return err(appError('EXECUTABLE_NOT_FOUND', 'Git executable was not found'));
    }
    return ok({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
  }

  private validateArgs(args: readonly string[], timeoutMs: number): Result<void> {
    if (!Array.isArray(args) || args.length === 0 || args.length > MAX_GIT_ARGS) {
      return err(appError('INVALID_INPUT', 'Git args must be a non-empty array'));
    }
    if (!args.every((arg) => typeof arg === 'string' && arg.length > 0 && arg.length <= MAX_GIT_ARG_LENGTH)) {
      return err(appError('INVALID_INPUT', 'Git args must be non-empty strings'));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_GIT_TIMEOUT_MS) {
      return err(appError('INVALID_INPUT', 'Git timeout is invalid'));
    }
    return ok(undefined);
  }

  private signalOptions(signal: AbortSignal | undefined): GitRunOptions | undefined {
    return signal === undefined ? undefined : { signal };
  }

  private mapError(result: GitRunResult): Result<never> | null {
    if (result.exitCode === 0) return null;
    if (result.exitCode === 128 && /not a git repository/i.test(result.stderr)) {
      return err(appError('GIT_NOT_REPOSITORY', 'Workspace is not a Git repository'));
    }
    if (result.exitCode === -1 && /ENOENT/i.test(result.stderr)) {
      return err(appError('EXECUTABLE_NOT_FOUND', 'Git executable was not found'));
    }
    return err(appError('INTERNAL_ERROR', 'Git command failed', true));
  }

  private isLimit(value: number, maximum: number): boolean {
    return Number.isInteger(value) && value >= 1 && value <= maximum;
  }

  private bound(value: string, maxBytes: number): { text: string; truncated: boolean } {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
    return { text: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true };
  }
}
