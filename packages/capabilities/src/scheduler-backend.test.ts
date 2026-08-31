import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SchedulerCapabilityBackend, type SchedulerRunResult } from './scheduler-backend.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function abortError(): Error {
  const error = new Error('operation aborted');
  error.name = 'AbortError';
  return error;
}

interface LaunchctlScript {
  readonly bootout?: 'ok' | 'fail' | 'abort';
  readonly print?: 'ok' | 'fail' | 'abort';
}

function launchctlRunImpl(script: LaunchctlScript = {}): ReturnType<typeof vi.fn> {
  return vi.fn(async (_executable: string, args: readonly string[]): Promise<SchedulerRunResult> => {
    const subcommand = args[0];
    if (subcommand === 'bootout') {
      if (script.bootout === 'fail') throw new Error('Boot-out failed: (ipc/send) invalid right port');
      if (script.bootout === 'abort') throw abortError();
    }
    if (subcommand === 'print') {
      if (script.print === 'fail') throw new Error('Could not find service');
      if (script.print === 'abort') throw abortError();
    }
    return { stdout: '', stderr: '' };
  });
}

async function temporaryLaunchAgentsDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-scheduler-mac-'));
  temporaryRoots.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}

describe('SchedulerCapabilityBackend', () => {
  it('lists tasks parsed from schtasks LIST output', async () => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => ({
      stdout: 'TaskName: \\MyTask\nStatus: Ready\n\nTaskName: \\Other Task\nStatus: Running\n',
      stderr: '',
    }));
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });

    const result = await backend.execute({ action: 'list' });

    expect(result).toMatchObject({
      ok: true,
      value: { tasks: [{ name: '\\MyTask', status: 'Ready' }, { name: '\\Other Task', status: 'Running' }] },
    });
  });

  it('creates a task with a quoted command line', async () => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: 'SUCCESS', stderr: '' }));
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });

    const result = await backend.execute({
      action: 'create',
      task_name: 'LnwjudTest',
      command: 'C:\\Program Files\\app\\tool.exe',
      arguments: ['--flag', 'value with space'],
      schedule: 'DAILY',
      start_time: '09:30',
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true, value: { created: true, task_name: 'LnwjudTest' } });
    expect(runImpl).toHaveBeenCalledWith('schtasks.exe', [
      '/Create', '/TN', 'LnwjudTest',
      '/TR', '"C:\\Program Files\\app\\tool.exe" --flag "value with space"',
      '/SC', 'DAILY', '/ST', '09:30',
    ]);
  });

  it('requires confirmation before deleting a scheduled task', async () => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: 'SUCCESS', stderr: '' }));
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });

    await expect(backend.execute({ action: 'delete', task_name: 'LnwjudTest' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(runImpl).not.toHaveBeenCalled();

    await expect(backend.execute({ action: 'delete', task_name: 'LnwjudTest', userConfirmed: true }))
      .resolves.toMatchObject({ ok: true, value: { deleted: true, task_name: 'LnwjudTest' } });
    expect(runImpl).toHaveBeenCalledWith('schtasks.exe', ['/Delete', '/TN', 'LnwjudTest', '/F']);
  });

  it('previews a deletion without confirmation or schtasks side effects', async () => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: 'SHOULD NOT RUN', stderr: '' }));
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });

    await expect(backend.execute({ action: 'delete', task_name: 'LnwjudTest', dry_run: true }))
      .resolves.toMatchObject({ ok: true, value: { dry_run: true, action: 'delete', task_name: 'LnwjudTest' } });
    expect(runImpl).not.toHaveBeenCalled();
  });

  it.each(['create', 'run'] as const)('requires confirmation before %s', async (action) => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: 'SUCCESS', stderr: '' }));
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });
    const input = action === 'create'
      ? { action, task_name: 'LnwjudTest', command: 'tool.exe' }
      : { action, task_name: 'LnwjudTest' };

    await expect(backend.execute(input))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(runImpl).not.toHaveBeenCalled();
  });

  it('rejects invalid task names', async () => {
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl: async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: '', stderr: '' }) });

    const result = await backend.execute({ action: 'delete', task_name: 'bad/name' });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('rejects non-win32 platforms', async () => {
    const backend = new SchedulerCapabilityBackend({ platform: 'linux', runImpl: async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: '', stderr: '' }) });

    const result = await backend.execute({ action: 'list' });

    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });

  it('returns recoverable errors with stderr detail', async () => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => {
      throw new Error('schtasks failed: access denied');
    });
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });

    const result = await backend.execute({ action: 'run', task_name: 'MissingTask', userConfirmed: true });

    expect(result).toMatchObject({ ok: false, error: { recoverable: true } });
  });

  it('warns that a failed mutation may already have completed and never retries schtasks automatically', async () => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => {
      throw new Error('transport interrupted after dispatch');
    });
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });

    const result = await backend.execute({ action: 'delete', task_name: 'LnwjudTest', userConfirmed: true });

    expect(result).toMatchObject({
      ok: false,
      error: {
        recoverable: true,
        message: expect.stringMatching(/outcome may be unknown.*do not retry automatically/i),
      },
    });
    expect(runImpl).toHaveBeenCalledTimes(1);
  });

  it('does not invoke schtasks when the caller is already cancelled', async () => {
    const runImpl = vi.fn(async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: '', stderr: '' }));
    const backend = new SchedulerCapabilityBackend({ platform: 'win32', runImpl });
    const controller = new AbortController();
    controller.abort();

    await expect(backend.execute({ action: 'run', task_name: 'LnwjudTest' }, controller.signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(runImpl).not.toHaveBeenCalled();
  });
});

