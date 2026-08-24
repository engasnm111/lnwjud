import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function coerceWindowsPath(rootPath: string): string {
  const raw = rootPath.trim();
  if (/^[A-Za-z]:/i.test(raw)) {
    const converted = raw.replaceAll('/', '\\');
    return /^[A-Za-z]:$/i.test(converted) ? `${converted}\\` : converted;
  }
  return process.platform === 'win32' ? raw.replaceAll('/', '\\') : raw;
}

export function normalizeWorkspaceRoot(rootPath: string): string {
  const resolved = path.resolve(coerceWindowsPath(rootPath));
  return resolved.endsWith(path.sep) ? resolved : `${resolved}${path.sep}`;
}

/** Return the drive or machine root that owns a path, without requiring the drive to exist. */
export function driveRootForPath(rootPath: string | undefined): string | null {
  if (typeof rootPath !== 'string' || rootPath.trim().length === 0) return null;
  const raw = rootPath.trim();
  const match = /^([A-Za-z]):(?:[\\/]|$)/.exec(raw);
  const letter = match?.[1];
  if (letter !== undefined) return `${letter.toUpperCase()}:\\`;
  if (raw.startsWith('/') || path.isAbsolute(raw)) {
    return path.parse(path.resolve(raw)).root || '/';
  }
  return null;
}

/** True when the path is any Windows drive root (C:\\, D:\\, …) or POSIX root (/). */
export function isDriveRoot(rootPath: string): boolean {
  const trimmed = rootPath.trim();
  if (trimmed === '/' || trimmed === path.sep) return true;
  return /^[A-Za-z]:[\\/]?$/.test(trimmed);
}

/** True when a path is contained by the supplied machine drive root. */
export function isUnderMachineRoot(rootPath: string, machineRoot: string): boolean {
  const root = driveRootForPath(machineRoot);
  const candidate = driveRootForPath(rootPath);
  if (root === null || candidate === null) return false;
  if (root === '/' && candidate === '/') return true;
  return root.toLowerCase() === candidate.toLowerCase();
}

/**
 * Resolve the restricted machine root from the active workspace first, then
 * normal Windows environment/cwd/home locations. No drive letter is fixed in code.
 */
export function machineRootPath(
  preferredPath?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const candidates = [
    preferredPath,
    environment.SystemDrive,
    environment.HOMEDRIVE,
  ];
  for (const candidate of candidates) {
    const root = driveRootForPath(candidate);
    if (root !== null) return root;
  }
  if (process.platform !== 'win32' && (!preferredPath || !/^[A-Za-z]:/i.test(preferredPath))) {
    return '/';
  }
  for (const candidate of [process.cwd(), os.homedir()]) {
    const root = driveRootForPath(candidate);
    if (root !== null) return root;
  }
  return path.parse(path.resolve(preferredPath ?? '.')).root || (process.platform === 'win32' ? 'C:\\' : '/');
}

/** Lists every fixed drive root that exists on this machine (C:\\, D:\\, … or /). */
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
  if (unrestricted) {
    const fixed = allFixedDriveRoots();
    if (preferredPath) {
      const preferredRoot = driveRootForPath(preferredPath);
      if (preferredRoot && !fixed.includes(preferredRoot)) return [preferredRoot, ...fixed];
    }
    return fixed;
  }
  return [machineRootPath(preferredPath)];
}
