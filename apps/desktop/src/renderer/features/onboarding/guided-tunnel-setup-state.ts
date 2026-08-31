import type { TunnelStatus } from '@lnwjud/ipc-contracts';

export type GuidedTunnelSetupState = 'not_started' | 'in_progress' | 'dismissed' | 'completed';
export type GuidedTunnelLaunchDecision = 'none' | 'show_tip' | 'resume_settings';
export type GuidedTunnelStep = 'create_tunnel' | 'save_key' | 'configure' | 'start' | 'connect_chatgpt';

export const GUIDED_TUNNEL_SETUP_STORAGE_KEY = 'lnwjud.guided-tunnel-setup.v1';

const guidedTunnelSetupStates = new Set<GuidedTunnelSetupState>([
  'not_started',
  'in_progress',
  'dismissed',
  'completed',
]);

export function isFreshTunnelSetup(tunnel: TunnelStatus): boolean {
  return !tunnel.hasApiKey && !tunnel.profileExists;
}

export function isTunnelConfigured(tunnel: TunnelStatus): boolean {
  return tunnel.hasApiKey && tunnel.profileExists;
}

export function isTunnelRunning(tunnel: TunnelStatus): boolean {
  // A managed persistent runtime intentionally survives Desktop restarts and
  // installer/update handoffs. During that detached window TunnelController may
  // report source=external even though this is the same configured lnwjud tunnel.
  // Runtime usability is therefore defined by the saved prerequisites + live
  // state, not by which process currently owns the child handle.
  return isTunnelConfigured(tunnel) && tunnel.state === 'running';
}

export function guidedTunnelPrerequisiteSignature(tunnel: TunnelStatus): string {
  const runtime = isTunnelRunning(tunnel) ? 'running' : 'not-running';
  return `${tunnel.hasApiKey ? 'key' : 'no-key'}:${tunnel.profileExists ? 'profile' : 'no-profile'}:${runtime}`;
}

export function guidedTunnelLaunchDecision(
  tunnel: TunnelStatus,
  state: GuidedTunnelSetupState,
): GuidedTunnelLaunchDecision {
  // Existing configured users must never be redirected back into onboarding on
  // update/reinstall/restart. The persistent runtime may still be reconciling for
  // a moment, but the saved Tunnel ID/profile + DPAPI key are already sufficient.
  if (isTunnelConfigured(tunnel)) return 'none';
  if (state === 'dismissed') return isFreshTunnelSetup(tunnel) ? 'none' : 'resume_settings';
  if (state === 'completed') return isFreshTunnelSetup(tunnel) ? 'show_tip' : 'resume_settings';
  if (state === 'in_progress') return 'resume_settings';
  return isFreshTunnelSetup(tunnel) ? 'show_tip' : 'resume_settings';
}

export function initialGuidedTunnelStep(tunnel: TunnelStatus): GuidedTunnelStep {
  if (!tunnel.profileExists) return 'create_tunnel';
  if (!tunnel.hasApiKey) return 'save_key';
  if (isTunnelRunning(tunnel)) return 'connect_chatgpt';
  return 'start';
}

export function readGuidedTunnelSetupState(storage: Pick<Storage, 'getItem'>): GuidedTunnelSetupState {
  try {
    const value = storage.getItem(GUIDED_TUNNEL_SETUP_STORAGE_KEY);
    return guidedTunnelSetupStates.has(value as GuidedTunnelSetupState)
      ? (value as GuidedTunnelSetupState)
      : 'not_started';
  } catch {
    return 'not_started';
  }
}

export function writeGuidedTunnelSetupState(
  storage: Pick<Storage, 'setItem'>,
  state: GuidedTunnelSetupState,
): void {
  storage.setItem(GUIDED_TUNNEL_SETUP_STORAGE_KEY, state);
}
