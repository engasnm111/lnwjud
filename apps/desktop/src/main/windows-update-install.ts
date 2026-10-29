import type { autoUpdater } from 'electron-updater';

/** Use after the main process has obtained explicit consent for the exact update. */
export function installWindowsUpdate(updater: Pick<typeof autoUpdater, 'quitAndInstall'>): void {
  updater.quitAndInstall(true, true);
}
