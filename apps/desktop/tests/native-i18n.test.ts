import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UpdateStatus } from '@lnwjud/ipc-contracts';
import { localizedUpdateStatusMessage, nativeMessages } from '../src/main/native-i18n.js';

const mainRoot = path.resolve(import.meta.dirname, '..', 'src', 'main');

describe('native main-process i18n', () => {
  it('localizes active updater state when the app language changes', () => {
    const ready: UpdateStatus = {
      phase: 'ready', currentVersion: '4.6.1', availableVersion: '4.6.2', progressPercent: 100,
      lastCheckedAt: null, message: null, canInstall: true,
    };
    expect(localizedUpdateStatusMessage(ready, 'th')).toContain('พร้อมติดตั้ง');
    expect(localizedUpdateStatusMessage(ready, 'en')).toContain('is ready');
    expect(localizedUpdateStatusMessage({
      ...ready, phase: 'unavailable', canInstall: false, message: nativeMessages('th').updaterUnavailableMacosUnsigned,
    }, 'en')).toContain('ad-hoc');
    expect(nativeMessages('th').shutdownBlockedTitle).toContain('ยังทำงานอยู่');
    expect(nativeMessages('en').shutdownBlockedTitle).toBe('lnwjud is still running');
    expect(nativeMessages('th').updaterInstallConfirmMessage('5.9.0')).toContain('v5.9.0');
    expect(nativeMessages('en').updaterInstallConfirmMessage('5.9.0')).toContain('v5.9.0');
    expect(nativeMessages('th').updaterInstallConfirmDetail).toContain('ไม่ต้องกด Next');
    expect(nativeMessages('en').updaterInstallConfirmDetail).toContain('without requiring any installer clicks');
  });

  it('keeps Thai native UI literals out of main and tray orchestration files', async () => {
    const [main, tray] = await Promise.all([
      readFile(path.join(mainRoot, 'main.ts'), 'utf8'),
      readFile(path.join(mainRoot, 'tray.ts'), 'utf8'),
    ]);
    expect(main).not.toMatch(/[ก-๙]/u);
    expect(tray).not.toMatch(/[ก-๙]/u);
    expect(main).toContain("from './native-i18n.js'");
    expect(tray).toContain("from './native-i18n.js'");
  });

  it('explains the complete post-consent update sequence in both locales', () => {
    const thai = nativeMessages('th');
    const english = nativeMessages('en');
    expect(thai.updaterInstallConfirmMessage('5.9.0')).toContain('5.9.0');
    expect(thai.updaterInstallConfirmDetail).toContain('หยุด Secure Tunnel');
    expect(thai.updaterInstallConfirmDetail).toContain('เปิดแอปใหม่อัตโนมัติ');
    expect(english.updaterInstallConfirmMessage('5.9.0')).toContain('5.9.0');
    expect(english.updaterInstallConfirmDetail).toContain('stop Secure Tunnel');
    expect(english.updaterInstallConfirmDetail).toContain('reopen automatically');
  });

  it('keeps a missing native updater authority visibly unavailable in either locale', () => {
    const thai = nativeMessages('th');
    const english = nativeMessages('en');
    const status: UpdateStatus = {
      phase: 'unavailable', currentVersion: '5.9.0', availableVersion: null, progressPercent: null,
      lastCheckedAt: null, message: thai.updaterUnavailableTransactionAuthority, canInstall: false,
    };
    expect(localizedUpdateStatusMessage(status, 'th')).toBe(thai.updaterUnavailableTransactionAuthority);
    expect(localizedUpdateStatusMessage(status, 'en')).toBe(english.updaterUnavailableTransactionAuthority);
    // The check itself is usable: only the installation transaction is held.
    const discovered = { ...status, phase: 'available' as const, availableVersion: '5.9.2' };
    expect(localizedUpdateStatusMessage(discovered, 'th')).toBe(thai.updaterUnavailableTransactionAuthority);
    expect(localizedUpdateStatusMessage(discovered, 'en')).toBe(english.updaterUnavailableTransactionAuthority);
  });
});
