import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { LocalCapabilityService } from './local-capability-service.js';

describe('LocalCapabilityService', () => {
  it('dispatches each local desktop capability to its local backend', async () => {
    const calls: string[] = [];
    const service = new LocalCapabilityService({
      shell: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('shell'); return ok({ value: 'shell' }); } },
      domCdp: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('dom_cdp'); return ok({ value: 'dom' }); } },
      accessibility: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('accessibility'); return ok({ value: 'accessibility' }); } },
      inputEvent: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('input_event'); return ok({ value: 'input' }); } },
      vision: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('vision'); return ok({ value: 'vision' }); } },
      window: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('window'); return ok({ value: 'window' }); } },
      health: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('health'); return ok({ value: 'health' }); } },
      systemInfo: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('system_info'); return ok({ value: 'system' }); } },
      notification: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('notification'); return ok({ value: 'notify' }); } },
      fileDialog: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('file_dialog'); return ok({ value: 'dialog' }); } },
      clipboard: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('clipboard'); return ok({ value: 'clipboard' }); } },
      webFetch: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('web_fetch'); return ok({ value: 'fetch' }); } },
      audio: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('audio'); return ok({ value: 'audio' }); } },
      screenRecord: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('screen_record'); return ok({ value: 'screen' }); } },
      office: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('office'); return ok({ value: 'office' }); } },
      scheduler: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('scheduler'); return ok({ value: 'scheduler' }); } },
      wslExec: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('wsl_exec'); return ok({ value: 'wsl' }); } },
      wslFs: { execute: async (): Promise<ReturnType<typeof ok>> => { calls.push('wsl_fs'); return ok({ value: 'wsl-fs' }); } },
    });

    await expect(service.execute('shell', {})).resolves.toMatchObject({ ok: true, value: { value: 'shell' } });
    await expect(service.execute('dom_cdp', {})).resolves.toMatchObject({ ok: true, value: { value: 'dom' } });
    await expect(service.execute('accessibility', {})).resolves.toMatchObject({ ok: true, value: { value: 'accessibility' } });
    await expect(service.execute('input_event', {})).resolves.toMatchObject({ ok: true, value: { value: 'input' } });
    await expect(service.execute('vision', {})).resolves.toMatchObject({ ok: true, value: { value: 'vision' } });
    await expect(service.execute('window', {})).resolves.toMatchObject({ ok: true, value: { value: 'window' } });
    await expect(service.execute('health', {})).resolves.toMatchObject({ ok: true, value: { value: 'health' } });
    await expect(service.execute('system_info', {})).resolves.toMatchObject({ ok: true, value: { value: 'system' } });
    await expect(service.execute('notification', {})).resolves.toMatchObject({ ok: true, value: { value: 'notify' } });
    await expect(service.execute('file_dialog', {})).resolves.toMatchObject({ ok: true, value: { value: 'dialog' } });
    await expect(service.execute('clipboard', {})).resolves.toMatchObject({ ok: true, value: { value: 'clipboard' } });
    await expect(service.execute('web_fetch', {})).resolves.toMatchObject({ ok: true, value: { value: 'fetch' } });
    await expect(service.execute('audio', {})).resolves.toMatchObject({ ok: true, value: { value: 'audio' } });
    await expect(service.execute('screen_record', {})).resolves.toMatchObject({ ok: true, value: { value: 'screen' } });
    await expect(service.execute('office', {})).resolves.toMatchObject({ ok: true, value: { value: 'office' } });
    await expect(service.execute('scheduler', {})).resolves.toMatchObject({ ok: true, value: { value: 'scheduler' } });
    await expect(service.execute('wsl_exec', {})).resolves.toMatchObject({ ok: true, value: { value: 'wsl' } });
    await expect(service.execute('wsl_fs', {})).resolves.toMatchObject({ ok: true, value: { value: 'wsl-fs' } });
    expect(calls).toEqual(['shell', 'dom_cdp', 'accessibility', 'input_event', 'vision', 'window', 'health', 'system_info', 'notification', 'file_dialog', 'clipboard', 'web_fetch', 'audio', 'screen_record', 'office', 'scheduler', 'wsl_exec', 'wsl_fs']);
  });

  it('reports an unsupported capability without throwing', async () => {
    const service = new LocalCapabilityService({
      shell: { execute: async (): Promise<ReturnType<typeof ok>> => ok({}) },
      domCdp: { execute: async (): Promise<ReturnType<typeof ok>> => ok({}) },
      accessibility: { execute: async (): Promise<ReturnType<typeof ok>> => ok({}) },
      inputEvent: { execute: async (): Promise<ReturnType<typeof ok>> => ok({}) },
      vision: { execute: async (): Promise<ReturnType<typeof ok>> => ok({}) },
      window: { execute: async (): Promise<ReturnType<typeof ok>> => ok({}) },
      health: { execute: async (): Promise<ReturnType<typeof ok>> => ok({}) },
    });

    const result = await service.execute('clipboard', {});
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('does not dispatch an already-cancelled capability call', async () => {
    let called = false;
    const backend = { execute: async (): Promise<ReturnType<typeof ok>> => { called = true; return ok({}); } };
    const service = new LocalCapabilityService({
      shell: backend,
      domCdp: backend,
      accessibility: backend,
      inputEvent: backend,
      vision: backend,
      window: backend,
      health: backend,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(service.execute('shell', {}, controller.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'PROCESS_TIMEOUT' },
    });
    expect(called).toBe(false);
  });
});
