import os from 'node:os';
import path from 'node:path';

export interface DataPathEnvironment {
  readonly LNWJUD_DATA_PATH?: string;
  readonly APPDATA?: string;
  readonly USERPROFILE?: string;
  readonly HOME?: string;
}

/** Resolve the per-user lnwjud data directory without embedding a developer profile path. */
export function resolveLnwjudDataPath(
  environment: DataPathEnvironment = process.env,
  roamingAppDataFallback?: string,
): string {
  const configured = environment.LNWJUD_DATA_PATH?.trim();
  if (configured) {
    if (/^[A-Za-z]:[\\/]/.test(configured)) return path.win32.resolve(configured);
    return path.resolve(configured);
  }

  const defaultAppData = getDefaultAppData(environment);
  const appData = firstNonEmpty(
    environment.APPDATA,
    roamingAppDataFallback,
    environment.USERPROFILE ? path.win32.join(environment.USERPROFILE, 'AppData', 'Roaming') : undefined,
    defaultAppData,
  );

  if (/^[A-Za-z]:[\\/]/.test(appData)) {
    return path.win32.resolve(appData, 'lnwjud');
  }
  return path.resolve(appData, 'lnwjud');
}

function getDefaultAppData(environment: DataPathEnvironment): string {
  if (process.platform === 'darwin') {
    const home = environment.HOME?.trim() || os.homedir();
    return path.join(home, 'Library', 'Application Support');
  }
  if (process.platform !== 'win32') {
    const home = environment.HOME?.trim() || os.homedir();
    return path.join(home, '.local', 'share');
  }
  const home = environment.USERPROFILE?.trim() || environment.HOME?.trim() || os.homedir();
  return path.join(home, 'AppData', 'Roaming');
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return getDefaultAppData({});
}
