import { describe, expect, it } from 'vitest';
import { detectLinuxSessionProfile } from './linux-session-profile.js';

describe('Linux session profile', () => {
  it('detects Wayland without inferring granted permissions', () => {
    const profile = detectLinuxSessionProfile({ arch: 'x64', commandExists: () => true, env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' } });
    expect(profile).toMatchObject({ sessionType: 'wayland', displayServer: 'wayland', dbusAvailable: true, portalAvailable: true, secretServiceAvailable: true, atSpiAvailable: true, headless: false });
    expect(profile.notes.join(' ')).toContain('user-approved portal');
  });

  it('detects X11, headless, and unsupported architectures deterministically', () => {
    expect(detectLinuxSessionProfile({ arch: 'x64', commandExists: () => false, env: { DISPLAY: ':0' } })).toMatchObject({ sessionType: 'x11', displayServer: 'x11', supportTier: 'supported', dbusAvailable: false });
    expect(detectLinuxSessionProfile({ arch: 'arm64', commandExists: () => false, env: { TERM: 'xterm' } })).toMatchObject({ sessionType: 'headless', supportTier: 'preview', headless: true });
    expect(detectLinuxSessionProfile({ arch: 'ia32', commandExists: () => false, env: {} })).toMatchObject({ supportTier: 'unsupported', sessionType: 'unknown' });
  });
});
