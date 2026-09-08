import path from 'node:path';

export type FilesystemRootKind = 'windows_drive' | 'windows_unc' | 'posix_mount';

export interface FilesystemRoot {
  readonly kind: FilesystemRootKind;
  readonly rootPath: string;
}

export type HostPathApi = typeof path.posix;

/** Return the path implementation for the host being composed. */
export function hostPathApi(platform: NodeJS.Platform = process.platform): HostPathApi {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** True when a path is absolute in the selected host syntax and not foreign syntax. */
export function isAbsoluteHostPath(value: string, platform: NodeJS.Platform = process.platform): boolean {
  return !isForeignAbsolutePath(value, platform) && hostPathApi(platform).isAbsolute(value);
}

/** Foreign absolute paths are never separator-rewritten into a host target. */
export function isForeignAbsolutePath(value: string, platform: NodeJS.Platform = process.platform): boolean {
  const input = value.trim();
  if (platform === 'win32') {
    // A single leading slash is POSIX-root syntax. Drive-qualified and UNC
    // paths may use forward slashes and remain valid Windows paths.
    return input.startsWith('/') && !input.startsWith('//') && !/^[A-Za-z]:[\\/]/.test(input);
  }
  return /^[A-Za-z]:[\\/]/.test(input) || input.startsWith('\\\\') || input.startsWith('//');
}

/** Resolve a path only when it is native to the selected host. */
export function resolveHostPath(value: string, platform: NodeJS.Platform = process.platform): string | null {
  if (isForeignAbsolutePath(value, platform)) return null;
  return hostPathApi(platform).resolve(value);
}

/** Normalize a path only when it is native to the selected host. */
export function normalizeHostPath(value: string, platform: NodeJS.Platform = process.platform): string | null {
  if (isForeignAbsolutePath(value, platform)) return null;
  return hostPathApi(platform).normalize(value);
}

/** Compute a host-native relative path, returning null for foreign syntax. */
export function relativeHostPath(rootPath: string, candidatePath: string, platform: NodeJS.Platform = process.platform): string | null {
  const root = resolveHostPath(rootPath, platform);
  const candidate = resolveHostPath(candidatePath, platform);
  if (root === null || candidate === null) return null;
  return hostPathApi(platform).relative(root, candidate);
}

/** Compare paths using host case rules while preserving POSIX case sensitivity. */
export function comparableHostPath(value: string, platform: NodeJS.Platform = process.platform): string | null {
  const normalized = normalizeHostPath(value, platform);
  if (normalized === null) return null;
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Classify only actual filesystem roots. A normal POSIX project such as
 * `/home/alice/project` is not a machine root; `/`, `/mnt/data`, and
 * `/Volumes/Data` are mount roots and must never become implicit workspaces.
 */
export function classifyFilesystemRoot(rootPath: string, platform: NodeJS.Platform = process.platform): FilesystemRoot | null {
  const input = rootPath.trim();
  if (input.length === 0) return null;

  if (platform === 'win32') {
    const normalized = path.win32.normalize(input.replaceAll('/', '\\'));
    if (/^[A-Za-z]:\\?$/.test(normalized)) {
      return { kind: 'windows_drive', rootPath: normalized.endsWith('\\') ? normalized : `${normalized}\\` };
    }
    if (/^\\\\[^\\]+\\[^\\]+\\?$/.test(normalized)) {
      return { kind: 'windows_unc', rootPath: normalized.endsWith('\\') ? normalized : `${normalized}\\` };
    }
    return null;
  }

  if (isForeignAbsolutePath(input, platform)) return null;
  const normalized = path.posix.normalize(input);
  const isKnownMount = normalized === '/'
    || /^\/Volumes\/[^/]+$/u.test(normalized)
    || /^\/mnt\/[^/]+$/u.test(normalized)
    || /^\/media\/[^/]+(?:\/[^/]+)?$/u.test(normalized)
    || /^\/run\/media\/[^/]+\/[^/]+$/u.test(normalized);
  if (isKnownMount) {
    return { kind: 'posix_mount', rootPath: normalized };
  }
  return null;
}

/** True for a machine/mount root on the selected host. */
export function isFilesystemRoot(rootPath: string, platform: NodeJS.Platform = process.platform): boolean {
  return classifyFilesystemRoot(rootPath, platform) !== null;
}

/** POSIX mount roots are diagnostic boundaries, never implicit project roots. */
export function isPosixMountRoot(rootPath: string, platform: NodeJS.Platform = process.platform): boolean {
  return classifyFilesystemRoot(rootPath, platform)?.kind === 'posix_mount';
}

/** Normalize a workspace root with exactly one trailing host separator. */
export function normalizeHostWorkspaceRoot(rootPath: string, platform: NodeJS.Platform = process.platform): string | null {
  const resolved = resolveHostPath(rootPath, platform);
  if (resolved === null) return null;
  const api = hostPathApi(platform);
  if (resolved === api.parse(resolved).root) return resolved;
  return resolved.endsWith(api.sep) ? resolved : `${resolved}${api.sep}`;
}

/** Host-aware containment with Windows case-insensitivity and POSIX boundaries. */
export function isHostPathWithin(rootPath: string, candidatePath: string, platform: NodeJS.Platform = process.platform): boolean {
  const root = comparableHostPath(rootPath, platform);
  const candidate = comparableHostPath(candidatePath, platform);
  if (root === null || candidate === null) return false;
  const relative = hostPathApi(platform).relative(root, candidate);
  if (relative === '') return true;
  if (hostPathApi(platform).isAbsolute(relative)) return false;
  const [firstSegment] = relative.split(hostPathApi(platform).sep);
  return firstSegment !== '..' && firstSegment !== '';
}
