import type { NativeRuntimeConnectRequest, TunnelRuntimeAdapter } from './tunnel-runtime-adapter.js';
import {
  TUNNEL_RUNTIME_ALIAS,
  classifyTunnelRuntimeFailure,
  runtimeErrorCode,
  type NativeTunnelRuntimeStatus,
  type TunnelFailureClass,
  type TunnelRuntimeCapabilities,
  type TunnelRuntimeSnapshot,
} from './tunnel-runtime-state.js';

export interface TunnelRuntimeDesiredState {
  readonly enabled: boolean;
  readonly tunnelId: string;
  readonly mcpServerUrl: string;
}

export interface TunnelRuntimeReconcilerAdapter {
  runtimeAlias(): string;
  capabilities(force?: boolean): Promise<TunnelRuntimeCapabilities>;
  status(): Promise<NativeTunnelRuntimeStatus>;
  connect(request: NativeRuntimeConnectRequest): Promise<NativeTunnelRuntimeStatus>;
  stop(): Promise<NativeTunnelRuntimeStatus>;
}

export interface TunnelRuntimeReconcilerOptions {
  readonly adapter: TunnelRuntimeReconcilerAdapter | TunnelRuntimeAdapter;
  readonly desiredState: () => TunnelRuntimeDesiredState | Promise<TunnelRuntimeDesiredState>;
  /** Manual Start may replace the dedicated lnwjud alias only after the prior runtime is confirmed stopped. */
  readonly allowStoppedTunnelIdReplacement?: boolean;
  readonly now?: () => Date;
}

export interface TunnelReconcileResult {
  readonly action: 'disabled' | 'healthy' | 'connected' | 'reconnected' | 'fallback-required' | 'auth-required' | 'operator-required' | 'retry-required';
  readonly snapshot: TunnelRuntimeSnapshot;
}

export class TunnelRuntimeReconciler {
  private reconnectCount = 0;
  private consecutiveFailures = 0;
  private lastConnectedAt: string | null = null;
  private lastReconnectAt: string | null = null;
  private lastSnapshot: TunnelRuntimeSnapshot | null = null;

  public constructor(private readonly options: TunnelRuntimeReconcilerOptions) {}

  public snapshot(): TunnelRuntimeSnapshot | null {
    return this.lastSnapshot;
  }

  public async reconcile(): Promise<TunnelReconcileResult> {
    const desired = normalizeDesired(await this.options.desiredState());
    const capabilities = await this.options.adapter.capabilities();
    if (!desired.enabled) {
      return this.publish(desired, capabilities, {
        action: 'disabled',
        state: 'stopped',
        healthy: null,
        ready: null,
        pollHealthy: null,
        failureClass: 'none',
        errorCode: null,
        message: 'Persistent tunnel runtime is disabled',
        uiUrl: null,
      });
    }
    if (!capabilities.managedConnect) {
      return this.publish(desired, capabilities, {
        action: 'fallback-required',
        state: 'starting',
        healthy: null,
        ready: null,
        pollHealthy: null,
        failureClass: 'none',
        errorCode: null,
        message: 'Native tunnel-client runtime supervision is unavailable; compatibility profile runtime is required',
        uiUrl: null,
      });
    }

    let current: NativeTunnelRuntimeStatus;
    try {
      current = await this.options.adapter.status();
    } catch (error: unknown) {
      return this.failure(desired, capabilities, error);
    }

    if (current.exists && current.tunnelId !== null && current.tunnelId !== desired.tunnelId) {
      const stoppedReplacementAllowed = this.options.allowStoppedTunnelIdReplacement === true && !current.running;
      if (!stoppedReplacementAllowed) {
        return this.publishFailure(desired, capabilities, 'operator', 'TUNNEL_ID_MISMATCH', 'Runtime alias is attached to a different tunnel ID; automatic replacement is refused. Press Start Tunnel to restart the persistent runtime with the saved configuration.', current);
      }
    }

    const bindingStale = current.mcpServerUrl !== null && !sameMcpUrl(current.mcpServerUrl, desired.mcpServerUrl);
    const healthy = runtimeAcceptable(current);
    if (current.exists && current.running && !bindingStale && healthy) {
      this.consecutiveFailures = 0;
      if (this.lastConnectedAt === null) this.lastConnectedAt = this.timestamp();
      return this.publish(desired, capabilities, {
        action: 'healthy',
        state: 'running',
        healthy: current.healthy,
        ready: current.ready,
        pollHealthy: current.pollHealthy,
        failureClass: 'none',
        errorCode: null,
        message: current.message,
        uiUrl: current.uiUrl,
      });
    }

    try {
      const connected = await this.options.adapter.connect({ tunnelId: desired.tunnelId, mcpServerUrl: desired.mcpServerUrl });
      if (connected.tunnelId !== null && connected.tunnelId !== desired.tunnelId) {
        return this.publishFailure(desired, capabilities, 'operator', 'TUNNEL_ID_MISMATCH', 'Managed runtime returned a different tunnel ID; automatic continuation is refused', connected);
      }
      if (!connected.running || connected.healthy === false || connected.ready === false || connected.pollHealthy === false) {
        const detail = connected.message ?? 'Managed tunnel runtime did not become fully ready';
        return this.publishFailure(desired, capabilities, 'transient', 'RUNTIME_NOT_READY', detail, connected);
      }
      const wasReconnect = current.exists || this.lastConnectedAt !== null;
      if (wasReconnect) this.reconnectCount += 1;
      this.consecutiveFailures = 0;
      this.lastConnectedAt = this.timestamp();
      if (wasReconnect) this.lastReconnectAt = this.lastConnectedAt;
      return this.publish(desired, capabilities, {
        action: wasReconnect ? 'reconnected' : 'connected',
        state: 'running',
        healthy: connected.healthy,
        ready: connected.ready,
        pollHealthy: connected.pollHealthy,
        failureClass: 'none',
        errorCode: null,
        message: bindingStale ? 'Rebound the same tunnel ID to the current Desktop MCP endpoint' : connected.message,
        uiUrl: connected.uiUrl,
      });
    } catch (error: unknown) {
      return this.failure(desired, capabilities, error);
    }
  }

