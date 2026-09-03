import { describe, expect, it } from 'vitest';
import { buildTunnelInitArgs, tunnelClientEnv } from '../src/main/tunnel-controller.js';

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

  it('keeps the Windows profile environment contract isolated from XDG overrides', () => {
    const env = tunnelClientEnv(
      ' key ',
      'C:\\Users\\me\\AppData\\Roaming\\tunnel-client',
      'win32',
      {
        USERPROFILE: 'C:\\Users\\me',
        APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
        HOME: 'C:\\Users\\me',
        XDG_CONFIG_HOME: '/tmp/should-not-leak',
        LNWJUD_DATA_PATH: 'C:\\private',
        LNWJUD_UNRESTRICTED: '1',
      },
      'C:\\Users\\me',
    );
    expect(env.CONTROL_PLANE_API_KEY).toBe('key');
    expect(env.USERPROFILE).toBe('C:\\Users\\me');
    expect(env.APPDATA).toBe('C:\\Users\\me\\AppData\\Roaming');
    expect(env.HOME).toBe('C:\\Users\\me');
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.LNWJUD_DATA_PATH).toBeUndefined();
    expect(env.LNWJUD_UNRESTRICTED).toBeUndefined();
  });

  it.each(['linux', 'darwin'] as const)('keeps %s HOME/XDG state and removes Windows-only environment aliases', (platform) => {
    const env = tunnelClientEnv(
      ' key ',
      '/home/me/.config/tunnel-client',
      platform,
      {
        HOME: '/home/me',
        XDG_CONFIG_HOME: '/home/me/.config',
        XDG_STATE_HOME: '/home/me/.local/state',
        USERPROFILE: 'C:\\leak',
        APPDATA: 'C:\\leak\\AppData\\Roaming',
        LNWJUD_DATA_PATH: '/tmp/private',
        LNWJUD_UNRESTRICTED: '1',
      },
      '/home/me',
    );
    expect(env.CONTROL_PLANE_API_KEY).toBe('key');
    expect(env.HOME).toBe('/home/me');
    expect(env.XDG_CONFIG_HOME).toBe('/home/me/.config');
    expect(env.XDG_STATE_HOME).toBe('/home/me/.local/state');
    expect(env.USERPROFILE).toBeUndefined();
    expect(env.APPDATA).toBeUndefined();
    expect(env.LNWJUD_DATA_PATH).toBeUndefined();
    expect(env.LNWJUD_UNRESTRICTED).toBeUndefined();
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
});
