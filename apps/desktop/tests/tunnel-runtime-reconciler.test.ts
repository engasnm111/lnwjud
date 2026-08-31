import { describe, expect, it, vi } from 'vitest';
import { TunnelRuntimeReconciler, type TunnelRuntimeDesiredState, type TunnelRuntimeReconcilerAdapter } from '../src/main/tunnel-runtime-reconciler.js';
import type { NativeTunnelRuntimeStatus, TunnelRuntimeCapabilities } from '../src/main/tunnel-runtime-state.js';

const capabilities: TunnelRuntimeCapabilities = {
  clientVersion: '0.0.11+fixture',
  nativeRuntimes: true,
  managedConnect: true,
  healthProbe: true,
  pollHealthGate: true,
  readyBeforeRetire: false,
  strictZeroDowntime: false,
  evidence: 'fixture',
};

const desired = {
  enabled: true,
  tunnelId: 'tunnel_fixture012345',
  mcpServerUrl: 'http://127.0.0.1:18765/mcp',
};

function runtime(overrides: Partial<NativeTunnelRuntimeStatus> = {}): NativeTunnelRuntimeStatus {
  return {
    exists: true,
    running: true,
    healthy: true,
    ready: true,
    pollHealthy: true,
    tunnelId: desired.tunnelId,
    mcpServerUrl: desired.mcpServerUrl,
    pid: 1234,
    uiUrl: 'http://127.0.0.1:9123/ui',
    message: null,
    ...overrides,
  };
}

function adapter(status: NativeTunnelRuntimeStatus, connect = runtime()): TunnelRuntimeReconcilerAdapter {
  return {
    runtimeAlias: (): string => 'lnwjud',
    capabilities: vi.fn(async () => capabilities),
    status: vi.fn(async () => status),
    connect: vi.fn(async () => connect),
    stop: vi.fn(async () => runtime({ running: false, healthy: false, ready: false, pollHealthy: false })),
  };
}

describe('TunnelRuntimeReconciler', () => {
  it('does nothing when the same tunnel and local binding are already healthy', async () => {
    const runtimeAdapter = adapter(runtime());
    const reconciler = new TunnelRuntimeReconciler({ adapter: runtimeAdapter, desiredState: (): TunnelRuntimeDesiredState => desired });
    const result = await reconciler.reconcile();
    expect(result.action).toBe('healthy');
    expect(result.snapshot).toMatchObject({ state: 'running', reconnectCount: 0, consecutiveFailures: 0 });
    expect(runtimeAdapter.connect).not.toHaveBeenCalled();
  });

  it('creates a missing native alias using the same immutable tunnel ID', async () => {
    const runtimeAdapter = adapter(runtime({ exists: false, running: false, tunnelId: null, mcpServerUrl: null }));
    const reconciler = new TunnelRuntimeReconciler({
      adapter: runtimeAdapter,
      desiredState: (): TunnelRuntimeDesiredState => desired,
      now: (): Date => new Date('2026-08-25T12:00:00.000Z'),
    });
    const result = await reconciler.reconcile();
    expect(result.action).toBe('connected');
    expect(runtimeAdapter.connect).toHaveBeenCalledWith({ tunnelId: desired.tunnelId, mcpServerUrl: desired.mcpServerUrl });
    expect(result.snapshot.lastConnectedAt).toBe('2026-08-25T12:00:00.000Z');
  });

  it('rebinds the same tunnel when the Desktop MCP loopback port changes', async () => {
    const runtimeAdapter = adapter(runtime({ mcpServerUrl: 'http://127.0.0.1:19999/mcp' }));
    const reconciler = new TunnelRuntimeReconciler({ adapter: runtimeAdapter, desiredState: (): TunnelRuntimeDesiredState => desired });
    const result = await reconciler.reconcile();
    expect(result.action).toBe('reconnected');
    expect(runtimeAdapter.connect).toHaveBeenCalledWith({ tunnelId: desired.tunnelId, mcpServerUrl: desired.mcpServerUrl });
    expect(result.snapshot.tunnelId).toBe(desired.tunnelId);
    expect(result.snapshot.message).toContain('same tunnel ID');
  });

  it('refuses automatic replacement when an existing alias reports a different tunnel ID', async () => {
    const runtimeAdapter = adapter(runtime({ tunnelId: 'tunnel_other0123456' }));
    const reconciler = new TunnelRuntimeReconciler({ adapter: runtimeAdapter, desiredState: (): TunnelRuntimeDesiredState => desired });
    const result = await reconciler.reconcile();
    expect(result.action).toBe('operator-required');
    expect(result.snapshot).toMatchObject({ state: 'error', lastErrorCode: 'TUNNEL_ID_MISMATCH' });
    expect(result.snapshot.message).toContain('Press Start Tunnel');
    expect(runtimeAdapter.connect).not.toHaveBeenCalled();
  });

  it('allows manual replacement only after the previous alias is confirmed stopped', async () => {
    const stoppedOther = runtime({
      running: false,
      healthy: false,
      ready: false,
      pollHealthy: false,
      tunnelId: 'tunnel_other0123456',
    });
    const runtimeAdapter = adapter(stoppedOther, runtime());
    const reconciler = new TunnelRuntimeReconciler({
      adapter: runtimeAdapter,
      desiredState: (): TunnelRuntimeDesiredState => desired,
      allowStoppedTunnelIdReplacement: true,
    });
    const result = await reconciler.reconcile();
    expect(result.action).toBe('reconnected');
    expect(runtimeAdapter.connect).toHaveBeenCalledWith({ tunnelId: desired.tunnelId, mcpServerUrl: desired.mcpServerUrl });
    expect(result.snapshot).toMatchObject({ state: 'running', tunnelId: desired.tunnelId });
  });

  it('classifies revoked credentials as auth-required instead of a transient reconnect', async () => {
    const runtimeAdapter = adapter(runtime({ exists: false, running: false, tunnelId: null, mcpServerUrl: null }));
    vi.mocked(runtimeAdapter.connect).mockRejectedValue(new Error('control plane returned 401: API key revoked'));
    const reconciler = new TunnelRuntimeReconciler({ adapter: runtimeAdapter, desiredState: (): TunnelRuntimeDesiredState => desired });
    const result = await reconciler.reconcile();
    expect(result.action).toBe('auth-required');
    expect(result.snapshot).toMatchObject({ state: 'auth-required', lastFailureClass: 'auth', lastErrorCode: 'AUTH_REQUIRED', consecutiveFailures: 1 });
  });

  it('requires compatibility fallback if native runtimes are not supported', async () => {
    const runtimeAdapter = adapter(runtime());
    vi.mocked(runtimeAdapter.capabilities).mockResolvedValue({ ...capabilities, nativeRuntimes: false, managedConnect: false });
    const reconciler = new TunnelRuntimeReconciler({ adapter: runtimeAdapter, desiredState: (): TunnelRuntimeDesiredState => desired });
    const result = await reconciler.reconcile();
    expect(result.action).toBe('fallback-required');
    expect(runtimeAdapter.status).not.toHaveBeenCalled();
  });
});
