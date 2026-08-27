export const WORKSPACE_RESET_CONFIRMATION = 'DELETE-REGISTERED-WORKSPACES';

interface WorkspaceRegistration {
  readonly id: string;
}

interface WorkspaceRegistrationService {
  list(): Promise<readonly WorkspaceRegistration[]>;
  delete(id: string): Promise<void>;
}

interface WorkspaceResetBackupService {
  create(reason: 'manual'): Promise<{ readonly id: string }>;
}

export interface WorkspaceResetResult {
  readonly deleted: number;
  readonly backupId: string | null;
}

/**
 * A workspace reset deletes only lnwjud registration rows, never project files.
 * It is still a broad persistent mutation, so it requires an exact phrase and a
 * restorable SQLite snapshot before the first row is removed.
 */
export async function resetWorkspaceRegistrations(
  workspaces: WorkspaceRegistrationService,
  backups: WorkspaceResetBackupService,
  confirmation: string | undefined,
): Promise<WorkspaceResetResult> {
  if (confirmation !== WORKSPACE_RESET_CONFIRMATION) {
    throw new Error(
      `Resetting all workspace registrations requires --confirm-reset-workspaces ${WORKSPACE_RESET_CONFIRMATION}`,
    );
  }

  const existing = await workspaces.list();
  if (existing.length === 0) return { deleted: 0, backupId: null };

  const backup = await backups.create('manual');
  for (const workspace of existing) await workspaces.delete(workspace.id);
  return { deleted: existing.length, backupId: backup.id };
}
