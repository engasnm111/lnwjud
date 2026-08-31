import type { MenuItemConstructorOptions } from 'electron';
import type { CloseBehavior, UiLocale, UpdateStatus } from '@lnwjud/ipc-contracts';
import { nativeMessages } from './native-i18n.js';

/** Minimal surface of Electron.NativeImage used by prepareTrayIcon; keeps the helper stub-testable. */
export interface TrayIconImage {
  resize(options: { readonly width?: number; readonly height?: number }): TrayIconImage;
  toPNG(): Buffer;
  addRepresentation(options: { readonly scaleFactor: number; readonly width: number; readonly height: number; readonly buffer: Buffer }): void;
}

const TRAY_ICON_SIZE_PX = 16;

/**
 * macOS menu bar icons must be small (~16pt with a @2x representation); a
 * full-size 512px logo would render as an oversized status item. Other
 * platforms already expect a full-resolution icon and are returned unchanged.
 */
export function prepareTrayIcon<T extends TrayIconImage>(image: T, platform: NodeJS.Platform): T {
  if (platform !== 'darwin') return image;
  const hidpi = image.resize({ width: TRAY_ICON_SIZE_PX * 2, height: TRAY_ICON_SIZE_PX * 2 });
  const standard = image.resize({ width: TRAY_ICON_SIZE_PX, height: TRAY_ICON_SIZE_PX });
  standard.addRepresentation({
    scaleFactor: 2,
    width: TRAY_ICON_SIZE_PX * 2,
    height: TRAY_ICON_SIZE_PX * 2,
    buffer: hidpi.toPNG(),
  });
  return standard as T;
}

export interface TrayMenuActions {
  readonly locale: UiLocale;
  readonly openMainWindow: () => void;
  readonly checkForUpdates: () => void;
  readonly updateLabel?: string;
  readonly quit: () => void;
}

export function createTrayMenuTemplate(actions: TrayMenuActions): MenuItemConstructorOptions[] {
  const labels = nativeMessages(actions.locale);
  return [
    { label: labels.trayOpen, click: actions.openMainWindow },
    { label: actions.updateLabel ?? labels.trayCheckUpdates, click: actions.checkForUpdates },
    { type: 'separator' },
    { label: labels.trayQuit, click: actions.quit },
  ];
}

export function createTrayUpdateLabel(status: UpdateStatus, locale: UiLocale): string {
  const messages = nativeMessages(locale);
  const version = status.availableVersion;
  if (status.phase === 'ready' && version !== null) return messages.trayInstall(version);
  if (status.phase === 'installing' && version !== null) return messages.trayPreparing(version);
  if (status.phase === 'downloading' && version !== null) return messages.trayDownloading(version, status.progressPercent);
  if (status.phase === 'checking') return messages.updaterChecking;
  return messages.trayCheckUpdates;
}

export function createTrayToolTip(locale: UiLocale): string {
  return nativeMessages(locale).trayTooltip;
}

export function shouldHideMainWindowOnClose(quitRequested: boolean, closeBehavior: CloseBehavior = 'tray'): boolean {
  return !quitRequested && closeBehavior === 'tray';
}
