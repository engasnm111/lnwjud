export type BatchResultStatus = 'succeeded' | 'failed' | 'skipped' | 'timed_out' | 'cancelled';

export interface BatchInvocation {
  readonly id: string;
  readonly tool: string;
  readonly input: unknown;
  readonly dependencies: readonly string[];
  readonly timeoutMs?: number;
  /** False keeps side-effecting child calls out of a parallel wave. */
  readonly parallelSafe: boolean;
}

export interface BatchExecutionGroup {
  readonly id: string;
  readonly parallel: boolean;
  readonly calls: readonly BatchInvocation[];
}

export interface BatchExecutionPlan {
  readonly parallel: boolean;
  readonly calls: readonly BatchInvocation[];
  readonly groups?: readonly BatchExecutionGroup[];
}

export interface BatchInvocationResult {
  readonly id: string;
  readonly tool: string;
  readonly status: BatchResultStatus;
  readonly durationMs: number;
  readonly value?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface BatchExecutionSummary {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly timedOut: number;
  readonly cancelled: number;
}

export interface BatchExecutionResult {
  readonly results: readonly BatchInvocationResult[];
  readonly summary: BatchExecutionSummary;
}

export type BatchInvoker = (call: BatchInvocation, signal: AbortSignal) => Promise<unknown>;

export interface ExecuteBatchOptions {
  readonly signal?: AbortSignal;
  /** Bounds simultaneously executing parallel-safe children. */
  readonly maxConcurrency?: number;
}

const DEFAULT_MAX_CONCURRENCY = 8;
const MAX_MAX_CONCURRENCY = 16;

type MutableBatchResult = BatchInvocationResult;

interface SettledOutcome {
  readonly kind: 'value' | 'error' | 'timeout' | 'cancelled';
  readonly value?: unknown;
  readonly error?: unknown;
}

const CANCELLATION_ERROR = Symbol('batch-cancellation');
const TIMEOUT_ERROR = Symbol('batch-timeout');

export async function executeBatch(
  plan: BatchExecutionPlan,
  invoke: BatchInvoker,
  options: ExecuteBatchOptions = {},
): Promise<BatchExecutionResult> {
  const orderedCalls = flattenPlan(plan);
  validatePlan(orderedCalls, plan.groups ?? []);

  const results = new Map<string, MutableBatchResult>();
  if (options.signal?.aborted) {
    for (const call of orderedCalls) results.set(call.id, cancelledResult(call));
    return finalize(orderedCalls, results);
  }

  const maxConcurrency = normalizeMaxConcurrency(options.maxConcurrency);
  if (plan.calls.length > 0) {
    await executeSet(plan.calls, plan.parallel, results, invoke, options.signal, maxConcurrency);
  }
  for (const group of plan.groups ?? []) {
    if (options.signal?.aborted) {
      for (const call of group.calls) {
        if (!results.has(call.id)) results.set(call.id, cancelledResult(call));
      }
      continue;
    }
    await executeSet(group.calls, group.parallel, results, invoke, options.signal, maxConcurrency);
  }

  return finalize(orderedCalls, results);
}

async function executeSet(
  calls: readonly BatchInvocation[],
  parallel: boolean,
  results: Map<string, MutableBatchResult>,
  invoke: BatchInvoker,
  signal: AbortSignal | undefined,
  maxConcurrency: number,
): Promise<void> {
  const pending = new Map(calls.map((call) => [call.id, call]));

  while (pending.size > 0) {
    if (signal?.aborted) {
      for (const call of pending.values()) results.set(call.id, cancelledResult(call));
      return;
    }

    const ready = [...pending.values()].filter((call) => call.dependencies.every((dependency) => results.has(dependency)));
    if (ready.length === 0) {
      for (const call of pending.values()) {
        results.set(call.id, skippedResult(call, 'DEPENDENCY_UNRESOLVED', 'Dependencies could not be resolved'));
      }
      return;
    }

    const blocked = ready.filter((call) => call.dependencies.some((dependency) => results.get(dependency)?.status !== 'succeeded'));
    for (const call of blocked) {
      pending.delete(call.id);
      results.set(call.id, skippedResult(call, 'DEPENDENCY_FAILED', 'A dependency did not succeed'));
    }

    const runnable = ready.filter((call) => !blocked.includes(call));
    if (runnable.length === 0) continue;

    const wave = selectWave(runnable, parallel, maxConcurrency);
    for (const call of wave) pending.delete(call.id);
    const settled = await Promise.allSettled(wave.map((call) => executeOne(call, invoke, signal)));
    for (let index = 0; index < wave.length; index += 1) {
      const call = wave[index];
      const outcome = settled[index];
      if (call === undefined || outcome === undefined) continue;
      results.set(call.id, outcome.status === 'fulfilled'
        ? outcome.value
        : failedResult(call, outcome.reason));
    }
  }
}

function selectWave(calls: readonly BatchInvocation[], parallel: boolean, maxConcurrency: number): readonly BatchInvocation[] {
  if (!parallel) return calls.slice(0, 1);
  const unsafe = calls.find((call) => !call.parallelSafe);
  return unsafe === undefined ? calls.slice(0, maxConcurrency) : [unsafe];
}

function normalizeMaxConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_CONCURRENCY;
  return Math.max(1, Math.min(MAX_MAX_CONCURRENCY, Math.trunc(value)));
}

