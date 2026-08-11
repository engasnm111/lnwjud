import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { WindowsNativeCapabilityBackend, type WindowsCapabilityBridge } from './windows-native-backend.js';

describe('WindowsNativeCapabilityBackend', () => {
  it('forwards a native capability request to the local bridge', async () => {
    const requests: unknown[] = [];
    const bridge: WindowsCapabilityBridge = {
      execute: async (request) => { requests.push(request); return ok({ ready: true }); },
    };
    const backend = new WindowsNativeCapabilityBackend('window', bridge, 'win32');

    const result = await backend.execute({ operation: 'list' });

    expect(result).toMatchObject({ ok: true, value: { ready: true } });
    expect(requests).toEqual([{ capability: 'window', input: { operation: 'list' } }]);
  });

  it('returns a dry-run description without sending native input', async () => {
    let called = false;
    const bridge: WindowsCapabilityBridge = {
      execute: async () => { called = true; return ok({}); },
    };
    const backend = new WindowsNativeCapabilityBackend('input_event', bridge, 'win32');

    const result = await backend.execute({ operation: 'click', dry_run: true });

    expect(result).toMatchObject({ ok: true, value: { dry_run: true, capability: 'input_event' } });
    expect(called).toBe(false);
  });

  it('reports an unavailable backend off Windows', async () => {
    const bridge: WindowsCapabilityBridge = { execute: async () => ok({}) };
    const backend = new WindowsNativeCapabilityBackend('vision', bridge, 'linux');

    await expect(backend.execute({ action: 'capture_display' })).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });
});
