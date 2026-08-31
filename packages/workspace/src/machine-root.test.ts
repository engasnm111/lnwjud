import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { driveRootForPath, isDriveRoot, isUnderMachineRoot, machineRootPath, normalizeWorkspaceRoot } from './machine-root.js';

describe('machine-root helpers', () => {
  it('derives the restricted machine root from an explicit workspace instead of a fixed drive letter', () => {
    expect(driveRootForPath('D:\\DPLANT-V8')).toBe('D:\\');
    expect(isDriveRoot('D:\\')).toBe(true);
    expect(isDriveRoot('D:\\apps')).toBe(false);
    expect(isUnderMachineRoot('D:\\DPLANT-V8', 'D:\\')).toBe(true);
    expect(isUnderMachineRoot('C:\\Windows', 'D:\\')).toBe(false);
    expect(machineRootPath('D:\\DPLANT-V8', { SystemDrive: 'C:' })).toBe('D:\\');
    expect(normalizeWorkspaceRoot('D:\\foo')).toBe(path.resolve('D:\\foo') + path.sep);
    expect(driveRootForPath('\\\\dgx-spark\\models')).toBeNull();
    expect(isDriveRoot('\\\\dgx-spark\\models')).toBe(false);
  });

  it('falls back to the Windows system drive without assuming E:', () => {
    expect(machineRootPath(undefined, { SystemDrive: 'C:' })).toBe('C:\\');
    expect(machineRootPath(undefined, { HOMEDRIVE: 'F:' })).toBe('F:\\');
  });

  it('supports POSIX root paths on non-Windows platforms', () => {
    expect(driveRootForPath('/Users/alice/projects')).toBe('/');
    expect(isDriveRoot('/')).toBe(true);
    expect(isDriveRoot('/Users')).toBe(false);
    expect(isUnderMachineRoot('/Users/alice', '/')).toBe(true);
  });
});
