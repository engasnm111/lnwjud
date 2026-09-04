import path from 'node:path';
import type { PlatformContext } from './platform-context.js';

export interface PlatformPathEnvironment {
  readonly APPDATA?: string;
  readonly HOME?: string;
  readonly XDG_DATA_HOME?: string;
  readonly XDG_CONFIG_HOME?: string;
  readonly XDG_CACHE_HOME?: string;
  readonly XDG_STATE_HOME?: string;
}

export interface PlatformPaths {
  readonly dataDir: string;
  readonly configDir: string;
  readonly cacheDir: string;
  readonly stateDir: string;
  readonly runtimeDir: string;
}

export function resolvePlatformPaths(
  context: PlatformContext,
  environment: PlatformPathEnvironment,
  homeDir: string,
): PlatformPaths {
  if (context.platform === 'win32') {
    const roaming = environment.APPDATA ?? path.win32.join(homeDir, 'AppData', 'Roaming');
    const root = path.win32.join(roaming, 'lnwjud');
    return derived(root, root, path.win32.join(root, 'cache'), root, path.win32);
  }

  if (context.platform === 'darwin') {
    const dataDir = path.posix.join(homeDir, 'Library', 'Application Support', 'lnwjud');
    const cacheDir = path.posix.join(homeDir, 'Library', 'Caches', 'lnwjud');
    return derived(dataDir, dataDir, cacheDir, dataDir, path.posix);
  }

  if (context.platform === 'linux') {
    const dataDir = path.posix.join(environment.XDG_DATA_HOME ?? path.posix.join(homeDir, '.local', 'share'), 'lnwjud');
    const configDir = path.posix.join(environment.XDG_CONFIG_HOME ?? path.posix.join(homeDir, '.config'), 'lnwjud');
    const cacheDir = path.posix.join(environment.XDG_CACHE_HOME ?? path.posix.join(homeDir, '.cache'), 'lnwjud');
    const stateDir = path.posix.join(environment.XDG_STATE_HOME ?? path.posix.join(homeDir, '.local', 'state'), 'lnwjud');
    return derived(dataDir, configDir, cacheDir, stateDir, path.posix);
  }

  throw new Error(`Unsupported platform for lnwjud paths: ${context.platform}`);
}

function derived(
  dataDir: string,
  configDir: string,
  cacheDir: string,
  stateDir: string,
  pathApi: typeof path.posix | typeof path.win32,
): PlatformPaths {
  return {
    dataDir,
    configDir,
    cacheDir,
    stateDir,
    runtimeDir: pathApi.join(stateDir, 'runtime'),
  };
}
