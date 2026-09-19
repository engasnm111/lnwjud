import type {
  AutomationCancelTaskOutcome,
  AutomationResolveDispatchOutcome,
  AutomationTaskLaunchOutcome,
  AutomationTaskLaunchPortRequest,
  AutomationTaskObservationOutcome,
  AutomationTaskRuntimePort,
} from '@lnwjud/application';
import type { GoalLeaseProof } from '@lnwjud/domain';
import type { McpToolResponse } from './result-mapper.js';

export const AUTOMATION_GOAL_LEASE_CONTEXT_KEY = '__lnwjudAutomationGoalLease';

export interface AutomationChildInvoker {
  invoke(
    name: string,
    input: unknown,
    signal?: AbortSignal,
    callId?: string,
  ): Promise<McpToolResponse>;
}

export interface AutomationRuntimeAdapterOptions {
  readonly goalLease?: GoalLeaseProof;
  readonly userConfirmed: boolean;
  readonly signal?: AbortSignal;
}

export class ToolRegistryAutomationRuntimeAdapter implements AutomationTaskRuntimePort {
  public constructor(
    private readonly child: AutomationChildInvoker,
    private readonly options: AutomationRuntimeAdapterOptions,
  ) {}

  public async launch(
    request: AutomationTaskLaunchPortRequest,
  ): Promise<AutomationTaskLaunchOutcome> {
    if (request.execution === undefined) {
      return {
        kind: 'rejected',
        code: 'INVALID_INPUT',
        detail: 'Native automation dispatch requires an explicit execution descriptor',
        retryable: false,
      };
    }
    const input = this.withEnvelope(launchInput(request));
    const tool = launchTool(request.execution.provider);
    let response: McpToolResponse;
    try {
      response = await this.child.invoke(tool, input, this.options.signal, request.childCallId);
    } catch (error) {
      return {
        kind: 'uncertain',
        detail: bounded(error instanceof Error ? error.message : 'Child tool invocation failed after dispatch'),
      };
    }
    if (response.isError === true) return launchError(response);
    const taskId = readTaskId(response.structuredContent, request.execution.provider);
    if (taskId === undefined) {
      return {
        kind: 'uncertain',
        detail: 'Child runtime returned success without a durable task/process handle',
      };
    }
    return {
      kind: 'started',
      taskId,
      detail: `launched via ${tool}`,
    };
  }

  public async observe(
    request: Parameters<AutomationTaskRuntimePort['observe']>[0],
  ): Promise<AutomationTaskObservationOutcome> {
    const tool = observationTool(request.provider);
    const input = observationInput(request.provider, request.workspaceId, request.taskId);
    let response: McpToolResponse;
    try {
      response = await this.child.invoke(tool, input, this.options.signal);
    } catch (error) {
      return {
        kind: 'unreachable',
        detail: bounded(error instanceof Error ? error.message : 'Child task observation failed'),
      };
    }
    if (response.isError === true) return observationError(response);
    return parseObservation(response.structuredContent);
  }

  public async resolveDispatch(): Promise<AutomationResolveDispatchOutcome> {
    return {
      kind: 'unknown',
      detail: 'Current shell/process/codex child runtimes do not expose a durable idempotency-key lookup',
    };
  }

  public async cancel(
    request: Parameters<AutomationTaskRuntimePort['cancel']>[0],
  ): Promise<AutomationCancelTaskOutcome> {
    const { tool, input } = cancellationInvocation(request.provider, request.workspaceId, request.taskId);
    let response: McpToolResponse;
    try {
      response = await this.child.invoke(tool, this.withEnvelope(input), this.options.signal);
    } catch (error) {
      return {
        kind: 'unknown',
        detail: bounded(error instanceof Error ? error.message : 'Child task cancellation failed'),
      };
    }
    if (response.isError === true) {
      return {
        kind: 'unknown',
        detail: errorMessage(response) ?? 'Child runtime rejected cancellation',
      };
    }
    const observation = parseObservation(response.structuredContent);
    if (observation.kind === 'observed' && isTerminalState(observation.state)) {
      return {
        kind: 'already_terminal',
        state: observation.state,
        ...(observation.detail === undefined ? {} : { detail: observation.detail }),
        ...(observation.terminalAt === undefined ? {} : { terminalAt: observation.terminalAt }),
      };
    }
    return { kind: 'requested', detail: `cancellation requested via ${tool}` };
  }

