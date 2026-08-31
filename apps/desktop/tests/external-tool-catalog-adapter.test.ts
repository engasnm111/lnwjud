import { describe, expect, it, vi } from 'vitest';
import type { ExtensionsService } from '@lnwjud/extensions';
import { projectExternalMcpTools } from '../src/main/tool-catalog/external-tool-catalog-adapter.js';

function fakeExtensions(overrides: Partial<ExtensionsService>): ExtensionsService {
  return {
    listSkills: vi.fn(),
    readSkill: vi.fn(),
    listMcpServers: vi.fn(),
    describeMcpServer: vi.fn(),
    listMcpResources: vi.fn(),
    callMcpTool: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as ExtensionsService;
}

describe('external Tool Catalog projection', () => {
  it('never connects or describes a disconnected external MCP during catalog reads', async () => {
    const describeMcpServer = vi.fn();
    const extensions = fakeExtensions({
      listMcpServers: vi.fn(async () => ({
        ok: true,
        value: {
          servers: [{
            name: 'offline-fixture',
            source: 'fixture',
            enabled: true,
            connected: false,
            excluded: false,
            command: 'missing-executable',
          }],
        },
      })) as ExtensionsService['listMcpServers'],
      describeMcpServer: describeMcpServer as ExtensionsService['describeMcpServer'],
    });

    const items = await projectExternalMcpTools(extensions, 'en');

    expect(describeMcpServer).not.toHaveBeenCalled();
    expect(items).toEqual([
      expect.objectContaining({
        name: '@offline-fixture',
        origin: 'external_mcp',
        declaredPermission: 'UNKNOWN',
        readiness: 'needs_setup',
        remediationIds: ['connect_external_mcp'],
      }),
    ]);
  });

  it('projects tools from an already-connected external MCP', async () => {
    const extensions = fakeExtensions({
      listMcpServers: vi.fn(async () => ({
        ok: true,
        value: {
          servers: [{
            name: 'connected-fixture',
            source: 'fixture',
            enabled: true,
            connected: true,
            excluded: false,
            command: 'fixture-server',
          }],
        },
      })) as ExtensionsService['listMcpServers'],
      describeMcpServer: vi.fn(async () => ({
        ok: true,
        value: {
          server: 'connected-fixture',
          enabled: true,
          connected: true,
          tools: [{ name: 'remote_read', description: 'Read remote data', inputSchema: { type: 'object' } }],
        },
      })) as ExtensionsService['describeMcpServer'],
    });

    const items = await projectExternalMcpTools(extensions, 'en');

    expect(items).toEqual([
      expect.objectContaining({
        name: 'remote_read',
        serverName: 'connected-fixture',
        readiness: 'unknown',
        declaredPermission: 'UNKNOWN',
      }),
    ]);
  });

  it('bounds connected external discovery so a hung server cannot block the catalog', async () => {
    const describeMcpServer = vi.fn((_input: unknown, signal?: AbortSignal) => new Promise((resolve) => {
      signal?.addEventListener('abort', () => resolve({
        ok: false,
        error: { code: 'PROCESS_TIMEOUT', message: 'cancelled', recoverable: true },
      }), { once: true });
    })) as ExtensionsService['describeMcpServer'];
    const extensions = fakeExtensions({
      listMcpServers: vi.fn(async () => ({
        ok: true,
        value: {
          servers: [{
            name: 'slow-fixture',
            source: 'fixture',
            enabled: true,
            connected: true,
            excluded: false,
            command: 'fixture-server',
          }],
        },
      })) as ExtensionsService['listMcpServers'],
      describeMcpServer,
    });

    const started = Date.now();
    const items = await projectExternalMcpTools(extensions, 'en', { describeTimeoutMs: 20 });

    expect(Date.now() - started).toBeLessThan(500);
    expect(items).toEqual([
      expect.objectContaining({ name: '@slow-fixture', readiness: 'unknown' }),
    ]);
    expect(describeMcpServer).toHaveBeenCalledTimes(1);
  });
});
