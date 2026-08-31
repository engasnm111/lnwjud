import { describe, expect, it } from 'vitest';
import {
  markStartupDoctorPassed,
  STARTUP_DOCTOR_STORAGE_KEY,
  startupDoctorCorePassed,
  startupDoctorNavigationTarget,
  startupDoctorRequired,
} from '../src/renderer/features/onboarding/startup-doctor-state.js';

function memoryStorage(initial: string | null = null): Pick<Storage, 'getItem' | 'setItem'> & { value: string | null } {
  const storage = {
    value: initial,
    getItem(key: string): string | null { return key === STARTUP_DOCTOR_STORAGE_KEY ? storage.value : null; },
    setItem(key: string, value: string): void { if (key === STARTUP_DOCTOR_STORAGE_KEY) storage.value = value; },
  };
  return storage;
}

describe('startup Doctor state', () => {
  it('passes startup on core checks even when optional or tunnel diagnostics fail', () => {
    expect(startupDoctorCorePassed({
      checks: [
        { id: 'os', required: true, status: 'pass', message: 'ok' },
        { id: 'database', required: true, status: 'pass', message: 'ok' },
        { id: 'git', required: false, status: 'warn', message: 'optional' },
        { id: 'executable_ripgrep', required: true, status: 'pass', message: 'ok' },
        { id: 'workspaces', required: true, status: 'pass', message: 'ok' },
        { id: 'mcp-port', required: true, status: 'pass', message: 'ok' },
        { id: 'codex', required: false, status: 'warn', message: 'optional' },
        { id: 'persistent_tunnel_identity', required: true, status: 'fail', message: 'not configured yet' },
      ],
    })).toBe(true);
  });

  it('fails startup when a required core check fails or is missing', () => {
    expect(startupDoctorCorePassed({
      checks: [
        { id: 'os', required: true, status: 'pass', message: 'ok' },
        { id: 'database', required: true, status: 'pass', message: 'ok' },
        { id: 'executable_ripgrep', required: true, status: 'fail', message: 'missing' },
        { id: 'workspaces', required: true, status: 'pass', message: 'ok' },
        { id: 'mcp-port', required: true, status: 'pass', message: 'ok' },
      ],
    })).toBe(false);
    expect(startupDoctorCorePassed({ checks: [] })).toBe(false);
    expect(startupDoctorCorePassed({
      checks: [
        { id: 'os', required: true, status: 'pass', message: 'ok' },
        { id: 'database', required: true, status: 'pass', message: 'ok' },
        { id: 'executable_ripgrep', required: true, status: 'unknown', message: 'probe timed out' },
        { id: 'mcp-port', required: true, status: 'pass', message: 'ok' },
      ],
    })).toBe(false);
  });

  it('does not deadlock a clean profile on the optional workspace check', () => {
    expect(startupDoctorCorePassed({
      checks: [
        { id: 'os', required: true, status: 'pass', message: 'ok' },
        { id: 'database', required: true, status: 'pass', message: 'ok' },
        { id: 'executable_ripgrep', required: true, status: 'pass', message: 'ok' },
        { id: 'workspaces', required: false, status: 'warn', message: 'add a project' },
        { id: 'mcp-port', required: true, status: 'pass', message: 'ok' },
      ],
    })).toBe(true);
  });

  it('does not deadlock first run on a required core warning when no core check failed', () => {
    expect(startupDoctorCorePassed({
      checks: [
        { id: 'os', required: true, status: 'pass', message: 'ok' },
        { id: 'database', required: true, status: 'pass', message: 'ok' },
        { id: 'executable_ripgrep', required: true, status: 'pass', message: 'ok' },
        { id: 'mcp-port', required: true, status: 'warn', message: 'identity-verified fallback port' },
      ],
    })).toBe(true);
  });

  it('allows Projects as a recovery destination while startup Doctor is blocking', () => {
    expect(startupDoctorNavigationTarget(false, 'projects')).toBe('projects');
    expect(startupDoctorNavigationTarget(false, 'settings')).toBe('doctor');
    expect(startupDoctorNavigationTarget(true, 'settings')).toBe('settings');
  });

  it('requires Doctor on a clean profile and after an app version changes', () => {
    const storage = memoryStorage();
    expect(startupDoctorRequired(storage, '4.12.0')).toBe(true);
    markStartupDoctorPassed(storage, '4.12.0');
    expect(startupDoctorRequired(storage, '4.12.0')).toBe(false);
    expect(startupDoctorRequired(storage, '4.13.0')).toBe(true);
  });

  it('fails safe when localStorage cannot be read', () => {
    const storage: Pick<Storage, 'getItem'> = { getItem(): string | null { throw new Error('blocked'); } };
    expect(startupDoctorRequired(storage, '4.12.0')).toBe(true);
  });
});
