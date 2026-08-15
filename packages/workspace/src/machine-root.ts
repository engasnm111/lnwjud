import { existsSync } from 'node:fs';
import path from 'node:path';

/** Only drive E: is allowed as a machine root. */
export const MACHINE_ROOT_LETTER = 'E';

function coerceWindowsPath(rootPath: string): string {
  const raw = rootPath.trim().replaceAll('/', '\\');
  // path.resolve('E:') expands to the process cwd on E: — force the drive root instead.
  if (/^[A-Za-z]:$/i.test(raw)) return `${raw}\\`;
  return raw;
}

export function normalizeWorkspaceRoot(rootPath: string): string {
  const resolved = path.resolve(coerceWindowsPath(rootPath));
  return resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
}

/** True when the path is exactly the E: drive root (e.g. E:\). */
export function isEMachineRoot(rootPath: string): boolean {
  const resolved = path.resolve(coerceWindowsPath(rootPath));
  const stripped = resolved.replace(/[\\/]+$/, '');
  return /^E:$/i.test(stripped);
}

/** True when the path is any Windows drive root (C:\, D:\, …). */
export function isDriveRoot(rootPath: string): boolean {
  const resolved = path.resolve(coerceWindowsPath(rootPath));
  const stripped = resolved.replace(/[\\/]+$/, '');
  return /^[A-Za-z]:$/i.test(stripped);
}

/** True when the path is on drive E: (including E:\ itself and subfolders). */
export function isUnderEDrive(rootPath: string): boolean {
  const resolved = path.resolve(coerceWindowsPath(rootPath));
  const normalized = normalizeWorkspaceRoot(resolved).replaceAll('/', '\\').toLowerCase();
  return normalized.startsWith('e:\\');
}

export function machineRootPath(): string {
  return `${MACHINE_ROOT_LETTER}:\\`;
}

/** Lists every fixed drive root that exists on this machine (C:\, D:\, …). */
export function allFixedDriveRoots(): readonly string[] {
  const roots: string[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (existsSync(root)) roots.push(root);
  }
  return roots;
}

/**
 * Machine roots for the current access mode:
 * E:\ only by default; every existing fixed drive root in unrestricted mode.
 */
export function machineRootPaths(unrestricted: boolean): readonly string[] {
  return unrestricted ? allFixedDriveRoots() : [machineRootPath()];
}
