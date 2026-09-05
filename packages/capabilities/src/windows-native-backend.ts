import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  appError,
  err,
  isApplicationAuthorized,
  isFullBypassAuthorization,
  ok,
  type InvocationAuthorization,
  type Result,
} from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';
import { readCapabilityActiveWorkspaceRoot } from './task-ownership.js';

export type WindowsCapabilityName =
  | 'accessibility'
  | 'input_event'
  | 'vision'
  | 'window'
  | 'system_info'
  | 'notification'
  | 'file_dialog'
  | 'clipboard'
  | 'audio'
  | 'screen_record'
  | 'office';

export interface WindowsCapabilityBridge {
  execute(request: { readonly capability: WindowsCapabilityName; readonly input: unknown }, signal?: AbortSignal): Promise<Result<unknown>>;
}

export interface WindowsNativeBackendOptions {
  /**
   * Fallback canonical roots for direct internal calls. Host-bound MCP calls
   * carry one Active Project root in trusted metadata, which takes precedence.
   */
  readonly allowedRootsProvider?: () => Promise<readonly string[]>;
  /** @deprecated Retained for caller compatibility; path-bearing native tools remain scoped. */
  readonly unrestricted?: boolean;
}

type NativePathField = 'file_path' | 'output_path' | 'target_path' | 'merge_paths';

const PATH_FIELDS: Readonly<Record<WindowsCapabilityName, readonly NativePathField[]>> = {
  accessibility: [],
  input_event: [],
  vision: [],
  window: [],
  system_info: [],
  notification: [],
  file_dialog: [],
  clipboard: [],
  audio: ['file_path', 'output_path'],
  screen_record: ['output_path'],
  office: ['file_path', 'target_path', 'merge_paths'],
};

export class WindowsNativeCapabilityBackend implements CapabilityBackend {
  public constructor(
    private readonly capability: WindowsCapabilityName,
    private readonly bridge: WindowsCapabilityBridge,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly options: WindowsNativeBackendOptions = {},
  ) {}

  public async execute(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (this.platform !== 'win32') return err(appError('INTERNAL_ERROR', 'Windows capability is unavailable on this platform', true));
    if (!isRecord(input)) return err(appError('INVALID_INPUT', 'Native capability input must be an object'));
    if (input.dry_run === true) return ok({ dry_run: true, capability: this.capability });
    if (isSignalAborted(signal)) return cancelledOperation();

    const pathCheck = await this.assertPathsAllowed(input, authorization);
    if (!pathCheck.ok) return pathCheck;
    if (isSignalAborted(signal)) return cancelledOperation();
    if (requiresExplicitConfirmation(this.capability, input) && !isApplicationAuthorized(authorization, input.userConfirmed === true)) {
      return err(appError('PERMISSION_REQUIRED', `${this.capability} action requires explicit user confirmation`));
    }

    return this.bridge.execute({ capability: this.capability, input }, signal);
  }

  private async assertPathsAllowed(input: Record<string, unknown>, authorization?: InvocationAuthorization): Promise<Result<void>> {
    const targets: { readonly field: NativePathField; readonly value: string }[] = [];
    for (const field of PATH_FIELDS[this.capability]) {
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

function cancelledOperation(): Result<never> {
  return err(appError('PROCESS_TIMEOUT', 'Windows capability operation was cancelled', true));
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function requiresExplicitConfirmation(capability: WindowsCapabilityName, input: Record<string, unknown>): boolean {
  const action = typeof input.action === 'string'
    ? input.action
    : typeof input.operation === 'string'
      ? input.operation
      : '';
  switch (capability) {
    case 'accessibility':
      return !['status', 'list_windows', 'observe', 'observe_summary', 'observe_changes', 'inspect_elements', 'find_element', 'read_value'].includes(action);
    case 'input_event': return true;
    case 'window': return !['list', 'get_active', 'get_bounds', 'get_display'].includes(action);
    case 'clipboard': return action !== 'get_text' && action !== 'get_image';
    case 'audio': return true;
    case 'screen_record': return action !== 'status';
    case 'office': {
      const app = typeof input.app === 'string' ? input.app : '';
      if (app === 'excel') return action !== 'read' && action !== 'sheets';
      if (app === 'word') return action !== 'read_text';
      if (app === 'powerpoint') return action !== 'read';
      if (app === 'outlook') return action !== 'list_folders' && action !== 'list_messages';
      return true;
    }
    default: return false;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  const [firstSegment] = relative.split(path.sep);
  return firstSegment !== '..';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
