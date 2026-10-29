import type { UiLocale, UpdateStatus } from '@lnwjud/ipc-contracts';

export interface NativeMessages {
  readonly trayOpen: string;
  readonly trayCheckUpdates: string;
  readonly trayQuit: string;
  readonly trayTooltip: string;
  readonly updaterUnavailablePackagedOnly: string;
  readonly updaterUnavailablePlatform: string;
  readonly updaterUnavailableMacosUnsigned: string;
  readonly updaterUnavailableTransactionAuthority: string;
  readonly updaterAuthorityChecking: string;
  readonly updaterCheckTitle: string;
  readonly updaterUnavailable: string;
  readonly updaterAlreadyChecking: string;
  readonly updaterChecking: string;
  readonly updaterCheckFailed: string;
  readonly updaterInstallWaiting: string;
  readonly updaterInstallConfirmTitle: string;
  updaterInstallConfirmMessage(version: string): string;
  readonly updaterInstallConfirmDetail: string;
  readonly updaterInstallConfirm: string;
  readonly updaterInstallFailedTitle: string;
  readonly updaterInstallFailedMessage: string;
  readonly updaterTunnelStopFailedTitle: string;
  readonly updaterTunnelStopFailedMessage: string;
  readonly updaterAvailableTitle: string;
  readonly ok: string;
  readonly cancel: string;
  readonly shutdownBlockedTitle: string;
  readonly shutdownBlockedMessage: string;
  readonly factoryResetTitle: string;
  readonly factoryResetMessage: string;
  readonly factoryResetDetail: string;
  readonly factoryResetConfirm: string;
  readonly logStatus: string;
  readonly logCapturedRowUnavailable: string;
  readonly logTime: string;
  readonly logLevel: string;
  readonly logMessage: string;
  readonly logSource: string;
  readonly logWorkspace: string;
  readonly logSession: string;
  readonly logTechnical: string;
  readonly logWorkLogTitle: string;
  readonly logExported: string;
  readonly logRows: string;
  updateAvailableStatus(version: string): string;
  updateAvailableDialog(version: string): string;
  updateDownloadingStatus(version: string | null, percent: number | null): string;
  updateCurrentStatus(version: string): string;
  updateCurrentDialog(version: string): string;
  updateReadyStatus(version: string): string;
  trayInstall(version: string): string;
  trayPreparing(version: string): string;
  trayDownloading(version: string, percent: number | null): string;
}

