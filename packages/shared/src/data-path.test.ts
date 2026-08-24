import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLnwjudDataPath } from './data-path.js';

describe('resolveLnwjudDataPath', () => {
  it('uses the same explicit override for Desktop and MCP', () => {
    const expected = process.platform === 'win32' ? path.resolve('D:\\agent-data') : path.win32.resolve('D:\\agent-data');
    expect(resolveLnwjudDataPath({ LNWJUD_DATA_PATH: 'D:\\agent-data', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })).toBe(expected);
  });

  it('defaults to the per-user roaming AppData lnwjud directory', () => {
    const expected = process.platform === 'win32'
      ? path.resolve('C:\\Users\\u\\AppData\\Roaming\\lnwjud')
      : path.win32.resolve('C:\\Users\\u\\AppData\\Roaming\\lnwjud');
    expect(resolveLnwjudDataPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })).toBe(expected);
  });

  it('accepts Electron appData as a fallback without embedding a build-machine profile', () => {
    const expected = process.platform === 'win32'
      ? path.resolve('C:\\Users\\end-user\\AppData\\Roaming\\lnwjud')
      : path.win32.resolve('C:\\Users\\end-user\\AppData\\Roaming\\lnwjud');
    expect(resolveLnwjudDataPath({}, 'C:\\Users\\end-user\\AppData\\Roaming')).toBe(expected);
  });
});
