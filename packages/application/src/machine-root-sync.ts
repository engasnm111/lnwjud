import { existsSync } from 'node:fs';
import {
  isDriveRoot,
  isEMachineRoot,
  machineRootPath,
  normalizeWorkspaceRoot,
  type Workspace,
  type WorkspaceService,
} from '@lnwjud/workspace';

/**
 * Ensures E:\ is registered as the sole machine root and removes other drive-root workspaces.
 * Project workspaces under E:\ are preserved.
 */
export async function syncEMachineRoot(workspaceService: WorkspaceService): Promise<Workspace | null> {
  const existing = await workspaceService.list();
  for (const workspace of existing) {
    if (isDriveRoot(workspace.realRootPath) && !isEMachineRoot(workspace.realRootPath)) {
      await workspaceService.delete(workspace.id);
    }
  }

  const root = machineRootPath();
  if (!existsSync(root)) return null;

  const afterPrune = await workspaceService.list();
  const target = normalizeWorkspaceRoot(root).toLowerCase();
  const found = afterPrune.find((entry) => normalizeWorkspaceRoot(entry.realRootPath).toLowerCase() === target);
  if (found !== undefined) return found;

  const added = await workspaceService.add('Local Disk E:', root);
  return added.ok ? added.value : null;
}
