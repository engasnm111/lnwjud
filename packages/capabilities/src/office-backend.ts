import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, isApplicationAuthorized, isFullBypassAuthorization, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import { readCapabilityActiveWorkspaceRoot } from './task-ownership.js';
import type { CapabilityBackend } from './local-capability-service.js';

const ACTIONS = ['status', 'read', 'read_text', 'sheets', 'list_folders', 'list_messages', 'write', 'replace', 'merge', 'save_as'] as const;
const READ_ACTIONS = new Set(['read', 'read_text', 'sheets', 'list_folders', 'list_messages']);
const PATH_FIELDS = ['file_path', 'target_path', 'merge_paths'] as const;
const MAX_PATHS = 16;

export interface PlatformOfficeBackendOptions {
  readonly platform: 'darwin' | 'linux';
  readonly backend: string;
  readonly dependency: string;
  readonly supportedApps: readonly string[];
  readonly dependencyAvailable?: () => boolean;
  readonly allowedRootsProvider?: () => Promise<readonly string[]>;
}

/**
 * Dependency-gated Office boundary shared by the target-specific adapters.
 * It intentionally does not emulate COM: a future UNO/Apple Events bridge
 * must be added behind this boundary after its own ownership and fixture gates.
 */
export class PlatformOfficeCapabilityBackend implements CapabilityBackend {
  private readonly dependencyAvailable: () => boolean;
  private readonly rootsProvider: () => Promise<readonly string[]>;

  public constructor(private readonly options: PlatformOfficeBackendOptions) {
    this.dependencyAvailable = options.dependencyAvailable ?? ((): boolean => false);
    this.rootsProvider = options.allowedRootsProvider ?? (async (): Promise<readonly string[]> => []);
  }

  public async execute(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (!isRecord(input)) return err(appError('INVALID_INPUT', 'office input must be an object'));
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'office operation was cancelled', true));
    const action = readAction(input);
    if (action === null) return err(appError('INVALID_INPUT', 'office action is invalid'));
    if (input.dry_run === true) return ok({ dry_run: true, capability: 'office', platform: this.options.platform, action });
    if (action === 'status') return ok(this.status());

    const app = typeof input.app === 'string' ? input.app.trim().toLowerCase() : '';
    if (app.length > 0 && !this.options.supportedApps.includes(app)) {
      return err(appError('UNSUPPORTED_PLATFORM', `${this.options.platform} Office app '${app}' is not supported by this provider`, true));
    }
    const paths = collectPaths(input);
    if (paths.length > MAX_PATHS) return err(appError('INVALID_INPUT', `office accepts at most ${MAX_PATHS} path targets`));
    const pathCheck = await this.assertPaths(paths, input, authorization, signal);
    if (!pathCheck.ok) return pathCheck;
    if (!READ_ACTIONS.has(action) && !isApplicationAuthorized(authorization, input.userConfirmed === true)) {
      return err(appError('PERMISSION_REQUIRED', `${this.options.platform} Office mutation requires explicit user confirmation`));
    }
    if (!this.dependencyAvailable()) {
      return err(appError('EXECUTABLE_NOT_FOUND', `${this.options.dependency} is not installed or available`, true));
    }
    return err(appError('UNSUPPORTED_PLATFORM', `${this.options.platform} Office provider is dependency-gated; this action has no implemented bridge`, true));
  }

  private status(): Record<string, unknown> {
    const available = this.dependencyAvailable();
    return {
      available,
      ready: false,
      local: true,
      backend: this.options.backend,
      platform: this.options.platform,
      supportedActions: [...ACTIONS],
      reason: available ? 'provider_not_implemented' : 'dependency_missing',
      readinessReason: available ? 'provider_not_implemented' : 'dependency_missing',
      dependencyState: available ? 'present' : 'missing',
    };
  }

  private async assertPaths(
    paths: readonly { readonly field: string; readonly value: string }[],
    input: Record<string, unknown>,
    authorization: InvocationAuthorization | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Result<void>> {
    if (paths.length === 0) return ok(undefined);
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'office path check was cancelled', true));
    const targetPaths = new Set(paths.filter(({ field }) => field === 'target_path').map(({ value }) => value));
    if (isFullBypassAuthorization(authorization)) {
      for (const item of paths) {
        if (isForeignPathSyntax(item.value, this.options.platform)) return err(appError('INVALID_INPUT', `office ${item.field} uses a foreign host path syntax`));
        if (await canonicalize(item.value, targetPaths.has(item.value), this.options.platform) === null) return err(appError('INVALID_INPUT', `office ${item.field} is unavailable`));
      }
      return ok(undefined);
    }
    const active = readCapabilityActiveWorkspaceRoot(input);
    const roots = active === undefined ? await this.rootsProvider() : [active];
    const canonicalRoots = (await Promise.all(roots.map((root) => canonicalize(root, false, this.options.platform)))).filter((root): root is string => root !== null);
    if (canonicalRoots.length === 0) return err(appError('PATH_OUTSIDE_WORKSPACE', 'office path operation requires an available Active Project root'));
    for (const item of paths) {
      if (isForeignPathSyntax(item.value, this.options.platform)) return err(appError('INVALID_INPUT', `office ${item.field} uses a foreign host path syntax`));
      const canonical = await canonicalize(item.value, targetPaths.has(item.value), this.options.platform);
      if (canonical === null || !canonicalRoots.some((root) => isWithin(root, canonical))) {
        return err(appError('PATH_OUTSIDE_WORKSPACE', `office ${item.field} is outside the Active Project`));
      }
    }
    return ok(undefined);
  }
}

function readAction(input: Record<string, unknown>): (typeof ACTIONS)[number] | null {
  const raw = input.action ?? input.operation;
  return typeof raw === 'string' && (ACTIONS as readonly string[]).includes(raw) ? raw as (typeof ACTIONS)[number] : null;
}

function collectPaths(input: Record<string, unknown>): readonly { readonly field: string; readonly value: string }[] {
  const paths: { field: string; value: string }[] = [];
  for (const field of PATH_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value.trim().length > 0) paths.push({ field, value: value.trim() });
    else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string' && item.trim().length > 0) paths.push({ field, value: item.trim() });
  }
  return paths;
}

async function canonicalize(value: string, allowMissingLeaf: boolean, platform: 'darwin' | 'linux'): Promise<string | null> {
  if (value.includes('\0') || isForeignPathSyntax(value, platform)) return null;
  const absolute = path.resolve(value);
  try {
    const resolved = await realpath(absolute);
    const info = await stat(resolved);
    return info.isFile() || info.isDirectory() ? resolved : null;
  } catch {
    if (!allowMissingLeaf) return null;
    try {
      const parent = await realpath(path.dirname(absolute));
      const info = await stat(parent);
      return info.isDirectory() ? path.join(parent, path.basename(absolute)) : null;
    } catch { return null; }
  }
}

function isForeignPathSyntax(value: string, platform: 'darwin' | 'linux'): boolean {
  if (platform === 'darwin' || platform === 'linux') {
    const input = value.trim();
    return input.includes('\\') || /^[A-Za-z]:[\\/]/u.test(input) || input.startsWith('//');
  }
  return false;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && !relative.split(path.sep).includes('..'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function executableInPath(name: string): boolean {
  const pathValue = process.env.PATH ?? '';
  return pathValue.split(':').filter(Boolean).some((entry) => existsSync(path.posix.join(entry, name)));
}
