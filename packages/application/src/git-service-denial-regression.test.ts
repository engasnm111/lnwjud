import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitAdapter } from '@lnwjud/git';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { GitService } from './git-service.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('GitService destructive checkout/ref regression', () => {
  it.each([
    ['ambiguous checkout path', ['checkout', 'src/file.ts']],
    ['force branch rename', ['branch', '-M', 'old', 'existing']],
    ['force branch copy', ['branch', '-C', 'source', 'existing']],
  ] as const)('denies confirmed %s before adapter dispatch', async (_label, args) => {
    const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-git-denial-'));
    temporaryRoots.push(rawRoot);
    const root = await realpath(rawRoot);
    const workspace: Workspace = {
      id: 'workspace-1', displayName: 'Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString(),
    };
    const repository: WorkspaceRepository = {
      async list(): Promise<Workspace[]> { return [workspace]; },
      async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
      async insert(): Promise<void> {},
      async delete(): Promise<void> {},
    };
    let calls = 0;
    const adapter = {
      async run(): Promise<{ ok: true; value: { exitCode: number; stdout: string; stderr: string } }> {
        calls += 1;
        return { ok: true, value: { exitCode: 0, stdout: '', stderr: '' } };
      },
    } as unknown as GitAdapter;
    const service = new GitService(repository, undefined, adapter);

    await expect(service.run({ clientId: 'test', clientName: 'test' }, {
      workspaceId: workspace.id,
      args,
      userConfirmed: true,
    })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(calls).toBe(0);
  });
});
