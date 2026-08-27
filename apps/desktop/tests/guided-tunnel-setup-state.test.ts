import { describe, expect, it } from 'vitest';
import type { TunnelStatus } from '@lnwjud/ipc-contracts';
import {
  guidedTunnelLaunchDecision,
  guidedTunnelPrerequisiteSignature,
  initialGuidedTunnelStep,
  isFreshTunnelSetup,
  isTunnelConfigured,
  isTunnelRunning,
  readGuidedTunnelSetupState,
  writeGuidedTunnelSetupState,
} from '../src/renderer/features/onboarding/guided-tunnel-setup-state.js';

function pristineTunnel(overrides: Partial<TunnelStatus> = {}): TunnelStatus {
  return {
    state: 'stopped',
    source: 'desktop',
    hasApiKey: false,
    clientPath: null,
    profileExists: false,
    message: null,
    logPath: null,
    persistent: null,
    ...overrides,
  };
}

describe('guided tunnel setup state', () => {
  it('treats missing key and profile as pristine even when a stale persistent runtime identity remains', () => {
    expect(guidedTunnelLaunchDecision(pristineTunnel(), 'not_started')).toBe('show_tip');
    expect(
      guidedTunnelLaunchDecision(
        pristineTunnel({
          state: 'running',
          source: 'external',
          persistent: {
            enabled: true,
            tunnelIdMasked: 'tunnel_0123********cdef',
            runtimeAlias: 'lnwjud',
            mode: 'external',
            state: 'running',
            healthy: null,
            ready: null,
            pollHealthy: null,
            reconnectCount: 0,
            lastConnectedAt: null,
            lastReconnectAt: null,
            nextReconnectAt: null,
            lastErrorCode: null,
            clientVersion: null,
            localMcpUrl: null,
            uiUrl: null,
            readyBeforeRetire: false,
            strictZeroDowntime: false,
            capabilityEvidence: null,
          },
        }),
        'completed',
      ),
    ).toBe('show_tip');
  });

  it('resumes a stale completed setup at the first missing prerequisite', () => {
    expect(guidedTunnelLaunchDecision(pristineTunnel({ profileExists: true }), 'completed')).toBe('resume_settings');
    expect(guidedTunnelLaunchDecision(pristineTunnel({ hasApiKey: true }), 'completed')).toBe('resume_settings');
    expect(guidedTunnelLaunchDecision(pristineTunnel({ hasApiKey: true, profileExists: true }), 'completed')).toBe('none');
  });

  it('resumes an in-progress setup until a desktop-owned configured tunnel reaches running', () => {
    expect(guidedTunnelLaunchDecision(pristineTunnel(), 'in_progress')).toBe('resume_settings');
    expect(guidedTunnelLaunchDecision(pristineTunnel({ state: 'running', source: 'external' }), 'in_progress')).toBe('resume_settings');
    expect(guidedTunnelLaunchDecision(pristineTunnel({ state: 'running', source: 'desktop', hasApiKey: true, profileExists: true }), 'in_progress')).toBe('none');
  });

  it('respects Later only while the actual setup is still pristine, then resumes if prerequisites change', () => {
    expect(guidedTunnelLaunchDecision(pristineTunnel(), 'dismissed')).toBe('none');
    expect(guidedTunnelLaunchDecision(pristineTunnel({ hasApiKey: true }), 'dismissed')).toBe('resume_settings');
    expect(guidedTunnelLaunchDecision(pristineTunnel({ profileExists: true }), 'dismissed')).toBe('resume_settings');
  });

  it('derives fresh, configured, and running states from real prerequisites and ownership', () => {
    expect(isFreshTunnelSetup(pristineTunnel())).toBe(true);
    expect(isFreshTunnelSetup(pristineTunnel({ persistent: {
      enabled: true,
      tunnelIdMasked: 'tunnel_0123********cdef',
      runtimeAlias: 'lnwjud',
      mode: 'external',
      state: 'running',
      healthy: null,
      ready: null,
      pollHealthy: null,
      reconnectCount: 0,
      lastConnectedAt: null,
      lastReconnectAt: null,
      nextReconnectAt: null,
      lastErrorCode: null,
      clientVersion: null,
      localMcpUrl: null,
      uiUrl: null,
      readyBeforeRetire: false,
      strictZeroDowntime: false,
      capabilityEvidence: null,
    } }))).toBe(true);
    expect(isTunnelConfigured(pristineTunnel({ hasApiKey: true, profileExists: true }))).toBe(true);
    expect(isTunnelConfigured(pristineTunnel({ hasApiKey: true }))).toBe(false);
    expect(isTunnelRunning(pristineTunnel({ state: 'running', source: 'external', hasApiKey: true, profileExists: true }))).toBe(false);
    expect(isTunnelRunning(pristineTunnel({ state: 'running', source: 'desktop', hasApiKey: true, profileExists: true }))).toBe(true);
  });

  it('changes the launch signature only when real prerequisites or runtime ownership change', () => {
    expect(guidedTunnelPrerequisiteSignature(pristineTunnel())).toBe('no-key:no-profile:not-running');
    expect(guidedTunnelPrerequisiteSignature(pristineTunnel({ hasApiKey: true }))).toBe('key:no-profile:not-running');
    expect(guidedTunnelPrerequisiteSignature(pristineTunnel({ hasApiKey: true, profileExists: true, state: 'running', source: 'external' }))).toBe('key:profile:external-running');
    expect(guidedTunnelPrerequisiteSignature(pristineTunnel({ hasApiKey: true, profileExists: true, state: 'running', source: 'desktop' }))).toBe('key:profile:desktop-running');
  });

  it('resumes at the first step required by the actual tunnel state', () => {
    expect(initialGuidedTunnelStep(pristineTunnel())).toBe('create_tunnel');
    expect(initialGuidedTunnelStep(pristineTunnel({ hasApiKey: true }))).toBe('create_tunnel');
    expect(initialGuidedTunnelStep(pristineTunnel({ profileExists: true }))).toBe('save_key');
    expect(initialGuidedTunnelStep(pristineTunnel({ hasApiKey: true, profileExists: true }))).toBe('start');
    expect(initialGuidedTunnelStep(pristineTunnel({ hasApiKey: true, profileExists: true, state: 'running', source: 'external' }))).toBe('start');
    expect(initialGuidedTunnelStep(pristineTunnel({ hasApiKey: true, profileExists: true, state: 'running', source: 'desktop' }))).toBe('connect_chatgpt');
  });

  it('stores only the finite onboarding state and tolerates corrupt values', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        values.set(key, value);
      },
    };

    writeGuidedTunnelSetupState(storage, 'in_progress');
    expect(readGuidedTunnelSetupState(storage)).toBe('in_progress');
    expect([...values.values()]).toEqual(['in_progress']);

    values.set('lnwjud.guided-tunnel-setup.v1', 'corrupt');
    expect(readGuidedTunnelSetupState(storage)).toBe('not_started');
  });
});
