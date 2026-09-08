import { describe, expect, it } from 'vitest';
import { createPlatformCapabilitySet } from './platform-capability-set.js';

describe('platform capability composition', () => {
  it('does not construct Windows providers for macOS/Linux profiles', async () => {
    const runtime = createPlatformCapabilitySet({
      platform: 'linux',
      dataPath: '/tmp/lnwjud-data',
      workspaceRootsProvider: async () => ['/tmp/project'],
    });

    await expect(runtime.service.execute('wsl_exec', { operation: 'status' })).resolves.toMatchObject({
      ok: true,
      value: { available: false, ready: false, reason: 'unsupported_platform', deliveryState: 'unsupported' },
    });
    await expect(runtime.service.execute('wsl_exec', { operation: 'run', executable: 'wsl.exe' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_PLATFORM' },
    });
    await expect(runtime.service.execute('input_event', { action: 'status' })).resolves.toMatchObject({
      ok: true,
      value: { available: false, ready: false, reason: 'native_host_missing' },
    });
    await expect(runtime.service.execute('system_info', { action: 'status' })).resolves.toMatchObject({
      ok: true,
      value: { available: true, ready: true, backend: 'node-system-info', platform: 'linux' },
    });
    await expect(runtime.health.execute({ operation: 'check_tool', tool: 'scheduler' })).resolves.toMatchObject({
      ok: true,
      value: { available: false, ready: false, reason: 'scheduler_provider_unavailable' },
    });
  });

  it('keeps Windows bridge composition explicit and injectable', () => {
    expect(() => createPlatformCapabilitySet({
      platform: 'win32',
      dataPath: 'C:\\lnwjud-data',
      workspaceRootsProvider: async () => ['C:\\project'],
    })).toThrow('integrity-bound bridge configuration');
  });

  it('fails closed for an unsupported host instead of constructing Linux adapters', async () => {
    const runtime = createPlatformCapabilitySet({
      platform: 'freebsd',
      dataPath: '/tmp/lnwjud-data',
      workspaceRootsProvider: async () => ['/tmp/project'],
    });

    await expect(runtime.service.execute('input_event', { action: 'status' })).resolves.toMatchObject({
      ok: true,
      value: { available: false, ready: false, reason: 'unsupported_platform' },
    });
    await expect(runtime.service.execute('scheduler', { action: 'list' })).resolves.toMatchObject({
      ok: true,
      value: { available: false, ready: false, reason: 'unsupported_platform' },
    });
  });
});
