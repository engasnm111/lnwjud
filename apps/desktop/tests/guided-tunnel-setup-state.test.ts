import { describe, expect, it } from 'vitest';
import type { TunnelStatus } from '@lnwjud/ipc-contracts';
import {
  guidedTunnelLaunchDecision,
  guidedTunnelPrerequisiteSignature,
  initialGuidedTunnelStep,
  isFreshTunnelSetup,
  isTunnelConfigured,
  isTunnelRunning,
  tunnelControlAvailability,
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

  it('never reopens onboarding for an already configured tunnel, including a detached persistent runtime', () => {
    expect(guidedTunnelLaunchDecision(pristineTunnel(), 'in_progress')).toBe('resume_settings');
    expect(guidedTunnelLaunchDecision(pristineTunnel({ hasApiKey: true, profileExists: true }), 'in_progress')).toBe('none');
    expect(guidedTunnelLaunchDecision(pristineTunnel({ state: 'running', source: 'external', hasApiKey: true, profileExists: true }), 'in_progress')).toBe('none');
    expect(guidedTunnelLaunchDecision(pristineTunnel({ state: 'running', source: 'desktop', hasApiKey: true, profileExists: true }), 'in_progress')).toBe('none');
  });

  it('respects Later only while the actual setup is still pristine, then resumes if prerequisites change', () => {
    expect(guidedTunnelLaunchDecision(pristineTunnel(), 'dismissed')).toBe('none');
    expect(guidedTunnelLaunchDecision(pristineTunnel({ hasApiKey: true }), 'dismissed')).toBe('resume_settings');
    expect(guidedTunnelLaunchDecision(pristineTunnel({ profileExists: true }), 'dismissed')).toBe('resume_settings');
  });

  it('derives fresh, configured, and running states from real prerequisites without coupling to Desktop process ownership', () => {
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
    expect(isTunnelRunning(pristineTunnel({ state: 'running', source: 'external', hasApiKey: true, profileExists: true }))).toBe(true);
    expect(isTunnelRunning(pristineTunnel({ state: 'running', source: 'desktop', hasApiKey: true, profileExists: true }))).toBe(true);
  });

  it('keeps Stop available and blocks Start when a persistent alias may still be active', () => {
    const staleAlias = pristineTunnel({
      persistent: {
        enabled: true,
        tunnelIdMasked: 'tunnel_0123********cdef',
        runtimeAlias: 'lnwjud',
        runtimeAliasActive: true,
        mode: 'native-managed',
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
    });
    const idle = { startPending: false, stopPending: false };

    expect(tunnelControlAvailability(staleAlias, idle).startDisabled).toBe(true);
    expect(tunnelControlAvailability(pristineTunnel({
      persistent: { ...staleAlias.persistent!, state: 'stopped' },
    }), idle).startDisabled).toBe(true);
    expect(tunnelControlAvailability(staleAlias, idle).stopDisabled).toBe(false);
    expect(tunnelControlAvailability(pristineTunnel({ state: 'starting', persistent: staleAlias.persistent }), idle).stopDisabled).toBe(false);
    expect(tunnelControlAvailability(pristineTunnel({
      persistent: { ...staleAlias.persistent!, state: 'starting' },
    }), idle).stopDisabled).toBe(false);
    expect(tunnelControlAvailability(pristineTunnel({
      ...staleAlias,
      persistent: {
        ...staleAlias.persistent!,
        runtimeAliasActive: false,
        state: 'error',
      },
    }), idle).stopDisabled).toBe(false);
    expect(tunnelControlAvailability(pristineTunnel(), idle).stopDisabled).toBe(true);
  });

  it('allows Stop to interrupt Start while preventing duplicate Starts', () => {
    expect(tunnelControlAvailability(pristineTunnel(), { startPending: true, stopPending: false })).toEqual({
      startDisabled: true,
      stopDisabled: false,
    });
  });

  it('locks both actions while Stop is already pending', () => {
    expect(tunnelControlAvailability(pristineTunnel({ state: 'running' }), { startPending: false, stopPending: true })).toEqual({
      startDisabled: true,
      stopDisabled: true,
    });
  });

  it('changes the launch signature only when real prerequisites or runtime liveness change', () => {
    expect(guidedTunnelPrerequisiteSignature(pristineTunnel())).toBe('no-key:no-profile:not-running');
    expect(guidedTunnelPrerequisiteSignature(pristineTunnel({ hasApiKey: true }))).toBe('key:no-profile:not-running');
    expect(guidedTunnelPrerequisiteSignature(pristineTunnel({ hasApiKey: true, profileExists: true, state: 'running', source: 'external' }))).toBe('key:profile:running');
    expect(guidedTunnelPrerequisiteSignature(pristineTunnel({ hasApiKey: true, profileExists: true, state: 'running', source: 'desktop' }))).toBe('key:profile:running');
  });

  it('resumes at the first step required by the actual tunnel state', () => {
    expect(initialGuidedTunnelStep(pristineTunnel())).toBe('create_tunnel');
    expect(initialGuidedTunnelStep(pristineTunnel({ hasApiKey: true }))).toBe('create_tunnel');
    expect(initialGuidedTunnelStep(pristineTunnel({ profileExists: true }))).toBe('save_key');
    expect(initialGuidedTunnelStep(pristineTunnel({ hasApiKey: true, profileExists: true }))).toBe('start');
    expect(initialGuidedTunnelStep(pristineTunnel({ hasApiKey: true, profileExists: true, state: 'running', source: 'external' }))).toBe('connect_chatgpt');
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
