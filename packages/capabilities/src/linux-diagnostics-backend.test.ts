import { describe, expect, it } from 'vitest';
import { LinuxDiagnosticsCapabilityBackend } from './linux-diagnostics-backend.js';

describe('LinuxDiagnosticsCapabilityBackend', () => {
  it('queries the user journal with bounded argv and maps JSON records', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const backend = new LinuxDiagnosticsCapabilityBackend({
      runImpl: async (executable: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
        calls.push({ executable, args });
        return { stdout: '{"__REALTIME_TIMESTAMP":"123","MESSAGE":"ok","SYSLOG_IDENTIFIER":"lnwjud","_PID":42,"PRIORITY":4}\n', stderr: '' };
      },
    });

    await expect(backend.execute({ action: 'logs', service: 'lnwjud', max_events: 3, since: '2026-08-30T00:00:00Z' })).resolves.toMatchObject({
      ok: true,
      value: { available: true, ready: true, backend: 'linux-journal', count: 1, events: [{ provider: 'lnwjud', id: 42, message: 'ok' }] },
    });
    expect(calls).toEqual([{
      executable: 'journalctl',
      args: ['--no-pager', '--output=json', '-n', '3', '--user', '-t', 'lnwjud', '--since', '2026-08-30T00:00:00.000Z'],
    }]);
  });

  it('keeps systemd service names allowlisted and read-only', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const backend = new LinuxDiagnosticsCapabilityBackend({
      runImpl: async (executable: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => { calls.push({ executable, args }); return { stdout: 'active', stderr: '' }; },
    });
    await expect(backend.execute({ action: 'service', service: 'lnwjud-tunnel.service' })).resolves.toMatchObject({ ok: true, value: { backend: 'systemd-user', service: 'lnwjud-tunnel.service' } });
    expect(calls).toEqual([{ executable: 'systemctl', args: ['--user', 'status', 'lnwjud-tunnel.service', '--no-pager', '--plain'] }]);
    await expect(backend.execute({ action: 'service', service: '$(touch /tmp/pwned)' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(calls).toHaveLength(1);
  });

  it('reports a dependency-gated profile when systemd/journalctl is absent', async () => {
    const backend = new LinuxDiagnosticsCapabilityBackend({ executableExists: (): boolean => false });
    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({ ok: true, value: { available: false, ready: false, reason: 'dependency_missing' } });
  });
});
