import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultMcpClientFactory } from './mcp-session-manager.js';

const fixturePath = fileURLToPath(new URL('../tests/fixtures/external-mcp-server.mjs', import.meta.url));

async function connectFixture(era: 'legacy' | 'modern' | 'schema-error'): ReturnType<typeof defaultMcpClientFactory.connect> {
  return defaultMcpClientFactory.connect({
    command: process.execPath,
    args: [fixturePath],
    env: { LNWJUD_EXTERNAL_MCP_FIXTURE_ERA: era },
  });
}

describe('default External MCP client protocol negotiation', () => {
  it('connects to a legacy 2025-era stdio MCP server and lists its tools', async () => {
    const session = await connectFixture('legacy');
    try {
      await expect(session.listTools()).resolves.toEqual([
        expect.objectContaining({ name: 'legacy_ping' }),
      ]);
    } finally {
      await session.close();
    }
  }, 20_000);

  it('connects to a modern 2026-07-28 stdio MCP server and lists its tools', async () => {
    const session = await connectFixture('modern');
    try {
      await expect(session.listTools()).resolves.toEqual([
        expect.objectContaining({ name: 'modern_ping' }),
      ]);
    } finally {
      await session.close();
    }
  }, 20_000);

  it('preserves isError tool results before success output-schema validation in the real SDK path', async () => {
    const session = await connectFixture('schema-error');
    try {
      await session.listTools();
      await expect(session.callTool('schema_error_demo', { mode: 'error-no-structured' })).resolves.toMatchObject({
        isError: true,
        content: [{ text: 'Demo validation failed: invalid input' }],
      });
      await expect(session.callTool('schema_error_demo', { mode: 'error-invalid-structured' })).resolves.toMatchObject({
        isError: true,
        structuredContent: { value: 42 },
      });
      await expect(session.callTool('schema_error_demo', { mode: 'success-valid' })).resolves.toMatchObject({
        structuredContent: { value: 'ok' },
      });
      await expect(session.callTool('schema_error_demo', { mode: 'success-invalid' })).rejects.toThrow(/structured content does not match.*output schema/i);
      await expect(session.callTool('schema_error_demo', { mode: 'success-missing' })).rejects.toThrow(/output schema.*structured content/i);
    } finally {
      await session.close();
    }
  }, 20_000);
});
