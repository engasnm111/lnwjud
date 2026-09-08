import {
  createPlatformProfile,
  detectLinuxSessionProfile,
  type LinuxSessionProfile,
  type PlatformProfile,
} from '@lnwjud/shared';

export type WindowsGeneration = 'windows-10' | 'windows-11' | 'unsupported-windows' | 'non-windows';

export interface PlatformCompatibilityProfile extends PlatformProfile {
  readonly generation: WindowsGeneration;
  readonly build: number | null;
  readonly supportedReleaseTarget: boolean;
  readonly disableHardwareAcceleration: boolean;
  readonly reason: string;
  readonly linuxSession?: LinuxSessionProfile;
}

export const WINDOWS_10_MIN_BUILD = 10_240;
export const WINDOWS_11_MIN_BUILD = 22_000;

export function windowsBuildFromRelease(release: string): number | null {
  const parts = release.trim().split('.');
  if (parts.length < 3) return null;
  const build = Number.parseInt(parts[2] ?? '', 10);
  return Number.isInteger(build) && build > 0 ? build : null;
}

export function platformCompatibilityProfile(
  platform: NodeJS.Platform,
  release: string,
  architecture: string,
): PlatformCompatibilityProfile {
  const profile = createPlatformProfile({ platform, arch: architecture, release });
  const build = platform === 'win32' ? windowsBuildFromRelease(release) : null;
  const windowsSupported = profile.family === 'windows' && profile.supportTier === 'supported';
  const generation: WindowsGeneration =
    profile.family !== 'windows'
      ? 'non-windows'
      : !windowsSupported
        ? 'unsupported-windows'
        : (build ?? 0) < WINDOWS_11_MIN_BUILD
          ? 'windows-10'
          : 'windows-11';

  const reason =
    profile.family === 'windows'
      ? !windowsSupported
        ? architecture === 'x64'
          ? 'lnwjud requires Windows 10 or Windows 11.'
          : 'lnwjud Windows packages require 64-bit x64 Windows.'
        : generation === 'windows-10'
          ? 'Windows 10 compatibility profile: software rendering is preferred for older GPU-driver stability.'
          : 'Windows 11 compatibility profile: hardware acceleration remains enabled.'
      : profile.family === 'macos'
        ? 'macOS native platform profile: host permissions and providers are selected at startup.'
        : profile.family === 'linux'
          ? 'Linux native platform profile: desktop session and optional providers are selected at startup.'
          : 'The host platform or architecture is outside the supported release matrix.';

  return {
    ...profile,
    generation,
    build,
    supportedReleaseTarget: profile.supportTier !== 'unsupported',
    disableHardwareAcceleration: generation === 'windows-10',
    reason,
    ...(profile.family === 'linux' ? { linuxSession: detectLinuxSessionProfile({ arch: architecture }) } : {}),
  };
}

/** Backward-compatible name for existing Windows-specific callers during migration. */
export function windowsCompatibilityProfile(
  platform: NodeJS.Platform,
  release: string,
  architecture: string,
): PlatformCompatibilityProfile {
  return platformCompatibilityProfile(platform, release, architecture);
}
