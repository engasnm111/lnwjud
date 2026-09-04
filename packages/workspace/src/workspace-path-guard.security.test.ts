import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Workspace } from './workspace-types.js';
import { WorkspacePathGuard } from './workspace-path-guard.js';

const execFileAsync = promisify(execFile);

function workspace(rootPath: string, id: string): Workspace {
  return {
    id,
    displayName: 'Security fixture',
    rootPath,
    realRootPath: rootPath,
    createdAt: new Date(0).toISOString(),
  };
}

describe('WorkspacePathGuard link security', () => {
  it('rejects a read through a Windows junction that points outside the workspace', async ({ skip }) => {
    if (process.platform !== 'win32') skip('junction security test requires Windows');

    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-junction-root-'));
    const outsidePath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-junction-outside-'));
    const junctionPath = path.join(rootPath, 'escape');
    try {
      try {
        await execFileAsync('cmd.exe', ['/c', 'mklink', '/J', junctionPath, outsidePath], { windowsHide: true });
      } catch {
        skip('junction creation is unavailable on this Windows environment');
      }

      const result = await new WorkspacePathGuard().resolveForRead(workspace(rootPath, 'workspace-junction'), 'escape\\outside.txt');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('PATH_OUTSIDE_WORKSPACE');
    } finally {
      await rm(rootPath, { recursive: true, force: true });
      await rm(outsidePath, { recursive: true, force: true });
    }
  });

  it('rejects a POSIX read through a symlink that points outside the workspace', async ({ skip }) => {
    if (process.platform === 'win32') skip('POSIX symlink security test runs on macOS/Linux');

    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-symlink-root-'));
    const outsidePath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-symlink-outside-'));
    try {
      await writeFile(path.join(outsidePath, 'secret.txt'), 'outside', 'utf8');
      await symlink(outsidePath, path.join(rootPath, 'escape'), 'dir');
      const result = await new WorkspacePathGuard().resolveForRead(workspace(rootPath, 'workspace-symlink-read'), 'escape/secret.txt');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('PATH_OUTSIDE_WORKSPACE');
    } finally {
      await rm(rootPath, { recursive: true, force: true });
      await rm(outsidePath, { recursive: true, force: true });
    }
  });

  it('rejects a POSIX write whose nearest existing ancestor is an escaping symlink', async ({ skip }) => {
    if (process.platform === 'win32') skip('POSIX symlink security test runs on macOS/Linux');

    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-symlink-write-root-'));
    const outsidePath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-symlink-write-outside-'));
    try {
      await symlink(outsidePath, path.join(rootPath, 'escape'), 'dir');
      const result = await new WorkspacePathGuard().resolveForWrite(workspace(rootPath, 'workspace-symlink-write'), 'escape/new/child.txt');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('PATH_OUTSIDE_WORKSPACE');
    } finally {
      await rm(rootPath, { recursive: true, force: true });
      await rm(outsidePath, { recursive: true, force: true });
    }
  });
});
