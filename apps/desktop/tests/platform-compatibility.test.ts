import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WINDOWS_10_MIN_BUILD,
  WINDOWS_11_MIN_BUILD,
  platformCompatibilityProfile,
  supportedHostPlatform,
  windowsBuildFromRelease,
  windowsCompatibilityProfile,
} from '../src/main/platform-compatibility.js';

describe('platform compatibility profile', () => {
  it('uses the platform-owned profile during desktop bootstrap', async () => {
    const mainSource = await readFile(path.resolve(import.meta.dirname, '../src/main/main.ts'), 'utf8');
    expect(mainSource).toContain("from './platform-compatibility.js'");
    expect(mainSource).toContain('platformCompatibilityProfile(process.platform, os.release(), process.arch)');
    expect(mainSource).not.toContain("from './windows-compatibility.js'");
    expect(mainSource).toContain('[PlatformCompatibility]');
  });

  it('parses NT build numbers used by Windows 10 and Windows 11', () => {
    expect(windowsBuildFromRelease('10.0.19045')).toBe(19045);
    expect(windowsBuildFromRelease('10.0.22631')).toBe(22631);
    expect(windowsBuildFromRelease('10.0.26200')).toBe(26200);
    expect(windowsBuildFromRelease('invalid')).toBeNull();
  });

  it('treats every Windows 10 x64 build from the original release boundary onward as supported', () => {
    expect(WINDOWS_10_MIN_BUILD).toBe(10240);
    for (const build of [10240, 14393, 17763, 19041, 19045]) {
      expect(windowsCompatibilityProfile('win32', `10.0.${build}`, 'x64')).toMatchObject({
        generation: 'windows-10',
        build,
        supportedReleaseTarget: true,
        disableHardwareAcceleration: true,
      });
    }
  });

  it('treats every Windows 11 x64 build from the original release boundary onward as supported', () => {
    expect(WINDOWS_11_MIN_BUILD).toBe(22000);
    for (const build of [22000, 22621, 22631, 26100, 26200]) {
      expect(windowsCompatibilityProfile('win32', `10.0.${build}`, 'x64')).toMatchObject({
        generation: 'windows-11',
        build,
        supportedReleaseTarget: true,
        disableHardwareAcceleration: false,
      });
    }
  });

  it('maps only the three supported host families and fails closed for unknown platforms', () => {
    expect(supportedHostPlatform('win32')).toBe('win32');
    expect(supportedHostPlatform('darwin')).toBe('darwin');
    expect(supportedHostPlatform('linux')).toBe('linux');
    expect(() => supportedHostPlatform('freebsd')).toThrow('Unsupported host platform: freebsd');
  });

  it('fails closed for unsupported Windows hosts while admitting supported non-Windows targets', () => {
    expect(windowsCompatibilityProfile('win32', '6.3.9600', 'x64').supportedReleaseTarget).toBe(false);
    expect(windowsCompatibilityProfile('win32', '10.0.19045', 'ia32').supportedReleaseTarget).toBe(false);
    expect(platformCompatibilityProfile('darwin', '23.6.0', 'arm64')).toMatchObject({
      family: 'macos',
      generation: 'non-windows',
      supportedReleaseTarget: true,
    });
    expect(platformCompatibilityProfile('linux', '6.8.0', 'x64')).toMatchObject({
      family: 'linux',
      generation: 'non-windows',
      supportedReleaseTarget: true,
    });
  });
});