describe('SchedulerCapabilityBackend (darwin launchd)', () => {
  it('creates a LaunchAgent plist and bootstraps it into the user domain', async () => {
    const directory = await temporaryLaunchAgentsDirectory();
    const runImpl = launchctlRunImpl();
    const backend = new SchedulerCapabilityBackend({ platform: 'darwin', runImpl, launchAgentsDirectory: (): string => directory });

    const result = await backend.execute({
      action: 'create',
      task_name: 'Nightly Report',
      command: '/usr/local/bin/report',
      arguments: ['--quiet'],
      schedule: 'DAILY',
      start_time: '09:30',
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true, value: { created: true, task_name: 'Nightly Report', backend: 'launchd' } });
    const plistPath = path.join(directory, 'com.lnwjud.task.nightly-report.plist');
    const plist = await readFile(plistPath, 'utf8');
    expect(plist).toContain('<string>com.lnwjud.task.nightly-report</string>');
    expect(plist).toContain('<key>LnwjudTaskName</key>');
    expect(plist).toContain('<string>Nightly Report</string>');
    expect(plist).toContain('<integer>9</integer>');
    expect(plist).toContain('<integer>30</integer>');
    expect(runImpl).toHaveBeenCalledWith('/bin/launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 0}`, plistPath], undefined);
  });

  it('removes the plist again when bootstrap fails', async () => {
    const directory = await temporaryLaunchAgentsDirectory();
    const runImpl = launchctlRunImpl();
    runImpl.mockImplementation(async (): Promise<SchedulerRunResult> => { throw new Error('bootstrap failed'); });
    const backend = new SchedulerCapabilityBackend({ platform: 'darwin', runImpl, launchAgentsDirectory: (): string => directory });

    const result = await backend.execute({
      action: 'create',
      task_name: 'Broken',
      command: '/usr/bin/true',
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: false, error: { recoverable: true } });
    await expect(readFile(path.join(directory, 'com.lnwjud.task.broken.plist'), 'utf8')).rejects.toThrow();
  });

  it('refuses to overwrite an existing LaunchAgent', async () => {
    const directory = await temporaryLaunchAgentsDirectory();
    await writeFile(path.join(directory, 'com.lnwjud.task.exists.plist'), '<plist version="1.0"></plist>', 'utf8');
    const runImpl = launchctlRunImpl();
    const backend = new SchedulerCapabilityBackend({ platform: 'darwin', runImpl, launchAgentsDirectory: (): string => directory });

    const result = await backend.execute({ action: 'create', task_name: 'Exists', command: '/usr/bin/true', userConfirmed: true });

    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('already exists') } });
    expect(runImpl).not.toHaveBeenCalled();
  });

  it('deletes by booting the agent out and removing the plist', async () => {
    const directory = await temporaryLaunchAgentsDirectory();
    const plistPath = path.join(directory, 'com.lnwjud.task.gone.plist');
    await writeFile(plistPath, '<plist version="1.0"></plist>', 'utf8');
    const runImpl = launchctlRunImpl();
    const backend = new SchedulerCapabilityBackend({ platform: 'darwin', runImpl, launchAgentsDirectory: (): string => directory });

    const result = await backend.execute({ action: 'delete', task_name: 'Gone', userConfirmed: true });

    expect(result).toMatchObject({ ok: true, value: { deleted: true, task_name: 'Gone', backend: 'launchd' } });
    await expect(readFile(plistPath, 'utf8')).rejects.toThrow();
  });

  it('treats a failed bootout as expected when the label is not loaded', async () => {
    const directory = await temporaryLaunchAgentsDirectory();
    const plistPath = path.join(directory, 'com.lnwjud.task.unloaded.plist');
    await writeFile(plistPath, '<plist version="1.0"></plist>', 'utf8');
    const runImpl = launchctlRunImpl({ bootout: 'fail', print: 'fail' });
    const backend = new SchedulerCapabilityBackend({ platform: 'darwin', runImpl, launchAgentsDirectory: (): string => directory });

    const result = await backend.execute({ action: 'delete', task_name: 'Unloaded', userConfirmed: true });

    expect(result).toMatchObject({ ok: true, value: { deleted: true } });
    await expect(readFile(plistPath, 'utf8')).rejects.toThrow();
  });

  it('refuses to report deletion while the LaunchAgent is still loaded', async () => {
    const directory = await temporaryLaunchAgentsDirectory();
    const plistPath = path.join(directory, 'com.lnwjud.task.stuck.plist');
    await writeFile(plistPath, '<plist version="1.0"></plist>', 'utf8');
    const runImpl = launchctlRunImpl({ bootout: 'fail', print: 'ok' });
    const backend = new SchedulerCapabilityBackend({ platform: 'darwin', runImpl, launchAgentsDirectory: (): string => directory });

    const result = await backend.execute({ action: 'delete', task_name: 'Stuck', userConfirmed: true });

    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('could not be unloaded from launchd') },
    });
    await expect(readFile(plistPath, 'utf8')).resolves.toBe('<plist version="1.0"></plist>');
  });

  it('reports an uncertain outcome when the loaded-state probe itself aborts', async () => {
    const directory = await temporaryLaunchAgentsDirectory();
    const plistPath = path.join(directory, 'com.lnwjud.task.abort-probe.plist');
    await writeFile(plistPath, '<plist version="1.0"></plist>', 'utf8');
    const runImpl = launchctlRunImpl({ bootout: 'fail', print: 'abort' });
    const backend = new SchedulerCapabilityBackend({ platform: 'darwin', runImpl, launchAgentsDirectory: (): string => directory });

    const result = await backend.execute({ action: 'delete', task_name: 'Abort Probe', userConfirmed: true });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'PROCESS_TIMEOUT', message: expect.stringContaining('cancelled or timed out') },
    });
    await expect(readFile(plistPath, 'utf8')).resolves.toBe('<plist version="1.0"></plist>');
  });

  it('lists configured LaunchAgents with their schedule time', async () => {
    const directory = await temporaryLaunchAgentsDirectory();
    await writeFile(path.join(directory, 'com.lnwjud.task.daily-backup.plist'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>Label</key><string>com.lnwjud.task.daily-backup</string>',
      '<key>LnwjudTaskName</key><string>Daily Backup</string>',
      '<key>StartCalendarInterval</key><dict>',
      '<key>Hour</key><integer>2</integer>',
      '<key>Minute</key><integer>15</integer>',
      '</dict></dict></plist>',
    ].join('\n'), 'utf8');
    const backend = new SchedulerCapabilityBackend({ platform: 'darwin', runImpl: launchctlRunImpl(), launchAgentsDirectory: (): string => directory });

    const result = await backend.execute({ action: 'list' });

    expect(result).toMatchObject({
      ok: true,
      value: { tasks: [{ name: 'Daily Backup', status: 'loaded-or-configured', schedule: 'DAILY', start_time: '02:15', backend: 'launchd' }] },
    });
  });

  it('runs a configured LaunchAgent via kickstart', async () => {
    const directory = await temporaryLaunchAgentsDirectory();
    await writeFile(path.join(directory, 'com.lnwjud.task.kick-me.plist'), '<plist version="1.0"></plist>', 'utf8');
    const runImpl = launchctlRunImpl();
    const backend = new SchedulerCapabilityBackend({ platform: 'darwin', runImpl, launchAgentsDirectory: (): string => directory });

    const result = await backend.execute({ action: 'run', task_name: 'Kick Me', userConfirmed: true });

    expect(result).toMatchObject({ ok: true, value: { started: true, task_name: 'Kick Me', backend: 'launchd' } });
    expect(runImpl).toHaveBeenCalledWith('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 0}/com.lnwjud.task.kick-me`], undefined);
  });
});
