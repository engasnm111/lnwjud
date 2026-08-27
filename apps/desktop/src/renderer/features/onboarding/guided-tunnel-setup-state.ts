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
  return isTunnelConfigured(tunnel) && tunnel.state === 'running' && tunnel.source === 'desktop';
}

export function guidedTunnelPrerequisiteSignature(tunnel: TunnelStatus): string {
  const runtime = isTunnelRunning(tunnel)
    ? 'desktop-running'
    : tunnel.source === 'external' && tunnel.state === 'running'
      ? 'external-running'
      : 'not-running';
  return `${tunnel.hasApiKey ? 'key' : 'no-key'}:${tunnel.profileExists ? 'profile' : 'no-profile'}:${runtime}`;
}

export function guidedTunnelLaunchDecision(
  tunnel: TunnelStatus,
  state: GuidedTunnelSetupState,
): GuidedTunnelLaunchDecision {
  if (isTunnelRunning(tunnel)) return 'none';
  if (state === 'dismissed') return isFreshTunnelSetup(tunnel) ? 'none' : 'resume_settings';
  if (state === 'completed') return isFreshTunnelSetup(tunnel) ? 'show_tip' : isTunnelConfigured(tunnel) ? 'none' : 'resume_settings';
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
