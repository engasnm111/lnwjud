import { describe, expect, it } from 'vitest';
import { DEFAULT_EXTENSIONS_SETTINGS } from './types.js';
import { LocalExtensionsService } from './extensions-service.js';
import type { McpClientFactory, McpClientSession } from './mcp-session-manager.js';

describe('LocalExtensionsService MCP bridge', () => {
  it('lists, describes, and calls child MCP tools through the session manager', async () => {
    const calls: string[] = [];
    const session: McpClientSession = {
      listTools: async () => [{ name: 'ping', description: 'Ping tool', inputSchema: { type: 'object' } }],
      callTool: async (name, args) => {
        calls.push(`${name}:${JSON.stringify(args)}`);
        return { content: [{ type: 'text', text: 'pong' }] };
      },
      close: async () => undefined,
    };
    const factory: McpClientFactory = {
      connect: async () => session,
    };
    const service = new LocalExtensionsService({
      settings: {
        ...DEFAULT_EXTENSIONS_SETTINGS,
        extraMcpServers: {
          mock: { command: 'node', args: ['mock-server.js'] },
        },
      },
      homeDir: process.cwd(),
      appDataDir: process.cwd(),
      clientFactory: factory,
    });

    const listed = await service.listMcpServers();
    expect(listed).toMatchObject({ ok: true, value: { servers: [expect.objectContaining({ name: 'mock', enabled: true })] } });

    const described = await service.describeMcpServer({ server: 'mock' });
    expect(described).toMatchObject({
      ok: true,
      value: {
        server: 'mock',
        tools: [{ name: 'ping', description: 'Ping tool' }],
      },
    });

    const called = await service.callMcpTool({ server: 'mock', tool: 'ping', arguments: { n: 1 } });
    expect(called.ok).toBe(true);
    expect(calls).toEqual(['ping:{"n":1}']);

    await service.close();
  });
});
