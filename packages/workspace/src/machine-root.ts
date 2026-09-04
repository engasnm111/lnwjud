import os from 'node:os';
import path from 'node:path';
import { isFilesystemRoot, normalizePathForComparison } from './path-containment.js';

function coerceWindowsPath(rootPath: string): string {
  const raw = rootPath.trim().replaceAll('/', '\\');
  if (/^[A-Za-z]:$/i.test(raw)) return `${raw}\\`;
  return raw;
}

export function normalizeWorkspaceRoot(rootPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32' || /^[A-Za-z]:(?:[\\/]|$)/.test(rootPath.trim()) || rootPath.trim().startsWith('\\\\')) {
    const resolved = path.win32.resolve(coerceWindowsPath(rootPath));
    return resolved.endsWith(path.win32.sep) ? resolved : `${resolved}${path.win32.sep}`;
  }
  const resolved = path.posix.resolve(rootPath.trim());
  return resolved.endsWith(path.posix.sep) ? resolved : `${resolved}${path.posix.sep}`;
}

/** Return the Windows drive root that owns a path, without requiring the drive to exist. */
export function driveRootForPath(rootPath: string | undefined): string | null {
  if (typeof rootPath !== 'string' || rootPath.trim().length === 0) return null;
  const raw = coerceWindowsPath(rootPath);
  const match = /^([A-Za-z]):(?:\\|$)/.exec(raw);
  const letter = match?.[1];
  return letter === undefined ? null : `${letter.toUpperCase()}:\\`;
}

/** True when the path is any Windows drive root (C:\\, D:\\, …). */
export function isDriveRoot(rootPath: string): boolean {
  return /^[A-Za-z]:\\?$/.test(coerceWindowsPath(rootPath));
}

/**
 * Neutral root guard used by trust-boundary code. POSIX `/` and whole Windows
 * filesystem roots are never treated as ordinary project roots automatically.
 */
export function isMachineWideRoot(rootPath: string, platform: NodeJS.Platform = process.platform): boolean {
  return isFilesystemRoot(rootPath, platform);
}

/** True when a path is contained by the supplied machine drive root. */
export function isUnderMachineRoot(rootPath: string, machineRoot: string): boolean {
  const root = driveRootForPath(machineRoot);
  const candidate = driveRootForPath(rootPath);
  return root !== null && candidate !== null && root.toLowerCase() === candidate.toLowerCase();
}

/**
 * Windows compatibility helper retained for legacy callers. On POSIX it never
 * falls back to `/`; an explicit project path is required and is returned as the
 * scoped root instead. This prevents accidental whole-machine trust.
 */
export function machineRootPath(
  preferredPath?: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') {
    const preferred = preferredPath?.trim();
    if (preferred === undefined || preferred.length === 0) {
      throw new Error('A scoped project path is required for machineRootPath on POSIX');
    }
    return path.posix.resolve(preferred);
  }

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
  throw new Error('Unable to resolve a Windows machine root');
}

/** Compare workspace roots using Windows case folding only for Windows paths. */
export function workspaceRootComparisonKey(rootPath: string, platform: NodeJS.Platform = process.platform): string {
  return normalizePathForComparison(rootPath, platform);
}
