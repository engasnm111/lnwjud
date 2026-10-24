import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const harness = vi.hoisted(() => ({
  recover: vi.fn(async (): Promise<{ kind: 'ready' } | { kind: 'held'; reason: string }> => ({ kind: 'ready' })),
  restore: vi.fn<(filename: string, backupDirectory: string, options: unknown) => { applied: boolean }>(() => ({ applied: false })),
}));

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: vi.fn(() => false), quit: vi.fn(), on: vi.fn(),
    whenReady: vi.fn(async () => undefined), setName: vi.fn(), setPath: vi.fn(),
    getPath: vi.fn(() => ''), setAppUserModelId: vi.fn(), isPackaged: true,
  },
  BrowserWindow: class { public static getAllWindows(): unknown[] { return []; } },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })), showErrorBox: vi.fn() },
  safeStorage: { decryptString: vi.fn() }, ipcMain: { handle: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() }, nativeImage: { createFromPath: vi.fn() },
  shell: { openExternal: vi.fn() }, Tray: class {},
}));
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn(), quitAndInstall: vi.fn() } }));
vi.mock('../src/main/native-update-client.js', () => ({
  createNativeUpdateBootstrapClient: vi.fn(() => ({ recoverBeforeStartup: harness.recover })),
}));
vi.mock('@lnwjud/storage', async (original) => ({ ...await original<typeof import('@lnwjud/storage')>(), applyPendingSqliteRestoreSync: harness.restore }));

import { prepareDataPath } from '../src/main/main.js';

beforeEach(() => {
  harness.restore.mockClear();
  harness.recover.mockReset().mockResolvedValue({ kind: 'ready' });
});

describe('packaged writable startup recovery', () => {
  it('holds a pending database restore when update recovery is uncertain', async () => {
    harness.recover.mockResolvedValue({ kind: 'held', reason: 'JOURNAL_CORRUPT' });
    await expect(prepareDataPath('test-profile')).rejects.toThrow('Update recovery holds writable startup');
    expect(harness.restore).not.toHaveBeenCalled();
  });

  it('does not begin restore while native recovery is still unresolved', async () => {
    let completeRecovery: (value: { kind: 'ready' }) => void = () => { throw new Error('Recovery did not start'); };
    harness.recover.mockImplementation(() => new Promise((resolve) => { completeRecovery = resolve; }));
    const startup = prepareDataPath('test-profile');
    await Promise.resolve();
    expect(harness.restore).not.toHaveBeenCalled();
    completeRecovery({ kind: 'ready' });
    await startup;
    expect(harness.restore).toHaveBeenCalledOnce();
  });

  it('preserves normal scheduled restore after verified no-pending recovery', async () => {
    await prepareDataPath('test-profile');
    expect(harness.restore).toHaveBeenCalledOnce();
    expect(harness.restore).toHaveBeenCalledWith(path.join('test-profile', 'lnwjud.sqlite'), path.join('test-profile', 'backups'), expect.any(Object));
  });
});
