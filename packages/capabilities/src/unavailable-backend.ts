import { appError, err, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';

export type UnavailableCapabilityReason =
  | 'unsupported_platform'
  | 'dependency_missing'
  | 'permission_required'
  | 'runtime_stopped'
  | 'unknown';

/** Explicit provider used when a capability is not part of the host profile. */
export class UnavailableCapabilityBackend implements CapabilityBackend {
  public constructor(
    private readonly capability: string,
    private readonly reason: UnavailableCapabilityReason = 'unsupported_platform',
    private readonly message = `${capability} is unavailable on this host`,
  ) {}

  public async execute(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    void signal;
    void authorization;
    // Health probes and dry-runs stay structured and non-throwing so the UI can
    // distinguish unsupported/dependency/permission states from an outage.
    if (isStatusProbe(input) || isDryRun(input)) {
      return ok({
        available: false,
        ready: false,
        local: true,
        capability: this.capability,
        reason: this.reason,
        readinessReason: this.reason,
        deliveryState: deliveryStateFor(this.reason),
        dependencyState: this.reason === 'dependency_missing' ? 'missing' : 'not_required',
        permissionState: this.reason === 'permission_required' ? 'required' : 'not_required',
        runtimeState: 'stopped',
        message: this.message,
      });
    }
    return err(appError(
      this.reason === 'unsupported_platform' ? 'UNSUPPORTED_PLATFORM' : 'INTERNAL_ERROR',
      `${this.message} (${this.reason})`,
      true,
    ));
  }
}

function deliveryStateFor(reason: UnavailableCapabilityReason): 'dependency_gated' | 'unsupported' | 'external_unknown' {
  if (reason === 'unsupported_platform') return 'unsupported';
  if (reason === 'unknown' || reason === 'runtime_stopped') return 'external_unknown';
  return 'dependency_gated';
}

function isStatusProbe(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.action === 'status' || record.action === 'list' || record.operation === 'status' || record.operation === 'check' || record.operation === 'check_all';
}

function isDryRun(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as Record<string, unknown>).dry_run === true;
}
