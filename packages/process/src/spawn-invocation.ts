import { ok, type Result } from '@lnwjud/domain';
import { toWindowsSpawnInvocation, type WindowsSpawnOptions } from './windows-spawn.js';

export interface PlatformSpawnInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments?: boolean;
  /** True only when lnwjud should create and owns a dedicated POSIX process group. */
  readonly ownsProcessGroup: boolean;
}

export interface PlatformSpawnOptions extends WindowsSpawnOptions {
  readonly platform?: NodeJS.Platform;
}

export function toPlatformSpawnInvocation(
  executable: string,
  args: readonly string[],
  options: PlatformSpawnOptions = {},
): Result<PlatformSpawnInvocation> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    const windows = toWindowsSpawnInvocation(executable, args, options);
    if (!windows.ok) return windows;
    return ok({ ...windows.value, ownsProcessGroup: false });
  }

  return ok({
    executable,
    args: [...args],
    ownsProcessGroup: platform === 'darwin' || platform === 'linux',
  });
}
