import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesktopRuntime, type DesktopRuntime } from '../src/main/desktop-services.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DesktopRuntime persistence', () => {
  it('restores workspaces and permission settings without restoring an MCP listener', async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-data-'));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-runtime-workspace-'));
    temporaryRoots.push(dataRoot, workspaceRoot);

    const firstRuntime = createDesktopRuntime(dataRoot);
    let firstClosed = false;
    try {
      const workspace = await firstRuntime.services.addWorkspace({ rootPath: workspaceRoot });
      await firstRuntime.services.setPermissionProfile({ profile: 'balanced' });
      await expect(firstRuntime.services.startMcp({ workspaceId: workspace.id })).resolves.toMatchObject({ running: true });
      await firstRuntime.close();
      firstClosed = true;

      const restartedRuntime = createDesktopRuntime(dataRoot);
      try {
        await expect(restartedRuntime.services.listWorkspaces()).resolves.toMatchObject([
          { id: workspace.id, realRootPath: workspaceRoot },
        ]);
        await expect(restartedRuntime.services.getDashboard()).resolves.toMatchObject({
          permissionProfile: 'balanced',
          mcp: { running: false, url: null, workspaceId: null },
        });
      } finally {
        await restartedRuntime.close();
      }
    } finally {
      if (!firstClosed) await closeRuntime(firstRuntime);
    }
  });
});

async function closeRuntime(runtime: DesktopRuntime): Promise<void> {
  await runtime.close();
}
