import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractTunnelId,
  extractTunnelMcpServerUrl,
  normalizeLoopbackMcpUrl,
  packagedStdioLauncherCandidates,
  preferredTunnelMcpCommand,
  resolveStdioLauncherPath,
  rewriteTunnelYamlMcpCommand,
  rewriteTunnelYamlMcpServerUrl,
  rewriteTunnelYamlRuntimeApiKeyRef,
} from '../src/main/tunnel-profile.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('tunnel profile MCP target', () => {
  it('rewrites a legacy stdio MCP block to the Desktop loopback HTTP MCP', () => {
    const yaml = [
      'config_version: 1',
      'health:',
      '  listen_addr: "127.0.0.1:8080"',
      'mcp:',
      '  commands:',
      '    - channel: main',
      '      command: "D:/lnwjud/lnwjud-mcp-stdio.cmd"',
      '',
    ].join('\n');
    const next = rewriteTunnelYamlMcpServerUrl(yaml, 'http://127.0.0.1:3001/mcp');
    expect(next).toContain('server_urls:');
    expect(next).toContain('connection_max_ttl: 168h0m0s');
    expect(next).toContain('url: "http://127.0.0.1:3001/mcp"');
    expect(next).not.toContain('commands:');
    expect(next).not.toContain('lnwjud-mcp-stdio.cmd');
  });

  it('repairs an existing HTTP profile when the Desktop MCP port changes', () => {
    const yaml = [
      'config_version: 1',
      'mcp:',
      '  server_urls:',
      '    - channel: main',
      '      url: "http://127.0.0.1:3001/mcp"',
      '',
    ].join('\n');
    const next = rewriteTunnelYamlMcpServerUrl(yaml, 'http://127.0.0.1:48888/mcp');
    expect(next).toContain('url: "http://127.0.0.1:48888/mcp"');
    expect(next).not.toContain('3001');
    expect(extractTunnelMcpServerUrl(next)).toBe('http://127.0.0.1:48888/mcp');
  });

  it('preserves top-level tunnel settings that follow the MCP block', () => {
    const yaml = [
      'config_version: 1',
      'mcp:',
      '  commands:',
      '    - channel: main',
      '      command: "legacy.cmd"',
      'log:',
      '  level: debug',
      'admin_ui:',
      '  open_browser: false',
      '',
    ].join('\n');
    const next = rewriteTunnelYamlMcpServerUrl(yaml, 'http://127.0.0.1:18765/mcp');
    expect(next).toContain('log:\n  level: debug');
    expect(next).toContain('admin_ui:\n  open_browser: false');
  });

  it('replaces a literal runtime API key with the environment secret reference without touching other sections', () => {
    const yaml = [
      'config_version: 1',
      'control_plane:',
      '  base_url: "https://api.openai.com"',
      '  tunnel_id: "tunnel_0123456789abcdef0123456789abcdef"',
      '  api_key: "sk-plaintext-must-not-remain"',
      'health:',
      '  listen_addr: "127.0.0.1:0"',
      '',
    ].join('\n');
    const next = rewriteTunnelYamlRuntimeApiKeyRef(yaml);
    expect(next).toContain('api_key: "env:CONTROL_PLANE_API_KEY"');
    expect(next).not.toContain('sk-plaintext-must-not-remain');
    expect(next).toContain('health:\n  listen_addr: "127.0.0.1:0"');
    expect(extractTunnelId(next)).toBe('tunnel_0123456789abcdef0123456789abcdef');
  });

  it('adds the runtime API key reference when an older control-plane block omitted it', () => {
    const yaml = [
      'control_plane:',
      '  base_url: "https://api.openai.com"',
      '  tunnel_id: "tunnel_0123456789abcdef0123456789abcdef"',
      'mcp:',
      '  server_urls:',
      '    - channel: main',
      '      url: "http://127.0.0.1:18765/mcp"',
      '',
    ].join('\n');
    const next = rewriteTunnelYamlRuntimeApiKeyRef(yaml);
    expect(next).toContain('api_key: "env:CONTROL_PLANE_API_KEY"');
    expect(next.indexOf('api_key:')).toBeLessThan(next.indexOf('mcp:'));
  });

  it('reads and repairs tunnel-client JSON profiles even when the file extension is .yaml', () => {
    const profile = JSON.stringify({
      config_version: 1,
      control_plane: {
        base_url: 'https://api.openai.com',
        tunnel_id: 'tunnel_0123456789abcdef0123456789abcdef',
        api_key: 'literal-must-not-remain',
      },
      mcp: {
        server_urls: [
          { channel: 'backup', url: 'http://127.0.0.1:19999/mcp' },
          { channel: 'main', url: 'http://127.0.0.1:3001/mcp' },
        ],
      },
      log: { level: 'info' },
    }, null, 2) + '\n';

    const withMcp = rewriteTunnelYamlMcpServerUrl(profile, 'http://127.0.0.1:18765/mcp');
    const next = rewriteTunnelYamlRuntimeApiKeyRef(withMcp);
    const parsed = JSON.parse(next) as {
      control_plane: { tunnel_id: string; api_key: string };
      mcp: { connection_max_ttl: string; server_urls: Array<{ channel: string; url: string }> };
      log: { level: string };
    };

    expect(extractTunnelId(next)).toBe('tunnel_0123456789abcdef0123456789abcdef');
    expect(extractTunnelMcpServerUrl(next)).toBe('http://127.0.0.1:18765/mcp');
    expect(parsed.control_plane.api_key).toBe('env:CONTROL_PLANE_API_KEY');
    expect(parsed.mcp.connection_max_ttl).toBe('168h0m0s');
    expect(parsed.mcp.server_urls.find((entry) => entry.channel === 'main')?.url).toBe('http://127.0.0.1:18765/mcp');
    expect(parsed.mcp.server_urls.find((entry) => entry.channel === 'backup')?.url).toBe('http://127.0.0.1:19999/mcp');
    expect(parsed.log.level).toBe('info');
  });

  it('normalizes only loopback HTTP MCP endpoints', () => {
    expect(normalizeLoopbackMcpUrl('http://localhost:3001/anything?x=1#fragment')).toBe('http://localhost:3001/mcp');
    expect(() => normalizeLoopbackMcpUrl('https://127.0.0.1:3001/mcp')).toThrow(/loopback HTTP/i);
    expect(() => normalizeLoopbackMcpUrl('http://192.168.1.50:3001/mcp')).toThrow(/loopback-only/i);
  });

  it('rewrites a local stdio MCP command to the supplied launcher', () => {
    const yaml = [
      'mcp:',
      '  commands:',
      '    - channel: main',
      '      command: "C:/Users/me/AppData/Local/Programs/lnwjud/lnwjud-mcp-stdio.cmd"',
    ].join('\n');
    const next = rewriteTunnelYamlMcpCommand(
      yaml,
      'C:\\Users\\me\\AppData\\Local\\Programs\\lnwjud\\lnwjud-mcp-stdio.cmd',
    );
    expect(next).toContain('command: "C:/Users/me/AppData/Local/Programs/lnwjud/lnwjud-mcp-stdio.cmd"');
  });

  it('keeps lnwjud.exe --mcp-stdio as a local stdio MCP command', () => {
    const yaml = '      command: "C:/old/lnwjud-mcp-stdio.cmd --workspace E:/lnwjud"';
    expect(rewriteTunnelYamlMcpCommand(yaml, 'D:/lnwjud/lnwjud.exe --mcp-stdio')).toContain(
      'command: "D:/lnwjud/lnwjud.exe --mcp-stdio"',
    );
  });

  it('replaces a stale node command for direct local stdio use', () => {
    const yaml = '      command: "node"';
    expect(rewriteTunnelYamlMcpCommand(yaml, 'D:/lnwjud/lnwjud-mcp-stdio.cmd')).toContain(
      'command: "D:/lnwjud/lnwjud-mcp-stdio.cmd"',
    );
  });

  it('falls back to the cmd launcher when the local host is not lnwjud.exe', () => {
    expect(preferredTunnelMcpCommand('C:\\Program Files\\nodejs\\node.exe', 'D:\\lnwjud\\lnwjud-mcp-stdio.cmd')).toBe(
      'D:\\lnwjud\\lnwjud-mcp-stdio.cmd',
    );
  });

  it('prefers the packaged cmd launcher for direct local stdio when the host is a GUI lnwjud.exe', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-exe-'));
    temporaryRoots.push(root);
    const exePath = path.join(root, 'lnwjud.exe');
    await writeFile(exePath, 'stub', 'utf8');
    const cmdPath = path.join(root, 'lnwjud-mcp-stdio.cmd');
    await writeFile(cmdPath, '@echo off\n', 'utf8');
    expect(preferredTunnelMcpCommand(exePath, cmdPath)).toBe(await realpath(cmdPath));
  });

  it('resolves the first existing packaged cmd candidate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stdio-'));
    temporaryRoots.push(root);
    const resources = path.join(root, 'resources');
    await mkdir(resources);
    const cmdPath = path.join(root, 'lnwjud-mcp-stdio.cmd');
    await writeFile(cmdPath, '@echo off\n', 'utf8');
    expect(resolveStdioLauncherPath(packagedStdioLauncherCandidates(path.join(root, 'lnwjud.exe'), resources))).toBe(
      path.resolve(cmdPath),
    );
  });
});
