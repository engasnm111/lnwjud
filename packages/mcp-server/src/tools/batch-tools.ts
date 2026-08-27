import { err, ok, type Result } from '@lnwjud/domain';
import { executeBatch, type BatchExecutionPlan, type BatchInvocation } from '../parallel-tool-executor.js';
import { type McpToolResponse } from '../result-mapper.js';
import { defineTool, type McpToolDefinition } from './tool-types.js';
import { toolBatchSchema } from './schemas.js';

export interface BatchToolInvoker {
  invoke(name: string, input: unknown, signal?: AbortSignal): Promise<McpToolResponse>;
  describe(name: string): Pick<McpToolDefinition, 'permission' | 'annotations'> | undefined;
}

interface BatchCallInput {
  readonly id?: string;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly dependsOn: readonly string[];
  readonly timeoutMs?: number;
}

interface BatchGroupInput {
  readonly id?: string;
  readonly parallel: boolean;
  readonly calls: readonly BatchCallInput[];
}

interface ToolBatchInput {
  readonly parallel: boolean;
  readonly calls?: readonly BatchCallInput[];
  readonly groups?: readonly BatchGroupInput[];
}

class BatchChildError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BatchChildError';
  }
}

export function batchTools(invoker: BatchToolInvoker): readonly McpToolDefinition[] {
  return [defineTool({
    name: 'tool_batch',
    description: 'Execute multiple MCP tools with parallel, dependency-aware, timeout, cancellation, and partial-result handling.',
    permission: 'EXECUTE',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: toolBatchSchema,
    async handler(rawInput, signal): Promise<Result<unknown>> {
      const input = rawInput as ToolBatchInput;
      const normalized = normalizePlan(input, invoker);
      if (!normalized.ok) return normalized;

      try {
        const result = await executeBatch(normalized.value, async (call, childSignal) => {
          if (call.tool === 'tool_batch') throw new BatchChildError('INVALID_INPUT', 'Nested tool_batch calls are not allowed');
          const response = await invoker.invoke(call.tool, call.input, childSignal);
          if (response.isError === true) throw toChildError(response);
          return response;
        }, { signal });
        return ok(result);
      } catch (error: unknown) {
        return err({
          code: 'INVALID_INPUT',
          message: error instanceof Error ? error.message : 'Batch plan is invalid',
          recoverable: false,
        });
      }
    },
  })];
}

function normalizePlan(input: ToolBatchInput, invoker: BatchToolInvoker): Result<BatchExecutionPlan> {
  let nextId = 1;
  const normalizeCall = (raw: BatchCallInput): BatchInvocation => {
    const id = raw.id ?? `call-${nextId}`;
    nextId += 1;
    const metadata = invoker.describe(raw.tool);
    const parallelSafe = metadata?.permission === 'READ'
      && metadata.annotations.readOnlyHint
      && !metadata.annotations.destructiveHint;
    return {
      id,
      tool: raw.tool,
      input: raw.arguments,
      dependencies: raw.dependsOn,
      ...(raw.timeoutMs === undefined ? {} : { timeoutMs: raw.timeoutMs }),
      parallelSafe,
    };
  };

  const calls = (input.calls ?? []).map(normalizeCall);
  const groups = (input.groups ?? []).map((group, index) => ({
    id: group.id ?? `group-${index + 1}`,
    parallel: group.parallel,
    calls: group.calls.map(normalizeCall),
  }));

  return ok({
    parallel: input.parallel,
    calls,
    ...(groups.length === 0 ? {} : { groups }),
  });
}

function toChildError(response: McpToolResponse): BatchChildError {
  const content = response.structuredContent;
  if (typeof content === 'object' && content !== null && 'error' in content) {
    const error = (content as { error?: unknown }).error;
    if (typeof error === 'object' && error !== null) {
      const code = 'code' in error && typeof error.code === 'string' ? error.code : 'CHILD_FAILED';
      const message = 'message' in error && typeof error.message === 'string' ? error.message : 'Child call failed';
      return new BatchChildError(code, message);
    }
  }
  return new BatchChildError('CHILD_FAILED', 'Child call failed');
}
