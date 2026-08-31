import { describe, expect, it, vi } from 'vitest';
import type { TunnelStatus } from '@lnwjud/ipc-contracts';
import { autoStartPersistentTunnel } from '../src/main/desktop-services.js';
import { TunnelRuntimeReconciler, type TunnelRuntimeDesiredState, type TunnelRuntimeReconcilerAdapter } from '../src/main/tunnel-runtime-reconciler.js';
import { TunnelRuntimeSupervisor, TRANSIENT_BACKOFF_MS } from '../src/main/tunnel-runtime-supervisor.js';
import type { NativeRuntimeConnectRequest } from '../src/main/tunnel-runtime-adapter.js';
import type { NativeTunnelRuntimeStatus, TunnelRuntimeCapabilities } from '../src/main/tunnel-runtime-state.js';

const TUNNEL_ID = 'tunnel_acceptance0123456789';
const MCP_A = 'http://127.0.0.1:18765/mcp';
const MCP_B = 'http://127.0.0.1:19876/mcp';

const CAPABILITIES: TunnelRuntimeCapabilities = {
  clientVersion: '0.0.11+acceptance',
  nativeRuntimes: true,
  managedConnect: true,
  healthProbe: true,
  pollHealthGate: true,
  readyBeforeRetire: false,
  strictZeroDowntime: false,
  evidence: 'acceptance fixture intentionally does not claim overlap handoff',
};

type Fault = 'none' | 'network' | 'auth';

class MutableRuntimeAdapter implements TunnelRuntimeReconcilerAdapter {
  public fault: Fault = 'none';
  public current: NativeTunnelRuntimeStatus;
  public readonly connectRequests: NativeRuntimeConnectRequest[] = [];
  public stopCount = 0;

  public constructor(initial: Partial<NativeTunnelRuntimeStatus> = {}) {
    this.current = runtime(initial);
  }

  public runtimeAlias(): string { return 'lnwjud'; }
  public async capabilities(): Promise<TunnelRuntimeCapabilities> { return CAPABILITIES; }
  public async status(): Promise<NativeTunnelRuntimeStatus> { return { ...this.current }; }

  public async connect(request: NativeRuntimeConnectRequest): Promise<NativeTunnelRuntimeStatus> {
    this.connectRequests.push({ ...request });
    if (this.fault === 'network') throw new Error('network unavailable while polling control plane');
    if (this.fault === 'auth') throw new Error('control plane returned 401: API key revoked');
    this.current = runtime({ tunnelId: request.tunnelId, mcpServerUrl: request.mcpServerUrl });
    return { ...this.current };
  }

  public async stop(): Promise<NativeTunnelRuntimeStatus> {
    this.stopCount += 1;
    this.current = runtime({ running: false, healthy: false, ready: false, pollHealthy: false });
    return { ...this.current };
  }
}

function runtime(overrides: Partial<NativeTunnelRuntimeStatus> = {}): NativeTunnelRuntimeStatus {
  return {
    exists: true,
    running: true,
    healthy: true,
    ready: true,
    pollHealthy: true,
    tunnelId: TUNNEL_ID,
    mcpServerUrl: MCP_A,
    pid: 4321,
    uiUrl: 'http://127.0.0.1:9123/ui',
    message: null,
    ...overrides,
  };
}

