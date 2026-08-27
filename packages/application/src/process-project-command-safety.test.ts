import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ok, type CommandSpec, type Result } from '@lnwjud/domain';
import type { ManagedProcess, ManagedProcessStart, ProcessLogResult } from '@lnwjud/process';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { ProcessService, type ProcessManagerPort, type ProjectCommandSource } from './process-service.js';

const roots: string[] = [];
const actor = { clientId: 'client-1', clientName: 'test' };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ workspace: Workspace; repository: WorkspaceRepository }> {
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-project-command-safety-'));
  roots.push(rawRoot);
  const root = await realpath(rawRoot);
  const workspace: Workspace = {
    id: 'workspace-1',
    displayName: 'Fixture',
    rootPath: root,
    realRootPath: root,
    createdAt: new Date(0).toISOString(),
  };
  return {
    workspace,
    repository: {
      async list(): Promise<readonly Workspace[]> { return [workspace]; },
      async get(id): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
      async insert(): Promise<void> {},
      async delete(): Promise<void> {},
    },
  };
}

function manager(calls: ManagedProcessStart[]): ProcessManagerPort {
  const handle: ManagedProcess = {
    processId: 'process-1',
    executable: 'pnpm',
    args: ['test'],
    cwd: 'C:\\workspace',
    state: 'running',
    startedAt: new Date(0).toISOString(),
  };
  return {
    async start(spec: ManagedProcessStart): Promise<Result<ManagedProcess>> { calls.push(spec); return ok(handle); },
    list(): readonly ManagedProcess[] { return [handle]; },
    status(): Result<ManagedProcess> { return ok(handle); },
    logs(): Result<ProcessLogResult> { return ok({ entries: [], truncated: false, nextSequence: 0 }); },
    async stop(): Promise<Result<void>> { return ok(undefined); },
  };
}

describe('ProcessService project command approval binding', () => {
  it('previews the exact project command without launching it', async () => {
    const { workspace, repository } = await fixture();
    const calls: ManagedProcessStart[] = [];
    const projectService: ProjectCommandSource = {
      async getCommand(): Promise<Result<CommandSpec>> { return ok({ executable: 'pnpm', args: ['test', '--runInBand'] }); },
    };
    const service = new ProcessService(repository, { processManager: manager(calls), projectService });

    await expect(service.previewProjectCommand(workspace.id, 'test')).resolves.toEqual({
      ok: true,
      value: { executable: 'pnpm', args: ['test', '--runInBand'] },
    });
    expect(calls).toEqual([]);
  });

  it('denies launch when the detected command changes after approval', async () => {
    const { workspace, repository } = await fixture();
    const calls: ManagedProcessStart[] = [];
    let resolution = 0;
    const projectService: ProjectCommandSource = {
      async getCommand(): Promise<Result<CommandSpec>> {
        resolution += 1;
        return resolution === 1
          ? ok({ executable: 'pnpm', args: ['test'] })
          : ok({ executable: 'pnpm', args: ['test', '--changed-after-approval'] });
      },
    };
    const service = new ProcessService(repository, { processManager: manager(calls), projectService });
    const preview = await service.previewProjectCommand(workspace.id, 'test');
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    await expect(service.startProjectCommand(actor, workspace.id, 'test', undefined, true, preview.value)).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: expect.stringMatching(/changed|fresh approval/i) },
    });
    expect(calls).toEqual([]);
  });

  it('launches only when the freshly resolved command exactly matches the approved preview', async () => {
    const { workspace, repository } = await fixture();
    const calls: ManagedProcessStart[] = [];
    const projectService: ProjectCommandSource = {
      async getCommand(): Promise<Result<CommandSpec>> { return ok({ executable: 'pnpm', args: ['test'] }); },
    };
    const service = new ProcessService(repository, { processManager: manager(calls), projectService });
    const preview = await service.previewProjectCommand(workspace.id, 'test');
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    await expect(service.startProjectCommand(actor, workspace.id, 'test', undefined, true, preview.value)).resolves.toMatchObject({ ok: true });
    expect(calls).toEqual([{ executable: 'pnpm', args: ['test'], cwd: workspace.realRootPath }]);
  });
});