  public async stop(): Promise<TunnelReconcileResult> {
    const desired = normalizeDesired(await this.options.desiredState());
    const capabilities = await this.options.adapter.capabilities();
    if (capabilities.managedConnect) {
      try {
        await this.options.adapter.stop();
      } catch (error: unknown) {
        return this.failure(desired, capabilities, error);
      }
    }
    this.consecutiveFailures = 0;
    return this.publish(desired, capabilities, {
      action: 'disabled',
      state: 'stopped',
      healthy: null,
      ready: null,
      pollHealthy: null,
      failureClass: 'none',
      errorCode: null,
      message: null,
      uiUrl: null,
    });
  }

  private failure(desired: TunnelRuntimeDesiredState, capabilities: TunnelRuntimeCapabilities, error: unknown): TunnelReconcileResult {
    const message = error instanceof Error ? error.message : String(error);
    const failureClass = classifyTunnelRuntimeFailure(message);
    const errorCode = runtimeErrorCode(message);
    return this.publishFailure(desired, capabilities, failureClass === 'none' ? 'transient' : failureClass, errorCode ?? 'TRANSIENT_RUNTIME_FAILURE', message, null);
  }

  private publishFailure(
    desired: TunnelRuntimeDesiredState,
    capabilities: TunnelRuntimeCapabilities,
    failureClass: Exclude<TunnelFailureClass, 'none'>,
    errorCode: string,
    message: string,
    runtime: NativeTunnelRuntimeStatus | null,
  ): TunnelReconcileResult {
    this.consecutiveFailures += 1;
    const action = failureClass === 'auth' ? 'auth-required' : failureClass === 'operator' ? 'operator-required' : 'retry-required';
    return this.publish(desired, capabilities, {
      action,
      state: failureClass === 'auth' ? 'auth-required' : failureClass === 'operator' ? 'error' : 'reconnecting',
      healthy: runtime?.healthy ?? null,
      ready: runtime?.ready ?? null,
      pollHealthy: runtime?.pollHealthy ?? null,
      failureClass,
      errorCode,
      message,
      uiUrl: runtime?.uiUrl ?? null,
    });
  }

  private publish(
    desired: TunnelRuntimeDesiredState,
    capabilities: TunnelRuntimeCapabilities,
    update: {
      readonly action: TunnelReconcileResult['action'];
      readonly state: TunnelRuntimeSnapshot['state'];
      readonly healthy: boolean | null;
      readonly ready: boolean | null;
      readonly pollHealthy: boolean | null;
      readonly failureClass: TunnelFailureClass;
      readonly errorCode: string | null;
      readonly message: string | null;
      readonly uiUrl: string | null;
    },
  ): TunnelReconcileResult {
    const snapshot: TunnelRuntimeSnapshot = {
      alias: this.options.adapter.runtimeAlias() || TUNNEL_RUNTIME_ALIAS,
      mode: 'native-managed',
      tunnelId: desired.tunnelId,
      mcpServerUrl: desired.mcpServerUrl,
      state: update.state,
      healthy: update.healthy,
      ready: update.ready,
      pollHealthy: update.pollHealthy,
      reconnectCount: this.reconnectCount,
      consecutiveFailures: this.consecutiveFailures,
      lastConnectedAt: this.lastConnectedAt,
      lastReconnectAt: this.lastReconnectAt,
      nextReconnectAt: null,
      lastFailureClass: update.failureClass,
      lastErrorCode: update.errorCode,
      message: update.message,
      uiUrl: update.uiUrl,
      capabilities,
    };
    this.lastSnapshot = snapshot;
    return { action: update.action, snapshot };
  }

  private timestamp(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}

function normalizeDesired(desired: TunnelRuntimeDesiredState): TunnelRuntimeDesiredState {
  const tunnelId = desired.tunnelId.trim();
  const mcpServerUrl = desired.mcpServerUrl.trim();
  if (!/^tunnel_[A-Za-z0-9_-]{8,128}$/.test(tunnelId)) throw new Error('Tunnel ID is invalid');
  if (mcpServerUrl.length === 0) throw new Error('Desktop MCP URL is required');
  return { enabled: desired.enabled, tunnelId, mcpServerUrl };
}

function runtimeAcceptable(status: NativeTunnelRuntimeStatus): boolean {
  return status.running && status.healthy !== false && status.ready !== false && status.pollHealthy !== false;
}

function sameMcpUrl(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.protocol === rightUrl.protocol
      && leftUrl.hostname.toLowerCase() === rightUrl.hostname.toLowerCase()
      && leftUrl.port === rightUrl.port
      && leftUrl.pathname.replace(/\/$/, '') === rightUrl.pathname.replace(/\/$/, '');
  } catch {
    return left.trim() === right.trim();
  }
}
