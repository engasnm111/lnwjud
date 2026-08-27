import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostMutationApprovalRequest } from '@lnwjud/mcp-server';
import { createDesktopRuntime } from '../src/main/desktop-services.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('desktop destructive administrative approval', () => {
  it('requires native approval before deleting a workspace registration', async () => {
    const dataRootRaw = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-admin-approval-data-'));
    temporaryRoots.push(dataRootRaw);
    const projectRootRaw = path.join(dataRootRaw, 'project');
    await mkdir(projectRootRaw, { recursive: true });
    const dataRoot = await realpath(dataRootRaw);
    const projectRoot = await realpath(projectRootRaw);
    let approve = false;
    const approvals: HostMutationApprovalRequest[] = [];
    const runtime = createDesktopRuntime(dataRoot, {
      hostMutationApprovalProvider: async (request) => {
        approvals.push(request);
        return approve;
      },
    });

    try {
      const workspace = await runtime.services.addWorkspace({ rootPath: projectRoot });
      const backupCountBeforeDelete = (await runtime.services.getDashboard()).backups.length;

      await expect(runtime.services.deleteWorkspace({ workspaceId: workspace.id, userConfirmed: true }))
        .rejects.toThrow(/native|host|approval/i);
      expect((await runtime.services.getDashboard()).backups).toHaveLength(backupCountBeforeDelete);
      expect((await runtime.services.listWorkspaces()).some((entry) => entry.id === workspace.id)).toBe(true);
      expect(approvals.at(-1)).toMatchObject({ toolName: 'workspace_registration_delete' });

      approve = true;
      await expect(runtime.services.deleteWorkspace({ workspaceId: workspace.id, userConfirmed: true }))
        .resolves.toMatchObject({ deleted: true, backupId: expect.any(String) });
    } finally {
      await runtime.close();
    }
  }, 30_000);

  it('wires database restore approval after safe lifecycle preconditions and before the restore marker mutation', async () => {
    const testDirectory = path.dirname(fileURLToPath(import.meta.url));
    const source = await readFile(path.resolve(testDirectory, '../src/main/desktop-services.ts'), 'utf8');
    const methodStart = source.indexOf('scheduleRestoreBackup: async');
    const methodEnd = source.indexOf('restoreRecoveryItem: async', methodStart);
    expect(methodStart).toBeGreaterThanOrEqual(0);
    expect(methodEnd).toBeGreaterThan(methodStart);
    const method = source.slice(methodStart, methodEnd);

    const tunnelCheck = method.indexOf('tunnelController.status()');
    const approval = method.indexOf("toolName: 'database_restore'");
    const mutation = method.indexOf('backupService.scheduleRestore(request.backupId)');
    expect(tunnelCheck).toBeGreaterThanOrEqual(0);
    expect(approval).toBeGreaterThan(tunnelCheck);
    expect(mutation).toBeGreaterThan(approval);
  });
});
