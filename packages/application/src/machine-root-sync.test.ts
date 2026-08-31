import type { Result } from '@lnwjud/domain';
import type { Workspace, WorkspaceService } from '@lnwjud/workspace';
import { describe, expect, it } from 'vitest';
import { syncMachineRoots, syncPreferredMachineRoot } from './machine-root-sync.js';

describe('machine-root synchronization', () => {
  it('does not fall back to a local drive when an explicit project canonicalizes to a network UNC path', async () => {
    const { service, addedRoots } = recordingWorkspaceService();

    await expect(syncPreferredMachineRoot(service, '\\\\dgx-spark\\models\\project-a')).resolves.toBeNull();

    expect(addedRoots).toEqual([]);
  });

  it('does not enumerate or register drive letters during unrestricted startup without an explicit project', async () => {
    const { service, addedRoots } = recordingWorkspaceService();

    await expect(syncMachineRoots(service, true)).resolves.toBeNull();

    expect(addedRoots).toEqual([]);
  });
});

function recordingWorkspaceService(): { readonly service: WorkspaceService; readonly addedRoots: string[] } {
  const addedRoots: string[] = [];
  const service = {
    async list(): Promise<Workspace[]> {
      return [];
    },
    async add(displayName: string, rootPath: string): Promise<Result<Workspace>> {
      addedRoots.push(rootPath);
      return {
        ok: true,
        value: {
          id: 'recorded-machine-root' as Workspace['id'],
          displayName,
          rootPath,
          realRootPath: rootPath,
          createdAt: '2026-08-28T00:00:00.000Z',
        },
      };
    },
  } as unknown as WorkspaceService;
  return { service, addedRoots };
}
