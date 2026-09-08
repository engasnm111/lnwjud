import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLnwjudDataPath } from './data-path.js';

describe('resolveLnwjudDataPath', () => {
  it('uses the same explicit override for Desktop and MCP', () => {
    expect(resolveLnwjudDataPath({ LNWJUD_DATA_PATH: 'D:\\agent-data', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, undefined, 'win32')).toBe(path.win32.resolve('D:\\agent-data'));
  });

  it('defaults to the per-user roaming AppData lnwjud directory', () => {
    expect(resolveLnwjudDataPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, undefined, 'win32')).toBe(path.win32.resolve('C:\\Users\\u\\AppData\\Roaming\\lnwjud'));
  });

  it('accepts Electron appData as a fallback without embedding a build-machine profile', () => {
    expect(resolveLnwjudDataPath({}, 'C:\\Users\\end-user\\AppData\\Roaming', 'win32')).toBe(path.win32.resolve('C:\\Users\\end-user\\AppData\\Roaming\\lnwjud'));
  });

  it.each([
    ['darwin', '/Users/alice/Library/Application Support/lnwjud'],
    ['linux', '/home/alice/.local/share/lnwjud'],
  ] as const)('uses host-native default data paths on %s', (platform, expected) => {
    expect(resolveLnwjudDataPath({ HOME: platform === 'darwin' ? '/Users/alice' : '/home/alice' }, undefined, platform)).toBe(expected);
  });

  it('prefers the Electron appData path in packaged macOS/Linux mode', () => {
    expect(resolveLnwjudDataPath({ HOME: '/Users/alice' }, '/Users/alice/Library/Application Support', 'darwin')).toBe('/Users/alice/Library/Application Support/lnwjud');
    expect(resolveLnwjudDataPath({ HOME: '/home/alice' }, '/home/alice/.config', 'linux')).toBe('/home/alice/.config/lnwjud');
  });

  it('uses an absolute XDG data directory on Linux and ignores a relative one', () => {
    expect(resolveLnwjudDataPath({ HOME: '/home/alice', XDG_DATA_HOME: '/mnt/data' }, undefined, 'linux')).toBe('/mnt/data/lnwjud');
    expect(resolveLnwjudDataPath({ HOME: '/home/alice', XDG_DATA_HOME: 'relative' }, undefined, 'linux')).toBe('/home/alice/.local/share/lnwjud');
  });
});
