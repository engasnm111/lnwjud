import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRequestedWorkspacePath } from './workspace-selection.js';

describe('direct STDIO workspace selection', () => {
  it('does not infer a system, home, current, or drive-root path on first use', () => {
    expect(resolveRequestedWorkspacePath({ registeredProjectPaths: [] })).toBeNull();
  });

  it('uses only an explicit request, strict root, or previously registered project', () => {
    expect(resolveRequestedWorkspacePath({
      requestedPath: 'Z:\\dgx-project',
      registeredProjectPaths: ['C:\\old-project'],
    })).toBe(path.resolve('Z:\\dgx-project'));
    expect(resolveRequestedWorkspacePath({
      strictAllowedRoots: ['D:\\strict-project'],
      registeredProjectPaths: ['C:\\old-project'],
    })).toBe(path.resolve('D:\\strict-project'));
    expect(resolveRequestedWorkspacePath({
      registeredProjectPaths: ['C:\\old-project'],
    })).toBe(path.resolve('C:\\old-project'));
  });
});
