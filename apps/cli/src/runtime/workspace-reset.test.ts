import { describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_RESET_CONFIRMATION,
  resetWorkspaceRegistrations,
} from './workspace-reset.js';

describe('resetWorkspaceRegistrations', () => {
  it('refuses a broad registration reset without the exact confirmation phrase', async () => {
    const list = vi.fn(async () => [{ id: 'workspace-1' }]);
    const remove = vi.fn(async () => undefined);
    const createBackup = vi.fn(async () => ({ id: 'backup-1' }));

    await expect(resetWorkspaceRegistrations(
      { list, delete: remove },
      { create: createBackup },
      'yes',
    )).rejects.toThrow(WORKSPACE_RESET_CONFIRMATION);

    expect(createBackup).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('creates a recoverable database backup before deleting any registration', async () => {
    const events: string[] = [];
    const result = await resetWorkspaceRegistrations(
      {
        list: async () => [{ id: 'workspace-1' }, { id: 'workspace-2' }],
        delete: async (id) => { events.push(`delete:${id}`); },
      },
      {
        create: async (reason) => {
          events.push(`backup:${reason}`);
          return { id: 'backup-before-reset' };
        },
      },
      WORKSPACE_RESET_CONFIRMATION,
    );

    expect(events).toEqual([
      'backup:manual',
      'delete:workspace-1',
      'delete:workspace-2',
    ]);
    expect(result).toEqual({ deleted: 2, backupId: 'backup-before-reset' });
  });

  it('does not create a needless backup when there are no registrations', async () => {
    const createBackup = vi.fn(async () => ({ id: 'backup-1' }));

    await expect(resetWorkspaceRegistrations(
      { list: async () => [], delete: async () => undefined },
      { create: createBackup },
      WORKSPACE_RESET_CONFIRMATION,
    )).resolves.toEqual({ deleted: 0, backupId: null });

    expect(createBackup).not.toHaveBeenCalled();
  });
});
