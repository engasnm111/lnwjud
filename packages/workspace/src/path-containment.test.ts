import { describe, expect, it } from 'vitest';
import {
  filesystemPathFlavor,
  isFilesystemRoot,
  isWithin,
  normalizePathForComparison,
} from './path-containment.js';

describe('cross-platform path containment', () => {
  it('keeps persisted Windows paths on win32 semantics regardless of host', () => {
    expect(filesystemPathFlavor('C:\\Users\\demo\\project', 'linux')).toBe('windows');
    expect(isWithin('C:\\Users\\demo\\project', 'C:\\Users\\demo\\project\\src\\index.ts', 'linux')).toBe(true);
    expect(isWithin('C:\\Users\\demo\\project', 'D:\\outside.txt', 'linux')).toBe(false);
    expect(normalizePathForComparison('C:\\Users\\Demo\\Project', 'linux')).toBe('c:\\users\\demo\\project\\');
  });

  it('uses case-sensitive POSIX comparison and rejects sibling traversal', () => {
    expect(filesystemPathFlavor('/home/demo/project', 'linux')).toBe('posix');
    expect(isWithin('/home/demo/project', '/home/demo/project/src/index.ts', 'linux')).toBe(true);
    expect(isWithin('/home/demo/project', '/home/demo/project-other/file.txt', 'linux')).toBe(false);
    expect(normalizePathForComparison('/home/Demo/Project', 'linux')).toBe('/home/Demo/Project/');
    expect(normalizePathForComparison('/home/demo/project', 'linux')).not.toBe(normalizePathForComparison('/home/Demo/Project', 'linux'));
  });

  it('identifies whole filesystem roots without treating ordinary projects as roots', () => {
    expect(isFilesystemRoot('C:\\', 'win32')).toBe(true);
    expect(isFilesystemRoot('C:\\project', 'win32')).toBe(false);
    expect(isFilesystemRoot('/', 'linux')).toBe(true);
    expect(isFilesystemRoot('/home/demo/project', 'linux')).toBe(false);
  });
});