  private withEnvelope(input: Record<string, unknown>): Record<string, unknown> {
    return {
      ...input,
      userConfirmed: this.options.userConfirmed,
      ...(this.options.goalLease === undefined ? {} : { goalLease: this.options.goalLease }),
    };
  }
}

function launchTool(provider: AutomationTaskLaunchPortRequest['provider']): string {
  if (provider === 'shell') return 'shell';
  if (provider === 'process') return 'process_start';
  return 'codex_run';
}

function launchInput(request: AutomationTaskLaunchPortRequest): Record<string, unknown> {
  const execution = request.execution;
  if (execution === undefined) return {};
  if (execution.provider === 'shell') {
    return {
      operation: 'run',
      workspaceId: request.workspaceId,
      executable: execution.executable,
      arguments: [...execution.arguments],
      execution: 'background',
      ...(execution.cwd === undefined ? {} : { cwd: execution.cwd }),
      ...(execution.timeoutMs === undefined ? {} : { timeout_seconds: Math.ceil(execution.timeoutMs / 1_000) }),
    };
  }
  if (execution.provider === 'process') {
    return {
      workspaceId: request.workspaceId,
      executable: execution.executable,
      args: [...execution.args],
      ...(execution.cwd === undefined ? {} : { cwd: execution.cwd }),
      ...(execution.timeoutMs === undefined ? {} : { timeoutMs: execution.timeoutMs }),
    };
  }
  return {
    workspaceId: request.workspaceId,
    instruction: execution.instruction,
  };
}
function observationTool(provider: 'shell' | 'process' | 'codex'): string {
  if (provider === 'shell') return 'task_status';
  if (provider === 'process') return 'process_status';
  return 'codex_task_status';
}

function observationInput(
  provider: 'shell' | 'process' | 'codex',
  workspaceId: string,
  taskId: string,
): Record<string, unknown> {
  if (provider === 'shell') return { workspaceId, taskId };
  if (provider === 'process') return { workspaceId, processId: taskId };
  return { workspaceId, codexTaskId: taskId };
}

function cancellationInvocation(
  provider: 'shell' | 'process' | 'codex',
  workspaceId: string,
  taskId: string,
): { readonly tool: string; readonly input: Record<string, unknown> } {
  if (provider === 'shell') {
    return {
      tool: 'shell',
      input: {
        operation: 'cancel',
        task_id: taskId,
        workspaceId,
      },
    };
  }
  if (provider === 'process') {
    return { tool: 'process_stop', input: { workspaceId, processId: taskId } };
  }
  return { tool: 'codex_stop', input: { workspaceId, codexTaskId: taskId } };
}

function launchError(response: McpToolResponse): AutomationTaskLaunchOutcome {
  const error = errorRecord(response);
  const code = typeof error?.code === 'string' ? error.code : 'CHILD_TOOL_ERROR';
  const recoverable = error?.recoverable === true;
  if (code === 'TIMEOUT' || code === 'CANCELLED') {
    return {
      kind: 'uncertain',
      detail: errorMessage(response) ?? `${code}: child dispatch outcome is uncertain`,
    };
  }
  return {
    kind: 'rejected',
    code,
    detail: errorMessage(response) ?? 'Child runtime rejected task launch',
    retryable: recoverable && code === 'INTERNAL_ERROR',
  };
}

function observationError(response: McpToolResponse): AutomationTaskObservationOutcome {
  const error = errorRecord(response);
  const code = typeof error?.code === 'string' ? error.code : 'CHILD_TOOL_ERROR';
  const detail = errorMessage(response) ?? 'Child task observation failed';
  if (code === 'TIMEOUT' || code === 'CANCELLED') return { kind: 'timeout', detail };
  if (code === 'FILE_NOT_FOUND' || code === 'INVALID_INPUT' || /not found/i.test(detail)) {
    return { kind: 'not_found', detail };
  }
  return { kind: 'unreachable', detail };
}

