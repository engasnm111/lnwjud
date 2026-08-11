import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ok, type Result } from '@lnwjud/domain';
import { permissionProfiles } from '@lnwjud/permissions';
import type { ManagedProcess, ProcessLogResult } from '@lnwjud/process';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import type { CodexStatus } from '@lnwjud/codex';
import { CodexService, type CodexAdapterPort } from './codex-service.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('CodexService', () => {
  it('requires EXECUTE permission before starting a Codex task and audits only metadata', async () => {
    const workspace = await createWorkspace();
    const adapter = fakeAdapter();
    const audit = { calls: [] as string[], async recordCodexRun(input: { codexTaskId: string; instruction: string }): Promise<void> { this.calls.push(`${input.codexTaskId}:${input.instruction}`); } };
    const service = new CodexService(repository(workspace), { adapter, auditService: audit, profile: permissionProfiles.balanced, taskIdFactory: (): string => 'codex-task-1' });

    const result = await service.run({ clientId: 'client-1', clientName: 'test' }, workspace.id, 'review this workspace');

    expect(result).toMatchObject({ ok: true, value: { codexTaskId: 'codex-task-1', processId: 'process-1' } });
    expect(adapter.starts).toEqual([{ cwd: workspace.realRootPath, instruction: 'review this workspace' }]);
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]).toContain('codex-task-1:review this workspace');
  });

  it('returns PERMISSION_REQUIRED under Safe without starting or auditing a task', async () => {
    const workspace = await createWorkspace();
    const adapter = fakeAdapter();
    const audit = { calls: 0, async recordCodexRun(): Promise<void> { this.calls += 1; } };
    const result = await new CodexService(repository(workspace), { adapter, auditService: audit, profile: permissionProfiles.safe })
      .run({ clientId: 'client-1', clientName: 'test' }, workspace.id, 'review this workspace');

    expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(adapter.starts).toHaveLength(0);
    expect(audit.calls).toBe(0);
  });

  it('reads the current permission profile for later Codex tasks', async () => {
    const workspace = await createWorkspace();
    const adapter = fakeAdapter();
    let profile = permissionProfiles.safe;
    const service = new CodexService(repository(workspace), {
      adapter,
      profileProvider: (): typeof profile => profile,
    });

    await expect(service.run({ clientId: 'client-1', clientName: 'test' }, workspace.id, 'blocked first'))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    profile = permissionProfiles.balanced;
    await expect(service.run({ clientId: 'client-1', clientName: 'test' }, workspace.id, 'allowed second'))
      .resolves.toMatchObject({ ok: true, value: { processId: 'process-1' } });
  });

  it('exposes bounded task status/logs and cancellation only to the owning client', async () => {
    const workspace = await createWorkspace();
    const adapter = fakeAdapter();
    const service = new CodexService(repository(workspace), { adapter, taskIdFactory: (): string => 'codex-task-1' });
    const started = await service.run({ clientId: 'client-1', clientName: 'test' }, workspace.id, 'review this workspace');
    if (!started.ok) throw new Error('Codex task did not start');

    await expect(service.taskStatus({ clientId: 'client-1', clientName: 'test' }, workspace.id, started.value.codexTaskId))
      .resolves.toMatchObject({ ok: true, value: { processId: 'process-1' } });
    await expect(service.taskLogs({ clientId: 'client-1', clientName: 'test' }, workspace.id, started.value.codexTaskId, { tailLines: 20 }))
      .resolves.toMatchObject({ ok: true, value: { entries: [] } });
    await expect(service.stop({ clientId: 'client-2', clientName: 'other' }, workspace.id, started.value.codexTaskId))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(service.stop({ clientId: 'client-1', clientName: 'test' }, workspace.id, started.value.codexTaskId))
      .resolves.toMatchObject({ ok: true });
  });
});

async function createWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-codex-service-'));
  roots.push(root);
  await mkdir(path.join(root, 'src'));
  return { id: 'workspace-1', displayName: 'Fixture', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
}

function repository(workspace: Workspace): WorkspaceRepository {
  return { async list(): Promise<Workspace[]> { return [workspace]; }, async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; }, async insert(): Promise<void> {}, async delete(): Promise<void> {} };
}

function fakeAdapter(): CodexAdapterPort & { starts: { cwd: string; instruction: string }[] } {
  const starts: { cwd: string; instruction: string }[] = [];
  return {
    starts,
    async status(): Promise<Result<CodexStatus>> { return ok({ installed: true, executablePath: 'C:\\tools\\codex.exe', version: '0.42.1', capabilities: ['exec'] }); },
    async start(cwd, instruction): Promise<Result<ManagedProcess>> { starts.push({ cwd, instruction }); return ok({ processId: 'process-1', executable: 'codex', args: ['exec', instruction], cwd, state: 'running', startedAt: new Date(0).toISOString() }); },
    statusProcess(): Result<ManagedProcess> { return ok({ processId: 'process-1', executable: 'codex', args: [], cwd: 'C:\\workspace', state: 'running', startedAt: new Date(0).toISOString() }); },
    logs(): Result<ProcessLogResult> { return ok({ entries: [], truncated: false, nextSequence: 0 }); },
    async stop(): Promise<Result<void>> { return ok(undefined); },
  };
}
