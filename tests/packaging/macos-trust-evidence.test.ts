import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

describe('macOS trust evidence contract', () => {
  it('keeps signing/notarization verification target-native and opt-in for protected CI', async (): Promise<void> => {
    const script = await readFile(path.join(repositoryRoot, 'scripts', 'verify-macos-release.sh'), 'utf8');
    expect(script).toContain('codesign --verify --deep --strict');
    expect(script).toContain('hdiutil verify');
    expect(script).toContain('xcrun stapler validate');
    expect(script).toContain('LNWJUD_REQUIRE_NOTARIZATION');
    expect(script).toContain('must run on macOS');
    expect(script).toContain('-L');
    expect(script).not.toMatch(/CSC_LINK|APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD/);
    await access(path.join(repositoryRoot, 'apps', 'desktop', 'build', 'entitlements.mac.plist'));
    await access(path.join(repositoryRoot, 'apps', 'desktop', 'build', 'entitlements.mac.inherit.plist'));
  });
});
