import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isDriveRoot, isEMachineRoot, isUnderEDrive, machineRootPath, normalizeWorkspaceRoot } from './machine-root.js';

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
});
