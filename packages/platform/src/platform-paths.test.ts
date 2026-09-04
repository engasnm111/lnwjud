import { describe, expect, it } from 'vitest';
import { createPlatformContext } from './platform-context.js';
import { resolvePlatformPaths } from './platform-paths.js';

describe('resolvePlatformPaths', () => {
  it('preserves the existing Windows roaming data root', () => {
    const paths = resolvePlatformPaths(
      createPlatformContext({ platform: 'win32', arch: 'x64' }),
      { APPDATA: 'D:\\Users\\Ohm\\AppData\\Roaming' },
      'D:\\Users\\Ohm',
    );
    expect(paths.dataDir).toBe('D:\\Users\\Ohm\\AppData\\Roaming\\lnwjud');
  });

  it('uses Application Support and Caches on macOS', () => {
    const paths = resolvePlatformPaths(createPlatformContext({ platform: 'darwin', arch: 'arm64' }), {}, '/Users/ohm');
    expect(paths.dataDir).toBe('/Users/ohm/Library/Application Support/lnwjud');
    expect(paths.cacheDir).toBe('/Users/ohm/Library/Caches/lnwjud');
  });

  it('uses XDG locations when present on Linux', () => {
    const paths = resolvePlatformPaths(
      createPlatformContext({ platform: 'linux', arch: 'x64' }),
      {
        XDG_DATA_HOME: '/tmp/data',
        XDG_CONFIG_HOME: '/tmp/config',
        XDG_CACHE_HOME: '/tmp/cache',
        XDG_STATE_HOME: '/tmp/state',
      },
      '/home/ohm',
    );
    expect(paths).toMatchObject({
      dataDir: '/tmp/data/lnwjud',
      configDir: '/tmp/config/lnwjud',
      cacheDir: '/tmp/cache/lnwjud',
      stateDir: '/tmp/state/lnwjud',
      runtimeDir: '/tmp/state/lnwjud/runtime',
    });
  });

  it('falls back to freedesktop defaults on Linux', () => {
    const paths = resolvePlatformPaths(createPlatformContext({ platform: 'linux', arch: 'x64' }), {}, '/home/ohm');
    expect(paths.dataDir).toBe('/home/ohm/.local/share/lnwjud');
    expect(paths.configDir).toBe('/home/ohm/.config/lnwjud');
  });
});