const th: NativeMessages = {
  trayOpen: 'เปิดหน้า',
  trayCheckUpdates: 'ตรวจอัปเดต',
  trayQuit: 'ปิดโปรแกรม',
  trayTooltip: 'lnwjud — ทำงานเบื้องหลัง',
  updaterUnavailablePackagedOnly: 'ระบบอัปเดตทำงานในแอปที่ติดตั้งจาก Release',
  updaterUnavailablePlatform: 'รูปแบบการติดตั้งนี้ให้ระบบปฏิบัติการจัดการอัปเดตเอง จึงปิดการอัปเดตอัตโนมัติของ lnwjud',
  updaterUnavailableMacosUnsigned: 'macOS เวอร์ชันนี้ใช้ลายเซ็น ad-hoc ที่อัปเดตข้ามเวอร์ชันไม่ได้ กรุณาดาวน์โหลดจาก GitHub Releases แล้วติดตั้งทับด้วยตนเอง (ข้อมูลเดิมไม่ถูกลบ)',
  updaterUnavailableTransactionAuthority: 'การอัปเดตอัตโนมัติยังใช้ไม่ได้ เพราะเครื่องนี้ยังไม่มีตัวติดตั้งที่ยืนยันแพ็กเกจ กู้คืนข้อมูล และเปิดแอปใหม่ได้อย่างปลอดภัย',
  updaterAuthorityChecking: 'กำลังตรวจสอบว่าระบบอัปเดตติดตั้งและกู้คืนได้อย่างปลอดภัยหรือไม่…',
  updaterCheckTitle: 'ตรวจอัปเดต - lnwjud',
  updaterUnavailable: 'การตรวจอัปเดตจะทำงานเมื่อใช้แอปที่ติดตั้งจาก Release แล้ว',
  updaterAlreadyChecking: 'กำลังตรวจอัปเดตอยู่ กรุณารอผลการตรวจสอบ',
  updaterChecking: 'กำลังตรวจหาเวอร์ชันใหม่…',
  updaterCheckFailed: 'ไม่สามารถตรวจอัปเดตได้',
  updaterInstallWaiting: 'รอให้งานที่กำลังทำเสร็จ จากนั้น lnwjud จะหยุด Secure Tunnel ติดตั้งอัปเดต และเปิดแอปใหม่อัตโนมัติ…',
  updaterInstallConfirmTitle: 'ยืนยันการติดตั้งอัปเดต',
  updaterInstallConfirmMessage: (version) => `lnwjud เวอร์ชัน v${version} พร้อมติดตั้งแล้ว ต้องการติดตั้งตอนนี้หรือไม่?`,
  updaterInstallConfirmDetail: 'หลังยืนยัน lnwjud จะรอให้งานที่กำลังทำเสร็จ หยุด Secure Tunnel ติดตั้งโดยไม่ต้องกด Next ในตัวติดตั้ง แล้วเปิดแอปใหม่อัตโนมัติ',
  updaterInstallConfirm: 'ติดตั้งและเปิดใหม่',
  updaterInstallFailedTitle: 'ติดตั้งอัปเดตไม่สำเร็จ',
  updaterInstallFailedMessage: 'lnwjud ยังเปิดอยู่ การติดตั้งอัปเดตไม่สำเร็จ คุณสามารถลองใหม่ได้จากป้ายเวอร์ชัน',
  updaterTunnelStopFailedTitle: 'ยังหยุด Secure Tunnel ไม่สำเร็จ',
  updaterTunnelStopFailedMessage: 'ยังติดตั้งอัปเดตไม่ได้ เพราะไม่สามารถยืนยันได้ว่า Secure Tunnel หยุดทำงานแล้ว กรุณาลองอีกครั้ง',
  updaterAvailableTitle: 'พบอัปเดต - lnwjud',
  ok: 'ตกลง',
  cancel: 'ยกเลิก',
  shutdownBlockedTitle: 'lnwjud ยังทำงานอยู่',
  shutdownBlockedMessage: 'ยังยืนยันไม่ได้ว่า Tunnel ที่ lnwjud ดูแลหยุดทำงานแล้ว โปรแกรมจะยังเปิดอยู่ กรุณาตรวจสอบสถานะ Tunnel แล้วลองปิดโปรแกรมอีกครั้ง',
  factoryResetTitle: 'รีเซ็ต lnwjud เป็นค่าเริ่มต้น',
  factoryResetMessage: 'ล้างข้อมูล lnwjud ทั้งหมดบนเครื่องนี้และเริ่มใหม่เหมือนติดตั้งครั้งแรก?',
  factoryResetDetail: 'การรีเซ็ตจะลบฐานข้อมูล การตั้งค่า โปรเจกต์ที่ลงทะเบียน คีย์และ secret, Tunnel profile, backups, logs, cache, ข้อมูลกู้คืน และ First-run state ทั้งหมด ไม่ลบโฟลเดอร์โปรเจกต์จริงของคุณ เมื่อเสร็จ lnwjud จะเปิดใหม่และแสดง Setup Guide',
  factoryResetConfirm: 'ล้างทั้งหมดและเริ่มใหม่',
  logStatus: 'สถานะ',
  logCapturedRowUnavailable: 'ไม่พบรายการที่จับไว้แล้ว',
  logTime: 'เวลา',
  logLevel: 'ระดับ',
  logMessage: 'ข้อความ',
  logSource: 'แหล่งที่มา',
  logWorkspace: 'Workspace',
  logSession: 'Session',
  logTechnical: 'ข้อมูลทางเทคนิค',
  logWorkLogTitle: 'บันทึกการทำงาน',
  logExported: 'เวลาส่งออก',
  logRows: 'จำนวนรายการ',
  updateAvailableStatus: (version) => `พบ v${version} — กำลังดาวน์โหลดในเบื้องหลัง`,
  updateAvailableDialog: (version) => `พบ lnwjud v${version} กำลังดาวน์โหลดอัปเดตในเบื้องหลัง`,
  updateDownloadingStatus: (_version, percent) => `กำลังดาวน์โหลดอัปเดต ${Math.round(percent ?? 0)}%`,
  updateCurrentStatus: (version) => `v${version} เป็นเวอร์ชันล่าสุดแล้ว`,
  updateCurrentDialog: (version) => `lnwjud v${version} เป็นเวอร์ชันล่าสุดแล้ว`,
  updateReadyStatus: (version) => `v${version} พร้อมติดตั้ง — กดที่เวอร์ชันมุมซ้ายบนเพื่ออัปเดต`,
  trayInstall: (version) => `ติดตั้งอัปเดต v${version}`,
  trayPreparing: (version) => `กำลังเตรียมติดตั้ง v${version}`,
  trayDownloading: (version, percent) => `กำลังดาวน์โหลด v${version}${percent === null ? '' : ` ${Math.round(percent)}%`}`,
};

