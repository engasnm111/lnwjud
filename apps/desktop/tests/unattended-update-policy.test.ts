import { describe, expect, it, vi } from 'vitest';
import { installWindowsUpdate, unattendedUpdateSupport } from '../src/main/unattended-update-policy.js';

describe('unattended update policy', () => {
  it('keeps Windows unattended installation unavailable until a native publisher authority exists', () => {
    expect(unattendedUpdateSupport('installer')).toEqual({
      kind: 'unavailable',
      reason: 'windows-publisher-verification-unavailable',
    });
  });

  it('does not infer a complete macOS update transaction from its distribution or signed-app eligibility', () => {
    expect(unattendedUpdateSupport('macos')).toEqual({
      kind: 'unavailable',
      reason: 'native-update-transaction-unavailable',
    });
  });

  it('keeps unsupported distributors out of unattended installation', () => {
    for (const distribution of ['portable', 'linux-appimage', 'unsupported'] as const) {
      expect(unattendedUpdateSupport(distribution).kind).toBe('unavailable');
    }
  });

  it('requests silent installation and relaunch explicitly for an authorized automatic Windows install', () => {
    const updater = { quitAndInstall: vi.fn() };
    installWindowsUpdate(updater, true);
    expect(updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
  });

  it('preserves the manual installer defaults', () => {
    const updater = { quitAndInstall: vi.fn() };
    installWindowsUpdate(updater, false);
    expect(updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith();
  });
});
