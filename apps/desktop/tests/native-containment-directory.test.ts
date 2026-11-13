import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveDesktopNativeContainmentDirectory } from '../src/main/native-containment-directory.js';

describe('Desktop native containment directory', () => {
  const desktopRoot = path.join(os.tmpdir(), 'source with spaces', 'apps', 'desktop');

  it.each([['src', 'main.ts'], ['dist', 'main.js']])('resolves the staged runtime from the %s entry module', (directory, filename) => {
    const mainModuleUrl = pathToFileURL(path.join(desktopRoot, directory, 'main', filename)).href;
    expect(resolveDesktopNativeContainmentDirectory(false, 'unused Electron development resources', mainModuleUrl))
      .toBe(path.join(desktopRoot, 'build', 'native-containment'));
  });

  it('keeps packaged resources authoritative without reading a development module URL', () => {
    const resources = path.join(os.tmpdir(), 'Program Files', 'lnwjud', 'resources');
    expect(resolveDesktopNativeContainmentDirectory(true, resources, 'unused development URL'))
      .toBe(path.join(resources, 'native-containment'));
  });
});
