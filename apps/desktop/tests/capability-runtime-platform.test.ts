import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalCapabilityRuntime } from '../src/main/capability-runtime.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRuntime(platform: NodeJS.Platform) {
  const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-capability-platform-'));
  roots.push(dataPath);
  return createLocalCapabilityRuntime(dataPath, async () => [dataPath], false, () => [], () => 5, platform);
}

describe('desktop capability platform composition', () => {
  it.each(['darwin', 'linux'] as const)('keeps Windows-only providers fail-closed on %s without invoking Windows executables', async (platform) => {
    const runtime = await createRuntime(platform);

    const accessibility = await runtime.service.execute('accessibility', { action: 'status' });
    expect(accessibility.ok).toBe(false);
    if (!accessibility.ok) expect(accessibility.error.message).toContain('unavailable on this platform');

    const systemInfo = await runtime.service.execute('system_info', { operation: 'os' });
    expect(systemInfo).toEqual({
      ok: true,
      value: expect.objectContaining({
        name: platform === 'darwin' ? 'macOS' : 'Linux',
        architecture: expect.any(String),
        computer_name: expect.any(String),
      }),
    });

    const scheduler = await runtime.service.execute('scheduler', { action: 'list' });
    expect(scheduler.ok).toBe(false);
    if (!scheduler.ok) expect(scheduler.error.message).toContain('unavailable on this platform');

    const wsl = await runtime.service.execute('wsl_exec', { operation: 'status' });
    expect(wsl).toEqual({
      ok: true,
      value: expect.objectContaining({ available: false, ready: false, backend: 'wsl' }),
    });
  });
});
