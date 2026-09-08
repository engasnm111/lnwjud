import path from 'node:path';
import { appError, err, ok, type Result } from '@lnwjud/domain';

export interface SpawnInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments?: boolean;
}

export interface WindowsSpawnOptions {
  readonly allowMetacharacters?: boolean;
}

export function toWindowsSpawnInvocation(
  executable: string,
  args: readonly string[],
  options: WindowsSpawnOptions = {},
  platform: NodeJS.Platform = process.platform,
): Result<SpawnInvocation> {
  if (platform !== 'win32' || !isWindowsCommandShim(executable)) {
    return ok({ executable, args });
  }
  return wrapWindowsCommandShim(executable, args, options, platform);
}

export function wrapWindowsCommandShim(
  executable: string,
  args: readonly string[],
  options: WindowsSpawnOptions = {},
  platform: NodeJS.Platform = process.platform,
): Result<SpawnInvocation> {
  if (platform !== 'win32') return ok({ executable, args });
  const values = [executable, ...args];
  if (!options.allowMetacharacters && values.some((value) => /[\r\n&|<>^%!"]/.test(value))) {
    return err(appError('INVALID_INPUT', 'Windows command shim arguments contain unsupported shell metacharacters'));
  }
  const commandLine = `"${values.map(quoteWindowsCommandArgument).join(' ')}"`;
  return ok({
    executable: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', commandLine],
    windowsVerbatimArguments: true,
  });
}

function isWindowsCommandShim(executable: string): boolean {
  return ['.cmd', '.bat'].includes(path.extname(executable).toLowerCase());
}

function quoteWindowsCommandArgument(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}
