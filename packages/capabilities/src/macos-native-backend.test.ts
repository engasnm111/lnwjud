import { describe, expect, it, vi } from 'vitest';
import { ok, type Result } from '@lnwjud/domain';
import { MacOsNativeCapabilityBackend, type MacOsCapabilityBridge } from './macos-native-backend.js';

function bridgeFixture() {
  const execute = vi.fn(async (request: { readonly capability: string; readonly input: Record<string, unknown> }): Promise<Result<unknown>> => ok({ capability: request.capability, input: request.input }));
  return { bridge: { execute } as MacOsCapabilityBridge, execute };
}

describe('MacOsNativeCapabilityBackend', () => {
  it('dispatches supported macOS capabilities through the injected bridge', async () => {
    const { bridge, execute } = bridgeFixture();
    const backend = new MacOsNativeCapabilityBackend('notification', bridge, 'darwin');

    await expect(backend.execute({ action: 'show', title: 'lnwjud', message: 'done' })).resolves.toMatchObject({
      ok: true,
      value: { capability: 'notification' },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('keeps clipboard writes behind the existing explicit-confirmation gate', async () => {
    const { bridge, execute } = bridgeFixture();
    const backend = new MacOsNativeCapabilityBackend('clipboard', bridge, 'darwin');

    const denied = await backend.execute({ action: 'set_text', text: 'secretless test' });
    expect(denied).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed outside macOS without invoking the bridge', async () => {
    const { bridge, execute } = bridgeFixture();
    const backend = new MacOsNativeCapabilityBackend('file_dialog', bridge, 'linux');

    const result = await backend.execute({ action: 'open' });
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('unavailable on this platform') } });
    expect(execute).not.toHaveBeenCalled();
  });
});
