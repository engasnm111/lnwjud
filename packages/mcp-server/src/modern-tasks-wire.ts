import {
  CLIENT_CAPABILITIES_META_KEY,
  MissingRequiredClientCapabilityError,
  ProtocolError,
  ProtocolErrorCode,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type McpServer,
} from '@modelcontextprotocol/server';
import type { FileActor } from '@lnwjud/application';
import { z } from 'zod';
import {
  MODERN_TASKS_EXTENSION_ID,
  ModernTasksProtocol,
} from './modern-tasks-protocol.js';
import type { McpApplicationServices } from './tool-registry.js';
import type { McpContent, McpToolResponse } from './result-mapper.js';

const MAX_TASK_ID_BYTES = 4096;
const requestMetaSchema = z.record(z.string(), z.unknown()).optional();
const taskIdParamsSchema = z.object({
  taskId: z.string().min(1).max(MAX_TASK_ID_BYTES),
  _meta: requestMetaSchema,
}).passthrough();
const updateParamsSchema = z.object({
  taskId: z.string().min(1).max(MAX_TASK_ID_BYTES),
  inputResponses: z.record(z.string(), z.unknown()),
  _meta: requestMetaSchema,
}).passthrough();

export interface ModernTasksRegistrationOptions {
  readonly actor: FileActor;
}

export function requestSupportsModernTasks(request: unknown): boolean {
  const root = asRecord(request);
  const params = asRecord(root?.params);
  const meta = asRecord(params?._meta);
  const clientCapabilities = asRecord(meta?.[CLIENT_CAPABILITIES_META_KEY]);
  const extensions = asRecord(clientCapabilities?.extensions);
  return asRecord(extensions?.[MODERN_TASKS_EXTENSION_ID]) !== undefined;
}

/**
 * Constructs the extension bridge for a modern server instance. The MCP SDK
 * recognises tasks/* as spec-owned method names, but the 2026 codec correctly
 * omits the removed core Tasks utility and therefore rejects those names
 * before a custom request handler can run. Modern lifecycle methods are thus
 * served at the raw transport boundary by maybeHandleModernTasksWireRequest.
 */
export function registerModernTasksProtocol(
  server: McpServer,
  services: McpApplicationServices,
  options: ModernTasksRegistrationOptions,
): ModernTasksProtocol {
  void server;
  return new ModernTasksProtocol(services, { actor: options.actor });
}

export async function maybeHandleModernTasksWireRequest(
  protocol: ModernTasksProtocol,
  request: JSONRPCMessage,
): Promise<JSONRPCMessage | undefined> {
  if (!isJSONRPCRequest(request)) return undefined;
  if (request.method !== 'tasks/get' && request.method !== 'tasks/update' && request.method !== 'tasks/cancel') return undefined;

  try {
    requireModernTasksClient(request.params);
    if (request.method === 'tasks/update') {
      const params = parseTaskParams(updateParamsSchema, request.params, request.method);
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: await protocol.updateTask({ taskId: params.taskId, inputResponses: params.inputResponses }),
      };
    }

    const params = parseTaskParams(taskIdParamsSchema, request.params, request.method);
    const result = request.method === 'tasks/get'
      ? await protocol.getTask({ taskId: params.taskId })
      : await protocol.cancelTask({ taskId: params.taskId });
    return { jsonrpc: '2.0', id: request.id, result };
  } catch (error: unknown) {
    return taskErrorResponse(request.id, error);
  }
}

/**
 * Rewrites a fully SDK-validated tools/call result into CreateTaskResult only
 * after the normal tool callback has completed. This avoids asking the SDK's
 * CallToolResult validator to accept an extension result it does not model.
 */
export async function maybeTransformModernTasksWireResponse(
  protocol: ModernTasksProtocol,
  request: JSONRPCMessage,
  response: JSONRPCMessage,
): Promise<JSONRPCMessage> {
  if (!isJSONRPCRequest(request) || request.method !== 'tools/call' || !requestSupportsModernTasks(request)) return response;
  if (!isJSONRPCResultResponse(response) || response.id !== request.id) return response;

  const params = asRecord(request.params);
  const toolName = boundedString(params?.name, 128);
  if (toolName === undefined) return response;
  const toolResponse = readToolResponse(response.result);
  if (toolResponse === undefined) return response;

  try {
    const task = await protocol.maybeCreateTask(toolName, params?.arguments, toolResponse);
    return task === undefined ? response : { ...response, result: task };
  } catch {
    // The already validated synchronous CallToolResult remains correct when a
    // backing handle cannot be re-resolved strongly enough to create a task.
    return response;
  }
}

function parseTaskParams<T>(schema: z.ZodType<T>, params: unknown, method: string): T {
  const parsed = schema.safeParse(asRecord(params) ?? {});
  if (parsed.success) return parsed.data;
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid params for ${method}: ${parsed.error.message}`);
}

function taskErrorResponse(id: string | number, error: unknown): JSONRPCMessage {
  const record = asRecord(error);
  const code = typeof record?.code === 'number' && Number.isSafeInteger(record.code)
    ? record.code
    : ProtocolErrorCode.InternalError;
  const message = error instanceof Error ? error.message : 'Internal error';
  const data = asRecord(record?.data);
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function requireModernTasksClient(params: unknown): void {
  if (requestSupportsModernTasks({ params })) return;
  throw new MissingRequiredClientCapabilityError({
    requiredCapabilities: { extensions: { [MODERN_TASKS_EXTENSION_ID]: {} } },
  }, 'Missing required client capability');
}

function readToolResponse(value: unknown): McpToolResponse | undefined {
  const record = asRecord(value);
  if (record === undefined || !Array.isArray(record.content)) return undefined;
  const content: McpContent[] = [];
  for (const item of record.content) {
    const parsed = readContent(item);
    if (parsed === undefined) return undefined;
    content.push(parsed);
  }
  const structuredContent = asRecord(record.structuredContent);
  return {
    content,
    ...(record.isError === true ? { isError: true } : {}),
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

function readContent(value: unknown): McpContent | undefined {
  const record = asRecord(value);
  if (record?.type === 'text' && typeof record.text === 'string') return { type: 'text', text: record.text };
  if (record?.type === 'image' && typeof record.data === 'string' && typeof record.mimeType === 'string') {
    return { type: 'image', data: record.data, mimeType: record.mimeType };
  }
  return undefined;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
