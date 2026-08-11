import { describe, expect, it } from 'vitest';
import type { McpHttpServerHandle, McpHttpServerOptions } from '@lnwjud/mcp-server';
import { DesktopMcpLifecycle, type McpHttpServerStarter } from '../src/main/mcp-lifecycle.js';

function createHandle(url: string, onClose: () => void): McpHttpServerHandle {
  const endpoint = new URL(url);
  return {
    address: { host: '127.0.0.1', port: Number(endpoint.port) },
    endpoint,
    close: async (): Promise<void> => { onClose(); },
  };
}

function createOptions(workspaceId: string): McpHttpServerOptions {
  return {
    port: 0,
    services: {},
    actor: { clientId: `desktop-${workspaceId}`, clientName: 'lnwjud desktop' },
  };
}

describe('DesktopMcpLifecycle', () => {
  it('starts one loopback server and exposes its live endpoint', async () => {
    let starts = 0;
    const starter: McpHttpServerStarter = {
      start: async (options) => {
        starts += 1;
        expect(options.port).toBe(0);
        return createHandle('http://127.0.0.1:43123/mcp', () => {});
      },
    };
    const lifecycle = new DesktopMcpLifecycle({
      starter,
      createServerOptions: createOptions,
      workspaceExists: async (workspaceId): Promise<boolean> => workspaceId === 'workspace-1',
    });

    await expect(lifecycle.start('workspace-1')).resolves.toEqual({
      running: true,
      url: 'http://127.0.0.1:43123/mcp',
      workspaceId: 'workspace-1',
    });
    expect(starts).toBe(1);
    expect(lifecycle.status()).toEqual({
      running: true,
      url: 'http://127.0.0.1:43123/mcp',
      workspaceId: 'workspace-1',
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
    const lifecycle = new DesktopMcpLifecycle({
      starter,
      createServerOptions: createOptions,
      workspaceExists: async (): Promise<boolean> => true,
    });

    const first = lifecycle.start('workspace-1');
    const second = lifecycle.start('workspace-1');
    resolveStart?.(createHandle('http://127.0.0.1:43124/mcp', () => {}));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { running: true, url: 'http://127.0.0.1:43124/mcp', workspaceId: 'workspace-1' },
      { running: true, url: 'http://127.0.0.1:43124/mcp', workspaceId: 'workspace-1' },
    ]);
    expect(starts).toBe(1);
  });

  it('closes the owned server and returns stopped status', async () => {
    let closes = 0;
    const starter: McpHttpServerStarter = {
      start: async (): Promise<McpHttpServerHandle> => createHandle('http://127.0.0.1:43125/mcp', () => { closes += 1; }),
    };
    const lifecycle = new DesktopMcpLifecycle({
      starter,
      createServerOptions: createOptions,
      workspaceExists: async (): Promise<boolean> => true,
    });

    await lifecycle.start('workspace-1');
    await expect(lifecycle.stop()).resolves.toEqual({ running: false, url: null, workspaceId: null });
    expect(closes).toBe(1);
    expect(lifecycle.status()).toEqual({ running: false, url: null, workspaceId: null });
  });

  it('leaves state stopped when workspace validation or server startup fails', async () => {
    let starts = 0;
    const lifecycle = new DesktopMcpLifecycle({
      starter: {
        start: async (): Promise<McpHttpServerHandle> => {
          starts += 1;
          throw new Error('EADDRINUSE');
        },
      },
      createServerOptions: createOptions,
      workspaceExists: async (workspaceId): Promise<boolean> => workspaceId === 'workspace-1',
    });

    await expect(lifecycle.start('missing')).rejects.toThrow('Workspace was not found');
    await expect(lifecycle.start('workspace-1')).rejects.toThrow('EADDRINUSE');
    expect(starts).toBe(1);
    expect(lifecycle.status()).toEqual({ running: false, url: null, workspaceId: null });
  });
});
