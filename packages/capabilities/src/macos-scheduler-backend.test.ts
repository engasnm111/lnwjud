import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MacOsSchedulerCapabilityBackend, type MacOsSchedulerFileSystem } from './macos-scheduler-backend.js';

function taskLabel(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'task';
  const digest = createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 12);
  return `com.lnwjud.scheduler.${slug}.${digest}`;
}

function fileSystem(overrides: Partial<MacOsSchedulerFileSystem> = {}): MacOsSchedulerFileSystem {
  return {
    listDirectory: async () => [],
    readText: async () => '',
    exists: async () => false,
    ensureDirectory: async () => undefined,
    writeExclusive: async () => undefined,
    rename: async () => undefined,
    remove: async () => undefined,
    ...overrides,
  };
}

describe('MacOsSchedulerCapabilityBackend', () => {
  it('rejects non-macOS platforms without touching launchctl', async () => {
    const runImpl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const backend = new MacOsSchedulerCapabilityBackend({ platform: 'linux', userId: 501, runImpl });

    await expect(backend.execute({ action: 'list' })).resolves.toMatchObject({
      ok: false, error: { code: 'INTERNAL_ERROR', message: expect.stringContaining('unavailable on this platform') },
    });
    expect(runImpl).not.toHaveBeenCalled();
  });

  it('keeps dry-run side-effect free and requires confirmation for mutations', async () => {
    const runImpl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const fs = fileSystem({ exists: vi.fn(async () => false) });
    const backend = new MacOsSchedulerCapabilityBackend({ platform: 'darwin', homeDirectory: '/Users/tester', userId: 501, runImpl, fileSystem: fs });

    await expect(backend.execute({ action: 'create', task_name: 'Daily Sync', command: '/usr/bin/true', schedule: 'DAILY', start_time: '09:30', dry_run: true }))
      .resolves.toMatchObject({ ok: true, value: { dry_run: true, provider: 'launchd', task_name: 'Daily Sync', schedule: 'DAILY' } });
    await expect(backend.execute({ action: 'create', task_name: 'Daily Sync', command: '/usr/bin/true' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(runImpl).not.toHaveBeenCalled();
    expect(fs.exists).not.toHaveBeenCalled();
  });

  it('creates an owned launchd plist atomically with escaped argv and bootstraps only that file', async () => {
    const runImpl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const writeExclusive = vi.fn(async () => undefined);
    const rename = vi.fn(async () => undefined);
    const fs = fileSystem({ writeExclusive, rename });
    const backend = new MacOsSchedulerCapabilityBackend({ platform: 'darwin', homeDirectory: '/Users/tester', userId: 501, runImpl, fileSystem: fs });
    const label = taskLabel('Daily Sync');
    const plistPath = `/Users/tester/Library/LaunchAgents/${label}.plist`;

    await expect(backend.execute({
      action: 'create', task_name: 'Daily Sync', command: '/Applications/My & Tool', arguments: ['<flag>', 'a"b'], schedule: 'DAILY', start_time: '09:30', userConfirmed: true,
    })).resolves.toMatchObject({ ok: true, value: { created: true, task_name: 'Daily Sync', label, provider: 'launchd' } });

    expect(writeExclusive).toHaveBeenCalledTimes(1);
    const [tempPath, content] = writeExclusive.mock.calls[0]!;
    expect(tempPath).toMatch(/^\/Users\/tester\/Library\/LaunchAgents\/\.com\.lnwjud\.scheduler\./);
    expect(content).toContain(`<string>${label}</string>`);
    expect(content).toContain('<string>/Applications/My &amp; Tool</string>');
    expect(content).toContain('<string>&lt;flag&gt;</string>');
    expect(content).toContain('<string>a&quot;b</string>');
    expect(content).toContain('<integer>9</integer>');
    expect(content).toContain('<integer>30</integer>');
    expect(rename).toHaveBeenCalledWith(tempPath, plistPath);
    expect(runImpl).toHaveBeenCalledWith('/bin/launchctl', ['bootstrap', 'gui/501', plistPath]);
  });

  it('lists only owned launch agents with matching labels and ignores foreign definitions', async () => {
    const name = 'Daily Sync';
    const label = taskLabel(name);
    const encoded = Buffer.from(name, 'utf8').toString('base64');
    const owned = `${label}.plist`;
    const fs = fileSystem({
      listDirectory: async () => [owned, 'com.other.foreign.plist', 'com.lnwjud.scheduler.tampered.plist'],
      readText: async (filePath) => filePath.endsWith(owned)
        ? `<!-- lnwjud-task-name:${encoded} --><key>Label</key><string>${label}</string>`
        : '<key>Label</key><string>com.other.foreign</string>',
    });
    const backend = new MacOsSchedulerCapabilityBackend({ platform: 'darwin', homeDirectory: '/Users/tester', userId: 501, fileSystem: fs });

    await expect(backend.execute({ action: 'list' })).resolves.toEqual({
      ok: true,
      value: {
        provider: 'launchd',
        tasks: [{ name, label, path: `/Users/tester/Library/LaunchAgents/${owned}` }],
      },
    });
  });

  it('runs and deletes only the deterministic owned launchd identity', async () => {
    const runImpl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const remove = vi.fn(async () => undefined);
    const fs = fileSystem({ exists: async () => true, remove });
    const backend = new MacOsSchedulerCapabilityBackend({ platform: 'darwin', homeDirectory: '/Users/tester', userId: 501, runImpl, fileSystem: fs });
    const label = taskLabel('Daily Sync');
    const plistPath = `/Users/tester/Library/LaunchAgents/${label}.plist`;

    await expect(backend.execute({ action: 'run', task_name: 'Daily Sync', userConfirmed: true }))
      .resolves.toMatchObject({ ok: true, value: { started: true, label } });
    await expect(backend.execute({ action: 'delete', task_name: 'Daily Sync', userConfirmed: true }))
      .resolves.toMatchObject({ ok: true, value: { deleted: true, label } });

    expect(runImpl).toHaveBeenNthCalledWith(1, '/bin/launchctl', ['kickstart', '-k', `gui/501/${label}`]);
    expect(runImpl).toHaveBeenNthCalledWith(2, '/bin/launchctl', ['bootout', `gui/501/${label}`]);
    expect(remove).toHaveBeenCalledWith(plistPath);
  });

  it('supports bounded HOURLY scheduling and rejects unsupported schedule names before mutation', async () => {
    const runImpl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const writeExclusive = vi.fn(async () => undefined);
    const fs = fileSystem({ writeExclusive });
    const backend = new MacOsSchedulerCapabilityBackend({ platform: 'darwin', homeDirectory: '/Users/tester', userId: 501, runImpl, fileSystem: fs });

    await expect(backend.execute({ action: 'create', task_name: 'Hourly Sync', command: '/usr/bin/true', schedule: 'HOURLY', userConfirmed: true }))
      .resolves.toMatchObject({ ok: true, value: { created: true, schedule: 'HOURLY' } });
    expect(writeExclusive.mock.calls[0]?.[1]).toContain('<key>StartInterval</key>\n  <integer>3600</integer>');

    await expect(backend.execute({ action: 'create', task_name: 'Weekly Sync', command: '/usr/bin/true', schedule: 'WEEKLY', userConfirmed: true }))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(runImpl).toHaveBeenCalledTimes(1);
  });

  it('reports uncertain mutation state after launchctl dispatch failure and never retries automatically', async () => {
    const runImpl = vi.fn(async () => { throw new Error('launchctl transport interrupted'); });
    const fs = fileSystem({ exists: async () => true });
    const backend = new MacOsSchedulerCapabilityBackend({ platform: 'darwin', homeDirectory: '/Users/tester', userId: 501, runImpl, fileSystem: fs });

    const result = await backend.execute({ action: 'run', task_name: 'Daily Sync', userConfirmed: true });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'PROCESS_TIMEOUT', recoverable: true, message: expect.stringMatching(/outcome may be unknown.*do not retry automatically/i) },
    });
    expect(runImpl).toHaveBeenCalledTimes(1);
  });

  it('does not touch launchd or the filesystem when already cancelled', async () => {
    const runImpl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const exists = vi.fn(async () => true);
    const backend = new MacOsSchedulerCapabilityBackend({ platform: 'darwin', homeDirectory: '/Users/tester', userId: 501, runImpl, fileSystem: fileSystem({ exists }) });
    const controller = new AbortController();
    controller.abort();

    await expect(backend.execute({ action: 'run', task_name: 'Daily Sync', userConfirmed: true }, controller.signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(exists).not.toHaveBeenCalled();
    expect(runImpl).not.toHaveBeenCalled();
  });
});
