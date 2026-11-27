import type { MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CloseBehavior, UiLocale, UpdateStatus } from '@lnwjud/ipc-contracts';
import { nativeMessages } from './native-i18n.js';

const mainDirectory = path.dirname(fileURLToPath(import.meta.url));

export function getTrayIconPath(platform: NodeJS.Platform = process.platform): string | undefined {
  const pngCandidates = [
    path.resolve(mainDirectory, '..', 'renderer', 'logo.png'),
    path.resolve(mainDirectory, '..', 'renderer', 'logo-192.png'),
    path.resolve(mainDirectory, '..', '..', 'build', 'icon.png'),
    path.resolve(mainDirectory, '..', '..', 'src', 'renderer', 'public', 'logo.png'),
  ];
  const windowsCandidates = [
    path.resolve(mainDirectory, '..', 'renderer', 'favicon.ico'),
    path.resolve(mainDirectory, '..', '..', 'build', 'icon.ico'),
    ...pngCandidates,
  ];
  // Linux desktop trays are most consistently backed by PNG pixmaps while
  // Windows keeps ICO as its native first choice. macOS also needs PNG so it
  // can be converted to a template image by the Tray composition code.
  const candidates = platform === 'win32' ? windowsCandidates : pngCandidates;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
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
  if (status.phase === 'available' && version !== null && status.mode !== undefined) return messages.trayDownloadPackage(version);
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
