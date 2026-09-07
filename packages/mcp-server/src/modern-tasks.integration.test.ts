import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  Client,
  StreamableHTTPClientTransport,
  isJSONRPCResponse,
  type JSONRPCRequest,
  type JSONRPCResponse,
  type Transport,
} from '@modelcontextprotocol/client';
import { ok } from '@lnwjud/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMcpHttp, type McpHttpServerHandle } from './http.js';
import { MODERN_TASKS_EXTENSION_ID } from './modern-tasks-protocol.js';

const MODERN_PROTOCOL_VERSION = '2026-07-28';
const MODERN_TASK_ID = 'modern-http-shell-task';
const startedAt = '2026-09-07T05:00:00.000Z';
const deadlineAt = '2026-09-07T05:10:00.000Z';

type FakeTaskState = 'running' | 'cancelled';

function modernMeta(): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
    [CLIENT_INFO_META_KEY]: { name: 'lnwjud-modern-tasks-wire-test', version: '0.1.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {
      extensions: { [MODERN_TASKS_EXTENSION_ID]: {} },
    },
  };
}

async function sendRawRequest(transport: Transport, request: JSONRPCRequest): Promise<JSONRPCResponse> {
  const previous = transport.onmessage;
  return new Promise<JSONRPCResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      transport.onmessage = previous;
      reject(new Error(`Timed out waiting for raw MCP response ${String(request.id)}`));
    }, 10_000);
    const finish = (callback: () => void): void => {
      clearTimeout(timer);
      transport.onmessage = previous;
      callback();
    };

    transport.onmessage = (message, extra): void => {
      if (isJSONRPCResponse(message) && message.id === request.id) {
        finish(() => resolve(message));
        return;
      }
      previous?.(message, extra);
    };

    void transport.send(request).catch((error: unknown) => {
      finish(() => reject(error));
    });
  });
}

function resultRecord(response: JSONRPCResponse): Record<string, unknown> {
  if ('error' in response) throw new Error(`Unexpected JSON-RPC error ${response.error.code}: ${response.error.message}`);
  if (typeof response.result !== 'object' || response.result === null || Array.isArray(response.result)) {
    throw new Error('Expected object JSON-RPC result');
  }
  return response.result as Record<string, unknown>;
}

function rawRequest(id: string, method: string, params: Record<string, unknown>): JSONRPCRequest {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: { ...params, _meta: modernMeta() },
  };
}

describe('modern MCP Tasks extension over localhost HTTP', () => {
  let handle: McpHttpServerHandle;
  let taskState: FakeTaskState;

  beforeEach(async () => {
    taskState = 'running';
    const snapshot = (): Record<string, unknown> => ({
      task_id: MODERN_TASK_ID,
      state: taskState,
      started_at: startedAt,
      deadline_at: deadlineAt,
      durable: true,
      truncated: false,
      ...(taskState === 'cancelled' ? { finished_at: '2026-09-07T05:01:00.000Z' } : {}),
    });

    handle = await startMcpHttp({
      port: 0,
      services: {
        capabilities: {
          async execute(tool: string, request: { operation?: string; task_id?: string }) {
            if (tool !== 'shell') return { ok: false, error: { code: 'INVALID_INPUT', message: 'unsupported tool' } } as const;
            if (request.operation === 'run') {
              taskState = 'running';
              return ok(snapshot());
            }
            if (request.task_id !== MODERN_TASK_ID) {
              return { ok: false, error: { code: 'PROCESS_NOT_FOUND', message: 'Task was not found' } } as const;
            }
            if (request.operation === 'cancel') taskState = 'cancelled';
            return ok(snapshot());
          },
        },
      },
      actor: { clientId: 'modern-tasks-http-test', clientName: 'modern-tasks-http-test' },
    });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('advertises the extension and serves tools/call -> get -> update -> cancel without reviving legacy core tasks', async () => {
    const client = new Client(
      { name: 'lnwjud-modern-tasks-http-client', version: '0.1.0' },
      {
        versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } },
        capabilities: { extensions: { [MODERN_TASKS_EXTENSION_ID]: {} } },
      },
    );
    const transport = new StreamableHTTPClientTransport(handle.endpoint);

    try {
      await client.connect(transport);
      expect(client.getServerCapabilities()?.tasks).toBeUndefined();
      expect(client.getServerCapabilities()?.extensions?.[MODERN_TASKS_EXTENSION_ID]).toEqual({});

      const created = resultRecord(await sendRawRequest(transport, rawRequest('modern-create', 'tools/call', {
        name: 'shell',
        arguments: { operation: 'run', executable: 'fake-shell-command', arguments: [] },
      })));
      expect(created).toMatchObject({ resultType: 'task', status: 'working' });
      expect(created.taskId).toEqual(expect.stringMatching(/^lnwjud-task-v1\./));
      const taskId = String(created.taskId);

      const got = resultRecord(await sendRawRequest(transport, rawRequest('modern-get', 'tasks/get', { taskId })));
      expect(got).toMatchObject({ resultType: 'complete', taskId, status: 'working' });

      const updated = resultRecord(await sendRawRequest(transport, rawRequest('modern-update', 'tasks/update', {
        taskId,
        inputResponses: { futureField: { accepted: true } },
      })));
      expect(updated).toEqual({ resultType: 'complete' });

      const cancelled = resultRecord(await sendRawRequest(transport, rawRequest('modern-cancel', 'tasks/cancel', { taskId })));
      expect(cancelled).toEqual({ resultType: 'complete' });

      const afterCancel = resultRecord(await sendRawRequest(transport, rawRequest('modern-get-cancelled', 'tasks/get', { taskId })));
      expect(afterCancel).toMatchObject({ resultType: 'complete', taskId, status: 'cancelled' });
    } finally {
      await client.close();
    }
  }, 30_000);
});
