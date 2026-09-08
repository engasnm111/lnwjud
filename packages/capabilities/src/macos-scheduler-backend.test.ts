import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MacosSchedulerCapabilityBackend } from './macos-scheduler-backend.js';

describe('MacosSchedulerCapabilityBackend', () => {
  it('keeps the macOS entry point bound to launchd and the owned LaunchAgents scope', async () => {
    const calls: string[] = [];
    const home = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-macos-scheduler-'));
    const backend = new MacosSchedulerCapabilityBackend({
      homeDirectory: home,
      runImpl: async (executable: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => { calls.push(`${executable} ${args.join(' ')}`); return { stdout: '', stderr: '' }; },
    });
    try {
      await expect(backend.execute({ action: 'create', task_name: 'mac test', command: '/usr/bin/true', userConfirmed: true })).resolves.toMatchObject({ ok: true, value: { backend: 'launchd', label: 'com.lnwjud.mac-test' } });
      expect(calls.some((call) => call.startsWith('launchctl bootstrap'))).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
