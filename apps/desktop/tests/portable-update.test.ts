import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, unlink, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PORTABLE_UPDATE_CHANNEL,
  PORTABLE_UPDATE_FEED_URL,
  configureUpdaterForDistribution,
  configureUpdaterForPlatform,
  createLinuxAppImageRollback,
  restoreLinuxAppImageIfMissing,
  currentPortableExecutablePath,
  detectWindowsDistribution,
  detectUpdaterDistribution,
  portableReplacementScript,
  usesElectronUpdaterInstall,
  waitsForNativeInstallAcceptance,
} from '../src/main/portable-update.js';

describe('Windows distribution-aware auto updater', () => {
  it('selects only updater formats with a platform-owned installation path', () => {
    expect(detectUpdaterDistribution(true, 'darwin', {})).toBe('macos');
    expect(detectUpdaterDistribution(true, 'linux', { APPIMAGE: '/tmp/lnwjud.AppImage' })).toBe('linux-appimage');
    expect(detectUpdaterDistribution(true, 'linux', {})).toBe('unsupported');
    expect(detectUpdaterDistribution(true, 'freebsd', {})).toBe('unsupported');
    expect(detectUpdaterDistribution(false, 'darwin', {})).toBe('unsupported');
  });

  it('routes Windows installers, macOS, and Linux AppImage through electron-updater install while keeping portable/unsupported formats out', () => {
    expect(usesElectronUpdaterInstall('installer')).toBe(true);
    expect(usesElectronUpdaterInstall('macos')).toBe(true);
    expect(usesElectronUpdaterInstall('linux-appimage')).toBe(true);
    expect(usesElectronUpdaterInstall('portable')).toBe(false);
    expect(usesElectronUpdaterInstall('unsupported')).toBe(false);
    expect(waitsForNativeInstallAcceptance('macos')).toBe(true);
    expect(waitsForNativeInstallAcceptance('linux-appimage')).toBe(true);
    expect(waitsForNativeInstallAcceptance('installer')).toBe(false);
    expect(waitsForNativeInstallAcceptance('portable')).toBe(false);
  });

  it('distinguishes electron-builder portable launches from installed builds', () => {
    expect(detectWindowsDistribution(true, { PORTABLE_EXECUTABLE_FILE: 'C:\\Tools\\lnwjud-Portable-4.11.0.exe' }, 'win32')).toBe('portable');
    expect(detectWindowsDistribution(true, {}, 'win32')).toBe('installer');
    expect(detectWindowsDistribution(false, { PORTABLE_EXECUTABLE_FILE: 'C:\\Tools\\lnwjud.exe' }, 'win32')).toBe('installer');
    expect(detectWindowsDistribution(true, { PORTABLE_EXECUTABLE_FILE: '/tmp/lnwjud' }, 'linux')).toBe('installer');
  });

  it('keeps the installer on the packaged GitHub feed and gives portable builds their own manifest channel', () => {
    const setFeedURL = vi.fn();
    const installerUpdater = { disableDifferentialDownload: false, setFeedURL };
    configureUpdaterForDistribution(installerUpdater, 'installer');
    expect(setFeedURL).not.toHaveBeenCalled();
    expect(installerUpdater.disableDifferentialDownload).toBe(false);

    const portableSetFeedURL = vi.fn();
    const portableUpdater = { disableDifferentialDownload: false, setFeedURL: portableSetFeedURL };
    configureUpdaterForDistribution(portableUpdater, 'portable');
    expect(portableUpdater.disableDifferentialDownload).toBe(true);
    expect(portableSetFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: PORTABLE_UPDATE_FEED_URL,
      channel: PORTABLE_UPDATE_CHANNEL,
      useMultipleRangeRequest: false,
    });
  });

  it('disables differential downloads for Linux AppImage without changing the native feed metadata', () => {
    const updater = { disableDifferentialDownload: false, setFeedURL: vi.fn() };
    configureUpdaterForPlatform(updater, 'linux-appimage');
    expect(updater.disableDifferentialDownload).toBe(true);
    expect(updater.setFeedURL).not.toHaveBeenCalled();
  });

  it('retains a working rollback after a Linux AppImage native move deletes the original', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-appimage-'));
    try {
      const current = path.join(root, 'lnwjud-5.8.1-x64.AppImage');
      const downloaded = path.join(root, 'lnwjud-5.8.2-x64.AppImage');
      await writeFile(current, 'old-working-app');
      await writeFile(downloaded, 'new-app');
      const { backupPath } = await createLinuxAppImageRollback(current, downloaded);
      await unlink(current); // AppImageUpdater.doInstall() unlinks before its mv.
      expect(await restoreLinuxAppImageIfMissing(current, backupPath)).toBe(true);
      expect(await readFile(current, 'utf8')).toBe('old-working-app');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects missing or symlinked Linux AppImage inputs before native installation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-appimage-'));
    try {
      const current = path.join(root, 'lnwjud.AppImage');
      const downloaded = path.join(root, 'update.AppImage');
      await writeFile(current, 'old');
      await expect(createLinuxAppImageRollback(current, downloaded)).rejects.toThrow();
      await symlink(current, downloaded);
      await expect(createLinuxAppImageRollback(current, downloaded)).rejects.toThrow('regular files');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('replaces the outer portable executable path rather than Electron temporary extraction path', () => {
    expect(currentPortableExecutablePath({ PORTABLE_EXECUTABLE_FILE: 'D:\\Apps\\lnwjud-portable.exe' }, 'C:\\Temp\\lnwjud.exe')).toBe('D:\\Apps\\lnwjud-portable.exe');
    expect(currentPortableExecutablePath({}, 'C:\\Program Files\\lnwjud\\lnwjud.exe')).toBe('C:\\Program Files\\lnwjud\\lnwjud.exe');
  });

  it('uses a wait, rollback backup, in-place replacement, restart, and script self-cleanup for portable installs', () => {
    const script = portableReplacementScript();
    expect(script).toContain('Get-Process -Id $CurrentPid');
    expect(script).toContain('$Target.lnwjud-update-backup');
    expect(script).toContain('Move-Item -LiteralPath $Target -Destination $backup -Force');
    expect(script).toContain('Move-Item -LiteralPath $Source -Destination $Target -Force');
    expect(script).toContain('Move-Item -LiteralPath $backup -Destination $Target -Force');
    expect(script).toContain('Start-Process -FilePath $Target');
    expect(script).toContain('Remove-Item -LiteralPath $PSCommandPath');
  });
});
