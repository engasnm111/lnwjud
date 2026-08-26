import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function coerceWindowsPath(rootPath: string): string {
  const raw = rootPath.trim().replaceAll('/', '\\');
  if (/^[A-Za-z]:$/i.test(raw)) return `${raw}\\`;
  return raw;
}

export function normalizeWorkspaceRoot(rootPath: string): string {
  if (process.platform !== 'win32' && rootPath.startsWith('/')) {
    const resolved = path.resolve(rootPath);
    return resolved.endsWith('/') ? resolved : `${resolved}/`;
  }
  const resolved = path.resolve(coerceWindowsPath(rootPath));
  return resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
}

/** Return the Windows drive root (or POSIX root `/`) that owns a path. */
export function driveRootForPath(rootPath: string | undefined): string | null {
  if (typeof rootPath !== 'string' || rootPath.trim().length === 0) return null;
  const raw = coerceWindowsPath(rootPath);
  const match = /^([A-Za-z]):(?:\\|$)/.exec(raw);
  const letter = match?.[1];
  if (letter !== undefined) return `${letter.toUpperCase()}:\\`;
  if (rootPath.startsWith('/') || path.isAbsolute(rootPath)) return '/';
  return null;
}

/** True when the path is any drive root or POSIX root (`/`). */
export function isDriveRoot(rootPath: string): boolean {
  const trimmed = rootPath.trim();
  if (trimmed === '/') return true;
  return /^[A-Za-z]:\\?$/.test(coerceWindowsPath(trimmed));
}

/** True when a path is contained by the supplied machine drive root. */
export function isUnderMachineRoot(rootPath: string, machineRoot: string): boolean {
  if (machineRoot === '/' || driveRootForPath(machineRoot) === '/') {
    return rootPath.startsWith('/') || path.isAbsolute(rootPath);
  }
  const root = driveRootForPath(machineRoot);
  const candidate = driveRootForPath(rootPath);
  return root !== null && candidate !== null && root.toLowerCase() === candidate.toLowerCase();
}

/**
 * Resolve the restricted machine root from the active workspace first, then
 * normal environment/cwd/home locations.
 */
export function machineRootPath(
  preferredPath?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const candidates = [
    preferredPath,
    environment.SystemDrive,
    environment.HOMEDRIVE,
    process.cwd(),
    os.homedir(),
  ];
  for (const candidate of candidates) {
    const root = driveRootForPath(candidate);
    if (root !== null) return root;
  }
  if (process.platform !== 'win32') return '/';
  return path.parse(path.resolve(preferredPath ?? '.')).root;
}

/** Lists every fixed drive root that exists on this machine. On POSIX returns `['/']`. */
export function allFixedDriveRoots(): readonly string[] {
  if (process.platform !== 'win32') {
    return ['/'];
  }
  const roots: string[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (existsSync(root)) roots.push(root);
  }
  return roots;
}

/** Machine roots for the current access mode. */
export function machineRootPaths(unrestricted: boolean, preferredPath?: string): readonly string[] {
  return unrestricted ? allFixedDriveRoots() : [machineRootPath(preferredPath)];
}
