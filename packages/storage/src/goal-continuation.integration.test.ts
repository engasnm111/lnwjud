import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GoalContinuationService } from '@lnwjud/application';
import { ScheduledContinuationService } from '@lnwjud/application';
import type { FileActor, GoalRequestCancellationPort, GoalTaskCancellationPort } from '@lnwjud/application';
import type { Workspace } from '@lnwjud/workspace';
import { SqliteDatabase } from './database.js';
import { SqliteGoalRepository } from './goal-repository.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; filename: string; workspace: Workspace }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-goal-'));
  temporaryRoots.push(root);
  return {
    root,
    filename: path.join(root, 'state.sqlite'),
    workspace: {
      id: 'workspace-1',
      displayName: 'Fixture',
      rootPath: root,
      realRootPath: root,
      createdAt: '2026-08-26T00:00:00.000Z',
    },
  };
}

async function open(
  filename: string,
  workspace: Workspace,
  now: () => Date,
  taskCancellation?: GoalTaskCancellationPort,
  requestCancellation?: GoalRequestCancellationPort,
): Promise<{
  database: SqliteDatabase;
  workspaces: SqliteWorkspaceRepository;
  repository: SqliteGoalRepository;
  service: GoalContinuationService;
  scheduledService: ScheduledContinuationService;
}> {
  const database = new SqliteDatabase(filename);
  const workspaces = new SqliteWorkspaceRepository(database);
  if (await workspaces.get(workspace.id) === null) await workspaces.insert(workspace);
  const repository = new SqliteGoalRepository(database);
  const scheduledService = new ScheduledContinuationService(repository, { now });
  const service = new GoalContinuationService(workspaces, repository, {
    now,
    scheduledContinuations: repository,
    ...(taskCancellation === undefined ? {} : { taskCancellation }),
    ...(requestCancellation === undefined ? {} : { requestCancellation }),
  });
  return { database, workspaces, repository, service, scheduledService };
}

const actor = (sessionId: string, clientId = 'chatgpt-web-client'): FileActor => ({
  clientId,
  clientName: 'ChatGPT Web',
  sessionId,
});

const createRequest = {
  workspaceId: 'workspace-1',
  goalKey: 'release-v4.11-goal',
  objective: 'Finish the durable continuation implementation safely.',
  plan: {
    steps: [
      { id: 'implement', title: 'Implement typed persistence' },
      { id: 'verify', title: 'Run verification' },
    ],
  },
  leaseSeconds: 60,
} as const;

