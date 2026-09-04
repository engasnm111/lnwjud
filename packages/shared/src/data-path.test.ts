import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLnwjudDataPath } from './data-path.js';

describe('resolveLnwjudDataPath', () => {
  it('uses the same explicit override for Desktop and MCP', () => {
    expect(resolveLnwjudDataPath({ LNWJUD_DATA_PATH: 'D:\\agent-data', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, undefined, 'win32')).toBe(path.win32.resolve('D:\\agent-data'));
  });

  it('defaults to the per-user roaming AppData lnwjud directory', () => {
    expect(resolveLnwjudDataPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, undefined, 'win32')).toBe('C:\\Users\\u\\AppData\\Roaming\\lnwjud');
  });

  it('accepts Electron appData as a fallback without embedding a build-machine profile', () => {
    expect(resolveLnwjudDataPath({}, 'C:\\Users\\end-user\\AppData\\Roaming', 'win32', 'C:\\Users\\fallback')).toBe('C:\\Users\\end-user\\AppData\\Roaming\\lnwjud');
  });

  it('uses Application Support on macOS', () => {
    expect(resolveLnwjudDataPath({ HOME: '/Users/end-user' }, undefined, 'darwin', '/Users/end-user')).toBe('/Users/end-user/Library/Application Support/lnwjud');
  });

  it('uses XDG data home on Linux', () => {
    expect(resolveLnwjudDataPath({ HOME: '/home/end-user', XDG_DATA_HOME: '/srv/data' }, undefined, 'linux', '/home/end-user')).toBe('/srv/data/lnwjud');
  });

  it('falls back to ~/.local/share on Linux', () => {
    expect(resolveLnwjudDataPath({ HOME: '/home/end-user' }, undefined, 'linux', '/home/end-user')).toBe('/home/end-user/.local/share/lnwjud');
  });
});
