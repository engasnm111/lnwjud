import { existsSync } from 'node:fs';
import {
  allFixedDriveRoots,
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

/**
 * Unrestricted mode: register every fixed drive root (C:\, D:\, E:\, …) as a machine root.
 * Existing roots are kept and never pruned. Returns the first available machine root.
 */
export async function syncAllDriveRoots(workspaceService: WorkspaceService): Promise<Workspace | null> {
  const roots = allFixedDriveRoots();
  if (roots.length === 0) return null;

  const existing = await workspaceService.list();
  let primary: Workspace | null = null;
  for (const root of roots) {
    const target = normalizeWorkspaceRoot(root).toLowerCase();
    const found = existing.find((entry) => normalizeWorkspaceRoot(entry.realRootPath).toLowerCase() === target);
    if (found !== undefined) {
      if (primary === null) primary = found;
      continue;
    }
    const added = await workspaceService.add(`Local Disk ${root[0]}:`, root);
    if (added.ok && primary === null) primary = added.value;
  }
  if (primary !== null) return primary;
  const after = await workspaceService.list();
  return after.find((entry) => isDriveRoot(entry.realRootPath)) ?? after[0] ?? null;
}

/**
 * Machine-root sync for the current access mode.
 * Default mode keeps E:\ as the sole machine root; unrestricted mode registers every fixed drive.
 */
export function syncMachineRoots(workspaceService: WorkspaceService, unrestricted: boolean): Promise<Workspace | null> {
  return unrestricted ? syncAllDriveRoots(workspaceService) : syncEMachineRoot(workspaceService);
}
