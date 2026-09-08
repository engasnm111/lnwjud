import { describe, expect, it, vi } from 'vitest';
import {
  PORTABLE_UPDATE_CHANNEL,
  PORTABLE_UPDATE_FEED_URL,
  configureUpdaterForDistribution,
  configureUpdaterForPlatform,
  currentPortableExecutablePath,
  detectWindowsDistribution,
  detectUpdaterDistribution,
  portableReplacementScript,
} from '../src/main/portable-update.js';

describe('Windows distribution-aware auto updater', () => {
  it('selects only updater formats with a platform-owned installation path', () => {
    expect(detectUpdaterDistribution(true, 'darwin', {})).toBe('macos');
    expect(detectUpdaterDistribution(true, 'linux', { APPIMAGE: '/tmp/lnwjud.AppImage' })).toBe('linux-appimage');
    expect(detectUpdaterDistribution(true, 'linux', {})).toBe('unsupported');
    expect(detectUpdaterDistribution(true, 'freebsd', {})).toBe('unsupported');
    expect(detectUpdaterDistribution(false, 'darwin', {})).toBe('unsupported');
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
