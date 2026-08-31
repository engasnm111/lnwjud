import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ok, type CommandSpec, type Result } from '@lnwjud/domain';
import { permissionProfiles } from '@lnwjud/permissions';
import type { ManagedProcess, ManagedProcessStart, ProcessLogResult } from '@lnwjud/process';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { ProcessService, type ProcessServiceDependencies, type ProjectCommandSource } from './process-service.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<Workspace> {
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-process-service-'));
  temporaryRoots.push(rawRoot);
  const root = await realpath(rawRoot);
  await mkdir(path.join(root, 'src'));
  return {
    id: 'workspace-1',
    displayName: 'Fixture',
    rootPath: root,
    realRootPath: root,
    createdAt: new Date(0).toISOString(),
  };
}

function repository(workspace: Workspace): WorkspaceRepository {
  return {
    async list(): Promise<Workspace[]> { return [workspace]; },
    async get(id: string): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
    async insert(): Promise<void> {},
    async delete(): Promise<void> {},
  };
}

function processHandle(id = 'process-1'): ManagedProcess {
  return {
    processId: id,
    executable: 'pnpm',
    args: ['test'],
    cwd: 'C:\\workspace',
    state: 'running',
    startedAt: new Date(0).toISOString(),
  };
}

describe('ProcessService', () => {
  const fullBypassAuthorization = {
    mode: 'full_bypass',
    applicationApproved: true,
    bypassApplicationAuthorization: true,
    source: 'full_bypass',
  } as const;

  it('allows a detected pnpm project command under Balanced and starts it in the guarded root', async () => {
    const workspace = await createWorkspace();
    const calls: ManagedProcessStart[] = [];
    const manager = fakeManager(calls);
    const projectCommands: ProjectCommandSource = {
      async getCommand(): Promise<Result<CommandSpec>> { return ok({ executable: 'pnpm', args: ['test'] }); },
    };
    const service = new ProcessService(repository(workspace), { processManager: manager, projectService: projectCommands });

    const result = await service.startProjectCommand({ clientId: 'client-1', clientName: 'test' }, workspace.id, 'test', undefined, true);

    expect(result).toMatchObject({ ok: true, value: { processId: 'process-1' } });
    expect(calls).toEqual([{ executable: 'pnpm', args: ['test'], cwd: workspace.realRootPath }]);
  });

  it('returns PERMISSION_REQUIRED for an unknown client executable', async () => {
    const workspace = await createWorkspace();
    const calls: ManagedProcessStart[] = [];
    const service = new ProcessService(repository(workspace), { processManager: fakeManager(calls) });

    const result = await service.start({ clientId: 'client-1', clientName: 'test' }, workspace.id, {
      executable: 'custom-tool.exe',
      args: [],
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(calls).toHaveLength(0);
  });

  it('runs cwd path guarding before permission decisions', async () => {
    const workspace = await createWorkspace();
    let permissionCalls = 0;
    const service = new ProcessService(repository(workspace), {
      processManager: fakeManager([]),
      permissionEngine: { decide(): 'ALLOW' { permissionCalls += 1; return 'ALLOW'; } },
    });

    const result = await service.start({ clientId: 'client-1', clientName: 'test' }, workspace.id, {
      executable: 'custom-tool.exe',
      args: [],
      cwd: '..\\outside',
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    expect(permissionCalls).toBe(0);
  });

  it('allows an explicitly absolute cwd outside the workspace in unrestricted mode', async () => {
    const workspace = await createWorkspace();
    const outsideRaw = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-process-outside-'));
    temporaryRoots.push(outsideRaw);
    const outside = await realpath(outsideRaw);
    const calls: ManagedProcessStart[] = [];
    const service = new ProcessService(repository(workspace), {
      processManager: fakeManager(calls),
      unrestricted: true,
    });

    const result = await service.start({ clientId: 'client-1', clientName: 'test' }, workspace.id, {
      executable: 'pnpm.cmd',
      args: ['test'],
      cwd: outside,
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true, value: { processId: 'process-1' } });
    expect(calls).toEqual([{ executable: 'pnpm.cmd', args: ['test'], cwd: outside }]);
  });

  it('rejects a workspace junction or symlink whose canonical cwd escapes the workspace', async () => {
    const workspace = await createWorkspace();
    const outsideRaw = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-process-junction-outside-'));
    temporaryRoots.push(outsideRaw);
    const outside = await realpath(outsideRaw);
    const escape = path.join(workspace.realRootPath, 'escape');
    await symlink(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
    const calls: ManagedProcessStart[] = [];
    const service = new ProcessService(repository(workspace), {
      processManager: fakeManager(calls),
      unrestricted: true,
    });

    const result = await service.start({ clientId: 'client-1', clientName: 'test' }, workspace.id, {
      executable: 'pnpm.cmd',
      args: ['test'],
      cwd: escape,
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['rm', ['-rf', 'target']],
    ['powershell.exe', ['-Command', 'Remove-Item target']],
    ['git', ['clean', '-fd']],
  ] as const)('requires confirmation for risky command %s, then dispatches after confirmation', async (executable, args) => {
    const workspace = await createWorkspace();
    const calls: ManagedProcessStart[] = [];
    const service = new ProcessService(repository(workspace), {
      processManager: fakeManager(calls),
      unrestricted: true,
    });

    const blocked = await service.start({ clientId: 'client-1', clientName: 'test' }, workspace.id, { executable, args });
    expect(blocked).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(calls).toHaveLength(0);
    const result = await service.start({ clientId: 'client-1', clientName: 'test' }, workspace.id, { executable, args, userConfirmed: true });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('accepts trusted Full Bypass for a risky command outside the workspace without caller confirmation', async () => {
    const workspace = await createWorkspace();
    const outsideRaw = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-process-full-bypass-'));
    temporaryRoots.push(outsideRaw);
    const outside = await realpath(outsideRaw);
    const calls: ManagedProcessStart[] = [];
    const service = new ProcessService(repository(workspace), {
      processManager: fakeManager(calls),
      profile: permissionProfiles.safe,
    });

    const result = await service.start(
      { clientId: 'client-1', clientName: 'test' },
      workspace.id,
      { executable: 'powershell.exe', args: ['-Command', 'Remove-Item target'], cwd: outside },
      undefined,
      fullBypassAuthorization,
    );

    expect(result).toMatchObject({ ok: true, value: { processId: 'process-1' } });
    expect(calls).toEqual([{ executable: 'powershell.exe', args: ['-Command', 'Remove-Item target'], cwd: outside }]);
  });

  it('enforces process ownership for status, logs, and stop handles', async () => {
    const workspace = await createWorkspace();
    const service = new ProcessService(repository(workspace), { processManager: fakeManager([]) });
    const started = await service.start({ clientId: 'client-1', clientName: 'test' }, workspace.id, {
      executable: 'pnpm',
      args: ['test'],
      userConfirmed: true,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await expect(service.status({ clientId: 'client-2', clientName: 'other' }, workspace.id, started.value.processId))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(service.logs({ clientId: 'client-1', clientName: 'test' }, workspace.id, started.value.processId, {}))
      .resolves.toMatchObject({ ok: true });
    await expect(service.stop({ clientId: 'client-1', clientName: 'test' }, workspace.id, started.value.processId, true))
      .resolves.toMatchObject({ ok: true });
  });

  it('does not dispatch a project process after cancellation wins during command discovery', async () => {
    const workspace = await createWorkspace();
    const calls: ManagedProcessStart[] = [];
    let releaseCommand!: () => void;
    const commandGate = new Promise<void>((resolve) => { releaseCommand = resolve; });
    const projectCommands: ProjectCommandSource = {
      async getCommand(): Promise<Result<CommandSpec>> {
        await commandGate;
        return ok({ executable: 'pnpm', args: ['test'] });
      },
    };
    const service = new ProcessService(repository(workspace), { processManager: fakeManager(calls), projectService: projectCommands });
    const controller = new AbortController();

    const starting = service.startProjectCommand({ clientId: 'client-1', clientName: 'test' }, workspace.id, 'test', controller.signal);
    controller.abort();
    releaseCommand();

    await expect(starting).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(calls).toHaveLength(0);
  });

  it('forwards the invocation signal to the process manager', async () => {
    const workspace = await createWorkspace();
    const calls: ManagedProcessStart[] = [];
    const observedSignals: Array<AbortSignal | undefined> = [];
    const service = new ProcessService(repository(workspace), { processManager: fakeManager(calls, observedSignals) });
    const signal = new AbortController().signal;

    await expect(service.start({ clientId: 'client-1', clientName: 'test' }, workspace.id, {
      executable: 'pnpm',
      args: ['test'],
      userConfirmed: true,
    }, signal)).resolves.toMatchObject({ ok: true });

    expect(observedSignals).toEqual([signal]);
  });

  it('provisionally owns a created process so a cancelled launch remains listable and stoppable', async () => {
    const workspace = await createWorkspace();
    const handle = processHandle('process-provisional');
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    let created!: () => void;
    const createdGate = new Promise<void>((resolve) => { created = resolve; });
    let stops = 0;
    const manager: NonNullable<ProcessServiceDependencies['processManager']> = {
      async start(_spec, _signal, onCreated): Promise<Result<ManagedProcess>> {
        onCreated?.(handle);
        created();
        await startGate;
        return ok(handle);
      },
      list(): readonly ManagedProcess[] { return [handle]; },
      status(): Result<ManagedProcess> { return ok(handle); },
      logs(): Result<ProcessLogResult> { return ok({ entries: [], truncated: false, nextSequence: 0 }); },
      async stop(): Promise<Result<void>> { stops += 1; return ok(undefined); },
    };
    const service = new ProcessService(repository(workspace), { processManager: manager });
    const actor = { clientId: 'client-1', clientName: 'test' };

    const starting = service.start(actor, workspace.id, { executable: 'pnpm', args: ['test'], userConfirmed: true });
    await createdGate;
    await expect(service.list(actor, workspace.id)).resolves.toMatchObject({
      ok: true,
      value: [expect.objectContaining({ processId: 'process-provisional' })],
    });
    await expect(service.stop(actor, workspace.id, 'process-provisional', true)).resolves.toMatchObject({ ok: true });
    expect(stops).toBe(1);
    releaseStart();
    await expect(starting).resolves.toMatchObject({ ok: true });
  });

  it('stops a process spawned just before its invocation is cancelled', async () => {
    const workspace = await createWorkspace();
    const handle = processHandle('process-cancelled-after-spawn');
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    let resolveCreated!: () => void;
    const created = new Promise<void>((resolve) => { resolveCreated = resolve; });
    let stops = 0;
    const manager: NonNullable<ProcessServiceDependencies['processManager']> = {
      async start(_spec, _signal, onCreated): Promise<Result<ManagedProcess>> {
        onCreated?.(handle);
        resolveCreated();
        await startGate;
        return ok(handle);
      },
      list(): readonly ManagedProcess[] { return [handle]; },
      status(): Result<ManagedProcess> { return ok(handle); },
      logs(): Result<ProcessLogResult> { return ok({ entries: [], truncated: false, nextSequence: 0 }); },
      async stop(): Promise<Result<void>> { stops += 1; return ok(undefined); },
    };
    const service = new ProcessService(repository(workspace), { processManager: manager });
    const controller = new AbortController();
    const starting = service.start(
      { clientId: 'client-1', clientName: 'test' },
      workspace.id,
      { executable: 'pnpm', args: ['test'], userConfirmed: true },
      controller.signal,
    );
    await created;
    controller.abort();
    releaseStart();

    await expect(starting).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(stops).toBe(1);
  });

  it('isolates process handles between sessions of the same client and workspace', async () => {
    const workspace = await createWorkspace();
    const service = new ProcessService(repository(workspace), { processManager: fakeManager([]) });
    const owner = { clientId: 'client-1', clientName: 'test', sessionId: 'session-a' };
    const otherSession = { clientId: 'client-1', clientName: 'test', sessionId: 'session-b' };
    const started = await service.start(owner, workspace.id, { executable: 'pnpm', args: ['test'], userConfirmed: true });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await expect(service.status(otherSession, workspace.id, started.value.processId)).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(service.logs(otherSession, workspace.id, started.value.processId, {})).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(service.stop(otherSession, workspace.id, started.value.processId)).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(service.list(otherSession, workspace.id)).resolves.toMatchObject({ ok: true, value: [] });
    await expect(service.status(owner, workspace.id, started.value.processId)).resolves.toMatchObject({ ok: true });
    expect(service.statusForGoalLiveness(workspace.id, started.value.processId)).toMatchObject({ ok: true, value: { state: 'running' } });
    expect(service.statusForGoalLiveness('another-workspace', started.value.processId)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });

  it('cancels a tracked process across MCP sessions while enforcing stable client/workspace ownership', async () => {
    const workspace = await createWorkspace();
    let current = processHandle('process-goal-cancel');
    const stopCalls: Array<{ processId: string; autoRetry: boolean | undefined }> = [];
    const manager: NonNullable<ProcessServiceDependencies['processManager']> = {
      async start(): Promise<Result<ManagedProcess>> { return ok(current); },
      list(): readonly ManagedProcess[] { return [current]; },
      status(): Result<ManagedProcess> { return ok(current); },
      logs(): Result<ProcessLogResult> { return ok({ entries: [], truncated: false, nextSequence: 0 }); },
      async stop(processId, autoRetry): Promise<Result<void>> {
        stopCalls.push({ processId, autoRetry });
        current = { ...current, state: 'stopped', finishedAt: new Date(1).toISOString(), exitCode: -1 };
        return ok(undefined);
      },
    };
    const service = new ProcessService(repository(workspace), { processManager: manager });
    const started = await service.start(
      { clientId: 'client-1', clientName: 'test', sessionId: 'session-a' },
      workspace.id,
      { executable: 'pnpm', args: ['test'], userConfirmed: true },
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await expect(service.cancelForGoal('client-2', workspace.id, started.value.processId))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    await expect(service.cancelForGoal('client-1', workspace.id, started.value.processId))
      .resolves.toMatchObject({ ok: true, value: { matched: true, state: 'cancelled' } });
    expect(stopCalls).toEqual([{ processId: 'process-goal-cancel', autoRetry: true }]);
    await expect(service.cancelForGoal('client-1', workspace.id, started.value.processId))
      .resolves.toMatchObject({ ok: true, value: { matched: true, state: 'already_terminal' } });
  });
});

function fakeManager(calls: ManagedProcessStart[], observedSignals: Array<AbortSignal | undefined> = []): ProcessServiceDependencies['processManager'] {
  return {
    async start(spec: ManagedProcessStart, signal?: AbortSignal): Promise<Result<ManagedProcess>> {
      calls.push(spec);
      observedSignals.push(signal);
      return ok(processHandle());
    },
    list(): readonly ManagedProcess[] { return [processHandle()]; },
    status(): Result<ManagedProcess> { return ok(processHandle()); },
    logs(): Result<ProcessLogResult> { return ok({ entries: [], truncated: false, nextSequence: 0 }); },
    async stop(): Promise<Result<void>> { return ok(undefined); },
  };
}
