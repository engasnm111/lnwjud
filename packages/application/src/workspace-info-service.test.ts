import { mkdtemp, realpath, rm } from 'node:fs/promises';
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
  it('registers an explicit absolute project without an automatically generated machine root', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-register-direct-'));
    temporaryRoots.push(projectRoot);
    const projectRealRoot = await realpath(projectRoot);

    const store = new Map<string, Workspace>();
    const repository: WorkspaceRepository = {
      async list(): Promise<Workspace[]> { return [...store.values()]; },
      async get(id: string): Promise<Workspace | null> { return store.get(id) ?? null; },
      async insert(workspace: Workspace): Promise<void> { store.set(workspace.id, workspace); },
      async delete(id: string): Promise<void> { store.delete(id); },
    };
    const service = new WorkspaceInfoService(repository, new WorkspaceService(repository));
    const actor = { clientId: 't', clientName: 't' };

    const registered = await service.register(actor, { path: projectRoot });

    expect(registered).toMatchObject({
      ok: true,
      value: { kind: 'project', realRootPath: projectRealRoot },
    });
    expect([...store.values()].some((entry) => /^[A-Za-z]:\\$/.test(entry.rootPath))).toBe(false);
  });

  it('registers a project under whichever drive-root machine root owns it and is idempotent', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-register-'));
    temporaryRoots.push(projectRoot);
    const machineRoot = path.parse(projectRoot).root;
    if (!/^[A-Za-z]:\\$/.test(machineRoot)) return;

    const store = new Map<string, Workspace>();
    const repository: WorkspaceRepository = {
      async list(): Promise<Workspace[]> { return [...store.values()]; },
      async get(id: string): Promise<Workspace | null> { return store.get(id) ?? null; },
      async insert(workspace: Workspace): Promise<void> { store.set(workspace.id, workspace); },
      async delete(id: string): Promise<void> { store.delete(id); },
    };
    const workspaceService = new WorkspaceService(repository);
    const machine = await workspaceService.add(`Local Disk ${machineRoot[0]}:`, machineRoot);
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

    const alternateDrive = machineRoot[0]?.toUpperCase() === 'Z' ? 'Y' : 'Z';
    const outside = await service.register(actor, {
      parentWorkspaceId: machine.value.id,
      path: `${alternateDrive}:\\outside-lnwjud`,
    });
    expect(outside).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('classifies every drive root as machine_root without a special drive letter', async () => {
    const repository: WorkspaceRepository = {
      async list(): Promise<Workspace[]> {
        return [{
          id: 'c-root',
          displayName: 'Local Disk C:',
          rootPath: 'C:\\',
          realRootPath: 'C:\\',
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
