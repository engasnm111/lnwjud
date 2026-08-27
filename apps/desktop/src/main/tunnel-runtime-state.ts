export const TUNNEL_RUNTIME_ALIAS = 'lnwjud';

export type TunnelRuntimeMode = 'native-managed' | 'profile-child';
export type TunnelFailureClass = 'none' | 'transient' | 'auth' | 'operator';

export interface TunnelRuntimeCapabilities {
  readonly clientVersion: string | null;
  readonly nativeRuntimes: boolean;
  readonly managedConnect: boolean;
  readonly healthProbe: boolean;
  readonly pollHealthGate: boolean;
  /**
   * True only when the installed official client exposes a documented/testable
   * overlap handoff primitive. v4.11 never infers this merely from reconnect.
   */
  readonly readyBeforeRetire: boolean;
  /** Strict zero-downtime can only be claimed when overlap handoff is proven. */
  readonly strictZeroDowntime: boolean;
  readonly evidence: string;
}

export interface NativeTunnelRuntimeStatus {
  readonly exists: boolean;
  readonly running: boolean;
  readonly healthy: boolean | null;
  readonly ready: boolean | null;
  readonly pollHealthy: boolean | null;
  readonly tunnelId: string | null;
  readonly mcpServerUrl: string | null;
  readonly pid: number | null;
  readonly uiUrl: string | null;
  readonly message: string | null;
}

export interface TunnelRuntimeSnapshot {
  readonly alias: string;
  readonly mode: TunnelRuntimeMode;
  readonly tunnelId: string;
  readonly mcpServerUrl: string;
  readonly state: 'stopped' | 'starting' | 'running' | 'reconnecting' | 'error' | 'auth-required';
  readonly healthy: boolean | null;
  readonly ready: boolean | null;
  readonly pollHealthy: boolean | null;
  readonly reconnectCount: number;
  readonly consecutiveFailures: number;
  readonly lastConnectedAt: string | null;
  readonly lastReconnectAt: string | null;
  readonly nextReconnectAt: string | null;
  readonly lastFailureClass: TunnelFailureClass;
  readonly lastErrorCode: string | null;
  readonly message: string | null;
  readonly uiUrl: string | null;
  readonly capabilities: TunnelRuntimeCapabilities;
}

export function maskTunnelId(tunnelId: string | null | undefined): string | null {
  const value = tunnelId?.trim();
  if (value === undefined || value.length === 0) return null;
  if (value.length <= 15) return `${value.slice(0, Math.min(7, value.length))}…`;
  return `${value.slice(0, 10)}${'*'.repeat(Math.min(18, Math.max(6, value.length - 14)))}${value.slice(-4)}`;
}

export function classifyTunnelRuntimeFailure(message: string | null | undefined): TunnelFailureClass {
  const value = (message ?? '').toLowerCase();
  if (value.length === 0) return 'none';
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|api[ _-]?key.*(?:invalid|expired|revoked|missing)|(?:invalid|expired|revoked|missing).*api[ _-]?key|authentication required|auth required/.test(value)) {
    return 'auth';
  }
  if (/tunnel(?:_| )?id.*(?:invalid|mismatch|inaccessible|not found)|(?:invalid|mismatch|inaccessible).*tunnel|client.*not found|profile.*(?:invalid|incompatible|missing)|unsupported.*runtime|permission denied/.test(value)) {
    return 'operator';
  }
  return 'transient';
}

export function runtimeErrorCode(message: string | null | undefined): string | null {
  const failureClass = classifyTunnelRuntimeFailure(message);
  if (failureClass === 'none') return null;
  if (failureClass === 'auth') return 'AUTH_REQUIRED';
  if (failureClass === 'operator') {
    const value = (message ?? '').toLowerCase();
    if (value.includes('tunnel') && /invalid|mismatch|inaccessible|not found/.test(value)) return 'TUNNEL_ID_MISMATCH';
    if (value.includes('client') && value.includes('not found')) return 'TUNNEL_CLIENT_MISSING';
    if (value.includes('profile')) return 'PROFILE_REPAIR_REQUIRED';
    return 'OPERATOR_ACTION_REQUIRED';
  }
  return 'TRANSIENT_RUNTIME_FAILURE';
}
