import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allFixedDriveRoots, isDriveRoot, isEMachineRoot, isUnderEDrive, machineRootPath, machineRootPaths, normalizeWorkspaceRoot } from './machine-root.js';

describe('machine-root helpers', () => {
  it('detects E: machine root and containment', () => {
    expect(isEMachineRoot('E:\\')).toBe(true);
    expect(isEMachineRoot('E:')).toBe(true);
    expect(isEMachineRoot('E:\\projects')).toBe(false);
    expect(isDriveRoot('C:\\')).toBe(true);
    expect(isDriveRoot('E:\\apps')).toBe(false);
    expect(isUnderEDrive('E:\\lnwjud')).toBe(true);
    expect(isUnderEDrive('C:\\Windows')).toBe(false);
    expect(machineRootPath().toUpperCase()).toBe('E:\\');
    expect(normalizeWorkspaceRoot('E:\\foo')).toBe(path.resolve('E:\\foo') + path.sep);
  });

  it('lists only existing drive roots', () => {
    const roots = allFixedDriveRoots();
    expect(Array.isArray(roots)).toBe(true);
    for (const root of roots) {
      expect(root).toMatch(/^[A-Z]:\\$/);
    }
    if (process.platform === 'win32') {
      // The test machine always has at least a system drive (C:) and the E: drive.
      expect(roots.length).toBeGreaterThan(1);
    }
  });

  it('expands machine roots in unrestricted mode', () => {
    expect(machineRootPaths(false)).toEqual(['E:\\']);
    const roots = machineRootPaths(true);
    expect(roots).toContain('E:\\');
    expect(roots.every((root) => /^[A-Z]:\\$/.test(root))).toBe(true);
  });
});
