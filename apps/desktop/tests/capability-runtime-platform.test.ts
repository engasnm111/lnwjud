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
    if (platform === 'linux') {
      expect(accessibility).toMatchObject({
        ok: true,
        value: {
          available: false,
          ready: false,
          backend: 'linux-native',
          reason: expect.stringMatching(/desktop_session_unavailable|provider_not_delivered/),
        },
      });
    } else {
      expect(accessibility.ok).toBe(false);
      if (!accessibility.ok) expect(accessibility.error.message).toContain('unavailable on this platform');
    }

    const systemInfo = await runtime.service.execute('system_info', { operation: 'os' });
    expect(systemInfo).toEqual({
      ok: true,
      value: expect.objectContaining({
        name: platform === 'darwin' ? 'macOS' : 'Linux',
        architecture: expect.any(String),
        computer_name: expect.any(String),
      }),
    });

    const notification = await runtime.service.execute('notification', { action: 'show', title: 'lnwjud', message: 'test', dry_run: true });
    const fileDialog = await runtime.service.execute('file_dialog', { action: 'open', dry_run: true });
    const clipboard = await runtime.service.execute('clipboard', { action: 'get_text', dry_run: true });
    if (platform === 'darwin') {
      expect(notification).toMatchObject({ ok: true, value: { dry_run: true, capability: 'notification' } });
      expect(fileDialog).toMatchObject({ ok: true, value: { dry_run: true, capability: 'file_dialog' } });
      expect(clipboard).toMatchObject({ ok: true, value: { dry_run: true, capability: 'clipboard' } });
    } else {
      for (const result of [notification, fileDialog, clipboard]) {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain('unavailable on this platform');
      }
    }

    const scheduler = await runtime.service.execute('scheduler', platform === 'darwin'
      ? { action: 'create', task_name: 'LnwjudTest', command: '/usr/bin/true', schedule: 'DAILY', start_time: '09:00', dry_run: true }
      : { action: 'list' });
    if (platform === 'darwin') {
      expect(scheduler).toMatchObject({ ok: true, value: { dry_run: true, provider: 'launchd', task_name: 'LnwjudTest' } });
    } else {
      expect(scheduler.ok).toBe(false);
      if (!scheduler.ok) expect(scheduler.error.message).toContain('unavailable on this platform');
    }

    const wsl = await runtime.service.execute('wsl_exec', { operation: 'status' });
    expect(wsl).toEqual({
      ok: true,
      value: expect.objectContaining({ available: false, ready: false, backend: 'wsl' }),
    });
  });
});
