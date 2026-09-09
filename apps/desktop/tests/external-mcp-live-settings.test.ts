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
  it('connects a server saved after runtime startup without requiring an app restart', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-live-external-mcp-'));
    temporaryRoots.push(rawDataRoot);
    const runtime = createDesktopRuntime(await realpath(rawDataRoot));
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
