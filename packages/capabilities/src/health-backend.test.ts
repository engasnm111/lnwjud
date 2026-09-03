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

  it('probes common native providers without side effects and preserves permission metadata', async () => {
    const calls: Array<{ readonly provider: string; readonly input: unknown }> = [];
    const provider = (name: string): { execute(input: unknown): Promise<Result<unknown>> } => ({
      async execute(input): Promise<Result<unknown>> {
        calls.push({ provider: name, input });
        return ok({ provider: name });
      },
    });
    const backend = new HealthCapabilityBackend({
      platform: 'darwin',
      systemInfo: provider('system_info'),
      notification: provider('notification'),
      fileDialog: provider('file_dialog'),
      clipboard: provider('clipboard'),
    });

    for (const tool of ['system_info', 'notification', 'file_dialog', 'clipboard'] as const) {
      await expect(backend.execute({ operation: 'check_tool', tool })).resolves.toMatchObject({
        ok: true,
        value: { tool, available: true, ready: true, applicable: true, provider: tool },
      });
    }
    await expect(backend.execute({ operation: 'check_tool', tool: 'system_info' })).resolves.toMatchObject({
      ok: true, value: { permission: 'READ' },
    });
    await expect(backend.execute({ operation: 'check_tool', tool: 'notification' })).resolves.toMatchObject({
      ok: true, value: { permission: 'WRITE' },
    });
    expect(calls).toEqual([
      { provider: 'system_info', input: { operation: 'os' } },
      { provider: 'notification', input: { action: 'show', title: 'lnwjud', message: 'health-check', dry_run: true } },
      { provider: 'file_dialog', input: { action: 'open', dry_run: true } },
      { provider: 'clipboard', input: { action: 'get_text', dry_run: true } },
      { provider: 'system_info', input: { operation: 'os' } },
      { provider: 'notification', input: { action: 'show', title: 'lnwjud', message: 'health-check', dry_run: true } },
    ]);
  });

  it('reports a configured common provider failure as unavailable instead of advertising false readiness', async () => {
    const backend = new HealthCapabilityBackend({
      platform: 'darwin',
      notification: { execute: async (): Promise<Result<unknown>> => ({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'notification provider unavailable', recoverable: true },
      }) },
    });

    await expect(backend.execute({ operation: 'check_tool', tool: 'notification' })).resolves.toMatchObject({
      ok: true,
      value: {
        permission: 'WRITE',
        available: false,
        ready: false,
        applicable: true,
        reason: 'notification provider unavailable',
      },
    });
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
