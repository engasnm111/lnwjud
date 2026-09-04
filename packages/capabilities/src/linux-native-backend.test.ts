import { describe, expect, it, vi } from 'vitest';
import { ok, type Result } from '@lnwjud/domain';
import { LinuxNativeCapabilityBackend, type LinuxNativeCapabilityBridge } from './linux-native-backend.js';
import type { LinuxSessionProfile } from './linux-session-profile.js';

const x11Profile: LinuxSessionProfile = {
  platformSupported: true,
  session: 'x11',
  interactive: true,
  display: ':0',
  waylandDisplay: undefined,
  dbusSessionAvailable: true,
};

const waylandProfile: LinuxSessionProfile = {
  platformSupported: true,
  session: 'wayland',
  interactive: true,
  display: undefined,
  waylandDisplay: 'wayland-0',
  dbusSessionAvailable: true,
};

function bridgeFixture() {
  const execute = vi.fn(async (request: { readonly capability: string; readonly input: Record<string, unknown>; readonly session: LinuxSessionProfile }): Promise<Result<unknown>> => ok({
    capability: request.capability,
    session: request.session.session,
    ready: true,
    available: true,
    provider: 'fixture',
  }));
  return { bridge: { execute } as LinuxNativeCapabilityBridge, execute };
}

describe('LinuxNativeCapabilityBackend', () => {
  it('reports X11 provider_not_delivered truthfully when no native bridge is configured', async () => {
    const backend = new LinuxNativeCapabilityBackend('accessibility', { platform: 'linux', sessionProfile: x11Profile });

    await expect(backend.execute({ action: 'status' })).resolves.toEqual({
      ok: true,
      value: expect.objectContaining({
        available: false,
        ready: false,
        backend: 'linux-native',
        session: 'x11',
        reason: 'provider_not_delivered',
      }),
    });
  });

  it('reports Wayland input as portal-session gated rather than ready', async () => {
    const backend = new LinuxNativeCapabilityBackend('input_event', { platform: 'linux', sessionProfile: waylandProfile });

    await expect(backend.execute({ action: 'status' })).resolves.toEqual({
      ok: true,
      value: expect.objectContaining({
        available: false,
        ready: false,
        session: 'wayland',
        reason: 'wayland_portal_session_required',
      }),
    });
  });

  it('reports headless desktop capabilities as session unavailable', async () => {
    const backend = new LinuxNativeCapabilityBackend('vision', {
      platform: 'linux',
      sessionProfile: { ...x11Profile, session: 'headless', interactive: false, display: undefined, dbusSessionAvailable: false },
    });

    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({
      ok: true,
      value: { available: false, ready: false, reason: 'desktop_session_unavailable', session: 'headless' },
    });
  });

  it('dispatches through an injected Linux bridge with session metadata', async () => {
    const { bridge, execute } = bridgeFixture();
    const backend = new LinuxNativeCapabilityBackend('accessibility', { platform: 'linux', sessionProfile: x11Profile, bridge });

    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({
      ok: true,
      value: { available: true, ready: true, provider: 'fixture', session: 'x11' },
    });
    expect(execute).toHaveBeenCalledWith({ capability: 'accessibility', input: { action: 'status' }, session: x11Profile }, undefined);
  });

  it('fails closed outside Linux without invoking a configured bridge', async () => {
    const { bridge, execute } = bridgeFixture();
    const backend = new LinuxNativeCapabilityBackend('window', { platform: 'darwin', sessionProfile: x11Profile, bridge });

    const result = await backend.execute({ action: 'status' });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('unavailable on this platform') } });
    expect(execute).not.toHaveBeenCalled();
  });
});
