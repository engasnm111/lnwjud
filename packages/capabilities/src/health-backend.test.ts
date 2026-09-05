import { describe, expect, it } from 'vitest';
import { ok, type Result } from '@lnwjud/domain';
import { HealthCapabilityBackend } from './health-backend.js';

describe('HealthCapabilityBackend', () => {
  it('reports all seven local capabilities without executing input actions', async () => {
    const backend = new HealthCapabilityBackend({
      platform: 'win32',
      domCdp: { execute: async (): Promise<Result<unknown>> => ok({ ready: true, port: 9222 }) },
      accessibility: { execute: async (): Promise<Result<unknown>> => ok({ available: true }) },
    });

    const result = await backend.execute({ operation: 'check_all' });

    expect(result).toMatchObject({ ok: true, value: { capabilities: {
      shell: { available: true },
      dom_cdp: { available: true, ready: true },
      accessibility: { available: true },
      input_event: { available: true },
      vision: { available: true },
      window: { available: true },
      health: { available: true },
    } } });
  });

  it('checks one named capability when requested', async () => {
    const backend = new HealthCapabilityBackend({ platform: 'linux' });

    await expect(backend.execute({ operation: 'check_tool', tool: 'input_event' })).resolves.toMatchObject({ ok: true, value: { tool: 'input_event', available: false } });
  });

  it('delegates WSL readiness independently from accessibility', async () => {
    const backend = new HealthCapabilityBackend({
      platform: 'win32',
      wslExec: { execute: async (): Promise<Result<unknown>> => ok({ available: true, ready: true, distro: 'Ubuntu' }) },
      wslFs: { execute: async (): Promise<Result<unknown>> => ok({ available: true, ready: true }) },
    });

    await expect(backend.execute({ operation: 'check_all' })).resolves.toMatchObject({ ok: true, value: { capabilities: {
      wsl_exec: { available: true, ready: true, distro: 'Ubuntu' },
      wsl_fs: { available: true, ready: true },
    } } });

    const single = await backend.execute({ operation: 'check_tool', tool: 'wsl_exec' });
    expect(single).toMatchObject({ ok: true, value: {
      permission: 'EXECUTE',
      supportsCancel: true,
      supportsDryRun: true,
      auditTarget: 'workspace',
    } });
  });
});
