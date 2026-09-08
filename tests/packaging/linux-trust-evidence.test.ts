import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

describe('Linux package evidence contract', () => {
  it('checks AppImage/DEB layout without importing foreign signing secrets', async (): Promise<void> => {
    const script = await readFile(path.join(repositoryRoot, 'scripts', 'verify-linux-release.sh'), 'utf8');
    expect(script).toContain('--appimage-extract');
    expect(script).toContain('dpkg-deb --info');
    expect(script).toContain('lnwjud-linux-host');
    expect(script).toContain('NATIVE_HOST.json');
    expect(script).toContain('must run on Linux');
    expect(script).toContain('-L');
    expect(script).not.toMatch(/CSC_LINK|APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD/);
    expect(script).not.toMatch(/apt-get install|sudo /i);
  });
});
