import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { McpHttpServerHandle, McpHttpServerOptions } from '@lnwjud/mcp-server';
import { checkConfiguredMcpPort } from '../src/main/desktop-services.js';
import { DesktopMcpLifecycle, type McpHttpServerStarter } from '../src/main/mcp-lifecycle.js';

function createHandle(url: string, onClose: () => void): McpHttpServerHandle {
  const endpoint = new URL(url);
  return {
    address: { host: '127.0.0.1', port: Number(endpoint.port) },
    endpoint,
    close: async (): Promise<void> => { onClose(); },
  };
}

function createOptions(): McpHttpServerOptions {
  return {
    port: 0,
    services: {},
    actor: { clientId: 'desktop-global', clientName: 'lnwjud desktop' },
  };
}

describe('DesktopMcpLifecycle', () => {
  it('starts one application-global loopback server and exposes its live endpoint', async () => {
    let starts = 0;
    const starter: McpHttpServerStarter = {
      start: async (options) => {
        starts += 1;
        expect(options.port).toBe(0);
        return createHandle('http://127.0.0.1:43123/mcp', () => {});
      },
    };
    const lifecycle = new DesktopMcpLifecycle({ starter, createServerOptions: createOptions });

    await expect(lifecycle.start()).resolves.toEqual({
      running: true,
      url: 'http://127.0.0.1:43123/mcp',
      lastStartError: null,
      workspaceId: null,
    });
    expect(starts).toBe(1);
    expect(lifecycle.status()).toEqual({
      running: true,
      url: 'http://127.0.0.1:43123/mcp',
      lastStartError: null,
      workspaceId: null,
    });
  });

  it('coalesces duplicate starts while keeping one server handle', async () => {
    let starts = 0;
    let resolveStart: ((handle: McpHttpServerHandle) => void) | undefined;
    const pendingStart = new Promise<McpHttpServerHandle>((resolve) => { resolveStart = resolve; });
    const starter: McpHttpServerStarter = {
      start: async (): Promise<McpHttpServerHandle> => {
        starts += 1;
        return pendingStart;
      },
    };
    const lifecycle = new DesktopMcpLifecycle({ starter, createServerOptions: createOptions });

    const first = lifecycle.start();
    const second = lifecycle.start();
    resolveStart?.(createHandle('http://127.0.0.1:43124/mcp', () => {}));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { running: true, url: 'http://127.0.0.1:43124/mcp', lastStartError: null, workspaceId: null },
      { running: true, url: 'http://127.0.0.1:43124/mcp', lastStartError: null, workspaceId: null },
    ]);
    expect(starts).toBe(1);
  });

  it('closes the owned server and returns stopped status', async () => {
    let closes = 0;
    const starter: McpHttpServerStarter = {
      start: async (): Promise<McpHttpServerHandle> => createHandle('http://127.0.0.1:43125/mcp', () => { closes += 1; }),
    };
    const lifecycle = new DesktopMcpLifecycle({ starter, createServerOptions: createOptions });

    await lifecycle.start();
    await expect(lifecycle.stop()).resolves.toEqual({ running: false, url: null, lastStartError: null, workspaceId: null });
    expect(closes).toBe(1);
    expect(lifecycle.status()).toEqual({ running: false, url: null, lastStartError: null, workspaceId: null });
  });

  it('leaves state stopped when server startup fails and can retry', async () => {
    let starts = 0;
    const lifecycle = new DesktopMcpLifecycle({
      starter: {
        start: async (): Promise<McpHttpServerHandle> => {
          starts += 1;
          if (starts === 1) throw new Error('EADDRINUSE');
          return createHandle('http://127.0.0.1:43126/mcp', () => {});
        },
      },
      createServerOptions: createOptions,
    });

    await expect(lifecycle.start()).rejects.toThrow('EADDRINUSE');
    expect(lifecycle.status()).toEqual({ running: false, url: null, lastStartError: 'EADDRINUSE', workspaceId: null });
    await expect(lifecycle.start()).resolves.toMatchObject({ running: true, lastStartError: null, workspaceId: null });
    expect(starts).toBe(2);
  });

  it('Doctor accepts the live configured Desktop MCP listener and retains startup errors', async () => {
    await expect(checkConfiguredMcpPort(
      { running: true, url: 'http://127.0.0.1:18765/mcp', lastStartError: null, workspaceId: null },
      18765,
      async () => true,
    )).resolves.toMatchObject({ status: 'pass' });
    const failed = await checkConfiguredMcpPort({ running: false, url: null, lastStartError: 'EADDRINUSE', workspaceId: null }, 18765);
    expect(failed.status).toBe('fail');
    expect(failed.message).toContain('EADDRINUSE');
  });

  it('Doctor treats an identity-verified fallback port as usable but warns about the configured-port mismatch', async () => {
    const probed: string[] = [];
    const result = await checkConfiguredMcpPort(
      { running: true, url: 'http://127.0.0.1:43123/mcp', lastStartError: null, workspaceId: null },
      18765,
      async (endpoint) => {
        probed.push(endpoint.origin);
        return true;
      },
    );
    expect(result).toMatchObject({ status: 'warn' });
    expect(result.message).toContain('43123');
    expect(result.message).toContain('18765');
    expect(probed).toEqual(['http://127.0.0.1:43123']);
  });

  it('Doctor still fails a fallback listener when its lnwjud identity cannot be verified', async () => {
    const result = await checkConfiguredMcpPort(
      { running: true, url: 'http://127.0.0.1:43123/mcp', lastStartError: null, workspaceId: null },
      18765,
      async () => false,
    );
    expect(result).toMatchObject({ status: 'fail' });
    expect(result.message).toContain('identity');
  });

  it('Doctor rejects a reported running listener when the lnwjud identity probe does not match', async () => {
    const result = await checkConfiguredMcpPort(
      { running: true, url: 'http://127.0.0.1:18765/mcp', lastStartError: null, workspaceId: null },
      18765,
      async () => false,
    );
    expect(result).toMatchObject({ status: 'fail' });
    expect(result.message).toContain('identity');
  });

  it('Doctor reports when the configured MCP port is occupied by another listener', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ product: 'someone-else' }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
      const result = await checkConfiguredMcpPort({ running: false, url: null, lastStartError: null, workspaceId: null }, address.port);
      expect(result.status).toBe('fail');
      expect(result.message).toContain('not an lnwjud Desktop MCP');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