describe('v4.11 persistent tunnel continuity acceptance', () => {
  it('keeps one immutable tunnel identity through runtime death, Desktop restart, and local MCP port rebinding', async () => {
    const adapter = new MutableRuntimeAdapter();
    let desiredMcp = MCP_A;
    const desiredState = (): TunnelRuntimeDesiredState => ({ enabled: true, tunnelId: TUNNEL_ID, mcpServerUrl: desiredMcp });

    const firstDesktop = new TunnelRuntimeReconciler({ adapter, desiredState });
    await expect(firstDesktop.reconcile()).resolves.toMatchObject({ action: 'healthy', snapshot: { tunnelId: TUNNEL_ID, mcpServerUrl: MCP_A } });

    // A. tunnel-client/runtime process dies. Reconciliation must recreate the
    // same runtime alias/tunnel identity rather than provisioning a replacement.
    adapter.current = runtime({ exists: false, running: false, healthy: null, ready: null, pollHealthy: null, tunnelId: null, mcpServerUrl: null, pid: null, uiUrl: null });
    await expect(firstDesktop.reconcile()).resolves.toMatchObject({ action: 'reconnected', snapshot: { tunnelId: TUNNEL_ID, state: 'running' } });

    // B/F. Desktop comes back with a different ephemeral loopback MCP port while
    // the native runtime survived. A fresh reconciler represents the new Desktop
    // process and must only rebind the local endpoint.
    desiredMcp = MCP_B;
    const restartedDesktop = new TunnelRuntimeReconciler({ adapter, desiredState });
    await expect(restartedDesktop.reconcile()).resolves.toMatchObject({
      action: 'reconnected',
      snapshot: { tunnelId: TUNNEL_ID, mcpServerUrl: MCP_B, state: 'running' },
    });

    expect(adapter.current.tunnelId).toBe(TUNNEL_ID);
    expect(adapter.current.mcpServerUrl).toBe(MCP_B);
    expect(adapter.connectRequests.length).toBeGreaterThanOrEqual(2);
    expect(new Set(adapter.connectRequests.map((request) => request.tunnelId))).toEqual(new Set([TUNNEL_ID]));
  });

  it('continues bounded transient retries beyond five minutes and recovers the same tunnel after connectivity returns', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new MutableRuntimeAdapter({ exists: false, running: false, healthy: null, ready: null, pollHealthy: null, tunnelId: null, mcpServerUrl: null, pid: null, uiUrl: null });
      adapter.fault = 'network';
      const reconciler = new TunnelRuntimeReconciler({
        adapter,
        desiredState: (): TunnelRuntimeDesiredState => ({ enabled: true, tunnelId: TUNNEL_ID, mcpServerUrl: MCP_A }),
      });
      const supervisor = new TunnelRuntimeSupervisor({ reconciler, enabled: (): boolean => true, jitter: (base: number): number => base });

      await supervisor.start();
      let elapsed = 0;
      let index = 0;
      while (elapsed <= 5 * 60_000 + 60_000) {
        const delay = TRANSIENT_BACKOFF_MS[Math.min(index, TRANSIENT_BACKOFF_MS.length - 1)]!;
        elapsed += delay;
        index += 1;
        await vi.advanceTimersByTimeAsync(delay);
      }

      expect(adapter.connectRequests.length).toBeGreaterThan(8);
      expect(supervisor.snapshot()).toMatchObject({ state: 'reconnecting', lastFailureClass: 'transient' });
      expect(adapter.stopCount).toBe(0);

      adapter.fault = 'none';
      await vi.advanceTimersByTimeAsync(TRANSIENT_BACKOFF_MS.at(-1)!);
      expect(supervisor.snapshot()).toMatchObject({ state: 'running', tunnelId: TUNNEL_ID, lastFailureClass: 'none' });
      expect(adapter.current.tunnelId).toBe(TUNNEL_ID);
      supervisor.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not tight-retry a revoked key and reconnects the same identity only after explicit operator repair', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new MutableRuntimeAdapter({ exists: false, running: false, healthy: null, ready: null, pollHealthy: null, tunnelId: null, mcpServerUrl: null, pid: null, uiUrl: null });
      adapter.fault = 'auth';
      const reconciler = new TunnelRuntimeReconciler({
        adapter,
        desiredState: (): TunnelRuntimeDesiredState => ({ enabled: true, tunnelId: TUNNEL_ID, mcpServerUrl: MCP_A }),
      });
      const supervisor = new TunnelRuntimeSupervisor({ reconciler, enabled: (): boolean => true, jitter: (base: number): number => base });

      await supervisor.start();
      expect(supervisor.snapshot()).toMatchObject({ state: 'auth-required', lastErrorCode: 'AUTH_REQUIRED' });
      expect(adapter.connectRequests).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(adapter.connectRequests).toHaveLength(1);

      adapter.fault = 'none';
      await supervisor.kick();
      expect(supervisor.snapshot()).toMatchObject({ state: 'running', tunnelId: TUNNEL_ID });
      expect(adapter.connectRequests).toHaveLength(2);
      expect(adapter.connectRequests.every((request) => request.tunnelId === TUNNEL_ID)).toBe(true);
      supervisor.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed on a tunnel identity mismatch and never replaces the saved identity automatically', async () => {
    const adapter = new MutableRuntimeAdapter({ tunnelId: 'tunnel_different987654321' });
    const reconciler = new TunnelRuntimeReconciler({
      adapter,
      desiredState: (): TunnelRuntimeDesiredState => ({ enabled: true, tunnelId: TUNNEL_ID, mcpServerUrl: MCP_A }),
    });

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      action: 'operator-required',
      snapshot: { tunnelId: TUNNEL_ID, state: 'error', lastErrorCode: 'TUNNEL_ID_MISMATCH' },
    });
    expect(adapter.connectRequests).toHaveLength(0);
  });

  it('keeps a surviving tunnel untouched when startup prerequisites are temporarily unavailable during reinstall', async () => {
    const baseStatus: TunnelStatus = {
      state: 'running',
      source: 'external',
      hasApiKey: true,
      clientPath: 'C:\\Program Files\\lnwjud\\resources\\tunnel-client\\tunnel-client.exe',
      profileExists: true,
      message: null,
      logPath: 'C:\\Users\\fixture\\AppData\\Roaming\\tunnel-client\\lnwjud.log',
      persistent: null,
    };
    const prerequisiteGaps: TunnelStatus[] = [
      { ...baseStatus, hasApiKey: false },
      { ...baseStatus, profileExists: false },
      { ...baseStatus, clientPath: null },
    ];

    for (const status of prerequisiteGaps) {
      const startAutomatically = vi.fn(async (): Promise<TunnelStatus> => status);
      const controller = { status: vi.fn(async (): Promise<TunnelStatus> => status), startAutomatically };
      await expect(autoStartPersistentTunnel(controller, true)).resolves.toBe(status);
      expect(startAutomatically).not.toHaveBeenCalled();
    }
  });

  it('does not stop or replace an already-observed tunnel when persistent auto reconnect is disabled at startup', async () => {
    const status: TunnelStatus = {
      state: 'running',
      source: 'external',
      hasApiKey: true,
      clientPath: 'C:\\Program Files\\lnwjud\\resources\\tunnel-client\\tunnel-client.exe',
      profileExists: true,
      message: null,
      logPath: 'C:\\Users\\fixture\\AppData\\Roaming\\tunnel-client\\lnwjud.log',
      persistent: null,
    };
    const startAutomatically = vi.fn(async (): Promise<TunnelStatus> => status);
    const controller = { status: vi.fn(async (): Promise<TunnelStatus> => status), startAutomatically };

    await expect(autoStartPersistentTunnel(controller, false)).resolves.toBe(status);
    expect(startAutomatically).not.toHaveBeenCalled();
  });
});
