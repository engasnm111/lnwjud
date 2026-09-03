import { describe, expect, it } from 'vitest';
import { detectLinuxSessionProfile } from './linux-session-profile.js';

describe('detectLinuxSessionProfile', () => {
  it('detects Wayland from XDG_SESSION_TYPE without treating permission as granted', () => {
    expect(detectLinuxSessionProfile({
      platform: 'linux',
      env: {
        XDG_SESSION_TYPE: 'wayland',
        WAYLAND_DISPLAY: 'wayland-0',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      },
    })).toEqual({
      platformSupported: true,
      session: 'wayland',
      interactive: true,
      display: undefined,
      waylandDisplay: 'wayland-0',
      dbusSessionAvailable: true,
    });
  });

  it('detects X11 from DISPLAY when XDG_SESSION_TYPE is absent', () => {
    expect(detectLinuxSessionProfile({
      platform: 'linux',
      env: { DISPLAY: ':0' },
    })).toMatchObject({
      platformSupported: true,
      session: 'x11',
      interactive: true,
      display: ':0',
      dbusSessionAvailable: false,
    });
  });

  it('reports headless when no desktop session evidence exists', () => {
    expect(detectLinuxSessionProfile({ platform: 'linux', env: {} })).toMatchObject({
      platformSupported: true,
      session: 'headless',
      interactive: false,
      dbusSessionAvailable: false,
    });
  });

  it('fails closed when used on a non-Linux platform', () => {
    expect(detectLinuxSessionProfile({ platform: 'darwin', env: { DISPLAY: ':0' } })).toMatchObject({
      platformSupported: false,
      session: 'headless',
      interactive: false,
    });
  });
});
