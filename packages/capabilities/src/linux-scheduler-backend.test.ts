import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LinuxSchedulerCapabilityBackend } from './linux-scheduler-backend.js';

describe('LinuxSchedulerCapabilityBackend', () => {
  it('keeps the Linux entry point bound to user systemd and argv-only execution', async () => {
    const calls: string[] = [];
    const home = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-linux-scheduler-'));
    const backend = new LinuxSchedulerCapabilityBackend({
      homeDirectory: home,
      runImpl: async (executable: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => { calls.push(`${executable} ${args.join(' ')}`); return { stdout: '', stderr: '' }; },
    });
    try {
      await expect(backend.execute({ action: 'create', task_name: 'linux test', command: '/usr/bin/true', userConfirmed: true })).resolves.toMatchObject({ ok: true, value: { backend: 'systemd-user', service: 'lnwjud-linux-test.service', timer: 'lnwjud-linux-test.timer' } });
      expect(calls.some((call) => call.startsWith('systemctl --user daemon-reload'))).toBe(true);
      expect(calls.every((call) => !call.includes('cron'))).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
