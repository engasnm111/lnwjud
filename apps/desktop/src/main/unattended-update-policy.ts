import type { autoUpdater } from 'electron-updater';
import type { UpdaterDistribution } from './portable-update.js';

export type UnattendedUpdateSupport =
  | { readonly kind: 'native-supported' }
  | { readonly kind: 'unavailable'; readonly reason: 'windows-publisher-verification-unavailable' | 'native-update-transaction-unavailable' | 'unsupported-distribution' };

export function unattendedUpdateSupport(distribution: UpdaterDistribution): UnattendedUpdateSupport {
  // electron-updater skips Windows signature checks without publisher metadata.
  if (distribution === 'installer') return { kind: 'unavailable', reason: 'windows-publisher-verification-unavailable' };
  if (distribution === 'macos') return { kind: 'unavailable', reason: 'native-update-transaction-unavailable' };
  return { kind: 'unavailable', reason: 'unsupported-distribution' };
}

export function installWindowsUpdate(updater: Pick<typeof autoUpdater, 'quitAndInstall'>, unattended: boolean): void {
  if (unattended) updater.quitAndInstall(true, true);
  else updater.quitAndInstall();
}
