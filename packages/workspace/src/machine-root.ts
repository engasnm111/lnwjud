import os from 'node:os';
import path from 'node:path';
import { classifyFilesystemRoot, hostPathApi, normalizeHostWorkspaceRoot, type FilesystemRoot } from './filesystem-root.js';

function coerceWindowsPath(rootPath: string): string {
  const raw = rootPath.trim().replaceAll('/', '\\');
  if (/^[A-Za-z]:$/i.test(raw)) return `${raw}\\`;
  return raw;
}

export function normalizeWorkspaceRoot(rootPath: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = platform === 'win32'
    ? normalizeHostWorkspaceRoot(coerceWindowsPath(rootPath), platform)
    : normalizeHostWorkspaceRoot(rootPath, platform);
  return normalized ?? rootPath.trim();
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

/** True when a path is contained by the supplied machine drive root. */
export function isUnderMachineRoot(rootPath: string, machineRoot: string): boolean {
  const root = driveRootForPath(machineRoot);
  const candidate = driveRootForPath(rootPath);
  return root !== null && candidate !== null && root.toLowerCase() === candidate.toLowerCase();
}

/** Host-aware machine-root classification used by Desktop/STDIO filtering. */
export function filesystemRootForPath(rootPath: string, platform: NodeJS.Platform = process.platform): FilesystemRoot | null {
  return classifyFilesystemRoot(rootPath, platform);
}

/** True for Windows drive/UNC roots or explicit POSIX mount roots. */
export function isMachineRootPath(rootPath: string, platform: NodeJS.Platform = process.platform): boolean {
  return filesystemRootForPath(rootPath, platform) !== null;
}

/**
 * Resolve the restricted machine root from the active workspace first, then
 * normal Windows environment/cwd/home locations. No drive letter is fixed in code.
 */
export function machineRootPath(
  preferredPath?: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') {
    const api = hostPathApi(platform);
    const candidate = preferredPath ?? environment.HOME ?? os.homedir() ?? process.cwd();
    return api.parse(api.resolve(candidate)).root;
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
  return path.parse(path.resolve(preferredPath ?? '.')).root;
}
