import { lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  inspect: vi.fn<() => Promise<void>>(),
  clearReset: vi.fn(), applyReset: vi.fn(),
  quit: vi.fn(), exit: vi.fn(), showErrorBox: vi.fn(),
  on: vi.fn(), whenReady: vi.fn(async () => undefined),
  appPath: vi.fn<() => string>(),
}));

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: vi.fn(() => true), quit: harness.quit, exit: harness.exit,
    on: harness.on, whenReady: harness.whenReady, setName: vi.fn(), setPath: vi.fn(),
    getPath: vi.fn(() => ''), getAppPath: harness.appPath,
    setAppUserModelId: vi.fn(), disableHardwareAcceleration: vi.fn(),
    commandLine: { appendSwitch: vi.fn() }, isPackaged: false,
  },
  BrowserWindow: class { public static getAllWindows(): unknown[] { return []; } },
  dialog: { showMessageBox: vi.fn(), showErrorBox: harness.showErrorBox },
  safeStorage: {}, ipcMain: { handle: vi.fn() }, Menu: {}, nativeImage: {}, shell: {}, Tray: class {},
}));
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn() } }));
vi.mock('@lnwjud/capabilities', async (original) => ({
  ...await original<typeof import('@lnwjud/capabilities')>(), assertHostWindowsUpdateStartup: harness.inspect,
}));
vi.mock('../src/main/factory-reset.js', async (original) => ({
  ...await original<typeof import('../src/main/factory-reset.js')>(),
  clearFactoryResetBootstrapSync: harness.clearReset, applyPendingFactoryResetSync: harness.applyReset,
}));

const originalArgv = process.argv;
const temporaryDirectories: string[] = [];
afterEach(async () => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== 'win32')('native admission before Desktop entrypoint writes', () => {
  it.each(['gui', 'stdio', 'factory-reset'] as const)('holds %s without touching the data profile or opening a headless dialog', async (mode) => {
    vi.resetModules();
    for (const mock of Object.values(harness)) mock.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-startup-admission-'));
    temporaryDirectories.push(root);
    const dataPath = path.join(root, 'profile');
    harness.appPath.mockReturnValue(fileURLToPath(new URL('../dist/main/', import.meta.url)));
    vi.stubEnv('LNWJUD_DATA_PATH', dataPath);
    process.argv = [process.execPath, 'lnwjud', ...mode === 'stdio' ? ['--mcp-stdio'] : mode === 'factory-reset' ? ['--lnwjud-apply-factory-reset'] : []];
    let deny: (error: Error) => void = () => { throw new Error('Inspection did not start'); };
    harness.inspect.mockImplementation(() => new Promise<void>((_resolve, reject) => { deny = reject; }));
    await import('../src/main/main.js');
    expect(harness.inspect).toHaveBeenCalledOnce();
    expect(harness.whenReady).not.toHaveBeenCalled();
    expect(harness.clearReset).not.toHaveBeenCalled();
    expect(harness.applyReset).not.toHaveBeenCalled();
    await expect(lstat(dataPath)).rejects.toMatchObject({ code: 'ENOENT' });
    if (mode === 'gui') {
      const listener = harness.on.mock.calls.find(([event]) => event === 'second-instance')?.[1];
      expect(listener).toBeTypeOf('function');
      listener(undefined, ['lnwjud.exe', '--log-viewer']);
      expect(harness.showErrorBox).not.toHaveBeenCalled();
    }
    deny(new Error('UPDATE_ENROLLMENT_UNVERIFIED'));
    await vi.waitFor(() => expect(mode === 'gui' ? harness.quit : harness.exit).toHaveBeenCalledOnce());
    expect(harness.clearReset).not.toHaveBeenCalled();
    expect(harness.applyReset).not.toHaveBeenCalled();
    await expect(lstat(dataPath)).rejects.toMatchObject({ code: 'ENOENT' });
    if (mode !== 'gui') {
      expect(harness.showErrorBox).not.toHaveBeenCalled();
      expect(harness.exit).toHaveBeenCalledWith(1);
    }
    expect(harness.inspect).toHaveBeenCalledWith(dataPath, fileURLToPath(new URL('../build/native-containment', import.meta.url)));
  });
});
