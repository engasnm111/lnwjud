import { describe, expect, it } from 'vitest';
import { MacosDiagnosticsCapabilityBackend } from './macos-diagnostics-backend.js';

describe('MacosDiagnosticsCapabilityBackend', () => {
  it('builds bounded Unified Log argv without a shell or untrusted predicate syntax', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const backend = new MacosDiagnosticsCapabilityBackend({
      runImpl: async (executable: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
        calls.push({ executable, args });
        return { stdout: '{"timestamp":"2026-08-31T00:00:00Z","eventMessage":"ok"}\n', stderr: '' };
      },
    });

    await expect(backend.execute({ action: 'logs', provider: 'lnwjud', max_events: 4, since: '2026-08-30T00:00:00Z' })).resolves.toMatchObject({
      ok: true,
      value: { available: true, ready: true, backend: 'macos-unified-log', count: 1 },
    });
    expect(calls).toEqual([{
      executable: 'log',
      args: [
        'show', '--style', 'ndjson', '--no-pager',
        '--predicate', '(process == "lnwjud" OR subsystem == "lnwjud" OR senderImagePath ENDSWITH[c] "lnwjud")',
        '--start', '2026-08-30T00:00:00.000Z',
      ],
    }]);
  });

  it('rejects unsafe service selectors before invoking launchctl', async () => {
    let calls = 0;
    const backend = new MacosDiagnosticsCapabilityBackend({
      runImpl: async (): Promise<{ stdout: string; stderr: string }> => { calls += 1; return { stdout: '', stderr: '' }; },
    });

    await expect(backend.execute({ action: 'service', service: '--all' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(calls).toBe(0);
  });

  it('does not claim readiness when launchd/log is missing', async () => {
    const backend = new MacosDiagnosticsCapabilityBackend({
      executableExists: (): boolean => false,
    });
    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({
      ok: true,
      value: { available: false, ready: false, reason: 'dependency_missing' },
    });
  });
});
