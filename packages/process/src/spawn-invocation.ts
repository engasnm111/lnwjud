import { appError, err, ok, type Result } from '@lnwjud/domain';
import { toWindowsSpawnInvocation, type SpawnInvocation, type WindowsSpawnOptions } from './windows-spawn.js';

export type { SpawnInvocation } from './windows-spawn.js';

export interface SpawnInvocationFactory {
  create(executable: string, args: readonly string[], options?: WindowsSpawnOptions): Result<SpawnInvocation>;
}

/** Host-neutral argv launch. POSIX receives the executable and argv directly. */
export function toSpawnInvocation(
  executable: string,
  args: readonly string[],
  options: WindowsSpawnOptions = {},
  platform: NodeJS.Platform = process.platform,
): Result<SpawnInvocation> {
  if (platform === 'win32') return toWindowsSpawnInvocation(executable, args, options, platform);
  if (executable.trim().length === 0 || args.some((arg) => typeof arg !== 'string')) {
    return err(appError('INVALID_INPUT', 'Executable and args are required'));
  }
  return ok({ executable, args: [...args] });
}

export function createSpawnInvocationFactory(platform: NodeJS.Platform = process.platform): SpawnInvocationFactory {
  return { create: (executable, args, options) => toSpawnInvocation(executable, args, options, platform) };
}
