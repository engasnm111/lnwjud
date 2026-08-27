import type { TunnelReconcileResult, TunnelRuntimeReconciler } from './tunnel-runtime-reconciler.js';
import type { TunnelRuntimeSnapshot } from './tunnel-runtime-state.js';

const TRANSIENT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000] as const;
const HEALTHY_RECONCILE_MS = 30_000;

export interface TunnelRuntimeSupervisorOptions {
  readonly reconciler: Pick<TunnelRuntimeReconciler, 'reconcile' | 'stop' | 'snapshot'>;
  readonly enabled: () => boolean;
  readonly now?: () => Date;
  readonly jitter?: (baseMs: number) => number;
  readonly healthyIntervalMs?: number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly onUpdate?: (snapshot: TunnelRuntimeSnapshot) => void;
}

export class TunnelRuntimeSupervisor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private disposed = false;
  private reconcileInFlight: Promise<TunnelReconcileResult | null> | null = null;
  private nextReconnectAt: string | null = null;

  public constructor(private readonly options: TunnelRuntimeSupervisorOptions) {}

  public async start(): Promise<TunnelReconcileResult | null> {
    this.disposed = false;
    this.running = true;
    this.clearTimer();
    return this.runOnce();
  }

  /**
   * Retry immediately after explicit operator repair (new key, new client path,
   * explicit reconfiguration). This is the only path that wakes an auth/operator
   * failure without waiting for another user action.
   */
  public async kick(): Promise<TunnelReconcileResult | null> {
    if (this.disposed) return null;
    this.running = true;
    this.clearTimer();
    return this.runOnce();
  }

  public async stopRuntime(): Promise<TunnelReconcileResult | null> {
    this.running = false;
    this.clearTimer();
    this.nextReconnectAt = null;
    const result = await this.options.reconciler.stop();
    this.publish(result.snapshot);
    return result;
  }

  /** Cancel Desktop monitoring while intentionally leaving a native managed
   * runtime alive. Used on Desktop exit so the same alias/tunnel can survive the
   * short GUI restart window and be rebound on the next launch. */
  public dispose(): void {
    this.disposed = true;
    this.running = false;
    this.nextReconnectAt = null;
    this.clearTimer();
  }

  public snapshot(): TunnelRuntimeSnapshot | null {
    const snapshot = this.options.reconciler.snapshot();
    return snapshot === null ? null : { ...snapshot, nextReconnectAt: this.nextReconnectAt };
  }

  private runOnce(): Promise<TunnelReconcileResult | null> {
    if (!this.running || this.disposed || !this.options.enabled()) return Promise.resolve(null);
    if (this.reconcileInFlight !== null) return this.reconcileInFlight;
    const operation = this.options.reconciler.reconcile()
      .then((result) => {
        if (!this.running || this.disposed) return result;
        this.scheduleFrom(result);
        this.publish(result.snapshot);
        return result;
      })
      .finally(() => {
        if (this.reconcileInFlight === operation) this.reconcileInFlight = null;
      });
    this.reconcileInFlight = operation;
    return operation;
  }

  private scheduleFrom(result: TunnelReconcileResult): void {
    if (!this.running || this.disposed || !this.options.enabled()) return;
    switch (result.action) {
      case 'healthy':
      case 'connected':
      case 'reconnected':
        this.schedule(this.options.healthyIntervalMs ?? HEALTHY_RECONCILE_MS, false);
        return;
      case 'retry-required': {
        const failures = Math.max(1, result.snapshot.consecutiveFailures);
        const base = TRANSIENT_BACKOFF_MS[Math.min(failures - 1, TRANSIENT_BACKOFF_MS.length - 1)]!;
        const jittered = this.options.jitter?.(base) ?? defaultJitter(base);
        this.schedule(Math.max(250, Math.min(90_000, Math.round(jittered))), true);
        return;
      }
      case 'auth-required':
      case 'operator-required':
      case 'fallback-required':
      case 'disabled':
        // Fail quiet: these need an explicit repair/reconfigure/start action.
        this.nextReconnectAt = null;
        this.clearTimer();
        return;
    }
  }

  private schedule(delayMs: number, reconnect: boolean): void {
    this.clearTimer();
    const dueAt = new Date(this.nowMs() + delayMs).toISOString();
    this.nextReconnectAt = reconnect ? dueAt : null;
    const create = this.options.setTimeout ?? setTimeout;
    this.timer = create(() => {
      this.timer = null;
      this.nextReconnectAt = null;
      void this.runOnce();
    }, delayMs);
    this.timer.unref?.();
  }

  private publish(snapshot: TunnelRuntimeSnapshot): void {
    this.options.onUpdate?.({ ...snapshot, nextReconnectAt: this.nextReconnectAt });
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    (this.options.clearTimeout ?? clearTimeout)(this.timer);
    this.timer = null;
  }

  private nowMs(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }
}

function defaultJitter(baseMs: number): number {
  // ±10% prevents synchronized retries while keeping the cap bounded.
  return baseMs * (0.9 + Math.random() * 0.2);
}

export { HEALTHY_RECONCILE_MS, TRANSIENT_BACKOFF_MS };
