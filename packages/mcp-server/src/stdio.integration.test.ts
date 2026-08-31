import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './tool-registry.js';

const expectedAdvertisedToolCount = new ToolRegistry({}, { clientId: 'count-test', clientName: 'count-test' }).list().length;
const fixturePath = fileURLToPath(new URL('../tests/fixtures/stdio-server.mjs', import.meta.url));

describe('MCP stdio transport', () => {
  it('serves independent 2026-07-28 requests with protocol-only stdout', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fixturePath],
      stderr: 'pipe',
    });
    let diagnostics = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      diagnostics += chunk.toString('utf8');
    });
    const client = new Client(
      { name: 'lnwjud-stdio-test-client', version: '0.1.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );

    try {
      await client.connect(transport);
      const first = await client.listTools();
      const second = await client.listTools();

      expect(first.tools.map((tool) => tool.name)).toHaveLength(expectedAdvertisedToolCount);
      expect(first.tools.some((tool) => tool.name.startsWith('codex_'))).toBe(false);
      expect(second.tools.map((tool) => tool.name)).toEqual(first.tools.map((tool) => tool.name));
      expect(diagnostics).toContain('lnwjud-stdio-test-diagnostic');
    } finally {
      await client.close();
    }
  }, 30_000);
});
