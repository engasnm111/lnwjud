import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { automationShellRequestDigest, appError, err, ok, type Result } from '@lnwjud/domain';
import { ShellCapabilityBackend, type CapabilityService, type CapabilityToolName } from '@lnwjud/capabilities';
import type { AutomationDispatchRequest, FileActor } from '@lnwjud/application';
import { permissionProfiles } from '@lnwjud/permissions';
import { AutomationRuntimeAdapter, type AutomationToolRegistryPort } from './automation-runtime-adapter.js';
import { ToolRegistry, type WorkspaceScope, type McpApplicationServices } from './tool-registry.js';

const roots: string[] = [];
const actor: FileActor = { clientId: 'client-a', clientName: 'Client A', sessionId: 'session-a' };
const goals = { validateGoalLease: async () => ok({ workspaceId: 'workspace-a' }) } as unknown as NonNullable<McpApplicationServices['goals']>;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

function dispatchRequest(
  root: string,
  overrides: Partial<AutomationDispatchRequest['context']> = {},
  dispatchOverrides: Partial<AutomationDispatchRequest['dispatch']> = {},
): AutomationDispatchRequest {
  const dispatch = {
    executable: process.execPath,
    arguments: ['-e', "setTimeout(() => process.stdout.write('automation-ok'), 40)"],
    cwd: root,
    timeoutSeconds: 30,
    maxOutputBytes: 1024,
    includeStdout: true,
    includeStderr: true,
    ...dispatchOverrides,
  };
  const taskId = overrides.taskId ?? 'automation-run-a-build-1';
  const requestDigest = overrides.requestDigest ?? automationShellRequestDigest({
    taskId,
    ownerClientId: actor.clientId,
    workspaceId: 'workspace-a',
    dispatch,
  });
  return {
    context: {
      runId: 'run-a', milestoneId: 'build', attemptId: 'attempt-a', taskId, requestDigest,
      goalId: 'goal-a', workspaceId: 'workspace-a', ...overrides,
    },
    dispatch,
    role: 'blocking_job',
    cancelWithGoal: true,
    goalLease: { goalId: 'goal-a', leaseToken: 'lease-token-a', leaseGeneration: 1 },
    userConfirmed: true,
  };
}

