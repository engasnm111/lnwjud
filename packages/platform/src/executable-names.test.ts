import { describe, expect, it } from 'vitest';
import { executableName, stdioLauncherName } from './executable-names.js';

describe('executable naming', () => {
  it('adds exe only for Windows', () => {
    expect(executableName('rg', { platform: 'win32' })).toBe('rg.exe');
    expect(executableName('rg.exe', { platform: 'win32' })).toBe('rg.exe');
    expect(executableName('rg', { platform: 'darwin' })).toBe('rg');
    expect(executableName('rg', { platform: 'linux' })).toBe('rg');
  });

  it('uses a cmd launcher only on Windows', () => {
    expect(stdioLauncherName({ platform: 'win32' })).toBe('lnwjud-mcp-stdio.cmd');
    expect(stdioLauncherName({ platform: 'darwin' })).toBe('lnwjud-mcp-stdio');
    expect(stdioLauncherName({ platform: 'linux' })).toBe('lnwjud-mcp-stdio');
  });
});
