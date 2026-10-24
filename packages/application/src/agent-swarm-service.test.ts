import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appError, err, ok, type InvocationAuthorization } from '@lnwjud/domain';
import { ProcessManager, type ManagedProcess } from '@lnwjud/process';
import { CodexAdapter, type CodexDiscoveryResult } from '@lnwjud/codex';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { CodexService } from './codex-service.js';
import { SqliteAgentSwarmRepository } from '../../storage/src/agent-swarm-repository.js';
import { SqliteDatabase } from '../../storage/src/database.js';
import { AgentSwarmService, type AgentSwarmCodexPort } from './agent-swarm-service.js';
import type { AgentSwarmStartRequest } from './agent-swarm-types.js';
import type { FileActor } from './file-service.js';

const temporaryRoots: string[] = [];
const actor: FileActor = { clientId: 'client-a', clientName: 'ChatGPT', sessionId: 'session-a' };
const otherActor: FileActor = { clientId: 'client-a', clientName: 'ChatGPT', sessionId: 'session-b' };
const authorization: InvocationAuthorization = {
  mode: 'standard',
  applicationApproved: true,
  bypassApplicationAuthorization: false,
  source: 'host_approval',
};

function managed(codexTaskId: string, state: ManagedProcess['state'] = 'running'): ManagedProcess {
  return {
    processId: `process-${codexTaskId}`,
    executable: 'codex',
    args: ['exec'],
    cwd: 'E:\\lnwjud',
    state,
    startedAt: '2026-08-31T00:00:00.000Z',
    ...(state === 'exited' ? { finishedAt: '2026-08-31T00:00:01.000Z', exitCode: 0 } : {}),
  };
}

async function fixture(codex: AgentSwarmCodexPort): Promise<{ database: SqliteDatabase; repository: SqliteAgentSwarmRepository; service: AgentSwarmService }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-agent-swarm-service-'));
  temporaryRoots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
  const repository = new SqliteAgentSwarmRepository(database);
  const service = new AgentSwarmService(repository, codex, () => new Date('2026-08-31T00:00:00.000Z'), () => '11111111-1111-4111-8111-111111111111');
  return { database, repository, service };
}

function startRequest(tasks = [{ id: 'inspect', prompt: 'Inspect the repository.' }], maxConcurrency?: number): AgentSwarmStartRequest {
  return {
    workspaceId: 'workspace-a',
    idempotencyKey: '22222222-2222-4222-8222-222222222222',
    accessMode: 'read_only' as const,
    tasks,
    ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
  };
}

