import { describe, expect, it, vi } from 'vitest';
import { TunnelRuntimeSupervisor, TRANSIENT_BACKOFF_MS } from '../src/main/tunnel-runtime-supervisor.js';
import type { TunnelReconcileResult } from '../src/main/tunnel-runtime-reconciler.js';
import type { TunnelRuntimeSnapshot } from '../src/main/tunnel-runtime-state.js';

function snapshot(overrides: Partial<TunnelRuntimeSnapshot> = {}): TunnelRuntimeSnapshot {
  return {
    alias: 'lnwjud',
    mode: 'native-managed',
    tunnelId: 'tunnel_fixture012345',
    mcpServerUrl: 'http://127.0.0.1:18765/mcp',
    state: 'running',
    healthy: true,
    ready: true,
    pollHealthy: true,
    reconnectCount: 0,
    consecutiveFailures: 0,
    lastConnectedAt: '2026-08-25T12:00:00.000Z',
    lastReconnectAt: null,
    nextReconnectAt: null,
    lastFailureClass: 'none',
    lastErrorCode: null,
    message: null,
    uiUrl: null,
    capabilities: {
      clientVersion: 'fixture', nativeRuntimes: true, managedConnect: true, healthProbe: true,
      pollHealthGate: true, readyBeforeRetire: false, strictZeroDowntime: false, evidence: 'fixture',
    },
    ...overrides,
  };
}

function result(action: TunnelReconcileResult['action'], overrides: Partial<TunnelRuntimeSnapshot> = {}): TunnelReconcileResult {
  return { action, snapshot: snapshot(overrides) };
}

describe('TunnelRuntimeSupervisor', () => {
  it('keeps retrying transient failures at the capped interval instead of permanently giving up', async () => {
    vi.useFakeTimers();
    try {
      let failures = 0;
      let current = snapshot({ state: 'reconnecting' });
      const reconciler = {
        reconcile: vi.fn(async (): Promise<TunnelReconcileResult> => {
          failures += 1;
          current = snapshot({ state: 'reconnecting', consecutiveFailures: failures, lastFailureClass: 'transient' });
          return { action: 'retry-required', snapshot: current };
        }),
        stop: vi.fn(async () => result('disabled', { state: 'stopped' })),
        snapshot: vi.fn(() => current),
      };
      const supervisor = new TunnelRuntimeSupervisor({
        reconciler,
        enabled: (): boolean => true,
        jitter: (base: number): number => base,
      });

      await supervisor.start();
      for (let index = 0; index < TRANSIENT_BACKOFF_MS.length + 3; index += 1) {
        const expectedDelay = TRANSIENT_BACKOFF_MS[Math.min(index, TRANSIENT_BACKOFF_MS.length - 1)]!;
        await vi.advanceTimersByTimeAsync(expectedDelay);
      }

      expect(reconciler.reconcile).toHaveBeenCalledTimes(TRANSIENT_BACKOFF_MS.length + 4);
      expect(current.consecutiveFailures).toBe(TRANSIENT_BACKOFF_MS.length + 4);
      supervisor.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not tight-retry auth failures and resumes only when explicitly kicked after repair', async () => {
    vi.useFakeTimers();
    try {
      let repaired = false;
      let current = snapshot({ state: 'auth-required', consecutiveFailures: 1, lastFailureClass: 'auth', lastErrorCode: 'AUTH_REQUIRED' });
      const reconciler = {
        reconcile: vi.fn(async (): Promise<TunnelReconcileResult> => {
          if (!repaired) return { action: 'auth-required', snapshot: current };
          current = snapshot({ state: 'running', consecutiveFailures: 0, lastFailureClass: 'none', lastErrorCode: null });
          return { action: 'reconnected', snapshot: current };
        }),
        stop: vi.fn(async () => result('disabled', { state: 'stopped' })),
        snapshot: vi.fn(() => current),
      };
      const supervisor = new TunnelRuntimeSupervisor({ reconciler, enabled: (): boolean => true, jitter: (base: number): number => base });
      await supervisor.start();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(reconciler.reconcile).toHaveBeenCalledTimes(1);

      repaired = true;
      await supervisor.kick();
      expect(reconciler.reconcile).toHaveBeenCalledTimes(2);
      expect(supervisor.snapshot()).toMatchObject({ state: 'running' });
      supervisor.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose cancels Desktop monitoring without stopping the native managed runtime', async () => {
    vi.useFakeTimers();
    try {
      const current = snapshot();
      const reconciler = {
        reconcile: vi.fn(async () => result('healthy')),
        stop: vi.fn(async () => result('disabled', { state: 'stopped' })),
        snapshot: vi.fn(() => current),
      };
      const supervisor = new TunnelRuntimeSupervisor({ reconciler, enabled: (): boolean => true, healthyIntervalMs: 1000 });
      await supervisor.start();
      supervisor.dispose();
      await vi.advanceTimersByTimeAsync(5000);
      expect(reconciler.reconcile).toHaveBeenCalledTimes(1);
      expect(reconciler.stop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