async function executeOne(call: BatchInvocation, invoke: BatchInvoker, parentSignal: AbortSignal | undefined): Promise<MutableBatchResult> {
  const started = Date.now();
  if (parentSignal?.aborted) return cancelledResult(call, Date.now() - started);

  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let resolveTimeout: (() => void) | undefined;
  let resolveCancellation: (() => void) | undefined;
  const onAbort = (): void => {
    controller.abort();
    resolveCancellation?.();
  };
  const timeout = new Promise<SettledOutcome>((resolve) => {
    resolveTimeout = (): void => resolve({ kind: 'timeout', error: TIMEOUT_ERROR });
  });
  const cancelled = new Promise<SettledOutcome>((resolve) => {
    resolveCancellation = (): void => resolve({ kind: 'cancelled', error: CANCELLATION_ERROR });
  });
  const invocation: Promise<SettledOutcome> = Promise.resolve()
    .then((): Promise<unknown> => invoke(call, controller.signal))
    .then((value: unknown): SettledOutcome => ({ kind: 'value', value }), (error: unknown): SettledOutcome => ({ kind: 'error', error }));

  if (call.timeoutMs !== undefined) timeoutHandle = setTimeout(() => {
    controller.abort();
    resolveTimeout?.();
  }, call.timeoutMs);
  if (parentSignal !== undefined) {
    if (parentSignal.aborted) resolveCancellation?.();
    else parentSignal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const outcome = await Promise.race([
      invocation,
      ...(call.timeoutMs === undefined ? [] : [timeout]),
      ...(parentSignal === undefined ? [] : [cancelled]),
    ]);
    const durationMs = Date.now() - started;
    if (outcome.kind === 'value') return { id: call.id, tool: call.tool, status: 'succeeded', durationMs, value: outcome.value };
    if (outcome.kind === 'timeout') return timedOutResult(call, durationMs);
    if (outcome.kind === 'cancelled') return cancelledResult(call, durationMs);
    return failedResult(call, outcome.error, durationMs);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    parentSignal?.removeEventListener('abort', onAbort);
  }
}

function flattenPlan(plan: BatchExecutionPlan): readonly BatchInvocation[] {
  return [...plan.calls, ...(plan.groups ?? []).flatMap((group) => group.calls)];
}

function validatePlan(calls: readonly BatchInvocation[], groups: readonly BatchExecutionGroup[]): void {
  const ids = new Set<string>();
  for (const call of calls) {
    if (ids.has(call.id)) throw new Error(`Duplicate batch call id: ${call.id}`);
    ids.add(call.id);
  }
  for (const call of calls) {
    for (const dependency of call.dependencies) {
      if (!ids.has(dependency)) throw new Error(`Unknown batch dependency: ${dependency}`);
    }
  }

  const groupIndex = new Map<string, number>();
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (group === undefined) continue;
    if (groupIndex.has(group.id)) throw new Error(`Duplicate batch group id: ${group.id}`);
    groupIndex.set(group.id, index);
  }
  const callGroup = new Map<string, number>();
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (group === undefined) continue;
    for (const call of group.calls) callGroup.set(call.id, index);
  }
  for (const call of calls) {
    const currentGroup = callGroup.get(call.id);
    if (currentGroup === undefined) continue;
    for (const dependency of call.dependencies) {
      const dependencyGroup = callGroup.get(dependency);
      if (dependencyGroup !== undefined && dependencyGroup > currentGroup) {
        throw new Error(`Batch dependency points to a later sequential group: ${dependency}`);
      }
    }
  }
}

function finalize(orderedCalls: readonly BatchInvocation[], results: Map<string, MutableBatchResult>): BatchExecutionResult {
  const stableResults = orderedCalls.map((call) => results.get(call.id) ?? skippedResult(call, 'NOT_EXECUTED', 'Call was not executed'));
  const summary: BatchExecutionSummary = {
    total: stableResults.length,
    succeeded: stableResults.filter((result) => result.status === 'succeeded').length,
    failed: stableResults.filter((result) => result.status === 'failed').length,
    skipped: stableResults.filter((result) => result.status === 'skipped').length,
    timedOut: stableResults.filter((result) => result.status === 'timed_out').length,
    cancelled: stableResults.filter((result) => result.status === 'cancelled').length,
  };
  return { results: stableResults, summary };
}

function failedResult(call: BatchInvocation, error: unknown, durationMs = 0): MutableBatchResult {
  const code = codedError(error)?.code ?? 'CHILD_FAILED';
  return {
    id: call.id,
    tool: call.tool,
    status: 'failed',
    durationMs,
    error: { code, message: errorMessage(error) },
  };
}

function timedOutResult(call: BatchInvocation, durationMs = 0): MutableBatchResult {
  return {
    id: call.id,
    tool: call.tool,
    status: 'timed_out',
    durationMs,
    error: { code: 'TIMEOUT', message: 'Child call timed out' },
  };
}

function cancelledResult(call: BatchInvocation, durationMs = 0): MutableBatchResult {
  return {
    id: call.id,
    tool: call.tool,
    status: 'cancelled',
    durationMs,
    error: { code: 'CANCELLED', message: 'Batch execution was cancelled' },
  };
}

function skippedResult(call: BatchInvocation, code: string, message: string): MutableBatchResult {
  return {
    id: call.id,
    tool: call.tool,
    status: 'skipped',
    durationMs: 0,
    error: { code, message },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return 'Child call failed';
}

function codedError(error: unknown): { readonly code: string } | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? { code } : undefined;
}
