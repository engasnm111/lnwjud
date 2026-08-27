import { describe, expect, it } from 'vitest';
import type { McpConnectionStatus, TunnelStatus } from '@lnwjud/ipc-contracts';
import { buildPersistentTunnelDoctorChecks } from '../src/main/desktop-services.js';

function tunnel(overrides: Partial<TunnelStatus> = {}): TunnelStatus {
  return {
    state: 'running',
    source: 'desktop',
    hasApiKey: true,
    clientPath: 'C:\\tools\\tunnel-client.exe',
    profileExists: true,
    message: null,
    logPath: 'C:\\data\\tunnel.log',
    persistent: {
      enabled: true,
      tunnelIdMasked: 'tunnel_0123**************cdef',
      runtimeAlias: 'lnwjud',
      mode: 'native-managed',
      state: 'running',
      healthy: true,
      ready: true,
      pollHealthy: true,
      reconnectCount: 2,
      lastConnectedAt: '2026-08-25T12:00:00.000Z',
      lastReconnectAt: '2026-08-25T12:05:00.000Z',
      nextReconnectAt: null,
      lastErrorCode: null,
      clientVersion: '0.0.11+fixture',
      localMcpUrl: 'http://127.0.0.1:18765/mcp',
      uiUrl: 'http://127.0.0.1:9123/ui',
      readyBeforeRetire: false,
      strictZeroDowntime: false,
      capabilityEvidence: 'fixture',
    },
    ...overrides,
  };
}

const mcp: McpConnectionStatus = { running: true, url: 'http://127.0.0.1:18765/mcp', workspaceId: null };

describe('persistent tunnel doctor diagnostics', () => {
  it('emits the complete v4.11 doctor check set without exposing secrets', () => {
    const checks = buildPersistentTunnelDoctorChecks({
      tunnel: tunnel(),
      mcp,
      tunnelHealth: { state: 'live', message: 'configured tunnel health endpoint is live' },
      persistentEnabled: true,
    });

    expect(checks.map((check) => check.id)).toEqual([
      'persistent_tunnel_identity',
      'runtime_alias_state',
      'runtime_process_running',
      'tunnel_health',
      'tunnel_ready',
      'control_plane_poll_health',
      'local_mcp_binding',
      'local_mcp_reachable',
      'tunnel_id_matches_saved_identity',
      'runtime_key_available',
    ]);
    expect(checks.filter((check) => check.status === 'fail')).toHaveLength(0);
    const messages = checks.map((check) => check.message).join('\n');
    expect(messages).not.toContain('CONTROL_PLANE_API_KEY');
    expect(messages).not.toContain('secret-value');
  });

  it('accepts a live runtime alias observed read-only even when Desktop does not own the process', () => {
    const external = tunnel({
      source: 'external',
      persistent: {
        ...tunnel().persistent!,
        mode: 'external',
        runtimeAliasActive: true,
        ready: true,
        healthy: true,
        pollHealthy: null,
        localMcpUrl: 'http://127.0.0.1:18765/mcp',
      },
    });
    const checks = buildPersistentTunnelDoctorChecks({
      tunnel: external,
      mcp,
      tunnelHealth: { state: 'live', message: 'live' },
      persistentEnabled: true,
    });
    const byId = new Map(checks.map((check) => [check.id, check]));
    expect(byId.get('runtime_alias_state')?.status).toBe('pass');
    expect(byId.get('tunnel_ready')?.status).toBe('pass');
    expect(byId.get('local_mcp_binding')?.status).toBe('pass');
    expect(byId.get('control_plane_poll_health')?.status).toBe('warn');
  });

  it('distinguishes operator, local, runtime, control-plane, binding, and auth failures', () => {
    const broken = tunnel({
      state: 'error',
      hasApiKey: false,
      persistent: {
        ...tunnel().persistent!,
        state: 'error',
        healthy: false,
        ready: false,
        pollHealthy: false,
        localMcpUrl: 'http://127.0.0.1:19999/mcp',
        lastErrorCode: 'TUNNEL_ID_MISMATCH',
      },
    });
    const checks = buildPersistentTunnelDoctorChecks({
      tunnel: broken,
      mcp: { running: false, url: null, workspaceId: null },
      tunnelHealth: { state: 'unhealthy', message: 'health probe failed' },
      persistentEnabled: true,
    });
    const messages = checks.map((check) => check.message).join('\n');

    expect(messages).toContain('LOCAL_MCP_DOWN');
    expect(messages).toContain('TUNNEL_RUNTIME_DOWN');
    expect(messages).toContain('CONTROL_PLANE_OFFLINE');
    expect(messages).toContain('AUTH_REQUIRED');
    expect(messages).toContain('TUNNEL_ID_MISMATCH');
    expect(messages).toContain('LOCAL_BINDING_STALE');
    expect(checks.some((check) => check.required && check.status === 'fail')).toBe(true);
  });
});
