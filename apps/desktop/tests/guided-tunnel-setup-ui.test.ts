import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TunnelStatus, UiLocale } from '@lnwjud/ipc-contracts';
import { FirstRunTunnelTip } from '../src/renderer/features/onboarding/FirstRunTunnelTip.js';
import { GuidedTunnelSetup } from '../src/renderer/features/onboarding/GuidedTunnelSetup.js';

const noop = (): void => undefined;
const noopAsync = async (): Promise<void> => undefined;

function tunnel(overrides: Partial<TunnelStatus> = {}): TunnelStatus {
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

function guideMarkup(locale: UiLocale, status: TunnelStatus): string {
  return renderToStaticMarkup(createElement(GuidedTunnelSetup, {
    locale,
    tunnel: status,
    open: true,
    onOpenChange: noop,
    onOpenExternal: noopAsync,
    onSaveApiKey: noopAsync,
    onConfigureProfile: async (): Promise<string> => 'C:\\fixture\\lnwjud.yaml',
    onStartTunnel: async (): Promise<TunnelStatus> => status,
    onRefresh: noopAsync,
    onLocalComplete: noop,
  }));
}

describe('guided tunnel onboarding UI', () => {
  it('renders the first-run tip in Thai and English without credential fields', () => {
    const th = renderToStaticMarkup(createElement(FirstRunTunnelTip, { locale: 'th', onStart: noop, onLater: noop }));
    const en = renderToStaticMarkup(createElement(FirstRunTunnelTip, { locale: 'en', onStart: noop, onLater: noop }));

    expect(th).toContain('ตั้งค่า ChatGPT ให้ใช้ lnwjud');
    expect(th).toContain('Windows DPAPI');
    expect(th).toContain('เริ่มตั้งค่า');
    expect(th).toContain('ไว้ทีหลัง');
    expect(en).toContain('Connect ChatGPT to lnwjud');
    expect(en).toContain('Start setup');
    expect(en).toContain('Set up later');
    expect(th).not.toContain('type="password"');
    expect(th).not.toContain('name="apiKey"');
    expect(th).not.toContain('name="tunnelId"');
  });

  it('renders the correct first required step from actual tunnel state', () => {
    expect(guideMarkup('th', tunnel())).toContain('1. สร้าง OpenAI Tunnel');
    expect(guideMarkup('en', tunnel({ hasApiKey: true }))).toContain('1. Create an OpenAI Tunnel');
    expect(guideMarkup('en', tunnel({ profileExists: true }))).toContain('2. Create a Runtime API key');
    expect(guideMarkup('en', tunnel({ hasApiKey: true, profileExists: true }))).toContain('4. Start the Tunnel');
  });

  it('does not jump to ChatGPT when a stale external runtime is running without local prerequisites', () => {
    const stale = guideMarkup('en', tunnel({ state: 'running', source: 'external' }));
    expect(stale).toContain('1. Create an OpenAI Tunnel');
    expect(stale).not.toContain('Local setup is complete.');
    expect(stale).not.toContain('Open ChatGPT Plugins');
  });

  it('does not treat a configured externally-owned runtime as locally complete', () => {
    const external = guideMarkup('en', tunnel({ state: 'running', source: 'external', hasApiKey: true, profileExists: true }));
    expect(external).toContain('4. Start the Tunnel');
    expect(external).not.toContain('Local setup is complete.');
  });

  it('disables Start Tunnel until both the key and profile are ready', () => {
    const pristine = guideMarkup('en', tunnel());
    const configured = guideMarkup('en', tunnel({ hasApiKey: true, profileExists: true }));
    expect(pristine).not.toContain('4. Start the Tunnel');
    expect(configured).toMatch(/<button[^>]*>Start Tunnel<\/button>/);
    expect(configured).not.toMatch(/<button[^>]*disabled=""[^>]*>Start Tunnel<\/button>/);
  });

  it('shows local completion and ChatGPT action only after running', () => {
    const running = guideMarkup('en', tunnel({
      state: 'running',
      hasApiKey: true,
      profileExists: true,
      persistent: {
        enabled: true,
        tunnelIdMasked: 'tunnel_0123********cdef',
        runtimeAlias: 'lnwjud',
        mode: 'native-managed',
        state: 'running',
        healthy: true,
        ready: true,
        pollHealthy: true,
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
    }));
    expect(running).toContain('Local setup is complete.');
    expect(running).toContain('Open ChatGPT Plugins');
    expect(running).toContain('tunnel_0123********cdef');
  });

  it('never renders a raw runtime key in status or summary markup', () => {
    const secret = 'sk-fixture-raw-secret-must-not-render';
    const markup = guideMarkup('en', tunnel({ hasApiKey: true, profileExists: true }));
    expect(markup).not.toContain(secret);
    expect(markup).not.toContain('sk-');
  });
});