describe('AutomationRuntimeAdapter', () => {
  it('maps exact task snapshots and treats not-found as absent without crossing actor sessions', async () => {
    const request = dispatchRequest('C:\\workspace-a');
    const registry: AutomationToolRegistryPort = {
      invokeAutomationShell: vi.fn(async () => ({
        content: [],
        structuredContent: { task_id: request.context.taskId, state: 'running', started_at: '2026-09-20T00:00:00.000Z' },
      })),
      observeAutomationShell: vi.fn(async () => err(appError('PROCESS_NOT_FOUND', 'missing'))),
    };
    const adapter = new AutomationRuntimeAdapter(registry, actor, () => new Date('2026-09-20T00:01:00.000Z'));

    await expect(adapter.launch(actor, request)).resolves.toEqual({
      ok: true,
      value: { presence: 'found', state: 'running', observedAt: '2026-09-20T00:00:00.000Z' },
    });
    await expect(adapter.observe(actor, request)).resolves.toEqual({
      ok: true,
      value: { presence: 'absent', observedAt: '2026-09-20T00:01:00.000Z' },
    });
    await expect(adapter.observe({ ...actor, sessionId: 'session-b' }, request))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });

  it('returns bounded task evidence from the exact trusted lookup and never infers success from missing state', async () => {
    const request = dispatchRequest('C:\\workspace-a');
    const observeAutomationShell = vi.fn<AutomationToolRegistryPort['observeAutomationShell']>()
      .mockResolvedValueOnce(ok({
        task_id: request.context.taskId,
        state: 'completed',
        exit_code: 0,
        finished_at: '2026-09-20T00:00:03.000Z',
        stdout: 'not returned as evidence',
      }))
      .mockResolvedValueOnce(ok({ task_id: request.context.taskId, pass: true, text: 'trust me' }));
    const registry: AutomationToolRegistryPort = {
      invokeAutomationShell: vi.fn(async () => ({
        content: [],
        structuredContent: {
          task_id: request.context.taskId,
          state: 'timed_out',
          exit_code: 124,
          finished_at: '2026-09-20T00:00:04.000Z',
        },
      })),
      observeAutomationShell,
    };
    const adapter = new AutomationRuntimeAdapter(registry, actor, () => new Date('2026-09-20T00:01:00.000Z'));

    await expect(adapter.readTask(actor, request)).resolves.toEqual({
      ok: true,
      value: {
        taskId: request.context.taskId,
        ownerClientId: actor.clientId,
        workspaceId: request.context.workspaceId,
        requestDigest: request.context.requestDigest,
        state: 'completed',
        exitCode: 0,
        observedAt: '2026-09-20T00:00:03.000Z',
      },
    });
    await expect(adapter.readTask(actor, request)).resolves.toMatchObject({
      ok: true,
      value: { state: 'unknown' },
    });
    await expect(adapter.ensureTask(actor, request)).resolves.toMatchObject({
      ok: true,
      value: { state: 'timed_out', exitCode: 124 },
    });
  });

  it('dispatches deterministically through ToolRegistry while keeping the reserved context out of the public schema', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-automation-adapter-'));
    roots.push(root);
    await mkdir(path.join(root, '.tasks'), { recursive: true });
    const backend = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory: path.join(root, '.tasks') });
    const capabilities: CapabilityService = {
      execute(tool: CapabilityToolName, input: unknown, signal?: AbortSignal, authorization?: Parameters<ShellCapabilityBackend['execute']>[2]): Promise<Result<unknown>> {
        return tool === 'shell'
          ? backend.execute(input, signal, authorization)
          : Promise.resolve(err(appError('INVALID_INPUT', 'unsupported test capability')));
      },
      observeAutomationShell(ownerClientId, workspaceId, taskId, requestDigest): Promise<Result<unknown>> {
        return backend.statusForAutomation(ownerClientId, workspaceId, taskId, requestDigest);
      },
    };
    const registry = new ToolRegistry({ capabilities, goals }, actor, {
      profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
      activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope> => ({ workspaceId: 'workspace-a', rootPath: root }),
      hostMutationApprovalProvider: async (): Promise<boolean> => true,
    });
    const adapter = new AutomationRuntimeAdapter(registry, actor);
    const request = dispatchRequest(root);

    const schema = JSON.stringify(registry.describeInputJsonSchema('shell'));
    expect(schema).not.toContain('requestDigest');
    expect(schema).not.toContain('milestoneId');
    const publicSpoof = await registry.invoke('shell', {
      workspaceId: 'workspace-a', operation: 'run', task_id: request.context.taskId,
      executable: request.dispatch.executable, arguments: request.dispatch.arguments, cwd: root, userConfirmed: true,
    });
    expect(publicSpoof.isError).toBe(true);

    const first = await adapter.launch(actor, request);
    expect(first).toMatchObject({ ok: true, value: { presence: 'found' } });
    const repeated = await adapter.launch(actor, request);
    expect(repeated).toMatchObject({ ok: true, value: { presence: 'found' } });
    const observed = await adapter.observe(actor, request);
    expect(observed).toMatchObject({ ok: true, value: { presence: 'found' } });

    const changedDispatch = { ...request.dispatch, arguments: ['--version'] };
    const changedDigest = automationShellRequestDigest({
      taskId: request.context.taskId,
      ownerClientId: actor.clientId,
      workspaceId: request.context.workspaceId,
      dispatch: changedDispatch,
    });
    const collision = await adapter.launch(actor, {
      ...request,
      dispatch: changedDispatch,
      context: { ...request.context, requestDigest: changedDigest },
    });
    expect(collision).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

    const terminal = await registry.invoke('shell', {
      workspaceId: 'workspace-a', operation: 'wait', task_id: request.context.taskId,
      timeout_seconds: 5,
    });
    expect(terminal.isError).not.toBe(true);
    expect(terminal.structuredContent).toMatchObject({ state: 'completed', stdout: 'automation-ok' });
  }, 20_000);

  it('reattaches to one exact running task after runtime replacement and reads its terminal receipt without relaunching', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-automation-adapter-restart-'));
    roots.push(root);
    const taskDirectory = path.join(root, '.tasks');
    await mkdir(taskDirectory, { recursive: true });
    const launchMarker = path.join(root, 'payload-launches.txt');
    const request = dispatchRequest(root, {}, {
      arguments: [
        '-e',
        `require('node:fs').appendFileSync(${JSON.stringify(launchMarker)}, 'payload\\n'); setTimeout(() => process.exit(0), 1200)`,
      ],
      includeStdout: false,
      includeStderr: false,
    });

    const compose = (): { registry: ToolRegistry; adapter: AutomationRuntimeAdapter } => {
      const backend = new ShellCapabilityBackend({ allowedRoots: [root], taskStateDirectory: taskDirectory, unrestricted: true });
      const capabilities: CapabilityService = {
        execute(tool: CapabilityToolName, input: unknown, signal?: AbortSignal, authorization?: Parameters<ShellCapabilityBackend['execute']>[2]): Promise<Result<unknown>> {
          return tool === 'shell'
            ? backend.execute(input, signal, authorization)
            : Promise.resolve(err(appError('INVALID_INPUT', 'unsupported test capability')));
        },
        observeAutomationShell(ownerClientId, workspaceId, taskId, requestDigest): Promise<Result<unknown>> {
          return backend.statusForAutomation(ownerClientId, workspaceId, taskId, requestDigest);
        },
      };
      const registry = new ToolRegistry({ capabilities, goals }, actor, {
        profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
        authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
        activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope> => ({ workspaceId: 'workspace-a', rootPath: root }),
        hostMutationApprovalProvider: async (): Promise<boolean> => true,
      });
      return { registry, adapter: new AutomationRuntimeAdapter(registry, actor) };
    };

    const firstRuntime = compose();
    const firstLaunch = await firstRuntime.adapter.launch(actor, request);
    expect(firstLaunch, JSON.stringify(firstLaunch)).toMatchObject({
      ok: true,
      value: { presence: 'found', state: 'running' },
    });

    const replacement = compose();
    await expect(replacement.adapter.observe(actor, request)).resolves.toMatchObject({
      ok: true,
      value: { presence: 'found', state: 'running' },
    });
    await expect(replacement.adapter.launch(actor, request)).resolves.toMatchObject({
      ok: true,
      value: { presence: 'found' },
    });
    const terminal = await replacement.registry.invoke('shell', {
      workspaceId: 'workspace-a', operation: 'wait', task_id: request.context.taskId, timeout_seconds: 5,
    });
    expect(terminal.isError).not.toBe(true);
    expect(terminal.structuredContent).toMatchObject({ state: 'completed', exit_code: 0 });

    const terminalRuntime = compose();
    await expect(terminalRuntime.adapter.observe(actor, request)).resolves.toMatchObject({
      ok: true,
      value: { presence: 'found', state: 'completed', terminalState: 'completed:0' },
    });
    expect((await readFile(launchMarker, 'utf8')).trim().split(/\r?\n/)).toEqual(['payload']);
  }, 20_000);
});
