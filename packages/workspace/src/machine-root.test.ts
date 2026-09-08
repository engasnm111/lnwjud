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
    expect(machineRootPath('D:\\DPLANT-V8', { SystemDrive: 'C:' }, 'win32')).toBe('D:\\');
    expect(normalizeWorkspaceRoot('D:\\foo', 'win32')).toBe(path.win32.resolve('D:\\foo') + path.win32.sep);
    expect(driveRootForPath('\\\\dgx-spark\\models')).toBeNull();
    expect(isDriveRoot('\\\\dgx-spark\\models')).toBe(false);
  });

  it('falls back to the Windows system drive without assuming E:', () => {
    expect(machineRootPath(undefined, { SystemDrive: 'C:' }, 'win32')).toBe('C:\\');
    expect(machineRootPath(undefined, { HOMEDRIVE: 'F:' }, 'win32')).toBe('F:\\');
  });

  it('does not turn a POSIX host into an implicit trusted root', () => {
    expect(machineRootPath('/home/alice/project', { HOME: '/home/alice' }, 'linux')).toBe('/');
    expect(normalizeWorkspaceRoot('/', 'linux')).toBe('/');
  });
});
