import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { canInstallMacosUpdates, isTrustedMacosUpdateSignature } from '../src/main/macos-update-trust.js';

const developerId = [
  'Authority=Developer ID Application: Example Developer (ABCDE12345)',
  'TeamIdentifier=ABCDE12345',
  'Timestamp=Oct 11, 2026',
].join('\n');

describe('macOS updater signing eligibility', () => {
  it('refuses legacy ad-hoc signatures even with a matching bundle identifier', () => {
    const details = ['Identifier=com.lnwjud.desktop', 'Signature=adhoc', 'CDHash=1234', 'TeamIdentifier=not set'].join('\n');
    expect(isTrustedMacosUpdateSignature(details)).toBe(false);
    const run = vi.fn(() => details);
    expect(canInstallMacosUpdates('/Applications/lnwjud.app/Contents/MacOS/lnwjud', run)).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('accepts verified Developer ID apps but not unsigned or unverified bundles', () => {
    const exe = '/Applications/lnwjud.app/Contents/MacOS/lnwjud';
    const run = vi.fn(() => developerId);
    expect(canInstallMacosUpdates(exe, run)).toBe(true);
    expect(run).toHaveBeenCalledWith(['--verify', '--deep', '--strict', '--all-architectures', path.resolve(exe, '../../..')]);
    expect(canInstallMacosUpdates(exe, () => { throw new Error('codesign verification failed'); })).toBe(false);
    expect(canInstallMacosUpdates('/tmp/Another.app/Contents/MacOS/lnwjud', run)).toBe(false);
    expect(isTrustedMacosUpdateSignature('Signature=adhoc\n' + developerId)).toBe(false);
    expect(isTrustedMacosUpdateSignature(developerId.replace('Oct 11, 2026', 'none'))).toBe(false);
    expect(isTrustedMacosUpdateSignature('TeamIdentifier=not set\nTimestamp=Oct 11, 2026')).toBe(false);
  });
});
