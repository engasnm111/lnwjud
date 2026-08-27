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
