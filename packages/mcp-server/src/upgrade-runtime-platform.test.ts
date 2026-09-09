import { describe, expect, it } from 'vitest';
import { benchmarkPackageCommand } from './upgrade-runtime.js';

describe('upgrade runtime package-manager platform contract', () => {
  it('uses the Windows npm command shim only on Windows', () => {
    expect(benchmarkPackageCommand('', 'benchmark', 'win32')).toEqual({
      executable: 'npm.cmd',
      args: ['run', 'benchmark'],
      script: 'benchmark',
    });
    expect(benchmarkPackageCommand('npm@11.6.0', 'bench', 'win32').executable).toBe('npm.cmd');
  });

  it('uses native npm on macOS and Linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(benchmarkPackageCommand('', 'benchmark', platform)).toEqual({
        executable: 'npm',
        args: ['run', 'benchmark'],
        script: 'benchmark',
      });
      expect(benchmarkPackageCommand('npm@11.6.0', 'bench', platform).executable).toBe('npm');
    }
  });

  it('keeps pinned pnpm and yarn commands behind cross-platform corepack', () => {
    expect(benchmarkPackageCommand('pnpm@10.15.0', 'benchmark', 'darwin')).toEqual({
      executable: 'corepack',
      args: ['pnpm@10.15.0', 'run', 'benchmark'],
      script: 'benchmark',
    });
    expect(benchmarkPackageCommand('yarn@4.9.2', 'bench', 'linux')).toEqual({
      executable: 'corepack',
      args: ['yarn@4.9.2', 'run', 'bench'],
      script: 'bench',
    });
  });
});
