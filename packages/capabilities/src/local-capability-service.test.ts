import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { LocalCapabilityService } from './local-capability-service.js';

describe('LocalCapabilityService', () => {
  it('dispatches each Khai-Hub capability to its local backend', async () => {
    const calls: string[] = [];
    const service = new LocalCapabilityService({
      shell: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('shell'); return ok({ value: 'shell' }); } },
      domCdp: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('dom_cdp'); return ok({ value: 'dom' }); } },
      accessibility: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('accessibility'); return ok({ value: 'accessibility' }); } },
      inputEvent: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('input_event'); return ok({ value: 'input' }); } },
      vision: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('vision'); return ok({ value: 'vision' }); } },
      window: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('window'); return ok({ value: 'window' }); } },
      health: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('health'); return ok({ value: 'health' }); } },
    });

    await expect(service.execute('shell', {})).resolves.toMatchObject({ ok: true, value: { value: 'shell' } });
    await expect(service.execute('dom_cdp', {})).resolves.toMatchObject({ ok: true, value: { value: 'dom' } });
    await expect(service.execute('accessibility', {})).resolves.toMatchObject({ ok: true, value: { value: 'accessibility' } });
    await expect(service.execute('input_event', {})).resolves.toMatchObject({ ok: true, value: { value: 'input' } });
    await expect(service.execute('vision', {})).resolves.toMatchObject({ ok: true, value: { value: 'vision' } });
    await expect(service.execute('window', {})).resolves.toMatchObject({ ok: true, value: { value: 'window' } });
    await expect(service.execute('health', {})).resolves.toMatchObject({ ok: true, value: { value: 'health' } });
    expect(calls).toEqual(['shell', 'dom_cdp', 'accessibility', 'input_event', 'vision', 'window', 'health']);
  });
});
