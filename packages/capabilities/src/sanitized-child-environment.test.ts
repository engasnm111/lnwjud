import { describe, expect, it } from 'vitest';
import { sanitizedChildEnvironment } from './sanitized-child-environment.js';

describe('sanitizedChildEnvironment', () => {
  it('removes credential-looking variables while preserving desktop session handles', () => {
    const result = sanitizedChildEnvironment({
      CONTROL_PLANE_API_KEY: 'secret',
      OPENAI_TOKEN: 'secret',
      DATABASE_PASSWORD: 'secret',
      APP_SECRET: 'secret',
      DISPLAY: ':99',
      WAYLAND_DISPLAY: 'wayland-0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      PIPEWIRE_REMOTE: 'pipewire-0',
      PATH: '/usr/bin',
    });

    expect(result).toEqual({
      DISPLAY: ':99',
      WAYLAND_DISPLAY: 'wayland-0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      PIPEWIRE_REMOTE: 'pipewire-0',
      PATH: '/usr/bin',
    });
  });

  it('does not treat unrelated words containing credential terms as secrets', () => {
    const result = sanitizedChildEnvironment({
      TOKENIZER_PATH: '/opt/tokenizer',
      SECRETARY_MODE: 'on',
      API_KEYBOARD_LAYOUT: 'us',
      LANG: 'en_US.UTF-8',
    });

    expect(result).toEqual({
      TOKENIZER_PATH: '/opt/tokenizer',
      SECRETARY_MODE: 'on',
      API_KEYBOARD_LAYOUT: 'us',
      LANG: 'en_US.UTF-8',
    });
  });
});
