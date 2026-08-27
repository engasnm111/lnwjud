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

  it('treats Windows 10 x64 as a supported release target and selects the conservative GPU profile', () => {
    expect(WINDOWS_10_MIN_BUILD).toBe(10240);
    expect(windowsCompatibilityProfile('win32', '10.0.19045', 'x64')).toMatchObject({
      generation: 'windows-10',
      build: 19045,
      supportedReleaseTarget: true,
      disableHardwareAcceleration: true,
    });
  });

  it('treats Windows 11 x64 as a supported release target without disabling GPU acceleration', () => {
    expect(WINDOWS_11_MIN_BUILD).toBe(22000);
    expect(windowsCompatibilityProfile('win32', '10.0.22631', 'x64')).toMatchObject({
      generation: 'windows-11',
      build: 22631,
      supportedReleaseTarget: true,
      disableHardwareAcceleration: false,
    });
  });

  it('fails the release-target contract for pre-Windows-10, x86, and non-Windows hosts', () => {
    expect(windowsCompatibilityProfile('win32', '6.3.9600', 'x64').supportedReleaseTarget).toBe(false);
    expect(windowsCompatibilityProfile('win32', '10.0.19045', 'ia32').supportedReleaseTarget).toBe(false);
    expect(windowsCompatibilityProfile('linux', '6.8.0', 'x64').supportedReleaseTarget).toBe(false);
  });
});