describe('durable goal continuation persistence', () => {
  it('creates once, is idempotent by workspace + goalKey, and resumes after a runtime/database restart', async () => {
    const { filename, workspace } = await fixture();
    let now = new Date('2026-08-26T00:00:00.000Z');
    const first = await open(filename, workspace, () => now);
    const created = await first.service.runGoal(actor('session-a'), createRequest);
    expect(created).toMatchObject({ ok: true, value: { acquired: true, goalKey: createRequest.goalKey, revision: 0 } });
    if (!created.ok) throw new Error('goal create failed');
    const goalId = created.value.goalId;
    const leaseToken = created.value.leaseToken;
    expect(leaseToken).toEqual(expect.any(String));

    const duplicate = await first.service.runGoal(actor('session-a'), createRequest);
    expect(duplicate).toMatchObject({ ok: true, value: { acquired: false, goalId, retryAfterSeconds: expect.any(Number) } });
    expect((await first.repository.list({ ownerClientId: actor('session-a').clientId, workspaceId: workspace.id, limit: 20 }))).toHaveLength(1);
    first.database.close();

    now = new Date('2026-08-26T00:01:01.000Z');
    const second = await open(filename, workspace, () => now);
    const resumed = await second.service.runGoal(actor('session-b'), { workspaceId: workspace.id, goalKey: createRequest.goalKey, leaseSeconds: 60 });
    expect(resumed).toMatchObject({ ok: true, value: { acquired: true, goalId, revision: 0 } });
    expect(resumed.ok && resumed.value.leaseToken).not.toBe(leaseToken);
    second.database.close();
  });

  it('uses stable client ownership across session changes and rejects a different client or workspace for an existing goal', async () => {
    const { filename, workspace, root } = await fixture();
    let now = new Date('2026-08-26T00:00:00.000Z');
    const runtime = await open(filename, workspace, () => now);
    const otherWorkspace: Workspace = {
      id: 'workspace-2', displayName: 'Other', rootPath: path.join(root, 'other'), realRootPath: path.join(root, 'other'), createdAt: workspace.createdAt,
    };
    await runtime.workspaces.insert(otherWorkspace);
    const created = await runtime.service.runGoal(actor('session-a'), createRequest);
    if (!created.ok) throw new Error('goal create failed');

    now = new Date('2026-08-26T00:01:01.000Z');
    await expect(runtime.service.runGoal(actor('session-b'), { workspaceId: workspace.id, goalKey: createRequest.goalKey })).resolves.toMatchObject({
      ok: true,
      value: { goalId: created.value.goalId, acquired: true },
    });
    await expect(runtime.service.runGoal(actor('other-session', 'other-client'), { workspaceId: workspace.id, goalKey: createRequest.goalKey })).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    });
    await expect(runtime.service.getGoal(actor('other-session', 'other-client'), { goalId: created.value.goalId })).resolves.toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    });
    await expect(runtime.service.getGoal(actor('session-b'), { workspaceId: otherWorkspace.id, goalKey: createRequest.goalKey })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    runtime.database.close();
  });

  it('allows only one concurrent lease winner and permits takeover only after expiry', async () => {
    const { filename, workspace } = await fixture();
    let now = new Date('2026-08-26T00:00:00.000Z');
    const first = await open(filename, workspace, () => now);
    const initial = await first.service.runGoal(actor('creator'), createRequest);
    if (!initial.ok || initial.value.leaseToken === undefined) throw new Error('goal create failed');
    await first.service.checkpointGoal(actor('creator'), {
      goalId: initial.value.goalId,
      leaseToken: initial.value.leaseToken,
      expectedRevision: initial.value.revision,
      currentPhase: 'ready',
      summary: 'Ready for the next scheduled turn.',
      stepUpdates: [],
      nextAction: 'Acquire the next lease.',
      blockers: [],
      evidence: [],
      activeTaskIds: [],
      releaseLease: true,
    });

    const second = await open(filename, workspace, () => now);
    const [left, right] = await Promise.all([
      first.service.runGoal(actor('scheduled-a'), { workspaceId: workspace.id, goalKey: createRequest.goalKey, leaseSeconds: 30 }),
      second.service.runGoal(actor('scheduled-b'), { workspaceId: workspace.id, goalKey: createRequest.goalKey, leaseSeconds: 30 }),
    ]);
    const winners = [left, right].filter((entry) => entry.ok && entry.value.acquired);
    expect(winners).toHaveLength(1);
    expect([left, right].filter((entry) => entry.ok && !entry.value.acquired)).toHaveLength(1);

    const held = await first.service.runGoal(actor('scheduled-c'), { workspaceId: workspace.id, goalKey: createRequest.goalKey, leaseSeconds: 30 });
    expect(held).toMatchObject({ ok: true, value: { acquired: false, retryAfterSeconds: expect.any(Number) } });
    now = new Date('2026-08-26T00:00:31.000Z');
    const takeover = await first.service.runGoal(actor('scheduled-d'), { workspaceId: workspace.id, goalKey: createRequest.goalKey, leaseSeconds: 30 });
    expect(takeover).toMatchObject({ ok: true, value: { acquired: true } });
    first.database.close();
    second.database.close();
  });

  it('enforces CAS revisions, renews the lease, and persists append-only checkpoint history plus active task IDs across restart', async () => {
    const { filename, workspace } = await fixture();
    let now = new Date('2026-08-26T00:00:00.000Z');
    const first = await open(filename, workspace, () => now);
    const created = await first.service.runGoal(actor('session-a'), createRequest);
    if (!created.ok || created.value.leaseToken === undefined) throw new Error('goal create failed');

    now = new Date('2026-08-26T00:00:20.000Z');
    const checkpointed = await first.service.checkpointGoal(actor('session-a'), {
      goalId: created.value.goalId,
      leaseToken: created.value.leaseToken,
      expectedRevision: 0,
      currentPhase: 'implementation',
      summary: 'Repository migration is implemented.',
      stepUpdates: [{ stepId: 'implement', status: 'completed', summary: 'SQLite CAS is in place.' }],
      nextAction: 'Check existing background task before starting verification.',
      blockers: [],
      evidence: [{ kind: 'path', value: 'packages/storage/src/goal-repository.ts' }],
      activeTaskIds: ['durable-task-123'],
    });
    expect(checkpointed).toMatchObject({
      ok: true,
      value: { revision: 1, activeTaskIds: ['durable-task-123'], leaseExpiresAt: '2026-08-26T00:01:20.000Z' },
    });

    await expect(first.service.checkpointGoal(actor('session-a'), {
      goalId: created.value.goalId,
      leaseToken: created.value.leaseToken,
      expectedRevision: 0,
      currentPhase: 'stale',
      summary: 'This stale turn must not win.',
      stepUpdates: [],
      nextAction: 'none',
      blockers: [],
      evidence: [],
      activeTaskIds: [],
    })).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT', recoverable: true } });
    first.database.close();

    const second = await open(filename, workspace, () => now);
    const snapshot = await second.service.getGoal(actor('session-b'), { goalId: created.value.goalId });
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        revision: 1,
        activeTaskIds: ['durable-task-123'],
        completedSteps: [expect.objectContaining({ id: 'implement' })],
        lastCheckpoint: expect.objectContaining({ revision: 1, summary: 'Repository migration is implemented.' }),
      },
    });
    const persisted = await second.repository.getById(created.value.goalId);
    expect(persisted?.checkpoints).toHaveLength(1);
    expect(persisted?.checkpoints[0]).toMatchObject({ revision: 1, summary: 'Repository migration is implemented.' });
    second.database.close();
  });

  it('keeps terminal goals terminal and never reopens them through runGoal', async () => {
    const { filename, workspace } = await fixture();
    const runtime = await open(filename, workspace, () => new Date('2026-08-26T00:00:00.000Z'));
    const created = await runtime.service.runGoal(actor('session-a'), createRequest);
    if (!created.ok || created.value.leaseToken === undefined) throw new Error('goal create failed');
    const finished = await runtime.service.finishGoal(actor('session-a'), {
      goalId: created.value.goalId,
      leaseToken: created.value.leaseToken,
      expectedRevision: created.value.revision,
      status: 'completed',
      summary: 'All acceptance criteria passed.',
      evidence: [{ kind: 'hash', value: 'sha256:abc123' }],
    });
    expect(finished).toMatchObject({ ok: true, value: { status: 'completed', revision: 1 } });

    const rerun = await runtime.service.runGoal(actor('session-b'), { workspaceId: workspace.id, goalKey: createRequest.goalKey });
    expect(rerun).toMatchObject({ ok: true, value: { status: 'completed', acquired: false, goalId: created.value.goalId } });
    expect(rerun.ok && 'leaseToken' in rerun.value).toBe(false);
    runtime.database.close();
  });

  it('fails closed on corrupted authoritative state and never stores raw lease tokens or sensitive checkpoint text', async () => {
    const { filename, workspace } = await fixture();
    const runtime = await open(filename, workspace, () => new Date('2026-08-26T00:00:00.000Z'));
    const created = await runtime.service.runGoal(actor('session-a'), createRequest);
    if (!created.ok || created.value.leaseToken === undefined) throw new Error('goal create failed');
    const secret = 'sk-test-SUPERSECRET0123456789';
    const leaseRow = runtime.database.connection.prepare('SELECT lease_token_hash FROM goals WHERE id = ?').get(created.value.goalId);
    expect(JSON.stringify(leaseRow)).not.toContain(created.value.leaseToken);
    expect(JSON.stringify(leaseRow)).toMatch(/[a-f0-9]{64}/);

    const checkpointed = await runtime.service.checkpointGoal(actor('session-a'), {
      goalId: created.value.goalId,
      leaseToken: created.value.leaseToken,
      expectedRevision: created.value.revision,
      currentPhase: 'verification',
      summary: `Verification key ${secret} must never persist.`,
      stepUpdates: [],
      nextAction: `Do not print ${secret}`,
      blockers: [`token=${secret}`],
      evidence: [{ kind: 'note', value: `Authorization: Bearer ${secret}` }],
      activeTaskIds: ['task-safe-id'],
    });
    expect(JSON.stringify(checkpointed)).not.toContain(secret);
    const raw = runtime.database.connection.prepare('SELECT summary, next_action, blockers_json, evidence_json FROM goal_checkpoints WHERE goal_id = ?').get(created.value.goalId);
    expect(JSON.stringify(raw)).not.toContain(secret);

    runtime.database.connection.prepare('UPDATE goals SET plan_json = ? WHERE id = ?').run('{broken-json', created.value.goalId);
    await expect(runtime.service.getGoal(actor('session-a'), { goalId: created.value.goalId })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR' },
    });
    runtime.database.close();
  }, 20_000);

  it('simulates a dead turn and resumes the same active task after lease expiry without repeating the mutation', async () => {
    const { filename, workspace } = await fixture();
    let now = new Date('2026-08-26T00:00:00.000Z');
    let mutationCount = 0;
    const first = await open(filename, workspace, () => now);
    const created = await first.service.runGoal(actor('timed-out-session'), { ...createRequest, leaseSeconds: 30 });
    if (!created.ok || created.value.leaseToken === undefined) throw new Error('goal create failed');
    if (!created.value.activeTaskIds.includes('task-long-1')) mutationCount += 1;
    const checkpointed = await first.service.checkpointGoal(actor('timed-out-session'), {
      goalId: created.value.goalId,
      leaseToken: created.value.leaseToken,
      expectedRevision: 0,
      currentPhase: 'long-test',
      summary: 'Started one durable verification task before the turn expired.',
      stepUpdates: [],
      nextAction: 'Inspect task-long-1 status; do not start a duplicate command.',
      blockers: [],
      evidence: [{ kind: 'task', value: 'task-long-1' }],
      activeTaskIds: ['task-long-1'],
    });
    expect(checkpointed).toMatchObject({ ok: true, value: { revision: 1 } });
    first.database.close();

    now = new Date('2026-08-26T00:00:31.000Z');
    const second = await open(filename, workspace, () => now);
    const resumed = await second.service.runGoal(actor('scheduled-next-session'), { workspaceId: workspace.id, goalKey: createRequest.goalKey, leaseSeconds: 30 });
    expect(resumed).toMatchObject({
      ok: true,
      value: {
        acquired: true,
        goalId: created.value.goalId,
        revision: 1,
        activeTaskIds: ['task-long-1'],
        nextAction: 'Inspect task-long-1 status; do not start a duplicate command.',
      },
    });
    if (resumed.ok && !resumed.value.activeTaskIds.includes('task-long-1')) mutationCount += 1;
    expect(mutationCount).toBe(1);
    const listed = await second.service.listGoals(actor('scheduled-next-session'), { workspaceId: workspace.id, limit: 20 });
    expect(listed).toMatchObject({ ok: true, value: { goals: [expect.objectContaining({ goalId: created.value.goalId })] } });
    second.database.close();
  });

  it('persists goal-relative task roles and provider bindings across restart', async () => {
    const { filename, workspace } = await fixture();
    const now = new Date('2026-08-26T00:00:00.000Z');
    const first = await open(filename, workspace, () => now);
    const created = await first.service.runGoal(actor('session-a'), createRequest);
    if (!created.ok || created.value.leaseToken === undefined) throw new Error('goal create failed');
    const trackedTasks = [
      { taskId: 'verification-job', provider: 'shell' as const, role: 'blocking_job' as const, cancelWithGoal: true },
      { taskId: 'xampp-mariadb', provider: 'process' as const, role: 'supporting_service' as const, cancelWithGoal: false },
    ];
    const checkpointed = await first.service.checkpointGoal(actor('session-a'), {
      goalId: created.value.goalId,
      leaseToken: created.value.leaseToken,
      expectedRevision: 0,
      currentPhase: 'verification',
      summary: 'Track the bounded job separately from the shared database service.',
      stepUpdates: [],
      nextAction: 'Wait for the verification job.',
      blockers: [],
      evidence: [],
      trackedTasks,
    });
    expect(checkpointed).toMatchObject({
      ok: true,
      value: { activeTaskIds: ['verification-job'], trackedTasks },
    });
    first.database.close();

    const second = await open(filename, workspace, () => now);
    try {
      await expect(second.service.getGoal(actor('session-b'), { goalId: created.value.goalId })).resolves.toMatchObject({
        ok: true,
        value: { activeTaskIds: ['verification-job'], trackedTasks },
      });
      const raw = second.database.connection.prepare('SELECT tracked_tasks_json, active_task_ids_json FROM goals WHERE id = ?').get(created.value.goalId);
      expect(raw).toMatchObject({ tracked_tasks_json: JSON.stringify(trackedTasks), active_task_ids_json: JSON.stringify(['verification-job']) });
    } finally {
      second.database.close();
    }
  });

  it('does not cancel a shared supporting service when cancelling a goal', async () => {
    const { filename, workspace } = await fixture();
    const now = new Date('2026-08-26T00:00:00.000Z');
    const calls: string[] = [];
    const taskCancellation: GoalTaskCancellationPort = {
      async cancelForGoal(_ownerClientId, _workspaceId, tasks) {
        return tasks.map((task) => {
          const taskId = typeof task === 'string' ? task : task.taskId;
          calls.push(taskId);
          return { taskId, status: 'cancelled' as const, providers: [] };
        });
      },
    };
    const runtime = await open(filename, workspace, () => now, taskCancellation);
    try {
      const created = await runtime.service.runGoal(actor('session-a'), createRequest);
      if (!created.ok || created.value.leaseToken === undefined) throw new Error('goal create failed');
      await runtime.service.checkpointGoal(actor('session-a'), {
        goalId: created.value.goalId,
        leaseToken: created.value.leaseToken,
        expectedRevision: 0,
        currentPhase: 'verification',
        summary: 'Keep the shared database service alive.',
        stepUpdates: [],
        nextAction: 'Cancel only goal-owned work.',
        blockers: [],
        evidence: [],
        trackedTasks: [
          { taskId: 'owned-job', provider: 'shell', role: 'blocking_job', cancelWithGoal: true },
          { taskId: 'shared-db', provider: 'process', role: 'supporting_service', cancelWithGoal: false },
        ],
      });
      const cancelled = await runtime.service.cancelGoal(actor('session-b'), {
        goalId: created.value.goalId,
        expectedRevision: 1,
        summary: 'Stop the goal-owned job.',
        evidence: [],
      });
      expect(cancelled).toMatchObject({
        ok: true,
        value: {
          trackedTaskIds: ['owned-job', 'shared-db'],
          trackedTasks: [
            { taskId: 'owned-job', provider: 'shell', role: 'blocking_job', cancelWithGoal: true },
            { taskId: 'shared-db', provider: 'process', role: 'supporting_service', cancelWithGoal: false },
          ],
          taskCancellations: [
            { taskId: 'owned-job', status: 'cancelled' },
            { taskId: 'shared-db', status: 'skipped', error: 'Task remains running because cancelWithGoal=false' },
          ],
          allTasksStopped: false,
        },
      });
      expect(calls).toEqual(['owned-job']);
      expect((await runtime.repository.getById(created.value.goalId))?.checkpoints.at(-1)).toMatchObject({
        trackedTasks: [
          { taskId: 'owned-job', provider: 'shell', role: 'blocking_job', cancelWithGoal: true },
          { taskId: 'shared-db', provider: 'process', role: 'supporting_service', cancelWithGoal: false },
        ],
      });
    } finally {
      runtime.database.close();
    }
  });

  it('cancels an active goal after lease expiry and stops every legacy-tracked task across session boundaries', async () => {
    const { filename, workspace } = await fixture();
    let now = new Date('2026-08-26T00:00:00.000Z');
    const calls: Array<{ ownerClientId: string; workspaceId: string; taskId: string }> = [];
    const taskCancellation: GoalTaskCancellationPort = {
      async cancelForGoal(ownerClientId, workspaceId, taskIds) {
        return taskIds.map((taskId) => {
          calls.push({ ownerClientId, workspaceId, taskId });
          return { taskId, status: 'cancelled' as const, providers: [] };
        });
      },
    };
    const requestCancellations: string[] = [];
    const requestCancellation: GoalRequestCancellationPort = {
      register: () => ({ accepted: true, done: Promise.resolve(), release: () => undefined }),
      async cancelForGoal(goalId) {
        requestCancellations.push(goalId);
        return { goalId, requested: 1, stopped: 1, remaining: 0, timedOut: false, requestIds: ['call-live'] };
      },
    };
    const runtime = await open(filename, workspace, () => now, taskCancellation, requestCancellation);
    try {
      const created = await runtime.service.runGoal(actor('session-a'), { ...createRequest, leaseSeconds: 30 });
      if (!created.ok || created.value.leaseToken === undefined) throw new Error('goal create failed');
      const checkpointed = await runtime.service.checkpointGoal(actor('session-a'), {
      goalId: created.value.goalId,
      leaseToken: created.value.leaseToken,
      expectedRevision: created.value.revision,
      currentPhase: 'running',
      summary: 'Three managed tasks are still tracked.',
      stepUpdates: [],
      nextAction: 'Cancel all tracked work.',
      blockers: [],
      evidence: [],
      activeTaskIds: ['process-task', 'codex-task', 'shell-task'],
      });
      expect(checkpointed).toMatchObject({ ok: true, value: { revision: 1 } });

      now = new Date('2026-08-26T00:00:31.000Z');
      const cancelled = await runtime.service.cancelGoal(actor('session-b'), {
        goalId: created.value.goalId,
        expectedRevision: 1,
        summary: 'User cancelled the goal and all tracked background work.',
        evidence: [{ kind: 'note', value: 'manual cancellation' }],
      });
      expect(cancelled).toMatchObject({
      ok: true,
      value: {
        status: 'cancelled',
        revision: 2,
        activeTaskIds: [],
        trackedTaskIds: ['process-task', 'codex-task', 'shell-task'],
        allTasksStopped: true,
        allRequestsStopped: true,
        requestCancellation: {
          goalId: created.value.goalId,
          requested: 1,
          stopped: 1,
          remaining: 0,
          timedOut: false,
          requestIds: ['call-live'],
        },
        taskCancellations: [
          { taskId: 'process-task', status: 'cancelled' },
          { taskId: 'codex-task', status: 'cancelled' },
          { taskId: 'shell-task', status: 'cancelled' },
        ],
      },
      });
      expect(calls).toEqual([
      { ownerClientId: 'chatgpt-web-client', workspaceId: 'workspace-1', taskId: 'process-task' },
      { ownerClientId: 'chatgpt-web-client', workspaceId: 'workspace-1', taskId: 'codex-task' },
      { ownerClientId: 'chatgpt-web-client', workspaceId: 'workspace-1', taskId: 'shell-task' },
      ]);
      expect(requestCancellations).toEqual([created.value.goalId]);
      expect(await runtime.repository.getById(created.value.goalId)).toMatchObject({ status: 'cancelled', activeTaskIds: [] });
      expect((await runtime.repository.getById(created.value.goalId))?.checkpoints.at(-1)).toMatchObject({
        revision: 2,
        activeTaskIds: ['process-task', 'codex-task', 'shell-task'],
      });
    } finally {
      runtime.database.close();
    }
  });

  it('marks a pending successor for host cancellation and makes an obsolete wake terminal_noop after goal cancellation', async () => {
    const { filename, workspace } = await fixture();
    let now = new Date('2026-08-26T00:00:00.000Z');
    const runtime = await open(filename, workspace, () => now);
    try {
      const created = await runtime.service.runGoal(actor('session-a'), { ...createRequest, leaseSeconds: 600 });
      if (!created.ok || created.value.leaseToken === undefined) throw new Error('goal create failed');
      const prepared = await runtime.scheduledService.prepareScheduledContinuation(actor('session-a'), {
        goalId: created.value.goalId,
        leaseToken: created.value.leaseToken,
        expectedRevision: created.value.revision,
        currentPhase: 'running',
        summary: 'A successor is armed while work continues.',
        stepUpdates: [],
        nextAction: 'Continue the goal.',
        blockers: [],
        evidence: [],
        activeTaskIds: [],
        successorDelayMinutes: 25,
        executionPreference: 'cloud',
      });
      expect(prepared).toMatchObject({ ok: true, value: { continuation: { status: 'prepared' } } });
      if (!prepared.ok) throw new Error('successor prepare failed');
      const scheduled = await runtime.scheduledService.recordScheduledContinuationReceipt(actor('session-a'), {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-cancel-me',
        runsOn: 'cloud',
      });
      expect(scheduled).toMatchObject({ ok: true, value: { status: 'scheduled' } });
      await runtime.repository.beginGoalFencedMutation({
        callId: 'live-call-before-cancel',
        goalId: created.value.goalId,
        workspaceId: workspace.id,
        ownerClientId: 'chatgpt-web-client',
        leaseTokenHash: createHash('sha256').update(created.value.leaseToken).digest('hex'),
        leaseGeneration: prepared.value.goal.leaseGeneration,
        startedAt: '2026-08-26T00:00:05.000Z',
        expiresAt: '2026-08-26T00:01:05.000Z',
      });
      expect((await runtime.repository.observeGoalFencedMutations(created.value.goalId, '2026-08-26T00:00:06.000Z')).liveFencedCallCount).toBe(1);

      now = new Date('2026-08-26T00:00:05.000Z');
      const cancelled = await runtime.service.cancelGoal(actor('session-b'), {
        goalId: created.value.goalId,
        expectedRevision: prepared.value.goal.revision,
        summary: 'Stop the goal and prevent its obsolete wake from continuing.',
        evidence: [{ kind: 'note', value: 'manual cancellation' }],
      });
      expect(cancelled).toMatchObject({
        ok: true,
        value: {
          status: 'cancelled',
          scheduledTaskCancellation: {
            action: 'delete_native_task',
            nativeTaskId: 'native-cancel-me',
            receiptRequired: true,
          },
        },
      });
      expect((await runtime.repository.observeGoalFencedMutations(created.value.goalId, '2026-08-26T00:00:06.000Z')).liveFencedCallCount).toBe(0);

      const lateWake = await runtime.scheduledService.claimScheduledContinuation(actor('session-c'), {
        continuationId: prepared.value.continuation.continuationId,
      });
      expect(lateWake).toMatchObject({ ok: true, value: { outcome: 'terminal_noop', goal: { status: 'cancelled' } } });
      expect((await runtime.repository.getById(created.value.goalId))?.status).toBe('cancelled');
    } finally {
      runtime.database.close();
    }
  });
});
