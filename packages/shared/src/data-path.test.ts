import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLnwjudDataPath } from './data-path.js';

describe('resolveLnwjudDataPath', () => {
  it('uses the same explicit override for Desktop and MCP', () => {
    expect(resolveLnwjudDataPath({ LNWJUD_DATA_PATH: 'D:\\agent-data', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })).toBe(path.resolve('D:\\agent-data'));
  });

  it('defaults to the per-user roaming AppData lnwjud directory', () => {
    expect(resolveLnwjudDataPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })).toBe(path.resolve('C:\\Users\\u\\AppData\\Roaming\\lnwjud'));
  });

  it('accepts Electron appData as a fallback without embedding a build-machine profile', () => {
    expect(resolveLnwjudDataPath({}, 'C:\\Users\\end-user\\AppData\\Roaming')).toBe(path.resolve('C:\\Users\\end-user\\AppData\\Roaming\\lnwjud'));
  });
});
