import os from 'node:os';
import path from 'node:path';

export interface DataPathEnvironment {
  readonly LNWJUD_DATA_PATH?: string;
  readonly APPDATA?: string;
  readonly USERPROFILE?: string;
  readonly HOME?: string;
  readonly XDG_DATA_HOME?: string;
}

/** Resolve the per-user lnwjud data directory without embedding a developer profile path. */
export function resolveLnwjudDataPath(
  environment: DataPathEnvironment = process.env,
  roamingAppDataFallback?: string,
): string {
  const configured = environment.LNWJUD_DATA_PATH?.trim();
  if (configured) return path.resolve(configured);

  const xdgData = environment.XDG_DATA_HOME?.trim();
  if (xdgData) return path.resolve(xdgData, 'lnwjud');

  const appData = firstNonEmpty(
    environment.APPDATA,
    roamingAppDataFallback,
    environment.USERPROFILE ? path.join(environment.USERPROFILE, 'AppData', 'Roaming') : undefined,
    environment.HOME ? (process.platform === 'win32' ? path.join(environment.HOME, 'AppData', 'Roaming') : path.join(environment.HOME, '.local', 'share')) : undefined,
    process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : path.join(os.homedir(), '.local', 'share'),
  );
  return path.resolve(appData, 'lnwjud');
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return path.join(os.homedir(), 'AppData', 'Roaming');
}
