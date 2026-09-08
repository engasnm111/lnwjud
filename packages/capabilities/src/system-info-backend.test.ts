import { describe, expect, it } from 'vitest';
import { SystemInfoCapabilityBackend } from './system-info-backend.js';

describe('portable system info backend', () => {
  it('reports read-only metadata without an Electron window', async () => {
    const backend = new SystemInfoCapabilityBackend('linux');
    await expect(backend.execute({ action: 'status' })).resolves.toMatchObject({ ok: true, value: { available: true, ready: true, backend: 'node-system-info', platform: 'linux' } });
    await expect(backend.execute({ action: 'summary' })).resolves.toMatchObject({ ok: true, value: { platform: 'linux', arch: process.arch, backend: 'node-system-info', memory_bytes: { total: expect.any(Number), free: expect.any(Number) } } });
  });

  it('does not probe after cancellation and rejects unknown actions', async () => {
    const backend = new SystemInfoCapabilityBackend('darwin');
    const controller = new AbortController();
    controller.abort();
    await expect(backend.execute({ action: 'summary' }, controller.signal)).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    await expect(backend.execute({ action: 'mutate' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
