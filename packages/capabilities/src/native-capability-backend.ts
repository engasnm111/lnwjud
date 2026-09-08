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
import { NativeHostProcessBridge } from './native-host-protocol.js';
import { readCapabilityActiveWorkspaceRoot } from './task-ownership.js';
import { isNativeCapabilityAction } from './native-capability-contract.js';

export type PortableNativeCapabilityName = 'accessibility' | 'input_event' | 'vision' | 'window' | 'audio' | 'screen_record' | 'office';
type NativePathField = 'file_path' | 'output_path' | 'target_path' | 'merge_paths';

const PATH_FIELDS: Readonly<Record<PortableNativeCapabilityName, readonly NativePathField[]>> = {
  accessibility: [], input_event: [], vision: [], window: [],
  audio: ['file_path', 'output_path'], screen_record: ['output_path'], office: ['file_path', 'target_path', 'merge_paths'],
};

export interface NativeCapabilityBackendOptions {
  readonly platform: 'darwin' | 'linux';
  readonly bridge?: NativeHostProcessBridge;
  readonly allowedRootsProvider?: () => Promise<readonly string[]>;
}

/**
 * Shared authorization/path boundary for macOS and Linux providers. The host
 * implementation remains platform-specific; this layer never turns a missing
 * native session into a successful Windows-shaped result.
 */
export class NativeCapabilityBackend implements CapabilityBackend {
  public constructor(
    private readonly capability: PortableNativeCapabilityName,
    private readonly options: NativeCapabilityBackendOptions,
  ) {}

  public async execute(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (!isRecord(input)) return err(appError('INVALID_INPUT', 'Native capability input must be an object'));
    if (input.dry_run === true) return ok({ dry_run: true, capability: this.capability, platform: this.options.platform });
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', `${this.capability} operation was cancelled`, true));
    const bridge = this.options.bridge;
    if (bridge === undefined) return ok(this.unavailable('native_host_missing'));
    const operation = readAction(input);
    if (!isNativeCapabilityAction(this.capability, operation)) {
      return err(appError('INVALID_INPUT', `${this.capability} action is not supported`));
    }
    if (operation === 'status') {
      const health = await bridge.execute('health', {}, signal, authorization);
      if (!health.ok) return health;
      const host = isRecord(health.value) ? health.value : {};
      const capabilityStatuses = isRecord(host.capabilities) ? host.capabilities : undefined;
      const capabilityStatus = capabilityStatuses === undefined ? undefined : capabilityStatuses[this.capability];
      if (isRecord(capabilityStatus)) {
        return ok({
          ...capabilityStatus,
          backend: `${this.options.platform}-native-host`,
          hostAvailable: host.available !== false,
          hostReady: host.ready !== false,
          local: true,
        });
      }
      // A healthy transport is not evidence that a provider is implemented or
      // that the desktop permission/session is ready. Keep the capability
      // visible but fail closed until the native host reports its own status.
      return ok({
        available: host.available !== false,
        ready: false,
        local: true,
        backend: `${this.options.platform}-native-host`,
        hostAvailable: host.available !== false,
        hostReady: host.ready !== false,
        reason: 'provider_not_implemented',
        readinessReason: 'provider_not_implemented',
      });
    }
    const pathCheck = await this.assertPathsAllowed(input, authorization);
    if (!pathCheck.ok) return pathCheck;
    if (requiresExplicitConfirmation(this.capability, input) && !isApplicationAuthorized(authorization, input.userConfirmed === true)) {
      return err(appError('PERMISSION_REQUIRED', `${this.capability} action requires explicit user confirmation`));
    }
    const result = await bridge.execute(this.capability, input, signal, authorization);
    if (!result.ok) return result;
    if (isRecord(result.value)) return ok({ ...result.value, backend: `${this.options.platform}-native-host`, available: result.value.available !== false });
    return ok({ backend: `${this.options.platform}-native-host`, available: true, value: result.value });
  }

