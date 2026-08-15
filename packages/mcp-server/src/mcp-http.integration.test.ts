import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMcpHttp, type McpHttpServerHandle } from './http.js';

describe('MCP localhost HTTP transport', () => {
  let handle: McpHttpServerHandle;

  beforeEach(async () => {
    handle = await startMcpHttp({
      port: 0,
      services: {},
      actor: { clientId: 'http-test', clientName: 'http-test' },
    });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('binds the server to the loopback address and serves v2026-07-28 tools', async () => {
    expect(handle.address.host).toBe('127.0.0.1');
    expect(handle.address.port).toBeGreaterThan(0);
    expect(handle.endpoint.pathname).toBe('/mcp');

    const client = new Client(
      { name: 'lnwjud-http-test-client', version: '0.1.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const transport = new StreamableHTTPClientTransport(handle.endpoint);

    try {
      await client.connect(transport);
      const first = await client.listTools();
      const second = await client.listTools();

      expect(first.tools.map((tool) => tool.name)).toHaveLength(51);
      expect(second.tools.map((tool) => tool.name)).toEqual(first.tools.map((tool) => tool.name));
    } finally {
      await client.close();
    }
  });

  it('serves legacy 2025-11-25 clients for Codex compatibility', async () => {
    const client = new Client({ name: 'codex-compatible-http-test-client', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(handle.endpoint);

    try {
      await client.connect(transport);
      const tools = await client.listTools();

      expect(tools.tools.map((tool) => tool.name)).toHaveLength(51);
    } finally {
      await client.close();
    }
  });
});
