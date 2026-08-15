import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceInfoService } from './workspace-info-service.js';
import { WorkspaceService, type Workspace, type WorkspaceRepository } from '@lnwjud/workspace';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('WorkspaceInfoService.register', () => {
  it('registers a project under the E: machine root and is idempotent', async () => {
    const projectRoot = await mkdtemp(path.join('E:\\', 'lnwjud-register-'));
    temporaryRoots.push(projectRoot);

    const store = new Map<string, Workspace>();
    const repository: WorkspaceRepository = {
      async list(): Promise<Workspace[]> { return [...store.values()]; },
      async get(id: string): Promise<Workspace | null> { return store.get(id) ?? null; },
      async insert(workspace: Workspace): Promise<void> { store.set(workspace.id, workspace); },
      async delete(id: string): Promise<void> { store.delete(id); },
    };
    const workspaceService = new WorkspaceService(repository);
    const machine = await workspaceService.add('Local Disk E:', 'E:\\');
    expect(machine.ok).toBe(true);
    if (!machine.ok) return;

    const service = new WorkspaceInfoService(repository, workspaceService);
    const actor = { clientId: 't', clientName: 't' };
    const first = await service.register(actor, { parentWorkspaceId: machine.value.id, path: projectRoot });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.kind).toBe('project');

    const second = await service.register(actor, { parentWorkspaceId: machine.value.id, path: projectRoot });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.id).toBe(first.value.id);

    const outside = await service.register(actor, {
      parentWorkspaceId: machine.value.id,
      path: path.join(os.tmpdir(), 'outside-lnwjud'),
    });
    expect(outside).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('lists machine_root kind for E:\\', async () => {
    const repository: WorkspaceRepository = {
      async list(): Promise<Workspace[]> {
        return [{
          id: 'e-root',
          displayName: 'Local Disk E:',
          rootPath: 'E:\\',
          realRootPath: 'E:\\',
          createdAt: new Date(0).toISOString(),
        }];
      },
      async get(): Promise<Workspace | null> { return null; },
      async insert(): Promise<void> {},
      async delete(): Promise<void> {},
    };
    const listed = await new WorkspaceInfoService(repository).list({ clientId: 't', clientName: 't' });
    expect(listed).toMatchObject({ ok: true, value: [{ kind: 'machine_root' }] });
  });
});
