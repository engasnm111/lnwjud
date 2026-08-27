export type WindowsGeneration = 'windows-10' | 'windows-11' | 'unsupported-windows' | 'non-windows';

export interface WindowsCompatibilityProfile {
  readonly generation: WindowsGeneration;
  readonly build: number | null;
  readonly supportedReleaseTarget: boolean;
  readonly disableHardwareAcceleration: boolean;
  readonly reason: string;
}

export const WINDOWS_10_MIN_BUILD = 10_240;
export const WINDOWS_11_MIN_BUILD = 22_000;

export function windowsBuildFromRelease(release: string): number | null {
  const parts = release.trim().split('.');
  if (parts.length < 3) return null;
  const build = Number.parseInt(parts[2] ?? '', 10);
  return Number.isInteger(build) && build > 0 ? build : null;
}

export function windowsCompatibilityProfile(
  platform: NodeJS.Platform,
  release: string,
  architecture: string,
): WindowsCompatibilityProfile {
  if (platform !== 'win32') {
    return {
      generation: 'non-windows',
      build: null,
      supportedReleaseTarget: false,
      disableHardwareAcceleration: false,
      reason: 'The packaged desktop release target is Windows x64.',
    };
  }

  const build = windowsBuildFromRelease(release);
  const x64 = architecture === 'x64';
  if (build === null || build < WINDOWS_10_MIN_BUILD || !x64) {
    return {
      generation: 'unsupported-windows',
      build,
      supportedReleaseTarget: false,
      disableHardwareAcceleration: false,
      reason: x64
        ? 'lnwjud requires Windows 10 or Windows 11.'
        : 'lnwjud Windows packages require 64-bit x64 Windows.',
    };
  }

  if (build < WINDOWS_11_MIN_BUILD) {
    return {
      generation: 'windows-10',
      build,
      supportedReleaseTarget: true,
      // Chromium/Electron can expose blank, partially unclickable, or unstable
      // surfaces on older Windows 10 GPU drivers. Software compositing is a
      // conservative compatibility default for Win10; Win11 keeps GPU accel.
      disableHardwareAcceleration: true,
      reason: 'Windows 10 compatibility profile: software rendering is preferred for older GPU-driver stability.',
    };
  }

  return {
    generation: 'windows-11',
    build,
    supportedReleaseTarget: true,
    disableHardwareAcceleration: false,
    reason: 'Windows 11 compatibility profile: hardware acceleration remains enabled.',
  };
}
