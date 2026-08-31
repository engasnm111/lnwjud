import { describe, expect, it } from 'vitest';
import {
  WINDOWS_10_MIN_BUILD,
  WINDOWS_11_MIN_BUILD,
  windowsBuildFromRelease,
  windowsCompatibilityProfile,
} from '../src/main/windows-compatibility.js';

describe('Windows 10/11 compatibility profile', () => {
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

  it('fails the release-target contract for pre-Windows-10, x86, and non-Windows hosts', () => {
    expect(windowsCompatibilityProfile('win32', '6.3.9600', 'x64').supportedReleaseTarget).toBe(false);
    expect(windowsCompatibilityProfile('win32', '10.0.19045', 'ia32').supportedReleaseTarget).toBe(false);
    expect(windowsCompatibilityProfile('linux', '6.8.0', 'x64').supportedReleaseTarget).toBe(false);
  });

  it('treats macOS arm64 and x64 as supported release targets', () => {
    expect(windowsCompatibilityProfile('darwin', '24.6.0', 'arm64')).toMatchObject({
      generation: 'macos',
      supportedReleaseTarget: true,
      disableHardwareAcceleration: false,
    });
    expect(windowsCompatibilityProfile('darwin', '23.0.0', 'x64')).toMatchObject({
      generation: 'macos',
      supportedReleaseTarget: true,
    });
  });

  it('keeps unsupported macOS architectures out of the release-target contract', () => {
    expect(windowsCompatibilityProfile('darwin', '24.6.0', 'ia32')).toMatchObject({
      generation: 'unsupported-macos',
      supportedReleaseTarget: false,
    });
  });
});
