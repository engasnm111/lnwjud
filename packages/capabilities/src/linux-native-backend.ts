import {
  appError,
  err,
  isApplicationAuthorized,
  ok,
  type InvocationAuthorization,
  type Result,
} from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';
import { detectLinuxSessionProfile, type LinuxSessionProfile } from './linux-session-profile.js';

export type LinuxCapabilityName = 'accessibility' | 'input_event' | 'vision' | 'window';

export interface LinuxNativeCapabilityBridge {
  execute(request: {
    readonly capability: LinuxCapabilityName;
    readonly input: Record<string, unknown>;
    readonly session: LinuxSessionProfile;
  }, signal?: AbortSignal): Promise<Result<unknown>>;
}

export interface LinuxNativeCapabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly sessionProfile?: LinuxSessionProfile;
  readonly bridge?: LinuxNativeCapabilityBridge;
}

/**
 * Linux native desktop boundary. Until a session-specific native bridge is
 * delivered, status calls remain successful but explicitly not-ready so
 * Doctor/health never advertise a Windows fallback or fabricated readiness.
 */
export class LinuxNativeCapabilityBackend implements CapabilityBackend {
  private readonly platform: NodeJS.Platform;
  private readonly sessionProfile: LinuxSessionProfile;
  private readonly bridge: LinuxNativeCapabilityBridge | undefined;

  public constructor(
    private readonly capability: LinuxCapabilityName,
    options: LinuxNativeCapabilityOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.sessionProfile = options.sessionProfile ?? detectLinuxSessionProfile({ platform: this.platform });
    this.bridge = options.bridge;
  }

  public async execute(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (this.platform !== 'linux') return err(appError('INTERNAL_ERROR', 'Linux capability is unavailable on this platform', true));
    if (!isRecord(input)) return err(appError('INVALID_INPUT', 'Linux capability input must be an object'));
    if (signal?.aborted === true) return err(appError('PROCESS_TIMEOUT', 'Linux capability operation was cancelled', true));

    const action = actionName(input);
    if (this.bridge === undefined) {
      const readiness = this.unavailableReadiness();
      if (action === 'status' || input.dry_run === true) {
        return ok({ ...readiness, ...(input.dry_run === true ? { dry_run: true } : {}) });
      }
      return err(appError(
        readiness.reason === 'wayland_portal_session_required' ? 'PERMISSION_REQUIRED' : 'INTERNAL_ERROR',
        this.unavailableMessage(readiness.reason),
        true,
      ));
    }

    if (input.dry_run === true) {
      const status = await this.bridge.execute({ capability: this.capability, input: { action: 'status' }, session: this.sessionProfile }, signal);
      if (!status.ok) return status;
      const value = isRecord(status.value) ? status.value : {};
      return ok({ ...value, dry_run: true, capability: this.capability, session: this.sessionProfile.session });
    }

    if (requiresExplicitConfirmation(this.capability, input)
      && !isApplicationAuthorized(authorization, input.userConfirmed === true)) {
      return err(appError('PERMISSION_REQUIRED', `${this.capability} action requires explicit user confirmation`));
    }

    return this.bridge.execute({ capability: this.capability, input, session: this.sessionProfile }, signal);
  }

  private unavailableReadiness(): Record<string, unknown> & { readonly reason: string } {
    const base = {
      available: false,
      ready: false,
      local: true,
      backend: 'linux-native',
      session: this.sessionProfile.session,
      dbus_session_available: this.sessionProfile.dbusSessionAvailable,
    } as const;
    if (!this.sessionProfile.interactive) return { ...base, reason: 'desktop_session_unavailable' };
    if (this.sessionProfile.session === 'wayland' && this.capability === 'input_event') {
      return { ...base, reason: 'wayland_portal_session_required' };
    }
    if (this.sessionProfile.session === 'wayland' && this.capability === 'window') {
      return { ...base, reason: 'wayland_window_control_unsupported' };
    }
    return { ...base, reason: 'provider_not_delivered' };
  }

  private unavailableMessage(reason: string): string {
    switch (reason) {
      case 'desktop_session_unavailable': return `Linux ${this.capability} requires an interactive desktop session`;
      case 'wayland_portal_session_required': return 'Wayland input requires a user-approved RemoteDesktop portal session';
      case 'wayland_window_control_unsupported': return 'Wayland window control is not available without a supported compositor provider';
      default: return `Linux ${this.capability} native provider is not delivered for ${this.sessionProfile.session}`;
    }
  }
}

function actionName(input: Record<string, unknown>): string {
  return typeof input.action === 'string'
    ? input.action
    : typeof input.operation === 'string'
      ? input.operation
      : '';
}

function requiresExplicitConfirmation(capability: LinuxCapabilityName, input: Record<string, unknown>): boolean {
  const action = actionName(input);
  switch (capability) {
    case 'accessibility':
      return !['status', 'list_windows', 'observe', 'observe_summary', 'observe_changes', 'inspect_elements', 'find_element', 'read_value'].includes(action);
    case 'input_event': return action !== 'status';
    case 'window': return !['status', 'list', 'get_active', 'get_bounds', 'get_display'].includes(action);
    case 'vision': return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
