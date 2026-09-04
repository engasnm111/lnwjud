import {
  appError,
  err,
  isApplicationAuthorized,
  ok,
  type InvocationAuthorization,
  type Result,
} from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';
import { NativeCapabilityPathPolicy, type NativePathField } from './native-path-policy.js';

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
  private readonly pathPolicy: NativeCapabilityPathPolicy;

  public constructor(
    private readonly capability: WindowsCapabilityName,
    private readonly bridge: WindowsCapabilityBridge,
    private readonly platform: NodeJS.Platform = process.platform,
    options: WindowsNativeBackendOptions = {},
  ) {
    this.pathPolicy = new NativeCapabilityPathPolicy(capability, PATH_FIELDS[capability], {
      ...(options.allowedRootsProvider === undefined ? {} : { allowedRootsProvider: options.allowedRootsProvider }),
    });
  }

  public async execute(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (this.platform !== 'win32') return err(appError('INTERNAL_ERROR', 'Windows capability is unavailable on this platform', true));
    if (!isRecord(input)) return err(appError('INVALID_INPUT', 'Native capability input must be an object'));
    if (input.dry_run === true) return ok({ dry_run: true, capability: this.capability });
    if (isSignalAborted(signal)) return cancelledOperation();

    const pathCheck = await this.pathPolicy.assertAllowed(input, authorization);
    if (!pathCheck.ok) return pathCheck;
    if (isSignalAborted(signal)) return cancelledOperation();
    if (requiresExplicitConfirmation(this.capability, input) && !isApplicationAuthorized(authorization, input.userConfirmed === true)) {
      return err(appError('PERMISSION_REQUIRED', `${this.capability} action requires explicit user confirmation`));
    }

    return this.bridge.execute({ capability: this.capability, input }, signal);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
