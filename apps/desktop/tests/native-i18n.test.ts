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
    expect(nativeMessages('th').shutdownBlockedTitle).toContain('ยังทำงานอยู่');
    expect(nativeMessages('en').shutdownBlockedTitle).toBe('lnwjud is still running');
    expect(nativeMessages('th').updaterTunnelStopConfirm).toContain('ติดตั้งต่อ');
    expect(nativeMessages('en').updaterTunnelStopConfirm).toBe('Stop Tunnel and Install');
    expect(nativeMessages('th').updaterTunnelStopDetail).toContain('Tunnel ID และ Key เดิม');
    expect(nativeMessages('en').updaterTunnelStopDetail).toContain('same Tunnel ID and key');
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
});
