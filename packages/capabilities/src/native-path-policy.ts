import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, isFullBypassAuthorization, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import { readCapabilityActiveWorkspaceRoot } from './task-ownership.js';

export type NativePathField = 'file_path' | 'output_path' | 'target_path' | 'merge_paths';

export interface NativePathPolicyOptions {
  /** Fallback canonical roots for direct internal calls without Active Project metadata. */
  readonly allowedRootsProvider?: () => Promise<readonly string[]>;
}

/**
 * Provider-neutral path boundary for native capabilities.
 *
 * Host-bound MCP calls carry a canonical Active Project root in trusted metadata.
 * Full Bypass removes the project-root restriction but never skips path existence /
 * canonical-parent validation. This contract is intentionally shared by Windows,
 * macOS, and future Linux native providers.
 */
export class NativeCapabilityPathPolicy {
  public constructor(
    private readonly capability: string,
    private readonly pathFields: readonly NativePathField[],
    private readonly options: NativePathPolicyOptions = {},
  ) {}

  public async assertAllowed(input: Record<string, unknown>, authorization?: InvocationAuthorization): Promise<Result<void>> {
    const targets: { readonly field: NativePathField; readonly value: string }[] = [];
    for (const field of this.pathFields) {
      const value = input[field];
      if (typeof value === 'string' && value.trim().length > 0) targets.push({ field, value: value.trim() });
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === 'string' && entry.trim().length > 0) targets.push({ field, value: entry.trim() });
        }
      }
    }
    if (targets.length === 0) return ok(undefined);

    if (isFullBypassAuthorization(authorization)) {
      for (const target of targets) {
        if (await canonicalizeNativePath(target.field, target.value) === null) {
          return err(appError('INVALID_INPUT', `${this.capability} target path is unavailable`));
        }
      }
      return ok(undefined);
    }

    const roots = await this.canonicalAllowedRoots(input);
    if (roots.length === 0) {
      return err(appError('PATH_OUTSIDE_WORKSPACE', `${this.capability} path operation requires an available Active Project root`));
    }
    for (const target of targets) {
      const canonicalTarget = await canonicalizeNativePath(target.field, target.value);
      if (canonicalTarget === null || !roots.some((root) => isWithin(root, canonicalTarget))) {
        return err(appError('PATH_OUTSIDE_WORKSPACE', `${this.capability} target path is outside the Active Project`));
      }
    }
    return ok(undefined);
  }

  private async canonicalAllowedRoots(input: Record<string, unknown>): Promise<readonly string[]> {
    const activeWorkspaceRoot = readCapabilityActiveWorkspaceRoot(input);
    let configured: readonly string[];
    if (activeWorkspaceRoot !== undefined) {
      configured = [activeWorkspaceRoot];
    } else if (this.options.allowedRootsProvider !== undefined) {
      try {
        configured = await this.options.allowedRootsProvider();
      } catch {
        return [];
      }
    } else {
      return [];
    }

    const roots: string[] = [];
    for (const candidate of configured) {
      try {
        const canonical = await realpath(path.resolve(candidate));
        if ((await stat(canonical)).isDirectory()) roots.push(canonical);
      } catch {
        continue;
      }
    }
    return roots;
  }
}

async function canonicalizeNativePath(field: NativePathField, value: string): Promise<string | null> {
  if (value.includes('\0')) return null;
  const absolute = path.resolve(value);
  if (field !== 'output_path' && field !== 'target_path') {
    try {
      return await realpath(absolute);
    } catch {
      return null;
    }
  }

  try {
    return await realpath(absolute);
  } catch {
    try {
      const parent = await realpath(path.dirname(absolute));
      if (!(await stat(parent)).isDirectory()) return null;
      return path.join(parent, path.basename(absolute));
    } catch {
      return null;
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  const [firstSegment] = relative.split(path.sep);
  return firstSegment !== '..';
}
