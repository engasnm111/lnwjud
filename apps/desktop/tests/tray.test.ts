import type { UpdateStatus } from '@lnwjud/ipc-contracts';
import { describe, expect, it, vi } from 'vitest';
import { nativeMessages } from '../src/main/native-i18n.js';
import {
  createTrayMenuTemplate,
  createTrayToolTip,
  createTrayUpdateLabel,
  prepareTrayIcon,
  shouldHideMainWindowOnClose,
  type TrayIconImage,
} from '../src/main/tray.js';

describe('desktop tray behavior', () => {
  it('exposes Thai open, update, and quit actions in the context menu', () => {
    const actions = {
      locale: 'th' as const,
      openMainWindow: vi.fn(),
      checkForUpdates: vi.fn(),
      quit: vi.fn(),
    };
    const menu = createTrayMenuTemplate(actions);

    expect(menu.map((item) => item.type === 'separator' ? 'separator' : item.label)).toEqual([
      'เปิดหน้า',
      'ตรวจอัปเดต',
      'separator',
      'ปิดโปรแกรม',
    ]);

    menu[0]?.click?.();
    menu[1]?.click?.();
    menu[3]?.click?.();
    expect(actions.openMainWindow).toHaveBeenCalledOnce();
    expect(actions.checkForUpdates).toHaveBeenCalledOnce();
    expect(actions.quit).toHaveBeenCalledOnce();
  });

  it('localizes the whole tray menu to English', () => {
    const menu = createTrayMenuTemplate({
      locale: 'en',
      openMainWindow: vi.fn(),
      checkForUpdates: vi.fn(),
      quit: vi.fn(),
    });

    expect(menu.map((item) => item.type === 'separator' ? 'separator' : item.label)).toEqual([
      'Open lnwjud',
      'Check for Updates',
      'separator',
      'Quit',
    ]);
  });

  it('shows a contextual install label when an update is ready', () => {
    const actions = {
      locale: 'th' as const,
      openMainWindow: vi.fn(),
      checkForUpdates: vi.fn(),
      updateLabel: 'ติดตั้งอัปเดต v4.7.0',
      quit: vi.fn(),
    };
    const menu = createTrayMenuTemplate(actions);

    expect(menu[1]?.label).toBe('ติดตั้งอัปเดต v4.7.0');
    menu[1]?.click?.();
    expect(actions.checkForUpdates).toHaveBeenCalledOnce();
  });

  it('localizes updater state labels and the tray tooltip', () => {
    const ready: UpdateStatus = {
      phase: 'ready',
      currentVersion: '4.6.1',
      availableVersion: '4.6.2',
      progressPercent: 100,
      lastCheckedAt: null,
      message: null,
      canInstall: true,
    };
    const downloading: UpdateStatus = {
      ...ready,
      phase: 'downloading',
      progressPercent: 42.4,
      canInstall: false,
    };

    expect(createTrayUpdateLabel(ready, 'th')).toBe('ติดตั้งอัปเดต v4.6.2');
    expect(createTrayUpdateLabel(ready, 'en')).toBe('Install update v4.6.2');
    expect(createTrayUpdateLabel(downloading, 'th')).toBe('กำลังดาวน์โหลด v4.6.2 42%');
    expect(createTrayUpdateLabel(downloading, 'en')).toBe('Downloading v4.6.2 42%');
    expect(createTrayToolTip('th')).toBe('lnwjud — ทำงานเบื้องหลัง');
    expect(createTrayToolTip('en')).toBe('lnwjud — running in background');
  });

  it('respects the configured close behavior while still allowing an intentional quit', () => {
    expect(shouldHideMainWindowOnClose(false)).toBe(true);
    expect(shouldHideMainWindowOnClose(false, 'tray')).toBe(true);
    expect(shouldHideMainWindowOnClose(false, 'quit')).toBe(false);
    expect(shouldHideMainWindowOnClose(true, 'tray')).toBe(false);
    expect(shouldHideMainWindowOnClose(true, 'quit')).toBe(false);
  });

  it('keeps manual update feedback localized in the native catalog', () => {
    expect(nativeMessages('th').updateCurrentDialog('4.6.1')).toBe('lnwjud v4.6.1 เป็นเวอร์ชันล่าสุดแล้ว');
    expect(nativeMessages('en').updateCurrentDialog('4.6.1')).toBe('lnwjud v4.6.1 is up to date');
  });
});

interface StubTrayImageCallLog {
  readonly resizes: Array<{ readonly width?: number; readonly height?: number }>;
  readonly representations: Array<{ readonly scaleFactor: number; readonly width: number; readonly height: number; readonly buffer: Buffer }>;
  readonly pngEncodes: number;
}

function createStubTrayImage(log: StubTrayImageCallLog): TrayIconImage {
  const image: TrayIconImage = {
    resize(options) {
      log.resizes.push(options);
      return image;
    },
    toPNG() {
      log.pngEncodes += 1;
      return Buffer.from('png');
    },
    addRepresentation(options) {
      log.representations.push(options);
    },
  };
  return image;
}

describe('prepareTrayIcon', () => {
  it('downsizes the icon to 16pt with a @2x representation on darwin', () => {
    const log: StubTrayImageCallLog = { resizes: [], representations: [], pngEncodes: 0 };
    const result = prepareTrayIcon(createStubTrayImage(log), 'darwin');

    expect(log.resizes).toEqual([
      { width: 32, height: 32 },
      { width: 16, height: 16 },
    ]);
    expect(log.representations).toEqual([
      { scaleFactor: 2, width: 32, height: 32, buffer: Buffer.from('png') },
    ]);
    expect(log.pngEncodes).toBe(1);
    expect(result).toBeDefined();
  });

  it('returns the image untouched on platforms that already receive full-size icons', () => {
    const log: StubTrayImageCallLog = { resizes: [], representations: [], pngEncodes: 0 };
    const image = createStubTrayImage(log);

    expect(prepareTrayIcon(image, 'win32')).toBe(image);
    expect(prepareTrayIcon(image, 'linux')).toBe(image);
    expect(log.resizes).toEqual([]);
    expect(log.representations).toEqual([]);
  });
});
