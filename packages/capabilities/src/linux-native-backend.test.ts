import { describe, expect, it } from 'vitest';
import { LinuxNativeCapabilityBackend } from './linux-native-backend.js';
import type { NativeHostProcessBridge } from './native-host-protocol.js';

describe('LinuxNativeCapabilityBackend', () => {
  it('keeps missing DBus/session providers dependency-gated', async () => {
    const backend = new LinuxNativeCapabilityBackend('accessibility');
    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({ ok: true, value: { available: false, ready: false, reason: 'native_host_missing' } });
  });

  it('does not substitute a Windows provider and forwards only bounded actions', async () => {
    const calls: string[] = [];
    const bridge = { execute: async (operation: string): Promise<{ ok: true; value: { available: boolean; ready: boolean } }> => { calls.push(operation); return { ok: true, value: { available: true, ready: true } }; } } as unknown as NativeHostProcessBridge;
    const backend = new LinuxNativeCapabilityBackend('vision', { bridge });
    await expect(backend.execute({ action: 'capture_display' })).resolves.toMatchObject({ ok: true, value: { backend: 'linux-native-host' } });
    expect(calls).toEqual(['vision']);
  });

  it('rejects unknown actions before dispatching to the native helper', async (): Promise<void> => {
    const calls: string[] = [];
    const bridge = { execute: async (operation: string): Promise<{ ok: true; value: { available: boolean; ready: boolean } }> => { calls.push(operation); return { ok: true, value: { available: true, ready: true } }; } } as unknown as NativeHostProcessBridge;
    const backend = new LinuxNativeCapabilityBackend('accessibility', { bridge });
    await expect(backend.execute({ action: 'run_arbitrary_code' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(calls).toEqual([]);
  });
});
