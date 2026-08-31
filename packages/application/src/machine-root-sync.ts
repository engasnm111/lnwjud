import { existsSync } from 'node:fs';
import {
  driveRootForPath,
  normalizeWorkspaceRoot,
  type Workspace,
  type WorkspaceService,
} from '@lnwjud/workspace';

/**
 * Legacy-compatible explicit machine-root registration.
 *
 * This function never falls back to the system/home drive and never scans A:–Z:.
 * Callers must provide a canonical project path whose owning drive they explicitly
 * intend to register. UNC/network paths intentionally produce no machine root.
 */
export async function syncPreferredMachineRoot(
  workspaceService: WorkspaceService,
  preferredPath?: string,
): Promise<Workspace | null> {
  const root = driveRootForPath(preferredPath);
  if (root === null) return null;
  if (!existsSync(root)) return null;

  const existing = await workspaceService.list();
  const target = normalizeWorkspaceRoot(root).toLowerCase();
  const found = existing.find((entry) => normalizeWorkspaceRoot(entry.realRootPath).toLowerCase() === target);
  if (found !== undefined) return found;

  const added = await workspaceService.add(`Local Disk ${root[0]?.toUpperCase() ?? ''}:`, root);
  return added.ok ? added.value : null;
}

/** Backward-compatible wrapper that no longer changes behavior in unrestricted mode. */
export function syncMachineRoots(
  workspaceService: WorkspaceService,
  unrestricted: boolean,
  preferredPath?: string,
): Promise<Workspace | null> {
  void unrestricted;
  return syncPreferredMachineRoot(workspaceService, preferredPath);
}
