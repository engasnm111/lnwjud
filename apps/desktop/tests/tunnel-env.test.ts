import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildTunnelInitArgs, resolveTunnelProfileDirectory, tunnelClientEnv } from '../src/main/tunnel-controller.js';

describe('Secure Tunnel Desktop HTTP wiring', () => {
  it('passes only tunnel-client runtime state and does not leak headless lnwjud scope switches', () => {
    const env = tunnelClientEnv('key', 'C:/Users/me/AppData/Roaming/tunnel-client');
    expect(env.CONTROL_PLANE_API_KEY).toBe('key');
    expect(env.TUNNEL_CLIENT_PROFILE).toBe('lnwjud');
    expect(env.TUNNEL_CLIENT_PROFILE_DIR).toBe('C:/Users/me/AppData/Roaming/tunnel-client');
    expect(env.LNWJUD_DATA_PATH).toBeUndefined();
    expect(env.LNWJUD_UNRESTRICTED).toBeUndefined();
    expect(env.MCP_CONNECTION_MAX_TTL).toBe('168h0m0s');
  });

  it('materializes a replaceable no-auth HTTP profile with a secret reference, never a stdio child', () => {
    const args = buildTunnelInitArgs(
      'tunnel_0123456789abcdef0123456789abcdef',
      'http://127.0.0.1:18765/mcp',
      'C:/Users/me/AppData/Roaming/tunnel-client',
    );
    expect(args).toEqual(expect.arrayContaining([
      'init',
      '--force',
      'sample_mcp_remote_no_auth',
      '--control-plane-api-key-ref',
      'env:CONTROL_PLANE_API_KEY',
      '--health-listen-addr',
      '127.0.0.1:0',
      '--mcp-server-url',
      'http://127.0.0.1:18765/mcp',
    ]));
    expect(args).not.toContain('--mcp-command');
    expect(args.join(' ')).not.toContain('lnwjud-mcp-stdio');
  });

  it('uses XDG data on Linux and preserves POSIX environment boundaries', () => {
    const profile = resolveTunnelProfileDirectory({ XDG_DATA_HOME: '/tmp/xdg-data' }, '/home/alice', 'linux');
    expect(profile).toBe('/tmp/xdg-data/lnwjud/tunnel-client');
    const env = tunnelClientEnv('key', profile, 'linux');
    expect(env.HOME).toBe(process.env.HOME ?? os.homedir());
    expect(env.USERPROFILE).toBeUndefined();
    expect(env.APPDATA).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBe(process.env.XDG_CONFIG_HOME);
  });

  it('ignores a relative XDG data directory instead of placing secrets under cwd', () => {
    const profile = resolveTunnelProfileDirectory({ XDG_DATA_HOME: 'relative-data' }, '/home/alice', 'linux');
    expect(profile).toBe('/home/alice/.local/share/lnwjud/tunnel-client');
  });

  it('uses the macOS Application Support profile root', () => {
    expect(resolveTunnelProfileDirectory({}, '/Users/alice', 'darwin')).toBe('/Users/alice/Library/Application Support/lnwjud/tunnel-client');
  });

  it('ignores a relative Windows APPDATA override', () => {
    expect(resolveTunnelProfileDirectory({ APPDATA: 'relative-data' }, 'C:\\Users\\alice', 'win32')).toBe('C:\\Users\\alice\\AppData\\Roaming\\tunnel-client');
  });
});
