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

  it('reports platform-gated capabilities as not applicable instead of generic missing backends', async () => {
    const backend = new HealthCapabilityBackend({ platform: 'linux' });

    await expect(backend.execute({ operation: 'check_tool', tool: 'input_event' })).resolves.toMatchObject({
      ok: true,
      value: {
        tool: 'input_event',
        availability: 'platform',
        platformPolicy: { platforms: ['win32'], sessions: ['interactive-desktop'] },
        available: false,
        ready: false,
        applicable: false,
        reason: 'Not applicable on linux',
      },
    });
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

  it('delegates scheduler health on macOS and keeps it non-applicable on Linux', async () => {
    const calls: unknown[] = [];
    const mac = new HealthCapabilityBackend({
      platform: 'darwin',
      scheduler: { execute: async (input): Promise<Result<unknown>> => { calls.push(input); return ok({ tasks: [], provider: 'launchd' }); } },
    });

    await expect(mac.execute({ operation: 'check_tool', tool: 'scheduler' })).resolves.toMatchObject({
      ok: true,
      value: {
        platformPolicy: { platforms: ['win32', 'darwin'] },
        available: true,
        ready: true,
        applicable: true,
        provider: 'launchd',
      },
    });
    expect(calls).toEqual([{ action: 'list' }]);

    const linux = new HealthCapabilityBackend({ platform: 'linux', scheduler: { execute: async (): Promise<Result<unknown>> => ok({ tasks: [] }) } });
    await expect(linux.execute({ operation: 'check_tool', tool: 'scheduler' })).resolves.toMatchObject({
      ok: true,
      value: { available: false, ready: false, applicable: false, reason: 'Not applicable on linux' },
    });
  });
});
