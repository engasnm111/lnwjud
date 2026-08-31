import type { DoctorReport } from '@lnwjud/ipc-contracts';
import type { Screen } from '../shell/AppShell.js';

export const STARTUP_DOCTOR_STORAGE_KEY = 'lnwjud.startup-doctor.passed-version.v1';

const STARTUP_CORE_CHECK_IDS = new Set(['os', 'database', 'executable_ripgrep', 'mcp-port']);

export function startupDoctorCorePassed(report: Pick<DoctorReport, 'checks'>): boolean {
  const coreChecks = report.checks.filter((check) => STARTUP_CORE_CHECK_IDS.has(check.id));
  return coreChecks.length === STARTUP_CORE_CHECK_IDS.size
    && coreChecks.every((check) => check.required && check.status !== 'fail' && check.status !== 'unknown');
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

export function startupDoctorNavigationTarget(ready: boolean, requested: Screen): Screen {
  if (ready || requested === 'doctor' || requested === 'projects') return requested;
  return 'doctor';
}