  private unavailable(reason: string): Record<string, unknown> {
    return { available: false, ready: false, local: true, backend: `${this.options.platform}-native-host`, reason };
  }

  private async assertPathsAllowed(input: Record<string, unknown>, authorization?: InvocationAuthorization): Promise<Result<void>> {
    const targets: string[] = [];
    for (const field of PATH_FIELDS[this.capability]) {
      const value = input[field];
      if (typeof value === 'string' && value.trim().length > 0) targets.push(value.trim());
      if (Array.isArray(value)) for (const entry of value) if (typeof entry === 'string' && entry.trim().length > 0) targets.push(entry.trim());
    }
    if (targets.length === 0) return ok(undefined);
    if (isFullBypassAuthorization(authorization)) {
      for (const target of targets) {
        if (isForeignPathSyntax(target)) return err(appError('INVALID_INPUT', `${this.capability} target path uses a foreign host syntax`));
        if (await canonicalize(target) === null) return err(appError('INVALID_INPUT', `${this.capability} target path is unavailable`));
      }
      return ok(undefined);
    }
    const roots = await this.canonicalRoots(input);
    if (roots === null) return err(appError('PATH_OUTSIDE_WORKSPACE', `${this.capability} path operation requires an available Active Project root`));
    for (const target of targets) {
      if (isForeignPathSyntax(target)) return err(appError('INVALID_INPUT', `${this.capability} target path uses a foreign host syntax`));
      const canonical = await canonicalize(target);
      if (canonical === null || !roots.some((root) => isWithin(root, canonical))) return err(appError('PATH_OUTSIDE_WORKSPACE', `${this.capability} target path is outside the Active Project`));
    }
    return ok(undefined);
  }

  private async canonicalRoots(input: Record<string, unknown>): Promise<readonly string[] | null> {
    const active = readCapabilityActiveWorkspaceRoot(input);
    let configured: readonly string[];
    if (active !== undefined) configured = [active];
    else if (this.options.allowedRootsProvider !== undefined) configured = await this.options.allowedRootsProvider();
    else configured = [];
    const roots: string[] = [];
    for (const candidate of configured) {
      if (isForeignPathSyntax(candidate)) continue;
      try {
        const root = await realpath(path.resolve(candidate));
        if ((await stat(root)).isDirectory()) roots.push(root);
      } catch { /* unavailable roots are not authorization roots */ }
    }
    return roots;
  }
}

function readAction(input: Record<string, unknown>): string {
  return typeof input.action === 'string' ? input.action : typeof input.operation === 'string' ? input.operation : 'status';
}

function requiresExplicitConfirmation(capability: PortableNativeCapabilityName, input: Record<string, unknown>): boolean {
  const action = readAction(input);
  switch (capability) {
    case 'accessibility': return !['status', 'list_windows', 'observe', 'observe_summary', 'observe_changes', 'inspect_elements', 'find_element', 'read_value'].includes(action);
    case 'input_event': return true;
    case 'window': return !['list', 'get_active', 'get_bounds', 'get_display'].includes(action);
    case 'audio': return true;
    case 'screen_record': return action !== 'status';
    case 'office': return !['read', 'read_text', 'sheets', 'list_folders', 'list_messages'].includes(action);
    case 'vision': return false;
  }
}

async function canonicalize(value: string): Promise<string | null> {
  if (value.includes('\0') || isForeignPathSyntax(value)) return null;
  try { return await realpath(path.resolve(value)); } catch {
    try { return path.join(await realpath(path.dirname(path.resolve(value))), path.basename(value)); } catch { return null; }
  }
}

/** POSIX providers must never reinterpret a persisted Windows path as a
 * relative filename under the current directory. Backslashes are rejected as
 * well, matching the workspace path guard's foreign-syntax policy. */
function isForeignPathSyntax(value: string): boolean {
  const input = value.trim();
  return input.includes('\\') || /^[A-Za-z]:[\\/]/u.test(input) || input.startsWith('//');
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && !relative.split(path.sep).includes('..'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
