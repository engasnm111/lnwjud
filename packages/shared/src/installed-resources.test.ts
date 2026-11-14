import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveInstalledResourcesPath } from './installed-resources.js';

describe('installed native resources', () => {
  it.each(['A', 'B'])('uses the stable authority for slot %s', (slot) => {
    const root = path.resolve('installed-lnwjud');
    expect(resolveInstalledResourcesPath(path.join(root, 'slots', slot, 'resources'))).toBe(path.join(root, 'resources'));
  });

  it('preserves flat Windows and macOS resource paths', () => {
    for (const resources of [path.resolve('installed-lnwjud', 'resources'), path.resolve('lnwjud.app', 'Contents', 'Resources')]) {
      expect(resolveInstalledResourcesPath(resources)).toBe(resources);
    }
  });

  it('does not infer a stable authority from an arbitrary directory name', () => {
    const resources = path.resolve('installed-lnwjud', 'backups', 'A', 'resources');
    expect(resolveInstalledResourcesPath(resources)).toBe(resources);
  });
});
