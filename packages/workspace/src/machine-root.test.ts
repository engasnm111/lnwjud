import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  driveRootForPath,
  isDriveRoot,
  isMachineWideRoot,
  isUnderMachineRoot,
  machineRootPath,
  normalizeWorkspaceRoot,
  workspaceRootComparisonKey,
} from './machine-root.js';

describe('machine-root helpers', () => {
  it('derives the restricted Windows machine root from an explicit workspace instead of a fixed drive letter', () => {
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

  it('never falls back to the POSIX filesystem root', () => {
    expect(machineRootPath('/home/demo/project', { HOME: '/home/demo' }, 'linux')).toBe('/home/demo/project');
    expect(() => machineRootPath(undefined, { HOME: '/home/demo' }, 'linux')).toThrow(/scoped project path/i);
    expect(isMachineWideRoot('/', 'linux')).toBe(true);
    expect(isMachineWideRoot('/home/demo/project', 'linux')).toBe(false);
    expect(normalizeWorkspaceRoot('/home/demo/project', 'linux')).toBe('/home/demo/project/');
  });

  it('folds case only for Windows comparison keys', () => {
    expect(workspaceRootComparisonKey('C:\\Users\\Demo\\Project', 'win32')).toBe('c:\\users\\demo\\project\\');
    expect(workspaceRootComparisonKey('/home/Demo/Project', 'linux')).toBe('/home/Demo/Project/');
  });
});
