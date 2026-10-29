import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appError, err, ok, type GoalLeaseProof } from '@lnwjud/domain';
import { FileService, GitService, ProcessService, SearchService, type FileActor } from '@lnwjud/application';
import { permissionProfiles, type PermissionProfile } from '@lnwjud/permissions';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { ToolRegistry, type McpApplicationServices, type ToolRegistryOptions } from './tool-registry.js';

const actor: FileActor = { clientId: 'recipe-client', clientName: 'recipe-test', sessionId: 'recipe-session' };
const directories: string[] = [];
const processes: Array<{ readonly service: ProcessService; readonly workspaceId: string }> = [];

afterEach(async () => {
  for (const entry of processes.splice(0)) {
    const listed = await entry.service.list(actor, entry.workspaceId);
    if (listed.ok) for (const child of listed.value) await entry.service.stop(actor, entry.workspaceId, child.processId, true);
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('checked workflows through registered tools', () => {
  it('observes the live host profile and leaves class-only queries advisory', async () => {
    let profile: PermissionProfile = permissionProfiles.safe;
    let bypass = false;
    const registry = new ToolRegistry({}, actor, {
      profileProvider: (): PermissionProfile => profile,
      authorizationModeProvider: (): 'full_bypass' | 'standard' => bypass ? 'full_bypass' : 'standard',
    });
    expect((await registry.invoke('permission_profile', {})).structuredContent).toMatchObject({
      profile: 'safe', defaults: permissionProfiles.safe.defaults, authorizationMode: 'standard', goalLeaseFenceRemains: true,
    });
    expect((await registry.invoke('permission_check', { action: 'filesystem.read' })).structuredContent)
      .toMatchObject({ decision: 'unknown', advisory: true, sideEffectsStarted: false });
    expect((await registry.invoke('permission_check', { tool: 'read_file', input: { workspaceId: 'a', path: 'a.txt' } })).structuredContent)
      .toMatchObject({ decision: 'allow', profile: 'safe' });
    profile = permissionProfiles.full;
    bypass = true;
    expect((await registry.invoke('permission_profile', {})).structuredContent)
      .toMatchObject({ profile: 'full', defaults: permissionProfiles.full.defaults, authorizationMode: 'full_bypass', operatingSystemAndRemotePolicyRemain: true });
    profile = { ...permissionProfiles.custom, defaults: { ...permissionProfiles.custom.defaults, WRITE: 'DENY' } };
    expect((await registry.invoke('permission_profile', {})).structuredContent)
      .toMatchObject({ profile: 'custom', defaults: { WRITE: 'DENY' }, authorizationMode: 'standard' });
  });

  it('previews exact admission without dispatch, host dialogs, fence mutation or lease heartbeat', async () => {
    const execute = vi.fn(async () => ok({ accepted: true }));
    const approval = vi.fn(async () => true);
    const fence = createFence();
    const registry = new ToolRegistry({ capabilities: { execute }, goalMutationFence: fence }, actor, {
      profileProvider: (): PermissionProfile => permissionProfiles.full,
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
      hostMutationApprovalProvider: approval,
      activeWorkspaceScopeProvider: (): { workspaceId: string; rootPath: string } => ({ workspaceId: 'a', rootPath: 'E:\\a' }),
    });
    const input = { tool: 'shell', input: { workspaceId: 'a', operation: 'run', executable: 'node', arguments: ['--version'] } };
    expect((await registry.invoke('permission_check', input)).structuredContent).toMatchObject({ decision: 'deny', goalLeaseRequired: true });
    expect((await registry.invoke('permission_check', { ...input, input: { ...input.input, goalLease: { ...proof, leaseGeneration: 1 } } })).structuredContent)
      .toMatchObject({ decision: 'deny', goalLeaseRequired: true });
    expect((await registry.invoke('permission_check', { ...input, input: { ...input.input, goalLease: proof } })).structuredContent)
      .toMatchObject({ decision: 'unknown', goalLeaseRequired: true });
    expect(execute).not.toHaveBeenCalled();
    expect(approval).not.toHaveBeenCalled();
    expect(fence.begin).not.toHaveBeenCalled();
    expect(fence.heartbeat).not.toHaveBeenCalled();
    expect(fence.end).not.toHaveBeenCalled();
  });

  it('shares active-project and explicit command workspace refusal with actual dispatch', async () => {
    const execute = vi.fn(async () => ok({ accepted: true }));
    const registry = new ToolRegistry({ capabilities: { execute } }, actor, {
      activeWorkspaceScopesProvider: (): Array<{ workspaceId: string; rootPath: string }> => [{ workspaceId: 'a', rootPath: 'E:\\a' }, { workspaceId: 'b', rootPath: 'E:\\b' }],
    });
    const input = { workspaceId: 'a', operation: 'run', executable: 'node', arguments: ['--version'], cwd: 'E:\\b' };
    expect((await registry.invoke('permission_check', { tool: 'shell', input })).structuredContent)
      .toMatchObject({ decision: 'deny', reason: expect.stringContaining('conflicts') });
    expect(await registry.invoke('shell', input)).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not turn a permission preview or chat confirmation into host approval', async () => {
    const execute = vi.fn(async () => ok({ accepted: true }));
    const approval = vi.fn(async () => false);
    const registry = new ToolRegistry({ capabilities: { execute } }, actor, { hostMutationApprovalProvider: approval });
    const input = { action: 'set_text', text: 'fixture text', userConfirmed: true };
    expect((await registry.invoke('permission_check', { tool: 'clipboard', input })).structuredContent)
      .toMatchObject({ decision: 'ask', hostApprovalRequired: true, sideEffectsStarted: false });
    expect(approval).not.toHaveBeenCalled();
    expect(await registry.invoke('clipboard', input)).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    expect(approval).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects unknown recipes and all invalid step arguments before any child executes', async () => {
    const execute = vi.fn(async () => ok({ accepted: true }));
    const registry = new ToolRegistry({ capabilities: { execute } }, actor);
    for (const name of ['recipe_run', 'recipe_describe']) {
      expect(await registry.invoke(name, { name: 'unknown-recipe' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    }
    for (const stepArguments of [
      { shell: { executable: 'node' } },
      { benchmark_run: { imaginary: true } },
      { benchmark_run: { goalLease: proof } },
      { benchmark_run: { workspaceId: 'foreign' } },
    ]) {
      expect(await registry.invoke('recipe_run', { name: 'release-check', workspaceId: 'a', dryRun: false, stepArguments }))
        .toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(registry.listInFlight()).toHaveLength(0);
  });

  // macOS 26.1 lacks kernel-owned containment for escaped descendants.
  // Exercise its denial explicitly; the real-launch recipes below are
  // applicable only on hosts with enforceable process-writer containment.
  it.skipIf(process.platform !== 'darwin')('denies macOS recipe benchmark execution before starting a child', async () => {
    const fixture = await createFixture();
    const registry = new ToolRegistry(fixture.services, actor, fixture.options);
    const result = await registry.invoke('recipe_run', {
      name: 'release-check', workspaceId: fixture.workspace.id, dryRun: false,
    });
    expect(result.structuredContent).toMatchObject({
      status: 'failed', executed: true, sideEffectsStarted: 'unknown',
      steps: [
        { tool: 'git_context', status: 'completed' },
        { tool: 'regression_report', status: 'completed' },
        { tool: 'benchmark_run', status: 'failed',
          response: { structuredContent: { error: { code: 'CONFLICT', message: expect.stringContaining('macOS process writer containment') } } } },
      ],
    });
    expect(await fixture.process.list(actor, fixture.workspace.id)).toMatchObject({ ok: true, value: [] });
    await expect(readFile(path.join(fixture.directory, 'benchmark-result.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'darwin')('defaults to preview and launches the real controlled benchmark only when dryRun is false', async () => {
    const fixture = await createFixture();
    const registry = new ToolRegistry(fixture.services, actor, fixture.options);
    const input = { name: 'release-check', workspaceId: fixture.workspace.id, prompt: 'fixture' };
    expect((await registry.invoke('recipe_run', input)).structuredContent).toMatchObject({
      status: 'planned', dryRun: true, executed: false, sideEffectsStarted: false,
      steps: [{ tool: 'git_context', status: 'planned' }, { tool: 'regression_report', status: 'planned' }, { tool: 'benchmark_run', status: 'planned' }],
    });
    expect(await fixture.process.list(actor, fixture.workspace.id)).toMatchObject({ ok: true, value: [] });
    await expect(readFile(path.join(fixture.directory, 'benchmark-result.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const run = await registry.invoke('recipe_run', { ...input, dryRun: false });
    expect(run.structuredContent).toMatchObject({ status: 'completed', dryRun: false, executed: true, sideEffectsStarted: true,
      steps: [{ tool: 'git_context', status: 'completed' }, { tool: 'regression_report', status: 'completed' },
        { tool: 'benchmark_run', status: 'completed', response: { structuredContent: { dryRun: false, started: true, process: { state: 'running' } } } }],
    });
    await vi.waitFor(async () => {
      expect(await readFile(path.join(fixture.directory, 'benchmark-result.txt'), 'utf8')).toBe('  ผลทดสอบ 😀  \n');
      const listed = await fixture.process.list(actor, fixture.workspace.id);
      expect(listed).toMatchObject({ ok: true, value: [{ state: 'exited', exitCode: 0 }] });
    }, { timeout: 10_000, interval: 25 });
  }, 15_000);

  it('rechecks changed host policy for every child and keeps completed receipts and the skipped remainder', async () => {
    const fixture = await createFixture();
    let profile: PermissionProfile = permissionProfiles.full;
    const originalStatus = fixture.git.status.bind(fixture.git);
    vi.spyOn(fixture.git, 'status').mockImplementation(async (...args) => {
      const response = await originalStatus(...args);
      profile = { ...permissionProfiles.custom, defaults: { ...permissionProfiles.custom.defaults, READ: 'DENY' } };
      return response;
    });
    const registry = new ToolRegistry(fixture.services, actor, { profileProvider: (): PermissionProfile => profile });
    const response = await registry.invoke('recipe_run', { name: 'release-check', workspaceId: fixture.workspace.id, dryRun: false });
    expect(response.structuredContent).toMatchObject({ status: 'failed', steps: [
      { tool: 'git_context', status: 'completed', response: { structuredContent: { git: { entries: expect.any(Array) } } } },
      { tool: 'regression_report', status: 'failed', response: { isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } } },
      { tool: 'benchmark_run', status: 'skipped' },
    ] });
    expect(await fixture.process.list(actor, fixture.workspace.id)).toMatchObject({ ok: true, value: [] });
  });

  it.skipIf(process.platform === 'darwin')('keeps Full Bypass recipe children fenced and hands the current proof to checked benchmark dispatch', async () => {
    const fixture = await createFixture();
    const fence = createFence();
    const registry = new ToolRegistry({ ...fixture.services, goalMutationFence: fence }, actor, fixture.options);
    const input = { name: 'release-check', workspaceId: fixture.workspace.id, dryRun: false };
    const denied = await registry.invoke('recipe_run', input);
    expect(denied.structuredContent).toMatchObject({ status: 'failed', steps: [
      { status: 'completed' }, { status: 'completed' },
      { tool: 'benchmark_run', status: 'failed', response: { structuredContent: { error: { code: 'CONFLICT' } } } },
    ] });
    expect(fence.begin).not.toHaveBeenCalled();
    expect(await fixture.process.list(actor, fixture.workspace.id)).toMatchObject({ ok: true, value: [] });
    const admitted = await registry.invoke('recipe_run', { ...input, goalLease: proof });
    expect(admitted.structuredContent).toMatchObject({ status: 'completed' });
    expect(fence.begin).toHaveBeenCalledTimes(1);
    expect(fence.begin.mock.calls[0]?.[3]).toEqual(proof);
    expect(fence.end).toHaveBeenCalledTimes(1);
    // benchmark_run starts a managed process; wait for its terminal receipt before fixture teardown.
    // Stopping a root that exits during Windows tree-kill can leave termination unverified.
    await vi.waitFor(async () => {
      const listed = await fixture.process.list(actor, fixture.workspace.id);
      expect(listed.ok && listed.value.some((child) => child.state === 'exited')).toBe(true);
    }, { timeout: 5000 });
  }, 15_000);

  it('stops the recipe after a child reports unavailable and retains the exact response', async () => {
    const registry = new ToolRegistry({}, actor);
    const response = await registry.invoke('recipe_run', { name: 'release-check', workspaceId: 'missing', dryRun: false });
    expect(response.structuredContent).toMatchObject({ status: 'unavailable', steps: [
      { tool: 'git_context', status: 'unavailable', response: { structuredContent: { available: false, status: 'needs_setup', requirements: expect.any(Array) } } },
      { tool: 'regression_report', status: 'skipped' }, { tool: 'benchmark_run', status: 'skipped' },
    ] });
  });

  it('returns prior receipts and the unstarted remainder when cancellation interrupts a child', async () => {
    const fixture = await createFixture();
    let release!: () => void;
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const status = fixture.git.status.bind(fixture.git);
    let calls = 0;
    vi.spyOn(fixture.git, 'status').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 3) {
        entered();
        await holding;
      }
      return status(...args);
    });
    const registry = new ToolRegistry(fixture.services, actor, fixture.options);
    const controller = new AbortController();
    const running = registry.invoke('recipe_run', { name: 'bugfix', workspaceId: fixture.workspace.id, dryRun: false }, undefined, controller.signal);
    try {
      await ready;
      controller.abort();
      const response = await running;
      expect(response.structuredContent).toMatchObject({ status: 'cancelled', steps: [
        { tool: 'workspace_context', status: 'completed', response: { structuredContent: { matchedFiles: 2 } } },
        { tool: 'git_context', status: 'cancellation_requested' },
        { tool: 'test_context', status: 'skipped' },
        { tool: 'live_logs_query', status: 'skipped' },
      ] });
      expect(await fixture.process.list(actor, fixture.workspace.id)).toMatchObject({ ok: true, value: [] });
    } finally {
      release();
      await vi.waitFor(() => expect(registry.listInFlight()).toHaveLength(0));
    }
  });

  it('preserves the prepared Engineering binding for child admission instead of running a raw child', async () => {
    const fixture = await createFixture();
    const unavailable = async (): Promise<ReturnType<typeof err>> => err(appError('INTERNAL_ERROR', 'Unexpected Goal operation'));
    const goals: NonNullable<McpApplicationServices['goals']> = {
      runGoal: unavailable, getGoal: unavailable, validateGoalLease: unavailable, updateGoalPlan: unavailable,
      updateGoalAcceptance: unavailable, reviseGoalIntent: unavailable, createContextCapsule: unavailable,
      getContextCapsule: unavailable, listContextCapsules: unavailable, recordDeliveryReceipt: unavailable,
      listDeliveryReceipts: unavailable, advanceGoalIteration: unavailable, checkpointGoal: unavailable,
      finishGoal: unavailable, cancelGoal: unavailable, reconcileGoals: unavailable, listGoals: unavailable,
    };
    const prepare = vi.fn(async (_workspaceId: string, objective: string) => err(appError('ENGINEERING_POLICY_CHANGED', `Observed prepared objective ${objective}`, true)));
    const registry = new ToolRegistry({ ...fixture.services, goals, engineeringPreparation: { prepare } }, actor, fixture.options);
    const response = await registry.invoke('recipe_run', {
      name: 'release-check', workspaceId: fixture.workspace.id, dryRun: false,
      engineeringTask: { objective: 'Approved release fixture', policyDigest: 'old-digest', primaryTaskKind: 'release', riskTier: 'high', deliveryScope: 'release', sessionId: actor.sessionId },
    });
    expect(response.structuredContent).toMatchObject({ status: 'failed', steps: [
      { status: 'completed' }, { status: 'completed' },
      { tool: 'benchmark_run', status: 'failed', response: { structuredContent: { error: { code: 'ENGINEERING_POLICY_CHANGED', message: 'Observed prepared objective Approved release fixture' } } } },
    ] });
    expect(prepare).toHaveBeenCalledWith(fixture.workspace.id, 'Approved release fixture', undefined);
    expect(await fixture.process.list(actor, fixture.workspace.id)).toMatchObject({ ok: true, value: [] });
  });
});

const proof: GoalLeaseProof = { goalId: 'recipe-goal', leaseToken: 'current-proof', leaseGeneration: 7 };

function createFence(): NonNullable<McpApplicationServices['goalMutationFence']> & { readonly begin: ReturnType<typeof vi.fn<NonNullable<McpApplicationServices['goalMutationFence']>['begin']>> } {
  return {
    inspectWorkspaceFence: vi.fn(async () => ok({ goalId: proof.goalId, leaseGeneration: proof.leaseGeneration })),
    begin: vi.fn(async (_actor, _workspaceId, _callId, received: GoalLeaseProof) => received.leaseToken === proof.leaseToken
      ? ok({ goalId: received.goalId, leaseGeneration: received.leaseGeneration }) : err(appError('CONFLICT', 'Stale lease token', true))),
    heartbeat: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    observe: vi.fn(async () => { throw new Error('Unexpected liveness mutation observation'); }),
  };
}

async function createFixture(): Promise<{ directory: string; workspace: Workspace; services: McpApplicationServices; options: ToolRegistryOptions; process: ProcessService; git: GitService }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-checked-recipe-'));
  directories.push(directory);
  const root = await realpath(directory);
  const workspace: Workspace = { id: 'recipe-workspace', displayName: 'Recipe fixture', rootPath: root, realRootPath: root, createdAt: new Date().toISOString() };
  const workspaces = new Map([[workspace.id, workspace]]);
  const repository: WorkspaceRepository = {
    async list() { return [...workspaces.values()]; },
    async get(id) { return workspaces.get(id) ?? null; },
    async insert(value) { workspaces.set(value.id, value); },
    async delete(id) { workspaces.delete(id); },
  };
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.15.0', scripts: { benchmark: 'node fixture.mjs' } }));
  await writeFile(path.join(root, 'fixture.mjs'), "import { writeFile } from 'node:fs/promises'; await writeFile('benchmark-result.txt', '  ผลทดสอบ 😀  \\n');\n");
  await promisify(execFile)('git', ['init', '--quiet', root], { windowsHide: true });
  const file = new FileService(repository);
  const git = new GitService(repository);
  const process = new ProcessService(repository);
  processes.push({ service: process, workspaceId: workspace.id });
  const search = new SearchService(repository);
  const services: McpApplicationServices = { file, git, process, search };
  const options: ToolRegistryOptions = { profileProvider: (): PermissionProfile => permissionProfiles.full, authorizationModeProvider: (): 'full_bypass' => 'full_bypass' };
  return { directory: root, workspace, services, options, process, git };
}
