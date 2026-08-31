import { createHash } from 'node:crypto';
import { appError, err, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import type { McpToolContext } from './tools/tool-types.js';

const DEFAULT_VERIFY_WAIT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_MS = 250;
const LOG_TAIL_LINES = 80;

interface VerificationCacheEntry {
  readonly cacheKey: string;
  readonly value: Record<string, unknown>;
}

export interface IncrementalVerifierOptions {
  readonly maxWaitMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
}

/** Shared across per-request MCP server factories so unchanged diffs hit cache. */
export class IncrementalVerifier {
  private readonly cache = new Map<string, VerificationCacheEntry>();
  private readonly maxWaitMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;

  public constructor(options: IncrementalVerifierOptions = {}) {
    this.maxWaitMs = positiveFinite(options.maxWaitMs, DEFAULT_VERIFY_WAIT_MS);
    this.pollMs = positiveFinite(options.pollMs, DEFAULT_POLL_MS);
    this.now = options.now ?? Date.now;
  }

  public async verify(context: McpToolContext, workspaceId: string, signal: AbortSignal, userConfirmed = false, authorization?: InvocationAuthorization): Promise<Result<Record<string, unknown>>> {
    const git = context.services.git;
    const processService = context.services.process;
    if (git === undefined || processService === undefined) {
      return err(appError('INTERNAL_ERROR', 'Incremental verification services are unavailable', true));
    }

    const fingerprint = await buildDiffFingerprint(context, workspaceId, signal);
    if (!fingerprint.ok) return fingerprint;
    const cached = this.cache.get(workspaceId);
    if (cached?.cacheKey === fingerprint.value.cacheKey) {
      return ok({
        cache: 'hit',
        cache_key: cached.cacheKey,
        changed_files: fingerprint.value.changedFiles,
        ...cached.value,
      });
    }

    if (signal.aborted) return cancelledVerification();
    const started = await processService.startProjectCommand(context.actor, workspaceId, 'typecheck', signal, userConfirmed, undefined, authorization);
    if (!started.ok) return started;
    let process = started.value;
    const deadline = this.now() + this.maxWaitMs;
    while (process.state === 'starting' || process.state === 'running' || process.state === 'termination_unverified') {
      if (signal.aborted) return cancelledVerification();
      if (this.now() >= deadline) {
        return err(appError(
          'PROCESS_TIMEOUT',
          'Incremental typecheck is still running after 5 minutes. For longer verification, launch it as a durable background shell task and record the task_id in the tracker.',
          true,
        ));
      }
      await delay(this.pollMs, signal);
      if (signal.aborted) return cancelledVerification();
      const status = await processService.status(context.actor, workspaceId, process.processId);
      if (!status.ok) return status;
      process = status.value;
    }

    const logs = await processService.logs(context.actor, workspaceId, process.processId, { tailLines: LOG_TAIL_LINES });
    if (!logs.ok) return logs;
    const passed = process.state === 'exited' && process.exitCode === 0;
    const verification = {
      passed,
      process_id: process.processId,
      state: process.state,
      command: { executable: process.executable, args: [...process.args], cwd: process.cwd },
      ...(process.exitCode === undefined ? {} : { exit_code: process.exitCode }),
      ...(process.error === undefined ? {} : { error: process.error }),
      logs: logs.value.entries,
      logs_truncated: logs.value.truncated,
      verified_at: new Date(this.now()).toISOString(),
    } satisfies Record<string, unknown>;
    this.cache.set(workspaceId, { cacheKey: fingerprint.value.cacheKey, value: verification });
    return ok({
      cache: 'miss',
      cache_key: fingerprint.value.cacheKey,
      changed_files: fingerprint.value.changedFiles,
      ...verification,
    });
  }
}

async function buildDiffFingerprint(
  context: McpToolContext,
  workspaceId: string,
  signal: AbortSignal,
): Promise<Result<{ readonly cacheKey: string; readonly changedFiles: readonly string[] }>> {
  const git = context.services.git;
  if (git === undefined) return err(appError('INTERNAL_ERROR', 'Git service is unavailable', true));
  const status = await git.status(context.actor, workspaceId, signal);
  if (!status.ok) return status;
  const unstaged = await git.diff(context.actor, workspaceId, { maxBytes: 2 * 1024 * 1024 }, signal);
  if (!unstaged.ok) return unstaged;
  const staged = await git.diff(context.actor, workspaceId, { staged: true, maxBytes: 2 * 1024 * 1024 }, signal);
  if (!staged.ok) return staged;
  const changedFiles = status.value.entries.map((entry) => entry.path).sort();
  const hash = createHash('sha256')
    .update(JSON.stringify(status.value.entries))
    .update('\0')
    .update(unstaged.value.patch)
    .update('\0')
    .update(staged.value.patch)
    .digest('hex');
  return ok({ cacheKey: hash, changedFiles });
}

function cancelledVerification(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Incremental verification was cancelled', true));
}

function positiveFinite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
