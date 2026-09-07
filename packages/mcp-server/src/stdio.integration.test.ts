import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  Client,
  isJSONRPCResponse,
  type JSONRPCRequest,
  type JSONRPCResponse,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MODERN_TASKS_EXTENSION_ID } from './modern-tasks-protocol.js';
import { ToolRegistry } from './tool-registry.js';

const MODERN_PROTOCOL_VERSION = '2026-07-28';
const expectedAdvertisedToolCount = new ToolRegistry({}, { clientId: 'count-test', clientName: 'count-test' }).list().length;
const fixturePath = fileURLToPath(new URL('../tests/fixtures/stdio-server.mjs', import.meta.url));

function modernMeta(): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
    [CLIENT_INFO_META_KEY]: { name: 'lnwjud-modern-stdio-wire-test', version: '0.1.0' },
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

function createClientAndTransport(): { readonly client: Client; readonly transport: StdioClientTransport; diagnostics(): string } {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixturePath],
    stderr: 'pipe',
  });
  let capturedDiagnostics = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    capturedDiagnostics += chunk.toString('utf8');
  });
  const client = new Client(
    { name: 'lnwjud-stdio-test-client', version: '0.1.0' },
    {
      versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } },
      capabilities: { extensions: { [MODERN_TASKS_EXTENSION_ID]: {} } },
    },
  );
  return { client, transport, diagnostics: () => capturedDiagnostics };
}

describe('MCP stdio transport', () => {
  it('serves independent 2026-07-28 requests with protocol-only stdout', async () => {
    const { client, transport, diagnostics } = createClientAndTransport();

    try {
      try {
        await client.connect(transport);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${detail}; child diagnostics: ${diagnostics().trim() || '[none]'}`, { cause: error });
      }
      const first = await client.listTools();
      const second = await client.listTools();

      expect(first.tools.map((tool) => tool.name)).toHaveLength(expectedAdvertisedToolCount);
      expect(first.tools.some((tool) => tool.name.startsWith('codex_'))).toBe(false);
      expect(second.tools.map((tool) => tool.name)).toEqual(first.tools.map((tool) => tool.name));
      expect(client.getServerCapabilities()?.tasks).toBeUndefined();
      expect(client.getServerCapabilities()?.extensions?.[MODERN_TASKS_EXTENSION_ID]).toEqual({});
      expect(diagnostics()).toContain('lnwjud-stdio-test-diagnostic');
    } finally {
      await client.close();
    }
  }, 30_000);

  it('serves the modern tasks extension lifecycle over the real stdio child process', async () => {
    const { client, transport, diagnostics } = createClientAndTransport();

    try {
      try {
        await client.connect(transport);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${detail}; child diagnostics: ${diagnostics().trim() || '[none]'}`, { cause: error });
      }

      const created = resultRecord(await sendRawRequest(transport, rawRequest('stdio-modern-create', 'tools/call', {
        name: 'shell',
        arguments: { operation: 'run', executable: 'fake-shell-command', arguments: [] },
      })));
      expect(created).toMatchObject({ resultType: 'task', status: 'working' });
      expect(created.taskId).toEqual(expect.stringMatching(/^lnwjud-task-v1\./));
      const taskId = String(created.taskId);

      const got = resultRecord(await sendRawRequest(transport, rawRequest('stdio-modern-get', 'tasks/get', { taskId })));
      expect(got).toMatchObject({ resultType: 'complete', taskId, status: 'working' });

      const updated = resultRecord(await sendRawRequest(transport, rawRequest('stdio-modern-update', 'tasks/update', {
        taskId,
        inputResponses: { futureField: { accepted: true } },
      })));
      expect(updated).toEqual({ resultType: 'complete' });

      const cancelled = resultRecord(await sendRawRequest(transport, rawRequest('stdio-modern-cancel', 'tasks/cancel', { taskId })));
      expect(cancelled).toEqual({ resultType: 'complete' });

      const afterCancel = resultRecord(await sendRawRequest(transport, rawRequest('stdio-modern-get-cancelled', 'tasks/get', { taskId })));
      expect(afterCancel).toMatchObject({ resultType: 'complete', taskId, status: 'cancelled' });
    } finally {
      await client.close();
    }
  }, 30_000);
});
