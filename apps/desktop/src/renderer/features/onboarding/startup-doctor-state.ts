import type { DoctorReport } from '@lnwjud/ipc-contracts';

export const STARTUP_DOCTOR_STORAGE_KEY = 'lnwjud.startup-doctor.passed-version.v1';

const STARTUP_CORE_CHECK_IDS = new Set(['os', 'database', 'ripgrep', 'workspaces', 'mcp-port']);

export function startupDoctorCorePassed(report: Pick<DoctorReport, 'checks'>): boolean {
  const coreChecks = report.checks.filter((check) => STARTUP_CORE_CHECK_IDS.has(check.id));
  return coreChecks.length === STARTUP_CORE_CHECK_IDS.size
    && coreChecks.every((check) => check.required && check.status === 'pass');
}

export function startupDoctorRequired(storage: Pick<Storage, 'getItem'>, appVersion: string): boolean {
  if (appVersion.trim().length === 0) return true;
  try {
    return storage.getItem(STARTUP_DOCTOR_STORAGE_KEY) !== appVersion;
  } catch {
    return true;
  }
}

export function markStartupDoctorPassed(storage: Pick<Storage, 'setItem'>, appVersion: string): void {
  if (appVersion.trim().length === 0) return;
  storage.setItem(STARTUP_DOCTOR_STORAGE_KEY, appVersion);
}
