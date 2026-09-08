import { describe, expect, it } from 'vitest';
import {
  classifyFilesystemRoot,
  isAbsoluteHostPath,
  isForeignAbsolutePath,
  isHostPathWithin,
  normalizeHostWorkspaceRoot,
  resolveHostPath,
} from './filesystem-root.js';

describe('host filesystem root model', () => {
  it('classifies Windows drive and UNC roots without assuming a drive letter', () => {
    expect(classifyFilesystemRoot('C:\\', 'win32')).toEqual({ kind: 'windows_drive', rootPath: 'C:\\' });
    expect(classifyFilesystemRoot('D:/', 'win32')).toEqual({ kind: 'windows_drive', rootPath: 'D:\\' });
    expect(classifyFilesystemRoot('\\\\server\\share', 'win32')).toEqual({ kind: 'windows_unc', rootPath: '\\\\server\\share\\' });
    expect(classifyFilesystemRoot('C:\\Users\\alice\\project', 'win32')).toBeNull();
  });

  it('classifies POSIX mount roots but not ordinary projects', () => {
    expect(classifyFilesystemRoot('/', 'linux')).toEqual({ kind: 'posix_mount', rootPath: '/' });
    expect(classifyFilesystemRoot('/mnt/data', 'linux')).toEqual({ kind: 'posix_mount', rootPath: '/mnt/data' });
    expect(classifyFilesystemRoot('/Volumes/Data', 'darwin')).toEqual({ kind: 'posix_mount', rootPath: '/Volumes/Data' });
    expect(classifyFilesystemRoot('/home/alice/project', 'linux')).toBeNull();
    expect(classifyFilesystemRoot('/mnt/data/project', 'linux')).toBeNull();
    expect(classifyFilesystemRoot('/Volumes/Data/project', 'darwin')).toBeNull();
    expect(classifyFilesystemRoot('/media/alice/USB/project', 'linux')).toBeNull();
  });

  it('rejects foreign absolute syntax instead of rewriting separators', () => {
    expect(isForeignAbsolutePath('C:\\old-project', 'linux')).toBe(true);
    expect(isForeignAbsolutePath('\\\\server\\share', 'darwin')).toBe(true);
    expect(isForeignAbsolutePath('/home/alice/project', 'win32')).toBe(true);
    expect(resolveHostPath('C:\\old-project', 'linux')).toBeNull();
    expect(isAbsoluteHostPath('C:\\old-project', 'linux')).toBe(false);
  });

  it('keeps host containment boundary-aware and case-sensitive on POSIX', () => {
    expect(isHostPathWithin('/home/alice/project', '/home/alice/project/src', 'linux')).toBe(true);
    expect(isHostPathWithin('/home/alice/project', '/home/alice/project-other', 'linux')).toBe(false);
    expect(isHostPathWithin('C:\\Project', 'c:\\project\\src', 'win32')).toBe(true);
    expect(isHostPathWithin('C:\\Project', 'C:\\Project-other', 'win32')).toBe(false);
  });

  it('normalizes roots without turning POSIX / into //', () => {
    expect(normalizeHostWorkspaceRoot('/', 'linux')).toBe('/');
    expect(normalizeHostWorkspaceRoot('/home/alice/project', 'linux')).toBe('/home/alice/project/');
    expect(normalizeHostWorkspaceRoot('C:\\Project', 'win32')).toBe('C:\\Project\\');
  });
});
