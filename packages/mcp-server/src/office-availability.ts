import type { CapabilityService } from '@lnwjud/capabilities';

/**
 * Side-effect-free availability probe for the office capability.
 *
 * Windows dispatch keeps the historical no-probe flow (the Windows office
 * backend returns real COM results and probing it would launch Office), so the
 * platform gate returns "available" without touching the backend. On every
 * other host the native backends answer a dry_run probe without executing
 * anything, which lets consumers refuse office mutations — and their recovery
 * backups — before promising work the platform cannot perform.
 */
const OFFICE_PROBE_INPUT = { app: 'word', action: 'merge', dry_run: true } as const;
const FALLBACK_REASON = 'Office automation is unavailable on this platform';

export async function officeUnavailableReason(capabilities: CapabilityService): Promise<string | null> {
  if (process.platform === 'win32') return null;
  try {
    const probe = await capabilities.execute('office', OFFICE_PROBE_INPUT);
    if (!probe.ok) return probe.error.message;
    const value = probe.value;
    if (isRecord(value) && value.available === false) {
      return typeof value.reason === 'string' && value.reason.trim().length > 0 ? value.reason : FALLBACK_REASON;
    }
    return null;
  } catch (error: unknown) {
    return error instanceof Error && error.message ? error.message : FALLBACK_REASON;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
