import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXTENSIONS_SETTINGS } from './types.js';
import { defaultApplicationDataDirectory, exclusionReason, McpConfigLoader } from './mcp-config-loader.js';
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
      workspaceRoot: 'E:\\project',
      settings: DEFAULT_EXTENSIONS_SETTINGS,
    });
    const servers = await loader.discover();
    expect(servers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'playwright',
        enabled: true,
        config: expect.objectContaining({
          args: expect.arrayContaining(['E:\\project']),
        }),
      }),
      expect.objectContaining({
        name: 'lnwjud',
        enabled: false,
        excluded: true,
      }),
    ]));
  });

  it.runIf(process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux')('discovers Claude Desktop MCP config from the current native host default location', async () => {
    const platform = process.platform as 'win32' | 'darwin' | 'linux';
    const home = await mkdtemp(path.join(os.tmpdir(), `lnwjud-mcp-${platform}-`));
    temporaryRoots.push(home);
    const appData = defaultApplicationDataDirectory(platform, home, {});
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    const configPath = pathApi.join(appData, 'Claude', 'claude_desktop_config.json');
    await mkdir(pathApi.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      mcpServers: { serena: { command: 'serena', args: ['start-mcp-server', '--context', 'chatgpt'] } },
    }), 'utf8');

    const loader = new McpConfigLoader({
      homeDir: home,
      platform,
      settings: DEFAULT_EXTENSIONS_SETTINGS,
      env: {},
    });
    await expect(loader.discover()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'serena', source: 'claude-desktop', enabled: true, excluded: false }),
    ]));
  });

  it('keeps application-data discovery paths platform-native and ignores relative environment overrides', () => {
    expect(defaultApplicationDataDirectory('win32', 'C:\\Users\\alice', { APPDATA: 'relative' }))
      .toBe('C:\\Users\\alice\\AppData\\Roaming');
    expect(defaultApplicationDataDirectory('win32', 'C:\\Users\\alice', { APPDATA: 'D:\\Roaming' }))
      .toBe('D:\\Roaming');
    expect(defaultApplicationDataDirectory('darwin', '/Users/alice', { XDG_CONFIG_HOME: '/ignored' }))
      .toBe('/Users/alice/Library/Application Support');
    expect(defaultApplicationDataDirectory('linux', '/home/alice', { XDG_CONFIG_HOME: 'relative' }))
      .toBe('/home/alice/.config');
    expect(defaultApplicationDataDirectory('linux', '/home/alice', { XDG_CONFIG_HOME: '/srv/config' }))
      .toBe('/srv/config');
  });

  it.runIf(process.platform === 'linux')('uses XDG_CONFIG_HOME for Claude Desktop discovery on Linux', async () => {
    const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-mcp-linux-xdg-'));
    temporaryRoots.push(rawRoot);
    const root = rawRoot.replaceAll('\\', '/');
    const xdg = path.posix.join(root, 'custom-config');
    const configPath = path.posix.join(xdg, 'Claude', 'claude_desktop_config.json');
    await mkdir(path.posix.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ mcpServers: { context7: { command: 'ctx7' } } }), 'utf8');

    const servers = await new McpConfigLoader({
      homeDir: root,
      platform: 'linux',
      settings: DEFAULT_EXTENSIONS_SETTINGS,
      env: { XDG_CONFIG_HOME: xdg },
    }).discover();
    expect(servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'context7', source: 'claude-desktop', enabled: true }),
    ]));
  });

  it('lets explicit lnwjud settings override the same server discovered from Cursor', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-mcp-override-'));
    temporaryRoots.push(home);
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await writeFile(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: { serena: { command: 'cursor-serena', args: ['old'] } },
    }), 'utf8');
    const settings = {
      ...DEFAULT_EXTENSIONS_SETTINGS,
      extraMcpServers: { serena: { command: 'settings-serena', args: ['new'], type: 'stdio' } },
    };
    const servers = await new McpConfigLoader({ homeDir: home, appDataDir: path.join(home, 'appdata'), settings }).discover();
    expect(servers.filter((server) => server.name === 'serena')).toEqual([
      expect.objectContaining({ source: 'lnwjud-settings', config: expect.objectContaining({ command: 'settings-serena', args: ['new'] }) }),
    ]);
  });

  it('canonicalizes surrounding MCP server-name whitespace before dedupe and allowlist evaluation', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-mcp-name-normalize-'));
    temporaryRoots.push(home);
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await writeFile(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: { ' serena ': { command: 'cursor-serena' } },
    }), 'utf8');
    const settings = {
      ...DEFAULT_EXTENSIONS_SETTINGS,
      disabledServers: ['serena'],
      extraMcpServers: { serena: { command: 'settings-serena' } },
    };
    const servers = await new McpConfigLoader({ homeDir: home, appDataDir: path.join(home, 'appdata'), settings }).discover();
    expect(servers.filter((server) => server.name === 'serena')).toEqual([
      expect.objectContaining({
        name: 'serena',
        source: 'lnwjud-settings',
        enabled: false,
        excluded: false,
        config: expect.objectContaining({ command: 'settings-serena' }),
      }),
    ]);
  });

  it('repairs legacy Serena boolean flags that were persisted without a value', () => {
    const settings = parseExtensionsSettings(JSON.stringify({
      extraMcpServers: {
        serena: {
          command: 'C:\\Users\\User\\.local\\bin\\serena.exe',
          args: [
            'start-mcp-server',
            '--context', 'chatgpt',
            '--open-web-dashboard', 'false',
            '--enable-gui-log-window',
            '--trace-lsp-communication', 'true',
          ],
        },
      },
    }));

    expect(settings.extraMcpServers.serena?.args).toEqual([
      'start-mcp-server',
      '--context', 'chatgpt',
      '--open-web-dashboard', 'false',
      '--enable-gui-log-window', 'false',
      '--trace-lsp-communication', 'true',
    ]);
  });

  it('does not rewrite similarly named flags for non-Serena MCP servers', () => {
    const settings = parseExtensionsSettings(JSON.stringify({
      extraMcpServers: {
        helper: {
          command: 'helper.exe',
          args: ['start-mcp-server', '--enable-gui-log-window'],
        },
      },
    }));

    expect(settings.extraMcpServers.helper?.args).toEqual(['start-mcp-server', '--enable-gui-log-window']);
  });

  it('honors disabledServers in enable_all mode', async () => {
    const settings = parseExtensionsSettings(JSON.stringify({
      mode: 'enable_all',
      disabledServers: ['playwright'],
    }));
    expect(settings.disabledServers).toEqual(['playwright']);
    expect(exclusionReason('helper', { command: 'node' })).toBeUndefined();
  });

  it('excludes names that cannot form an unambiguous external MCP namespace', () => {
    expect(exclusionReason('valid-server_1', { command: 'node' })).toBeUndefined();
    expect(exclusionReason('bad/server', { command: 'node' })).toContain('stable external namespace');
    expect(exclusionReason(' bad server ', { command: 'node' })).toContain('stable external namespace');
    expect(exclusionReason('', { command: 'node' })).toContain('stable external namespace');
  });
});
