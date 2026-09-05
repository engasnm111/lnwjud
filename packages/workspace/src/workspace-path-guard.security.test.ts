import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Workspace } from './workspace-types.js';
import { WorkspacePathGuard } from './workspace-path-guard.js';

const execFileAsync = promisify(execFile);

describe('WorkspacePathGuard reparse-point security', () => {
  it('rejects a read through a junction that points outside the workspace', async ({ skip }) => {
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

      const workspace: Workspace = {
        id: 'workspace-junction',
        displayName: 'Junction fixture',
        rootPath,
        realRootPath: rootPath,
        createdAt: new Date(0).toISOString(),
      };
      const result = await new WorkspacePathGuard().resolveForRead(workspace, 'escape\\outside.txt');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('PATH_OUTSIDE_WORKSPACE');
    } finally {
      await rm(rootPath, { recursive: true, force: true });
      await rm(outsidePath, { recursive: true, force: true });
    }
  });
});
