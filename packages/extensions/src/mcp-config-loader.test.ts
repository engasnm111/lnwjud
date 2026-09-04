import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXTENSIONS_SETTINGS } from './types.js';
import { exclusionReason, McpConfigLoader, resolveClaudeDesktopConfigPath } from './mcp-config-loader.js';
import { parseExtensionsSettings } from './allowlist.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('McpConfigLoader', () => {
  it('discovers Cursor MCP servers and substitutes workspaceFolder', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-mcp-cfg-'));
    temporaryRoots.push(home);
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await writeFile(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['-y', '@playwright/mcp', '--cwd', '${workspaceFolder}'],
        },
        lnwjud: {
          command: 'lnwjud.exe',
          args: ['--mcp-stdio'],
        },
      },
    }), 'utf8');

    const loader = new McpConfigLoader({
      homeDir: home,
      appDataDir: path.join(home, 'AppData', 'Roaming'),
      workspaceRoot: 'E:\\\\project',
      settings: DEFAULT_EXTENSIONS_SETTINGS,
    });
    const servers = await loader.discover();
    expect(servers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'playwright',
        enabled: true,
        config: expect.objectContaining({
          args: expect.arrayContaining(['E:\\\\project']),
        }),
      }),
      expect.objectContaining({
        name: 'lnwjud',
        enabled: false,
        excluded: true,
      }),
    ]));
  });

  it('honors disabledServers in enable_all mode', async () => {
    const settings = parseExtensionsSettings(JSON.stringify({
      mode: 'enable_all',
      disabledServers: ['playwright'],
    }));
    expect(settings.disabledServers).toEqual(['playwright']);
    expect(exclusionReason('helper', { command: 'node' })).toBeUndefined();
  });

  it('resolves platform-native Claude Desktop config locations', () => {
    expect(resolveClaudeDesktopConfigPath('win32', 'C:\\Users\\ohm', undefined, { APPDATA: 'C:\\Users\\ohm\\AppData\\Roaming' }))
      .toBe('C:\\Users\\ohm\\AppData\\Roaming\\Claude\\claude_desktop_config.json');
    expect(resolveClaudeDesktopConfigPath('darwin', '/Users/ohm', undefined, {}))
      .toBe('/Users/ohm/Library/Application Support/Claude/claude_desktop_config.json');
    expect(resolveClaudeDesktopConfigPath('linux', '/home/ohm', undefined, { XDG_CONFIG_HOME: '/srv/config' }))
      .toBe('/srv/config/Claude/claude_desktop_config.json');
  });
});
