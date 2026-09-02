import path from 'node:path';

export type FilesystemPathFlavor = 'windows' | 'posix';
export type FilesystemPathApi = typeof path.win32 | typeof path.posix;

/**
 * Pick path semantics from the canonical/root path rather than from the host OS.
 * This keeps persisted Windows workspaces comparable during migration while native
 * POSIX paths remain case-sensitive and never inherit win32 drive semantics.
 */
export function filesystemPathFlavor(rootPath: string, platform: NodeJS.Platform = process.platform): FilesystemPathFlavor {
  if (looksLikeWindowsPath(rootPath)) return 'windows';
  if (path.posix.isAbsolute(rootPath)) return 'posix';
  return platform === 'win32' ? 'windows' : 'posix';
}

export function filesystemPathApi(rootPath: string, platform: NodeJS.Platform = process.platform): FilesystemPathApi {
  return filesystemPathFlavor(rootPath, platform) === 'windows' ? path.win32 : path.posix;
}

export function normalizePathForComparison(rootPath: string, platform: NodeJS.Platform = process.platform): string {
  const pathApi = filesystemPathApi(rootPath, platform);
  const resolved = pathApi.resolve(rootPath);
  const normalized = resolved.endsWith(pathApi.sep) ? resolved : `${resolved}${pathApi.sep}`;
  return pathApi === path.win32 ? normalized.toLowerCase() : normalized;
}

/** True only for a whole filesystem root such as C:\\, a UNC share root, or /. */
export function isFilesystemRoot(rootPath: string, platform: NodeJS.Platform = process.platform): boolean {
  if (rootPath.trim().length === 0) return false;
  const pathApi = filesystemPathApi(rootPath, platform);
  const resolved = pathApi.resolve(rootPath);
  return resolved === pathApi.parse(resolved).root;
}

export function isWithin(rootPath: string, candidatePath: string, platform: NodeJS.Platform = process.platform): boolean {
  const pathApi = filesystemPathApi(rootPath, platform);
  if (filesystemPathFlavor(candidatePath, platform) !== filesystemPathFlavor(rootPath, platform)
    && (path.win32.isAbsolute(candidatePath) || path.posix.isAbsolute(candidatePath))) {
    return false;
  }
  const relativePath = pathApi.relative(pathApi.resolve(rootPath), pathApi.resolve(candidatePath));
  if (relativePath === '') return true;
  if (pathApi.isAbsolute(relativePath)) return false;
  const [firstSegment] = relativePath.split(pathApi.sep);
  return firstSegment !== '..';
}

function looksLikeWindowsPath(value: string): boolean {
  const trimmed = value.trim();
  return /^[A-Za-z]:(?:[\\/]|$)/.test(trimmed) || /^\\\\[^\\]+\\[^\\]+/.test(trimmed);
}
