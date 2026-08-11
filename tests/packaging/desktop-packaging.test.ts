import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(import.meta.dirname, '..', '..', 'apps', 'desktop');

describe('Windows desktop packaging', () => {
  it('declares lnwjud x64 NSIS packaging and built runtime bundles', async () => {
    const configPath = path.join(desktopRoot, 'electron-builder.yml');
    const config = await readFile(configPath, 'utf8');

    expect(config).toContain('productName: lnwjud');
    expect(config).toContain('output: dist/installers');
    expect(config).toContain('target: nsis');
    expect(config).toContain('- x64');
    expect(config).toContain('signAndEditExecutable: false');
    await access(path.join(desktopRoot, 'dist', 'main', 'main.js'));
    await access(path.join(desktopRoot, 'dist', 'preload', 'index.cjs'));
    await access(path.join(desktopRoot, 'dist', 'renderer', 'index.html'));

    const mainBundle = await readFile(path.join(desktopRoot, 'dist', 'main', 'main.js'), 'utf8');
    expect(mainBundle).toContain('webSecurity: true');
    expect(mainBundle).not.toContain('webSecurity: false');
    expect(mainBundle).toContain('setName("lnwjud"');
    expect(mainBundle).toContain('LNWJUD_DATA_PATH');
    expect(mainBundle).toContain('setPath("userData"');
  });
});