function runningCodex(): { codex: AgentSwarmCodexPort; run: AgentSwarmCodexPort['run']; stop: AgentSwarmCodexPort['stop'] } {
  let sequence = 0;
  const run = vi.fn<AgentSwarmCodexPort['run']>(async (_actor, _workspaceId, _instruction, _signal, _userConfirmed, _authorization, sandboxMode) => {
    sequence += 1;
    expect(sandboxMode).toBe('read-only');
    return ok({ codexTaskId: `codex-${sequence}`, processId: `process-${sequence}` });
  });
  const stop = vi.fn<AgentSwarmCodexPort['stop']>(async () => ok(undefined));
  const codex: AgentSwarmCodexPort = {
    run,
    taskStatus: async (_actor, _workspaceId, codexTaskId) => ok(managed(codexTaskId)),
    taskLogs: async () => ok({ entries: [], truncated: false, nextSequence: 0 }),
    stop,
  };
  return { codex, run, stop };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AgentSwarmService', () => {
  it('requires host approval, rejects write mode, and validates dependency cycles', async () => {
    const fake = runningCodex();
    const { database, service } = await fixture(fake.codex);
    try {
      const denied = await service.start(actor, startRequest(), undefined, undefined);
      expect(denied).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });

      const writeMode = await service.start(actor, { ...startRequest(), accessMode: 'workspace_write' as never }, undefined, authorization);
      expect(writeMode).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });

      const cycle = await service.start(actor, startRequest([
        { id: 'a', prompt: 'A', dependsOn: ['b'] },
        { id: 'b', prompt: 'B', dependsOn: ['a'] },
      ]), undefined, authorization);
      expect(cycle).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(fake.run).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it('launches each queued task at most once and scopes status to the owner session', async () => {
    const fake = runningCodex();
    const { database, service } = await fixture(fake.codex);
    try {
      const started = await service.start(actor, startRequest(), undefined, authorization);
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(fake.run).toHaveBeenCalledTimes(1);
      expect(await service.status(otherActor, 'workspace-a', started.value.swarmId)).toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });
      await service.cancel(actor, 'workspace-a', started.value.swarmId, authorization);
    } finally {
      database.close();
    }
  });

  it('redacts terminal Codex output before persistence and result reads', async () => {
    const codex: AgentSwarmCodexPort = {
      run: async () => ok({ codexTaskId: 'codex-secret', processId: 'process-secret' }),
      taskStatus: async () => ok(managed('codex-secret', 'exited')),
      taskLogs: async () => ok({
        entries: [
          { sequence: 0, stream: 'stdout', text: 'token=plain-secret sk-test-secret\n' },
          { sequence: 1, stream: 'stderr', text: 'Authorization: Bearer bearer-secret\n' },
        ],
        truncated: false,
        nextSequence: 2,
      }),
      stop: async () => ok(undefined),
    };
    const { database, service } = await fixture(codex);
    try {
      const started = await service.start(actor, startRequest(), undefined, authorization);
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      await vi.waitFor(async () => {
        const status = await service.status(actor, 'workspace-a', started.value.swarmId);
        expect(status).toMatchObject({ ok: true, value: { state: 'completed' } });
      });

      const result = await service.result(actor, 'workspace-a', started.value.swarmId, 'inspect');
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.value.text).toContain('[REDACTED]');
      expect(result.value.text).not.toContain('plain-secret');
      expect(result.value.text).not.toContain('sk-test-secret');
      expect(result.value.text).not.toContain('bearer-secret');

      const cancelledAfterCompletion = await service.cancel(actor, 'workspace-a', started.value.swarmId, authorization);
      expect(cancelledAfterCompletion).toMatchObject({ ok: true, value: { state: 'completed' } });
    } finally {
      database.close();
    }
  });

  it('continues collecting running agent results after the start request signal is aborted', async () => {
    let finished = false;
    const codex: AgentSwarmCodexPort = {
      run: async () => ok({ codexTaskId: 'codex-detached', processId: 'process-detached' }),
      taskStatus: async () => ok(managed('codex-detached', finished ? 'exited' : 'running')),
      taskLogs: async () => ok({ entries: [{ sequence: 0, stream: 'stdout', text: 'repository-analysis-complete' }], truncated: false, nextSequence: 1 }),
      stop: async () => ok(undefined),
    };
    const { database, service } = await fixture(codex);
    const requestController = new AbortController();
    try {
      const started = await service.start(actor, startRequest(), requestController.signal, authorization);
      expect(started).toMatchObject({ ok: true, value: { state: 'running' } });
      if (!started.ok) return;

      requestController.abort();
      finished = true;
      await vi.waitFor(async () => {
        expect(await service.status(actor, 'workspace-a', started.value.swarmId)).toMatchObject({
          ok: true, value: { state: 'completed', tasks: [expect.objectContaining({ state: 'completed', resultAvailable: true })] },
        });
      }, { timeout: 3000 });
      expect(await service.result(actor, 'workspace-a', started.value.swarmId, 'inspect')).toMatchObject({
        ok: true, value: { text: 'repository-analysis-complete', eof: true },
      });
    } finally {
      database.close();
    }
  });

  // macOS lacks a kernel all-descendants owner-loss proof, so native completion
  // of opaque child agents stays unverified even when root pipes close.
  it.skipIf(process.platform === 'darwin')('runs three read-only agents through actual managed processes and collects their EOF-driven results after request cancellation', async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-real-swarm-cli-'));
    temporaryRoots.push(workdir);
    await mkdir(path.join(workdir, 'workspace'));
    const root = path.join(workdir, 'workspace');
    const workspace: Workspace = { id: 'workspace-a', displayName: 'Swarm CLI fixture', rootPath: root, realRootPath: root, createdAt: new Date().toISOString() };
    const workspaceRepository: WorkspaceRepository = {
      async get(id) { return id === workspace.id ? workspace : null; },
      async list() { return [workspace]; },
      async insert() { throw new Error('Unexpected workspace insertion'); },
      async delete() { throw new Error('Unexpected workspace deletion'); },
    };
    const discovered: CodexDiscoveryResult = {
      status: { installed: true, executablePath: process.execPath, capabilities: ['exec', 'sandbox', 'read-only'] },
      capabilities: { instructionMode: 'exec-argument', names: ['exec', 'sandbox', 'read-only'] },
    };
    const mockCli = new CodexAdapter(
      { async discover(): Promise<ReturnType<typeof ok<CodexDiscoveryResult>>> { return ok(discovered); } },
      new ProcessManager(),
      { build(_executable, _capabilities, instruction, sandboxMode): ReturnType<typeof ok<{ executable: string; args: string[] }>> {
        expect(sandboxMode).toBe('read-only');
        return ok({ executable: process.execPath, args: [
          '-e',
          "process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('analysis:' + process.argv[1]); });",
          instruction,
        ] });
      } },
    );
    const servicePort = new CodexService(workspaceRepository, { adapter: mockCli });
    const { database, service } = await fixture(servicePort);
    const requestSignal = new AbortController();
    try {
      const started = await service.start(actor, startRequest([
        { id: 'analyze', prompt: 'repository' },
        { id: 'security', prompt: 'permissions' },
        { id: 'quality', prompt: 'tests' },
      ], 3), requestSignal.signal, authorization);
      expect(started).toMatchObject({ ok: true, value: { state: 'running' } });
      if (!started.ok) return;
      requestSignal.abort();
      await vi.waitFor(async () => {
        expect(await service.status(actor, 'workspace-a', started.value.swarmId)).toMatchObject({
          ok: true, value: { state: 'completed', tasks: [
            expect.objectContaining({ state: 'completed', resultAvailable: true }),
            expect.objectContaining({ state: 'completed', resultAvailable: true }),
            expect.objectContaining({ state: 'completed', resultAvailable: true }),
          ] },
        });
      }, { timeout: 12000 });
      for (const [id, prompt] of [['analyze', 'repository'], ['security', 'permissions'], ['quality', 'tests']]) {
        expect(await service.result(actor, 'workspace-a', started.value.swarmId, id)).toMatchObject({
          ok: true, value: { state: 'completed', text: 'analysis:' + prompt, eof: true },
        });
      }
    } finally {
      database.close();
    }
  });

  it('isolates a child launch failure while keeping running and independent siblings alive', async () => {
    let sequence = 0;
    const stop = vi.fn<AgentSwarmCodexPort['stop']>(async () => ok(undefined));
    const codex: AgentSwarmCodexPort = {
      run: vi.fn<AgentSwarmCodexPort['run']>(async (_actor, _workspaceId, instruction) => {
        sequence += 1;
        if (instruction.includes('second')) return err(appError('CODEX_NOT_AVAILABLE', 'second launch failed'));
        return ok({ codexTaskId: `codex-${sequence}`, processId: `process-${sequence}` });
      }),
      taskStatus: async (_actor, _workspaceId, codexTaskId) => ok(managed(codexTaskId)),
      taskLogs: async () => ok({ entries: [], truncated: false, nextSequence: 0 }),
      stop,
    };
    const { database, service } = await fixture(codex);
    try {
      const started = await service.start(actor, startRequest([
        { id: 'first', prompt: 'first task' },
        { id: 'second', prompt: 'second task' },
        { id: 'third', prompt: 'third task' },
      ], 2), undefined, authorization);
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(stop).not.toHaveBeenCalled();
      expect(codex.run).toHaveBeenCalledTimes(3);
      const states = new Map(started.value.tasks.map((task) => [task.id, task.state]));
      expect(states.get('first')).toBe('running');
      expect(states.get('second')).toBe('failed');
      expect(states.get('third')).toBe('running');
      expect(started.value.state).toBe('running');
      await service.cancel(actor, 'workspace-a', started.value.swarmId, authorization);
    } finally {
      database.close();
    }
  });
});
