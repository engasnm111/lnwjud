import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allFixedDriveRoots, driveRootForPath, isDriveRoot, isUnderMachineRoot, machineRootPath, machineRootPaths, normalizeWorkspaceRoot } from './machine-root.js';

describe('machine-root helpers', () => {
  it('derives the restricted machine root from an explicit workspace instead of a fixed drive letter', () => {
    expect(driveRootForPath('D:\\DPLANT-V8')).toBe('D:\\');
    expect(isDriveRoot('D:\\')).toBe(true);
    expect(isDriveRoot('D:\\apps')).toBe(false);
    expect(isUnderMachineRoot('D:\\DPLANT-V8', 'D:\\')).toBe(true);
    expect(isUnderMachineRoot('C:\\Windows', 'D:\\')).toBe(false);
    expect(machineRootPath('D:\\DPLANT-V8', { SystemDrive: 'C:' })).toBe('D:\\');
  });

  it('falls back to system drive when specified', () => {
    expect(machineRootPath(undefined, { SystemDrive: 'C:' })).toBe('C:\\');
    expect(machineRootPath(undefined, { HOMEDRIVE: 'F:' })).toBe('F:\\');
  });

  it('lists only existing drive roots', () => {
    const roots = allFixedDriveRoots();
    expect(Array.isArray(roots)).toBe(true);
    for (const root of roots) expect(root).toMatch(/^([A-Z]:\\|\/)$/);
    if (process.platform === 'win32') expect(roots.length).toBeGreaterThan(0);
  });

  it('uses the selected workspace drive in restricted mode and every fixed drive in unrestricted mode', () => {
    expect(machineRootPaths(false, 'D:\\DPLANT-V8')).toEqual(['D:\\']);
    const roots = machineRootPaths(true, 'D:\\DPLANT-V8');
    expect(roots.length).toBeGreaterThan(0);
  });
});