const en: NativeMessages = {
  trayOpen: 'Open lnwjud',
  trayCheckUpdates: 'Check for Updates',
  trayQuit: 'Quit',
  trayTooltip: 'lnwjud — running in background',
  updaterUnavailablePackagedOnly: 'Updates are available in an installed Release build',
  updaterUnavailablePlatform: 'This installation format is updated by the operating system package manager; lnwjud automatic updates are disabled.',
  updaterUnavailableMacosUnsigned: 'This macOS build has an ad-hoc signature incompatible with in-place updates. Download from GitHub Releases and manually replace the app; your data is preserved.',
  updaterUnavailableTransactionAuthority: 'Automatic updates are unavailable because this installation does not have a verified installer that can authenticate the package, restore data, and relaunch safely.',
  updaterAuthorityChecking: 'Checking whether the update system can install and recover safely…',
  updaterCheckTitle: 'Check for Updates - lnwjud',
  updaterUnavailable: 'Update checks are available after installing a Release build',
  updaterAlreadyChecking: 'An update check is already running. Please wait for it to finish.',
  updaterChecking: 'Checking for a newer version…',
  updaterCheckFailed: 'Unable to check for updates',
  updaterInstallWaiting: 'Waiting for current work to finish. lnwjud will then stop Secure Tunnel, install the update, and reopen automatically…',
  updaterInstallConfirmTitle: 'Confirm Update Installation',
  updaterInstallConfirmMessage: (version) => `lnwjud version v${version} is ready. Install this update now?`,
  updaterInstallConfirmDetail: 'After you confirm, lnwjud will wait for current work to finish, stop Secure Tunnel, install without requiring any installer clicks, and reopen automatically.',
  updaterInstallConfirm: 'Install and Reopen',
  updaterInstallFailedTitle: 'Update Installation Failed',
  updaterInstallFailedMessage: 'lnwjud is still open because the update could not be installed. Try again from the version badge.',
  updaterTunnelStopFailedTitle: 'Secure Tunnel Did Not Stop',
  updaterTunnelStopFailedMessage: 'The update cannot be installed yet because lnwjud could not confirm that Secure Tunnel stopped. Please try again.',
  updaterAvailableTitle: 'Update Available - lnwjud',
  ok: 'OK',
  cancel: 'Cancel',
  shutdownBlockedTitle: 'lnwjud is still running',
  shutdownBlockedMessage: 'The owned tunnel could not be confirmed stopped. lnwjud will remain open; check the tunnel status and retry Quit.',
  factoryResetTitle: 'Reset lnwjud',
  factoryResetMessage: 'Erase all lnwjud data on this device and start again like a fresh installation?',
  factoryResetDetail: 'This deletes the database, settings, registered projects, saved keys and secrets, Tunnel profile, backups, logs, cache, recovery data, and first-run state. Your actual project folders are not deleted. lnwjud will relaunch into the Setup Guide.',
  factoryResetConfirm: 'Erase everything and start over',
  logStatus: 'Status',
  logCapturedRowUnavailable: 'Captured row is no longer available',
  logTime: 'Time',
  logLevel: 'Level',
  logMessage: 'Message',
  logSource: 'Source',
  logWorkspace: 'Workspace',
  logSession: 'Session',
  logTechnical: 'Technical metadata',
  logWorkLogTitle: 'Work Log',
  logExported: 'Exported',
  logRows: 'Rows',
  updateAvailableStatus: (version) => `v${version} found — downloading in the background`,
  updateAvailableDialog: (version) => `lnwjud v${version} is available and is downloading in the background`,
  updateDownloadingStatus: (_version, percent) => `Downloading update ${Math.round(percent ?? 0)}%`,
  updateCurrentStatus: (version) => `v${version} is up to date`,
  updateCurrentDialog: (version) => `lnwjud v${version} is up to date`,
  updateReadyStatus: (version) => `v${version} is ready — click the version badge in the top-left to update`,
  trayInstall: (version) => `Install update v${version}`,
  trayPreparing: (version) => `Preparing install v${version}`,
  trayDownloading: (version, percent) => `Downloading v${version}${percent === null ? '' : ` ${Math.round(percent)}%`}`,
};

export function nativeMessages(locale: UiLocale): NativeMessages {
  return locale === 'en' ? en : th;
}

export function localizedUpdateStatusMessage(status: UpdateStatus, locale: UiLocale): string | null {
  const messages = nativeMessages(locale);
  const version = status.availableVersion;
  switch (status.phase) {
    case 'unavailable':
      if (status.message === th.updaterUnavailableMacosUnsigned || status.message === en.updaterUnavailableMacosUnsigned) return messages.updaterUnavailableMacosUnsigned;
      if (status.message === th.updaterUnavailableTransactionAuthority || status.message === en.updaterUnavailableTransactionAuthority) return messages.updaterUnavailableTransactionAuthority;
      if (status.message === th.updaterUnavailablePlatform || status.message === en.updaterUnavailablePlatform) return messages.updaterUnavailablePlatform;
      return messages.updaterUnavailablePackagedOnly;
    case 'checking': return messages.updaterChecking;
    case 'available': return version === null ? messages.updaterChecking : messages.updateAvailableStatus(version);
    case 'downloading': return messages.updateDownloadingStatus(version, status.progressPercent);
    case 'ready':
      return version === null ? status.message : messages.updateReadyStatus(version);
    case 'installing': return messages.updaterInstallWaiting;
    case 'up-to-date': return messages.updateCurrentStatus(status.currentVersion);
    case 'idle': return null;
    case 'error': return status.message;
  }
}
