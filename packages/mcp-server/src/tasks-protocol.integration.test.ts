import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ok } from '@lnwjud/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startMcpHttp, type McpHttpServerHandle } from './http.js';

const completedTask = {
  task_id: 'task-done',
  state: 'completed',
  exit_code: 0,
  stdout: 'tasks wire ok',
  started_at: '2026-08-22T01:00:00.000Z',
  finished_at: '2026-08-22T01:05:00.000Z',
  deadline_at: '2026-08-23T01:00:00.000Z',
  durable: true,
  truncated: false,
};

const taskResultSchema = z.looseObject({
  taskId: z.string(),
  status: z.string(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
});

describe('MCP tasks protocol over localhost HTTP', () => {
  let handle: McpHttpServerHandle;

  beforeEach(async () => {
    handle = await startMcpHttp({
      port: 0,
      services: {
        capabilities: {
          async execute(tool: string, request: { operation?: string; task_id?: string }) {
            if (tool !== 'shell') return { ok: false, error: { code: 'INVALID_INPUT', message: 'unsupported tool' } } as const;
            if (request.operation === 'list') return ok({ tasks: [completedTask] });
            if (request.task_id === 'task-done') return ok(completedTask);
            return { ok: false, error: { code: 'PROCESS_NOT_FOUND', message: 'Task was not found' } } as const;
          },
        },
      },
      actor: { clientId: 'tasks-http-test', clientName: 'tasks-http-test' },
    });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('does not advertise the deprecated core tasks capability to current-protocol clients', async () => {
    const client = new Client(
      { name: 'lnwjud-modern-tasks-test-client', version: '0.1.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const transport = new StreamableHTTPClientTransport(handle.endpoint);

    try {
      await client.connect(transport);
      expect(client.getServerCapabilities()?.tasks).toBeUndefined();
      expect(() => client.request(
        { method: 'tasks/list', params: {} },
        z.looseObject({ tasks: z.array(taskResultSchema) }),
      )).toThrow(/not supported by the negotiated protocol version.*2026-07-28/i);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('advertises the tasks capability and serves the four task operations to a 2025-era client', async () => {
    const client = new Client(
      { name: 'lnwjud-tasks-test-client', version: '0.1.0' },
      { versionNegotiation: { mode: 'legacy' } },
    );
    const transport = new StreamableHTTPClientTransport(handle.endpoint);

    try {
      await client.connect(transport);
      expect(client.getServerCapabilities()?.tasks).toEqual({ list: {}, cancel: {} });

      const listed = await client.request({ method: 'tasks/list', params: {} }, z.looseObject({ tasks: z.array(taskResultSchema) }));
      expect(listed.tasks).toHaveLength(1);
      expect(listed.tasks[0]).toMatchObject({ taskId: 'task-done', status: 'completed', ttl: 86_400_000 });

      const got = await client.request({ method: 'tasks/get', params: { taskId: 'task-done' } }, taskResultSchema);
      expect(got).toMatchObject({ taskId: 'task-done', status: 'completed' });

      const payload = await client.request({ method: 'tasks/result', params: { taskId: 'task-done' } }, z.looseObject({
        content: z.array(z.looseObject({ type: z.string(), text: z.string() })),
        isError: z.boolean(),
        _meta: z.looseObject({}),
      }));
      expect(payload.isError).toBe(false);
      expect(JSON.parse(payload.content[0]!.text)).toMatchObject({ task_id: 'task-done', exit_code: 0 });
      expect(payload._meta?.['io.modelcontextprotocol/related-task']).toEqual({ taskId: 'task-done' });

      await expect(client.request({ method: 'tasks/cancel', params: { taskId: 'task-done' } }, taskResultSchema))
        .rejects.toMatchObject({ code: -32602 });
      await expect(client.request({ method: 'tasks/get', params: { taskId: 'missing' } }, taskResultSchema))
        .rejects.toMatchObject({ code: -32602 });
    } finally {
      await client.close();
    }
  }, 30_000);
});
