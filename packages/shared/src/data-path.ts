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
  electronAppData?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const configured = environment.LNWJUD_DATA_PATH?.trim();
  if (configured) return pathApi.resolve(configured);

  const home = firstNonEmpty(environment.HOME, os.homedir());
  if (platform === 'win32') {
    const appData = firstNonEmpty(
      environment.APPDATA,
      electronAppData,
      environment.USERPROFILE ? pathApi.join(environment.USERPROFILE, 'AppData', 'Roaming') : undefined,
      home ? pathApi.join(home, 'AppData', 'Roaming') : undefined,
      pathApi.join(os.homedir(), 'AppData', 'Roaming'),
    );
    return pathApi.resolve(appData, 'lnwjud');
  }

  if (platform === 'darwin') {
    const appData = firstNonEmpty(
      electronAppData,
      home ? pathApi.join(home, 'Library', 'Application Support') : undefined,
      pathApi.join(os.homedir(), 'Library', 'Application Support'),
    );
    return pathApi.resolve(appData, 'lnwjud');
  }

  const xdgDataHome = environment.XDG_DATA_HOME?.trim();
  const appData = firstNonEmpty(
    electronAppData,
    xdgDataHome && pathApi.isAbsolute(xdgDataHome) ? xdgDataHome : undefined,
    home ? pathApi.join(home, '.local', 'share') : undefined,
    pathApi.join(os.homedir(), '.local', 'share'),
  );
  return pathApi.resolve(appData, 'lnwjud');
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return path.join(os.homedir(), 'AppData', 'Roaming');
}
