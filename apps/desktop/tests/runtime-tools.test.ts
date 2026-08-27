import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundledRuntimeToolDirectories, prependBundledRuntimeToolsToPath } from '../src/main/runtime-tools.js';

describe.skipIf(process.platform !== 'win32')('bundled Windows runtime tools', () => {
  it('resolves the packaged ripgrep directory under Electron resources', () => {
    expect(bundledRuntimeToolDirectories('C:\\Program Files\\lnwjud\\resources')).toEqual([
      path.join('C:\\Program Files\\lnwjud\\resources', 'runtime-tools', 'ripgrep'),
    ]);
  });

  it('prepends an existing bundled tool directory without dropping the system PATH', () => {
    const environment: NodeJS.ProcessEnv = { Path: ['C:\\Windows\\System32', 'C:\\Tools'].join(path.delimiter) };
    const resources = 'C:\\Program Files\\lnwjud\\resources';
    const bundled = path.join(resources, 'runtime-tools', 'ripgrep');

    expect(prependBundledRuntimeToolsToPath(environment, resources, (candidate) => candidate === bundled)).toEqual([bundled]);
    expect(environment.Path?.split(path.delimiter)).toEqual([bundled, 'C:\\Windows\\System32', 'C:\\Tools']);
  });

  it('does not mutate PATH when the bundled tool directory is absent', () => {
    const environment: NodeJS.ProcessEnv = { Path: 'C:\\Windows\\System32' };
    expect(prependBundledRuntimeToolsToPath(environment, 'C:\\missing', () => false)).toEqual([]);
    expect(environment.Path).toBe('C:\\Windows\\System32');
  });
});
