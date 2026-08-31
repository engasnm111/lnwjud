import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { resolveSharedWorkspace, resolveWorkspaceForPath } from './workspace-locator.js';

function repository(workspaces: readonly Workspace[]): WorkspaceRepository {
  return {
    async list(): Promise<Workspace[]> { return [...workspaces]; },
    async get(id: string): Promise<Workspace | null> { return workspaces.find((entry) => entry.id === id) ?? null; },
    async insert(): Promise<void> {},
    async delete(): Promise<void> {},
  };
}

describe('resolveWorkspaceForPath', () => {
  const drive: Workspace = {
    id: 'drive-c',
    displayName: 'C',
    rootPath: 'C:\\',
    realRootPath: 'C:\\',
    createdAt: new Date(0).toISOString(),
  };
  const nested: Workspace = {
    id: 'project',
    displayName: 'Project',
    rootPath: 'C:\\Users\\me\\proj',
    realRootPath: 'C:\\Users\\me\\proj',
    createdAt: new Date(0).toISOString(),
  };

  it('requires workspaceId for relative paths', async () => {
    const result = await resolveWorkspaceForPath(repository([drive]), undefined, 'src\\file.ts');
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('picks the longest matching workspace for an absolute path', async () => {
    const result = await resolveWorkspaceForPath(
      repository([drive, nested]),
      undefined,
      'C:\\Users\\me\\proj\\docs\\plan.md',
    );
    expect(result).toMatchObject({ ok: true, value: { id: 'project' } });
  });

  it('rejects an absolute path outside the given workspaceId', async () => {
    const result = await resolveWorkspaceForPath(
      repository([drive, nested]),
      nested.id,
      'C:\\Windows\\notepad.exe',
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });

  it('keeps the explicit workspace as an audit anchor for an outside absolute path under Full Bypass', async () => {
    const result = await resolveWorkspaceForPath(
      repository([drive, nested]),
      nested.id,
      'D:\\outside\\proof.txt',
      { mode: 'full_bypass', applicationApproved: true, bypassApplicationAuthorization: true, source: 'full_bypass' },
    );
    expect(result).toMatchObject({ ok: true, value: { id: 'project' } });
  });

  it('requires source and destination to share one workspace', async () => {
    const other: Workspace = {
      id: 'drive-d',
      displayName: 'D',
      rootPath: 'D:\\',
      realRootPath: 'D:\\',
      createdAt: new Date(0).toISOString(),
    };
    const result = await resolveSharedWorkspace(
      repository([drive, other]),
      undefined,
      path.win32.join('C:\\', 'a.txt'),
      path.win32.join('D:\\', 'a.txt'),
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
  });
});