function parseObservation(
  structured: Readonly<Record<string, unknown>> | undefined,
): AutomationTaskObservationOutcome {
  if (structured === undefined) {
    return { kind: 'unreachable', detail: 'Child runtime returned no structured task status' };
  }
  const stateValue = findString(structured, ['state', 'status']);
  const exitCode = findNumber(structured, ['exitCode', 'exit_code']);
  const terminalAt = findString(structured, ['finishedAt', 'finished_at', 'completedAt', 'completed_at', 'terminalAt', 'terminal_at']);
  const detail = findString(structured, ['message', 'detail', 'stderr', 'error']);

  if (stateValue === undefined) {
    if (typeof exitCode === 'number') {
      return {
        kind: 'observed',
        state: exitCode === 0 ? 'completed' : 'failed',
        ...(detail === undefined ? {} : { detail: bounded(detail) }),
        ...(terminalAt === undefined ? {} : { terminalAt }),
      };
    }
    return { kind: 'unreachable', detail: 'Child runtime status did not include a recognizable state' };
  }

  const state = normalizeState(stateValue, exitCode);
  if (state === undefined) {
    return { kind: 'unreachable', detail: `Unknown child task state: ${stateValue}` };
  }
  return {
    kind: 'observed',
    state,
    ...(detail === undefined ? {} : { detail: bounded(detail) }),
    ...(terminalAt === undefined ? {} : { terminalAt }),
  };
}

function normalizeState(
  value: string,
  exitCode: number | undefined,
): 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'termination_unverified' | undefined {
  const state = value.toLowerCase().replaceAll('-', '_');
  if (state === 'starting' || state === 'queued' || state === 'pending') return 'starting';
  if (state === 'running' || state === 'working' || state === 'in_progress') return 'running';
  if (state === 'completed' || state === 'succeeded' || state === 'success') return 'completed';
  if (state === 'failed' || state === 'error') return 'failed';
  if (state === 'cancelled' || state === 'canceled') return 'cancelled';
  if (state === 'timed_out' || state === 'timeout') return 'timed_out';
  if (state === 'termination_unverified' || state === 'unknown_termination') return 'termination_unverified';
  if (state === 'exited' || state === 'terminal') {
    return exitCode === 0 ? 'completed' : 'failed';
  }
  return undefined;
}

function readTaskId(
  structured: Readonly<Record<string, unknown>> | undefined,
  provider: 'shell' | 'process' | 'codex',
): string | undefined {
  if (structured === undefined) return undefined;
  const keys = provider === 'shell'
    ? ['task_id', 'taskId']
    : provider === 'process'
      ? ['processId', 'process_id']
      : ['codexTaskId', 'codex_task_id', 'taskId', 'task_id'];
  return findString(structured, keys);
}
function findString(value: unknown, keys: readonly string[], depth = 0): string | undefined {
  if (depth > 4 || typeof value !== 'object' || value === null) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findString(entry, keys, depth + 1);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  for (const nested of Object.values(record)) {
    const found = findString(nested, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findNumber(value: unknown, keys: readonly string[], depth = 0): number | undefined {
  if (depth > 4 || typeof value !== 'object' || value === null) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findNumber(entry, keys, depth + 1);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  for (const nested of Object.values(record)) {
    const found = findNumber(nested, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function errorRecord(response: McpToolResponse): Record<string, unknown> | undefined {
  const error = response.structuredContent?.error;
  return typeof error === 'object' && error !== null && !Array.isArray(error)
    ? error as Record<string, unknown>
    : undefined;
}

function errorMessage(response: McpToolResponse): string | undefined {
  const error = errorRecord(response);
  if (typeof error?.message === 'string' && error.message.trim().length > 0) return bounded(error.message);
  const text = response.content.find((entry) => entry.type === 'text');
  return text?.type === 'text' ? bounded(text.text) : undefined;
}

function isTerminalState(
  state: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'termination_unverified',
): state is 'completed' | 'failed' | 'cancelled' | 'timed_out' {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'timed_out';
}

function bounded(value: string): string {
  let cleaned = '';
  for (const character of value) {
    const point = character.codePointAt(0);
    cleaned += point !== undefined && (point <= 0x1f || point === 0x7f) ? ' ' : character;
  }
  return cleaned.trim().slice(0, 2_048);
}
