import { describe, expect, it } from 'vitest';
import { ok, type Result } from '@lnwjud/domain';
import { EventLogCapabilityBackend } from './event-log-backend.js';

function backendWithRunner(runner: (script: string, environment: Record<string, string>) => Promise<Result<string>>): EventLogCapabilityBackend {
  return new EventLogCapabilityBackend({ platform: 'win32', runner: async (script, environment) => runner(script, environment) });
}

describe('EventLogCapabilityBackend', () => {
  it('runs an allowlisted query through the PowerShell runner with env-var parameters', async () => {
    const seen: { script: string; environment: Record<string, string> }[] = [];
    const backend = backendWithRunner(async (script, environment) => {
      seen.push({ script, environment });
      return ok(JSON.stringify([{ time: '2026-08-22T01:00:00.000Z', provider: 'Application Error', id: 1000, level: 'Error', message: 'faulting module' }]));
    });

    const result = await backend.execute({ operation: 'query', provider: 'Application Error', log_name: 'Application', max_events: 10 });
    expect(result).toMatchObject({ ok: true, value: { available: true, mode: 'query', count: 1 } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.environment).toMatchObject({ LNWJUD_EVENT_MODE: 'query', LNWJUD_EVENT_PROVIDER: 'Application Error', LNWJUD_EVENT_LOG: 'Application', LNWJUD_EVENT_MAX: '10' });
    expect(seen[0]!.script).toContain('Get-WinEvent');
  });

  it('maps crash_trace onto the bounded WER query', async () => {
    const seen: Record<string, string>[] = [];
    const backend = backendWithRunner(async (_script, environment) => {
      seen.push(environment);
      return ok('[]');
    });

    const result = await backend.execute({ operation: 'crashes', hours: 12 });
    expect(result).toMatchObject({ ok: true, value: { available: true, mode: 'crashes', count: 0, events: [] } });
    expect(seen[0]).toMatchObject({ LNWJUD_EVENT_MODE: 'crashes', LNWJUD_EVENT_HOURS: '12' });
    expect(seen[0]!.LNWJUD_EVENT_PROVIDER).toBeUndefined();
  });

  it('rejects providers and log names outside the allowlist before spawning anything', async () => {
    let spawns = 0;
    const backend = backendWithRunner(async () => { spawns += 1; return ok('[]'); });

    await expect(backend.execute({ operation: 'query', provider: 'SomeRandomProvider' })).resolves.toMatchObject({
      ok: false, error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('not allowlisted') },
    });
    await expect(backend.execute({ operation: 'query', log_name: 'Security' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(backend.execute({ operation: 'query' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(spawns).toBe(0);
  });

  it('bounds max_events and validates the since timestamp', async () => {
    const seen: Record<string, string>[] = [];
    const backend = backendWithRunner(async (_script, environment) => { seen.push(environment); return ok('[]'); });

    await backend.execute({ operation: 'query', provider: '.NET Runtime', max_events: 9999 });
    expect(seen.at(-1)!.LNWJUD_EVENT_MAX).toBe('500');

    await backend.execute({ operation: 'query', provider: '.NET Runtime', since: '2026-08-21T10:00:00Z' });
    expect(seen.at(-1)!.LNWJUD_EVENT_SINCE).toBe('2026-08-21T10:00:00.000Z');

    await expect(backend.execute({ operation: 'query', provider: '.NET Runtime', since: 'yesterday' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('reports a missing portable log executable and surfaces helper errors', async () => {
    const backend = new EventLogCapabilityBackend({
      platform: 'linux',
      portableRunner: async (): Promise<Result<string>> => ({ ok: false, error: { code: 'PROCESS_NOT_FOUND', message: 'journalctl not installed', recoverable: true } }),
    });
    await expect(backend.execute({ operation: 'crashes' })).resolves.toMatchObject({ ok: true, value: { available: false, reason: 'portable_log_provider_missing' } });

    const failing = backendWithRunner(async () => Promise.resolve({ ok: false as const, error: { code: 'PROCESS_TIMEOUT' as const, message: 'timeout', recoverable: true } }));
    await expect(failing.execute({ operation: 'query', provider: 'Application Error' })).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
  });

  it('passes bounded portable filters to the host-native log provider', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const backend = new EventLogCapabilityBackend({
      platform: 'linux',
      portableRunner: async (executable, args): Promise<Result<string>> => {
        calls.push({ executable, args });
        return ok('[]');
      },
    });

    await expect(backend.execute({ operation: 'query', log_name: 'Application', provider: 'my-app', max_events: 4 })).resolves.toMatchObject({
      ok: true,
      value: { available: true, ready: true, count: 0, logName: 'Application', provider: 'my-app' },
    });
    expect(calls).toEqual([{ executable: 'journalctl', args: ['--no-pager', '--output=json', '-n', '4', '--user', '-t', 'my-app'] }]);
  });

  it('builds a quoted macOS predicate without exposing request text as a new argument', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const backend = new EventLogCapabilityBackend({
      platform: 'darwin',
      portableRunner: async (executable, args): Promise<Result<string>> => {
        calls.push({ executable, args });
        return ok('[]');
      },
    });

    await backend.execute({ operation: 'crashes', provider: 'my.app', max_events: 3, since: '2026-08-21T10:00:00Z' });
    expect(calls[0]).toMatchObject({ executable: 'log' });
    expect(calls[0]?.args).toEqual([
      'show', '--style', 'ndjson', '--no-pager', '--predicate',
      '(eventMessage CONTAINS[c] "crash" OR eventMessage CONTAINS[c] "exception") AND (process == "my.app" OR subsystem == "my.app" OR senderImagePath ENDSWITH[c] "my.app")',
      '--start', '2026-08-21T10:00:00.000Z',
    ]);
  });

  it('parses macOS NDJSON fields and ignores the finished marker', async () => {
    const backend = new EventLogCapabilityBackend({
      platform: 'darwin',
      portableRunner: async (): Promise<Result<string>> => ok([
        JSON.stringify({
          timestamp: '2026-08-21 10:00:00.000000+0000',
          process: 'lnwjud',
          processID: 42,
          messageType: 'Error',
          eventMessage: 'native host failed',
        }),
        JSON.stringify({ finished: true }),
      ].join('\n')),
    });

    await expect(backend.execute({ operation: 'query', provider: 'lnwjud' })).resolves.toMatchObject({
      ok: true,
      value: {
        count: 1,
        events: [{
          time: '2026-08-21 10:00:00.000000+0000',
          provider: 'lnwjud',
          id: 42,
          level: 'Error',
          message: 'native host failed',
        }],
      },
    });
  });

  it('accepts a legacy macOS JSON array from a compatible log implementation', async () => {
    const backend = new EventLogCapabilityBackend({
      platform: 'darwin',
      portableRunner: async (): Promise<Result<string>> => ok(JSON.stringify([{ timestamp: '2026-08-21T10:00:00Z', eventMessage: 'one' }])),
    });

    await expect(backend.execute({ operation: 'query', provider: 'lnwjud' })).resolves.toMatchObject({
      ok: true,
      value: { count: 1, events: [{ message: 'one' }] },
    });
  });
});
