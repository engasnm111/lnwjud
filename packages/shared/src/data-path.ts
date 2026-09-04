import os from 'node:os';
import path from 'node:path';
import { createPlatformContext, resolvePlatformPaths } from '@lnwjud/platform';

export interface DataPathEnvironment {
  readonly LNWJUD_DATA_PATH?: string;
  readonly APPDATA?: string;
  readonly USERPROFILE?: string;
  readonly HOME?: string;
  readonly XDG_DATA_HOME?: string;
  readonly XDG_CONFIG_HOME?: string;
  readonly XDG_CACHE_HOME?: string;
  readonly XDG_STATE_HOME?: string;
}

/** Resolve the per-user lnwjud data directory without embedding a developer profile path. */
export function resolveLnwjudDataPath(
  environment: DataPathEnvironment = process.env,
  roamingAppDataFallback?: string,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = resolveHomeDirectory(environment, platform),
): string {
  const configured = environment.LNWJUD_DATA_PATH?.trim();
  if (configured) return platform === 'win32' ? path.win32.resolve(configured) : path.posix.resolve(configured);

  if (platform === 'win32') {
    const appData = firstNonEmpty(
      environment.APPDATA,
      roamingAppDataFallback,
      environment.USERPROFILE ? path.win32.join(environment.USERPROFILE, 'AppData', 'Roaming') : undefined,
      environment.HOME ? path.win32.join(environment.HOME, 'AppData', 'Roaming') : undefined,
      path.win32.join(homeDir, 'AppData', 'Roaming'),
    );
    return path.win32.resolve(appData, 'lnwjud');
  }

  const context = createPlatformContext({ platform, arch: process.arch });
  return resolvePlatformPaths(context, environment, homeDir).dataDir;
}

function resolveHomeDirectory(environment: DataPathEnvironment, platform: NodeJS.Platform): string {
  if (platform === 'win32') return firstNonEmpty(environment.USERPROFILE, environment.HOME, os.homedir());
  return firstNonEmpty(environment.HOME, os.homedir());
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return os.homedir();
}
