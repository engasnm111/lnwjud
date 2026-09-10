import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesktopRuntime } from '../src/main/desktop-services.js';

const fixturePath = fileURLToPath(new URL('../../../packages/extensions/tests/fixtures/external-mcp-server.mjs', import.meta.url));
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }));
});

describe('Desktop live External MCP settings', () => {
  it('explicit Tool Catalog recheck connects a live-saved external MCP while passive reads remain side-effect free', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-live-external-mcp-recheck-'));
    temporaryRoots.push(rawDataRoot);
    const runtime = createDesktopRuntime(await realpath(rawDataRoot), { checkpointEncryptionKey: Buffer.alloc(32, 7) });
    try {
      const current = runtime.getUserSettings();
      await runtime.services.setUserSettings({
        settings: {
          ...current,
          extensions: {
            ...current.extensions,
            extraMcpServers: [{
              name: 'live',
              command: process.execPath,
              args: [fixturePath],
              cwd: '',
              type: 'stdio',
              env: { LNWJUD_EXTERNAL_MCP_FIXTURE_ERA: 'modern' },
            }],
          },
        },
      });

      const passive = await runtime.services.getToolCatalog({ locale: 'en' });
      expect(passive.items).toContainEqual(expect.objectContaining({ name: '@live', origin: 'external_mcp', readiness: 'needs_setup' }));

      const rechecked = await runtime.services.recheckToolCatalog({ locale: 'en', requirementIds: ['external_mcp_connection'] });
      expect(rechecked.catalog.items).toContainEqual(expect.objectContaining({ name: 'modern_ping', serverName: 'live', origin: 'external_mcp', available: true }));
      expect(rechecked.doctor.checks).toContainEqual(expect.objectContaining({ id: 'external_mcp_connection', status: 'pass' }));
    } finally {
      await runtime.close();
    }
  });

  it('connects a server saved after runtime startup without requiring an app restart', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-live-external-mcp-'));
    temporaryRoots.push(rawDataRoot);
    const runtime = createDesktopRuntime(await realpath(rawDataRoot), { checkpointEncryptionKey: Buffer.alloc(32, 7) });
    try {
      const current = runtime.getUserSettings();
      const saved = await runtime.services.setUserSettings({
        settings: {
          ...current,
          extensions: {
            ...current.extensions,
            extraMcpServers: [{
              name: 'live',
              command: process.execPath,
              args: [fixturePath],
              cwd: '',
              type: 'stdio',
              env: { LNWJUD_EXTERNAL_MCP_FIXTURE_ERA: 'modern' },
            }],
          },
        },
      });
      expect(saved.restartRequired).toBe(false);

      const extensions = runtime.mcpServices.extensions;
      expect(extensions).toBeDefined();
      if (extensions === undefined) throw new Error('Desktop External MCP service is unavailable');
      await expect(extensions.describeMcpServer({ server: 'live' })).resolves.toMatchObject({
        ok: true,
        value: {
          connected: true,
          tools: [expect.objectContaining({ name: 'modern_ping' })],
        },
      });
    } finally {
      await runtime.close();
    }
  });
});
