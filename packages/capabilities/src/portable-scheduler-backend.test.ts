import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LinuxSchedulerCapabilityBackend, MacosSchedulerCapabilityBackend } from './portable-scheduler-backend.js';

describe('portable scheduler providers', () => {
  it('rejects ambiguous create requests before touching the host scheduler', async () => {
    const calls: string[] = [];
    const backend = new LinuxSchedulerCapabilityBackend({ runImpl: async (executable: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => { calls.push(`${executable} ${args.join(' ')}`); return { stdout: '', stderr: '' }; } });
    await expect(backend.execute({ action: 'create', task_name: 'invalid-command', command: '   ', userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(backend.execute({ action: 'create', task_name: 'invalid-schedule', command: '/usr/bin/true', schedule: 42, userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(calls).toHaveLength(0);
  });

  it('rejects control characters before serializing launchd or systemd units', async () => {
    const calls: string[] = [];
    const home = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-scheduler-control-'));
    const backend = new LinuxSchedulerCapabilityBackend({ homeDirectory: home, runImpl: async (executable: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => { calls.push(`${executable} ${args.join(' ')}`); return { stdout: '', stderr: '' }; } });
    try {
      await expect(backend.execute({ action: 'create', task_name: 'newline-command', command: '/usr/bin/true\n[Install]\nWantedBy=default.target', userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      await expect(backend.execute({ action: 'create', task_name: 'newline-argument', command: '/usr/bin/printf', arguments: ['safe', 'bad\r\nExecStart=/bin/sh'], userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(calls).toHaveLength(0);
      await expect(readFile(path.join(home, '.config', 'systemd', 'user', 'lnwjud-newline-command.service'), 'utf8')).rejects.toThrow();
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('keeps macOS launchd mutations explicit and escapes plist arguments', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-launchd-'));
    const calls: string[] = [];
    const backend = new MacosSchedulerCapabilityBackend({ homeDirectory: home, runImpl: async (executable: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => { calls.push(`${executable} ${args.join(' ')}`); return { stdout: '', stderr: '' }; } });
    try {
      await expect(backend.execute({ action: 'create', task_name: 'daily report', command: '/usr/bin/printf', arguments: ['a&b'], schedule: 'DAILY', start_time: '09:30' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
      const created = await backend.execute({ action: 'create', task_name: 'daily report', command: '/usr/bin/printf', arguments: ['a&b'], schedule: 'DAILY', start_time: '09:30', userConfirmed: true });
      expect(created).toMatchObject({ ok: true, value: { backend: 'launchd', label: 'com.lnwjud.daily-report' } });
      const plist = await readFile(path.join(home, 'Library', 'LaunchAgents', 'com.lnwjud.daily-report.plist'), 'utf8');
      expect(plist).toContain('a&amp;b');
      expect(plist).toContain('<key>lnwjudTaskName</key><string>daily report</string>');
      expect(calls.some((call) => call.startsWith('launchctl bootstrap'))).toBe(true);
      await expect(backend.execute({ action: 'create', task_name: 'daily-report', command: '/usr/bin/false', schedule: 'DAILY', start_time: '09:30', userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect((await readFile(path.join(home, 'Library', 'LaunchAgents', 'com.lnwjud.daily-report.plist'), 'utf8'))).toContain('/usr/bin/printf');
      await expect(backend.execute({ action: 'run', task_name: 'daily-report', userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      await expect(backend.execute({ action: 'delete', task_name: 'daily-report', userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect((await readFile(path.join(home, 'Library', 'LaunchAgents', 'com.lnwjud.daily-report.plist'), 'utf8'))).toContain('/usr/bin/printf');
      await expect(backend.execute({ action: 'create', task_name: 'weekly report', command: '/usr/bin/printf', schedule: 'WEEKLY', weekday: 5, start_time: '10:15', userConfirmed: true })).resolves.toMatchObject({ ok: true });
      const weekly = await readFile(path.join(home, 'Library', 'LaunchAgents', 'com.lnwjud.weekly-report.plist'), 'utf8');
      expect(weekly).toContain('<key>Weekday</key>');
      expect(weekly).toContain('<integer>5</integer>');
      await expect(backend.execute({ action: 'create', task_name: 'once report', command: '/usr/bin/printf', schedule: 'ONCE', start_date: '2030-04-05', start_time: '11:20', userConfirmed: true })).resolves.toMatchObject({ ok: true });
      const once = await readFile(path.join(home, 'Library', 'LaunchAgents', 'com.lnwjud.once-report.plist'), 'utf8');
      expect(once).toContain('<key>Year</key>');
      expect(once).toContain('<integer>2030</integer>');
      await writeFile(path.join(home, 'Library', 'LaunchAgents', 'com.lnwjud.foreign.plist'), '<plist><dict><key>Label</key><string>com.lnwjud.foreign</string></dict></plist>');
      const listed = await backend.execute({ action: 'list' });
      expect(listed).toMatchObject({ ok: true, value: { tasks: expect.not.arrayContaining([expect.objectContaining({ name: 'foreign' })]) } });
      await expect(backend.execute({ action: 'run', task_name: 'daily report', userConfirmed: true })).resolves.toMatchObject({ ok: true, value: { started: true } });
      expect(calls.some((call) => call.includes('launchctl kickstart -k gui/'))).toBe(true);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('writes only owned Linux user units and does not fall back to cron', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-systemd-'));
    const calls: string[] = [];
    const backend = new LinuxSchedulerCapabilityBackend({ homeDirectory: home, runImpl: async (executable: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => { calls.push(`${executable} ${args.join(' ')}`); return { stdout: '', stderr: '' }; } });
    try {
      const created = await backend.execute({ action: 'create', task_name: 'build-test', command: '/usr/bin/node', arguments: ['--version', '100% done'], schedule: 'HOURLY', userConfirmed: true });
      expect(created).toMatchObject({ ok: true, value: { backend: 'systemd-user', service: 'lnwjud-build-test.service', timer: 'lnwjud-build-test.timer' } });
      await expect(backend.execute({ action: 'create', task_name: 'build test', command: '/usr/bin/false', schedule: 'HOURLY', userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect((await readFile(path.join(home, '.config', 'systemd', 'user', 'lnwjud-build-test.service'), 'utf8'))).toContain('ExecStart=/usr/bin/node');
      expect((await readFile(path.join(home, '.config', 'systemd', 'user', 'lnwjud-build-test.service'), 'utf8'))).toContain('100%% done');
      await expect(backend.execute({ action: 'run', task_name: 'build test', userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      await expect(backend.execute({ action: 'delete', task_name: 'build test', userConfirmed: true })).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect((await readFile(path.join(home, '.config', 'systemd', 'user', 'lnwjud-build-test.service'), 'utf8'))).toContain('ExecStart=/usr/bin/node');
      expect(calls.every((call) => !call.includes('cron'))).toBe(true);
      await expect(backend.execute({ action: 'create', task_name: 'weekly-build', command: '/usr/bin/node', schedule: 'WEEKLY', weekday: 2, start_time: '08:00', userConfirmed: true })).resolves.toMatchObject({ ok: true });
      const weekly = await readFile(path.join(home, '.config', 'systemd', 'user', 'lnwjud-weekly-build.timer'), 'utf8');
      expect(weekly).toContain('OnCalendar=Tue *-*-* 08:00:00');
      await expect(backend.execute({ action: 'create', task_name: 'once-build', command: '/usr/bin/node', schedule: 'ONCE', start_date: '2030-04-05', start_time: '08:00', userConfirmed: true })).resolves.toMatchObject({ ok: true });
      const once = await readFile(path.join(home, '.config', 'systemd', 'user', 'lnwjud-once-build.timer'), 'utf8');
      expect(once).toContain('OnCalendar=2030-04-05 08:00:00');
      await writeFile(path.join(home, '.config', 'systemd', 'user', 'lnwjud-foreign.service'), '[Service]\nExecStart=/usr/bin/false\n');
      await writeFile(path.join(home, '.config', 'systemd', 'user', 'lnwjud-foreign.timer'), '[Timer]\nOnCalendar=hourly\n');
      const foreignListed = await backend.execute({ action: 'list' });
      expect(foreignListed).toMatchObject({ ok: true, value: { tasks: expect.not.arrayContaining([expect.objectContaining({ name: 'lnwjud-foreign.service' })]) } });
      await expect(backend.execute({ action: 'run', task_name: 'build-test', userConfirmed: true })).resolves.toMatchObject({ ok: true, value: { started: true, timer: 'lnwjud-build-test.timer' } });
      expect(calls.some((call) => call.includes('systemctl --user start lnwjud-build-test.service'))).toBe(true);
      expect(calls.some((call) => call.includes('systemctl --user enable --now lnwjud-build-test.timer'))).toBe(true);
      const listed = await backend.execute({ action: 'list' });
      expect(listed).toMatchObject({ ok: true, value: { available: true, ready: true, tasks: expect.arrayContaining([expect.objectContaining({ name: 'lnwjud-build-test.service' })]) } });
      await expect(backend.execute({ action: 'delete', task_name: 'build-test', userConfirmed: true })).resolves.toMatchObject({ ok: true, value: { deleted: true } });
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
