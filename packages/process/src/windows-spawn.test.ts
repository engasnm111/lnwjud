import { describe, expect, it } from 'vitest';
import { wrapWindowsCommandShim } from './windows-spawn.js';

describe('wrapWindowsCommandShim', () => {
  it('keeps cmd /s from stripping quotes around a path with spaces', () => {
    const result = wrapWindowsCommandShim('C:\\Program Files\\nodejs\\npm.cmd', ['run', 'check'], {}, 'win32');

    expect(result).toMatchObject({
      ok: true,
      value: {
        args: ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\npm.cmd" run check"'],
        windowsVerbatimArguments: true,
      },
    });
  });

  it('preserves empty arguments in the cmd command line', () => {
    expect(wrapWindowsCommandShim('C:\\tools\\npx.cmd', ['--version', ''], {}, 'win32')).toMatchObject({
      ok: true,
      value: {
        args: ['/d', '/s', '/c', '"C:\\tools\\npx.cmd --version """'],
        windowsVerbatimArguments: true,
      },
    });
  });

  it('preserves terminal backslashes before the next argument', () => {
    expect(wrapWindowsCommandShim('C:\\tools\\fixture.cmd', ['C:\\Program Files\\', 'next'], {}, 'win32')).toMatchObject({
      ok: true,
      value: {
        args: ['/d', '/s', '/c', '"C:\\tools\\fixture.cmd "C:\\Program Files\\\\" next"'],
        windowsVerbatimArguments: true,
      },
    });
  });

  it('rejects shell metacharacters unless they are explicitly allowed', () => {
    expect(wrapWindowsCommandShim('C:\\tools\\tool.cmd', ['&', 'whoami'], {}, 'win32')).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(wrapWindowsCommandShim('C:\\tools\\tool.cmd', ['&', 'whoami'], { allowMetacharacters: true }, 'win32')).toMatchObject({
      ok: true,
      value: { args: ['/d', '/s', '/c', '"C:\\tools\\tool.cmd & whoami"'] },
    });
  });

  it.each(['linux', 'darwin'] as const)('preserves literal executable and arguments on %s', (platform) => {
    const executable = '/opt/tools with spaces/tool.cmd';
    const args = ['&', 'two words', '$HOME'];
    expect(wrapWindowsCommandShim(executable, args, {}, platform)).toEqual({
      ok: true,
      value: { executable, args },
    });
  });
});
