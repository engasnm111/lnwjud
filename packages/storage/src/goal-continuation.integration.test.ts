import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GoalContinuationService } from '@lnwjud/application';
import { ScheduledContinuationService } from '@lnwjud/application';
import type { FileActor, GoalRequestCancellationPort, GoalTaskCancellationPort } from '@lnwjud/application';
import type { ScheduledContinuationWorkerLiveness } from '@lnwjud/domain';
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
    engineeringEvidenceVerifier: { verify: async (_workspaceId, evidence): Promise<boolean> => evidence.runId === 'host-task-1' },
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

describe('workflow metadata compatibility', () => {
  it('persists workflow metadata, rejects same-key input drift, and preserves future schema through checkpoint/reopen', async () => {
    const { filename, workspace } = await fixture();
    const now = new Date('2026-10-08T00:00:00.000Z');
    const runtime = await open(filename, workspace, () => now);
    const workflow = {
      schemaVersion: 1, templateId: 'project-check', templateRevision: 1,
      inputDigest: 'a'.repeat(64), requestKeyHash: 'b'.repeat(64),
      inputs: { project: workspace.rootPath },
    } as const;
    const request = { ...createRequest, goalKey: 'workflow:project-check:abc123', workflow };
    const created = await runtime.service.runGoal(actor('workflow-test'), request);
    expect(created.ok).toBe(true);
    if (!created.ok || !created.value.leaseToken) throw new Error('expected acquired workflow Goal');
    expect((await runtime.repository.getById(created.value.goalId))?.workflow).toEqual(workflow);
    const replay = await runtime.service.runGoal(actor('workflow-test'), request);
    expect(replay).toMatchObject({ ok: true, value: { acquired: false, goalId: created.value.goalId } });
    const changed = await runtime.service.runGoal(actor('workflow-test'), {
      ...request, workflow: { ...workflow, inputDigest: 'c'.repeat(64) },
    });
    expect(changed).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    const future = { schemaVersion: 2, nextFormat: { opaque: ['must-survive'] } };
    runtime.database.connection.prepare('UPDATE goals SET workflow_json = ? WHERE id = ?')
      .run(JSON.stringify(future), created.value.goalId);
    const checkpointed = await runtime.service.checkpointGoal(actor('workflow-test'), {
      goalId: created.value.goalId, leaseToken: created.value.leaseToken,
      expectedRevision: created.value.revision, currentPhase: 'verify',
      summary: 'Preserve future metadata', stepUpdates: [], nextAction: 'continue',
      blockers: [], evidence: [], activeTaskIds: [],
    });
    expect(checkpointed.ok).toBe(true);
    runtime.database.close();
    const reopened = await open(filename, workspace, () => now);
    expect((await reopened.repository.getById(created.value.goalId))?.workflow).toEqual(future);
    reopened.database.close();
  });
});

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

  it('reports an unfinished completion precondition instead of a false stale-CAS conflict after runGoal reacquires the lease', async () => {
    const { filename, workspace } = await fixture();
    const now = new Date('2026-08-26T00:00:00.000Z');
    const runtime = await open(filename, workspace, () => now);
    try {
      const created = await runtime.service.runGoal(actor('session-a'), {
        ...createRequest,
        acceptanceCriteria: [{ id: 'release-ready', title: 'Release evidence is complete' }],
      });
      if (!created.ok || created.value.leaseToken === undefined) throw new Error('goal create failed');

      const checkpointed = await runtime.service.checkpointGoal(actor('session-a'), {
        goalId: created.value.goalId,
        leaseToken: created.value.leaseToken,
        expectedRevision: created.value.revision,
        currentPhase: 'completed',
        summary: 'Plan steps are complete, but the explicit release acceptance criterion is still pending.',
        stepUpdates: [
          { stepId: 'implement', status: 'completed', summary: 'Implementation complete.' },
          { stepId: 'verify', status: 'completed', summary: 'Verification complete.' },
        ],
        nextAction: '',
        blockers: [],
        evidence: [],
        activeTaskIds: [],
        releaseLease: true,
      });
      if (!checkpointed.ok) throw new Error('checkpoint failed');

      const resumed = await runtime.service.runGoal(actor('session-a'), {
        workspaceId: workspace.id,
        goalKey: createRequest.goalKey,
      });
      expect(resumed).toMatchObject({
        ok: true,
        value: { acquired: true, revision: checkpointed.value.revision },
      });
      if (!resumed.ok || resumed.value.leaseToken === undefined) throw new Error('goal resume failed');

      const finished = await runtime.service.finishGoal(actor('session-a'), {
        goalId: resumed.value.goalId,
        leaseToken: resumed.value.leaseToken,
        expectedRevision: resumed.value.revision,
        status: 'completed',
        summary: 'Attempt completion using the exact lease and revision returned by runGoal.',
        evidence: [],
      });

      expect(finished).toMatchObject({
        ok: false,
        error: {
          code: 'CONFLICT',
          message: expect.stringContaining('acceptance criteria remain unfinished: release-ready'),
        },
      });
      expect((await runtime.service.getGoal(actor('session-a'), { goalId: resumed.value.goalId }))).toMatchObject({
        ok: true,
        value: { revision: resumed.value.revision, status: 'active' },
      });
    } finally {
      runtime.database.close();
    }
  });

  it('persists a goal Ponytail override across restart and changes it only through leased checkpoint CAS', async () => {
    const { filename, workspace } = await fixture();
    let now = new Date('2026-08-26T00:00:00.000Z');
    const first = await open(filename, workspace, () => now);
    const created = await first.service.runGoal(actor('session-a'), { ...createRequest, ponytailMode: 'full' });
    expect(created).toMatchObject({ ok: true, value: { acquired: true, revision: 0, ponytailMode: 'full' } });
    if (!created.ok || created.value.leaseToken === undefined) throw new Error('goal create failed');
    const goalId = created.value.goalId;
    first.database.close();

    const second = await open(filename, workspace, () => now);
    const persisted = await second.service.getGoal(actor('session-b'), { goalId });
    expect(persisted).toMatchObject({ ok: true, value: { ponytailMode: 'full' } });
    expect(second.database.connection.prepare('SELECT ponytail_mode FROM goals WHERE id = ?').get(goalId))
      .toMatchObject({ ponytail_mode: 'full' });

    const unleasedChange = await second.service.runGoal(actor('session-b'), {
      workspaceId: workspace.id,
      goalKey: createRequest.goalKey,
      ponytailMode: 'ultra',
    });
    expect(unleasedChange).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

    now = new Date('2026-08-26T00:01:01.000Z');
    const resumed = await second.service.runGoal(actor('session-b'), {
      workspaceId: workspace.id,
      goalKey: createRequest.goalKey,
    });
    expect(resumed).toMatchObject({ ok: true, value: { acquired: true, ponytailMode: 'full' } });
    if (!resumed.ok || resumed.value.leaseToken === undefined) throw new Error('goal resume failed');

    const inherited = await second.service.checkpointGoal(actor('session-b'), {
      goalId,
      leaseToken: resumed.value.leaseToken,
      expectedRevision: resumed.value.revision,
      currentPhase: 'policy',
      summary: 'Return the goal to inherited Ponytail policy.',
      stepUpdates: [],
      nextAction: 'Continue with inherited policy.',
      blockers: [],
      evidence: [],
      activeTaskIds: [],
      ponytailMode: 'inherit',
      releaseLease: true,
    });
    expect(inherited).toMatchObject({ ok: true, value: { revision: 1, ponytailMode: 'inherit' } });
    expect(second.database.connection.prepare('SELECT ponytail_mode FROM goals WHERE id = ?').get(goalId))
      .toMatchObject({ ponytail_mode: null });
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

  it('recovers a stale rolling-worker lease after one minute of trustworthy inactivity and invalidates the old worker generation', async () => {
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
        currentPhase: 'rolling-work',
        summary: 'Rolling work has one native watchdog.',
        stepUpdates: [],
        nextAction: 'Resume safely if this worker disappears.',
        blockers: [],
        evidence: [],
        activeTaskIds: [],
        successorDelayMinutes: 25,
        executionPreference: 'cloud',
      });
      if (!prepared.ok) throw new Error('successor prepare failed');
      const scheduled = await runtime.scheduledService.recordScheduledContinuationReceipt(actor('session-a'), {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-stale-lease-recovery',
        dueAt: prepared.value.continuation.dueAt,
        runsOn: 'cloud',
      });
      expect(scheduled).toMatchObject({ ok: true, value: { status: 'scheduled' } });

      const recoveryService = new GoalContinuationService(runtime.workspaces, runtime.repository, {
        now: (): Date => now,
        scheduledContinuations: runtime.repository,
        workerLiveness: {
          observe: async (goalId, trackedTasks): Promise<ScheduledContinuationWorkerLiveness> => {
            const goal = await runtime.repository.getById(goalId);
            if (goal === null) throw new Error('goal missing during liveness probe');
            return {
              trustworthy: true,
              observedAt: now.toISOString(),
              leaseGeneration: goal.leaseGeneration,
              leaseActivitySeq: goal.leaseActivitySeq,
              liveFencedCallCount: 0,
              blockingTaskStates: trackedTasks
                .filter((task) => task.role === 'blocking_job')
                .map((task) => ({ taskId: task.taskId, provider: task.provider, state: 'terminal' as const })),
            };
          },
        },
      });

      now = new Date('2026-08-26T00:00:30.000Z');
      const tooSoon = await recoveryService.runGoal(actor('session-b'), { workspaceId: workspace.id, goalKey: createRequest.goalKey, leaseSeconds: 600 });
      expect(tooSoon).toMatchObject({ ok: true, value: { acquired: false, retryAfterSeconds: 30 } });

      now = new Date('2026-08-26T00:01:01.000Z');
      const recovered = await recoveryService.runGoal(actor('session-c'), { workspaceId: workspace.id, goalKey: createRequest.goalKey, leaseSeconds: 600 });
      expect(recovered).toMatchObject({
        ok: true,
        value: {
          acquired: true,
          leaseRecovery: 'stale_worker_recovered',
          goalId: created.value.goalId,
          leaseGeneration: prepared.value.goal.leaseGeneration + 1,
        },
      });

      const staleWorker = await runtime.service.checkpointGoal(actor('session-a'), {
        goalId: created.value.goalId,
        leaseToken: created.value.leaseToken,
        expectedRevision: prepared.value.goal.revision,
        currentPhase: 'stale-worker',
        summary: 'This worker must no longer own the goal.',
        stepUpdates: [],
        nextAction: 'Must fail.',
        blockers: [],
        evidence: [],
        activeTaskIds: [],
      });
      expect(staleWorker).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    } finally {
      runtime.database.close();
    }
  });

  it('immediately recovers an orphaned foreground lease when trustworthy liveness proves no worker exists', async () => {
    const { filename, workspace } = await fixture();
    const now = new Date('2026-08-26T00:00:00.000Z');
    const runtime = await open(filename, workspace, () => now);
    try {
      const created = await runtime.service.runGoal(actor('foreground-a'), { ...createRequest, leaseSeconds: 600 });
      if (!created.ok || created.value.leaseToken === undefined) throw new Error('goal create failed');

      const recoveryService = new GoalContinuationService(runtime.workspaces, runtime.repository, {
        now: (): Date => now,
        workerLiveness: {
          observe: async (goalId, trackedTasks): Promise<ScheduledContinuationWorkerLiveness> => {
            const goal = await runtime.repository.getById(goalId);
            if (goal === null) throw new Error('goal missing during liveness probe');
            return {
              trustworthy: true,
              observedAt: now.toISOString(),
              leaseGeneration: goal.leaseGeneration,
              leaseActivitySeq: goal.leaseActivitySeq,
              liveFencedCallCount: 0,
              blockingTaskStates: trackedTasks
                .filter((task) => task.role === 'blocking_job')
                .map((task) => ({ taskId: task.taskId, provider: task.provider, state: 'absent' as const })),
            };
          },
        },
      });

      const recovered = await recoveryService.runGoal(actor('foreground-b'), {
        workspaceId: workspace.id,
        goalKey: createRequest.goalKey,
        leaseSeconds: 600,
      });
      expect(recovered).toMatchObject({
        ok: true,
        value: {
          acquired: true,
          leaseRecovery: 'stale_worker_recovered',
          goalId: created.value.goalId,
          leaseGeneration: created.value.leaseGeneration + 1,
        },
      });

      const staleWorker = await runtime.service.checkpointGoal(actor('foreground-a'), {
        goalId: created.value.goalId,
        leaseToken: created.value.leaseToken,
        expectedRevision: created.value.revision,
        currentPhase: 'stale-foreground-worker',
        summary: 'The orphaned foreground lease must no longer be valid.',
        stepUpdates: [],
        nextAction: 'Must fail.',
        blockers: [],
        evidence: [],
        activeTaskIds: [],
      });
      expect(staleWorker).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    } finally {
      runtime.database.close();
    }
  });

  it('does not reclaim an unexpired foreground lease while trustworthy liveness still sees a fenced worker call', async () => {
    const { filename, workspace } = await fixture();
    const now = new Date('2026-08-26T00:00:00.000Z');
    const runtime = await open(filename, workspace, () => now);
    try {
      const created = await runtime.service.runGoal(actor('foreground-a'), { ...createRequest, leaseSeconds: 600 });
      if (!created.ok) throw new Error('goal create failed');

      const recoveryService = new GoalContinuationService(runtime.workspaces, runtime.repository, {
        now: (): Date => now,
        scheduledContinuations: runtime.repository,
        workerLiveness: {
          observe: async (goalId): Promise<ScheduledContinuationWorkerLiveness> => {
            const goal = await runtime.repository.getById(goalId);
            if (goal === null) throw new Error('goal missing during liveness probe');
            return {
              trustworthy: true,
              observedAt: now.toISOString(),
              leaseGeneration: goal.leaseGeneration,
              leaseActivitySeq: goal.leaseActivitySeq,
              liveFencedCallCount: 1,
              blockingTaskStates: [],
            };
          },
        },
      });

      const held = await recoveryService.runGoal(actor('foreground-b'), {
        workspaceId: workspace.id,
        goalKey: createRequest.goalKey,
        leaseSeconds: 600,
      });
      expect(held).toMatchObject({
        ok: true,
        value: { acquired: false, goalId: created.value.goalId, retryAfterSeconds: 600 },
      });
    } finally {
      runtime.database.close();
    }
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
      resumeContext: {
        changedFiles: ['packages/storage/src/goal-repository.ts'],
        commands: [{ command: 'pnpm test goal-continuation', status: 'passed', exitCode: 0, result: '17 passed' }],
        decisions: ['Keep compare-and-swap checkpoint writes atomic.'],
        failedAttempts: ['Legacy summary-only checkpoint did not capture command evidence.'],
        pendingValidation: ['Run full storage suite.'],
        resumePrerequisites: ['Reuse durable-task-123 if it is still running.'],
        stateFacts: [{ kind: 'hash', value: 'HEAD:abc123' }],
        artifacts: [{ kind: 'path', value: 'packages/storage/src/goal-repository.ts' }],
      },
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
        lastCheckpoint: expect.objectContaining({
          revision: 1,
          summary: 'Repository migration is implemented.',
          resumeContext: expect.objectContaining({
            changedFiles: ['packages/storage/src/goal-repository.ts'],
            commands: [expect.objectContaining({ status: 'passed', exitCode: 0, result: '17 passed' })],
            pendingValidation: ['Run full storage suite.'],
          }),
        }),
      },
    });
    const persisted = await second.repository.getById(created.value.goalId);
    expect(persisted?.checkpoints).toHaveLength(1);
    expect(persisted?.checkpoints[0]).toMatchObject({
      revision: 1,
      summary: 'Repository migration is implemented.',
      resumeContext: { pendingValidation: ['Run full storage suite.'] },
    });
    second.database.close();
  });

  it('keeps one rolling worker lease alive across repeated milestone checkpoints and releases it only at handoff', async () => {
    const { filename, workspace } = await fixture();
    let now = new Date('2026-08-26T00:00:00.000Z');
    const runtime = await open(filename, workspace, () => now);
    try {
      const created = await runtime.service.runGoal(actor('rolling-session'), { ...createRequest, leaseSeconds: 600 });
      if (!created.ok || created.value.leaseToken === undefined) throw new Error('goal create failed');
      const prepared = await runtime.scheduledService.prepareScheduledContinuation(actor('rolling-session'), {
        goalId: created.value.goalId,
        leaseToken: created.value.leaseToken,
        expectedRevision: created.value.revision,
        currentPhase: 'rolling-work',
        summary: 'Keep one recurring watchdog while the same worker continues.',
        stepUpdates: [],
        nextAction: 'Continue useful work after each milestone.',
        blockers: [],
        evidence: [],
        activeTaskIds: [],
        executionPreference: 'cloud',
      });
      if (!prepared.ok) throw new Error('watchdog prepare failed');
      const receipt = await runtime.scheduledService.recordScheduledContinuationReceipt(actor('rolling-session'), {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-work-conservation',
        dueAt: prepared.value.continuation.dueAt,
        runsOn: 'cloud',
      });
      expect(receipt).toMatchObject({ ok: true, value: { occurrence: 'interval', intervalMinutes: 60, status: 'scheduled' } });

      let revision = prepared.value.goal.revision;
      const generation = prepared.value.goal.leaseGeneration;
      for (const [minute, expectedExpiry] of [
        [9, '2026-08-26T00:19:00.000Z'],
        [18, '2026-08-26T00:28:00.000Z'],
        [27, '2026-08-26T00:37:00.000Z'],
        [36, '2026-08-26T00:46:00.000Z'],
      ] as const) {
        now = new Date(`2026-08-26T00:${String(minute).padStart(2, '0')}:00.000Z`);
        const checkpoint = await runtime.service.checkpointGoal(actor('rolling-session'), {
          goalId: created.value.goalId,
          leaseToken: created.value.leaseToken,
          expectedRevision: revision,
          currentPhase: 'rolling-work',
          summary: `Milestone at minute ${minute}; keep working.`,
          stepUpdates: [],
          nextAction: 'Execute the next safe action in this same worker turn.',
          blockers: [],
          evidence: [{ kind: 'note', value: `minute-${minute}` }],
          activeTaskIds: [],
          releaseLease: false,
        });
        expect(checkpoint).toMatchObject({
          ok: true,
          value: {
            status: 'active',
            leaseGeneration: generation,
            leaseExpiresAt: expectedExpiry,
          },
        });
        if (!checkpoint.ok) throw new Error(`checkpoint ${minute} failed`);
        revision = checkpoint.value.revision;
      }

      now = new Date('2026-08-26T00:36:30.000Z');
      const handoff = await runtime.service.checkpointGoal(actor('rolling-session'), {
        goalId: created.value.goalId,
        leaseToken: created.value.leaseToken,
        expectedRevision: revision,
        currentPhase: 'handoff',
        summary: 'Host boundary requires durable handoff.',
        stepUpdates: [],
        nextAction: 'Next worker resumes from this checkpoint.',
        blockers: [],
        evidence: [],
        activeTaskIds: [],
        releaseLease: true,
        resumeContext: {
          changedFiles: [],
          commands: [],
          decisions: ['Ordinary milestone checkpoints kept the same worker lease.'],
          failedAttempts: [],
          pendingValidation: ['Resume useful work on the next worker.'],
          resumePrerequisites: ['Claim the same durable goal before mutation.'],
          stateFacts: [{ kind: 'note', value: 'minute-36-handoff' }],
          artifacts: [],
        },
      });
      expect(handoff).toMatchObject({ ok: true, value: { status: 'active', leaseGeneration: generation } });
      if (!handoff.ok) throw new Error('handoff checkpoint failed');
      expect(handoff.value.leaseExpiresAt).toBeUndefined();

      const staleMutation = await runtime.service.checkpointGoal(actor('rolling-session'), {
        goalId: created.value.goalId,
        leaseToken: created.value.leaseToken,
        expectedRevision: handoff.value.revision,
        currentPhase: 'stale-worker',
        summary: 'Released worker must not mutate.',
        stepUpdates: [],
        nextAction: 'none',
        blockers: [],
        evidence: [],
        activeTaskIds: [],
      });
      expect(staleMutation).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    } finally {
      runtime.database.close();
    }
  });

  it('keeps terminal goals terminal and never reopens them through runGoal', async () => {
    const { filename, workspace } = await fixture();
    const runtime = await open(filename, workspace, () => new Date('2026-08-26T00:00:00.000Z'));
    const created = await runtime.service.runGoal(actor('session-a'), createRequest);
    if (!created.ok || created.value.leaseToken === undefined) throw new Error('goal create failed');
    const accepted = await runtime.service.checkpointGoal(actor('session-a'), {
      goalId: created.value.goalId,
      leaseToken: created.value.leaseToken,
      expectedRevision: created.value.revision,
      currentPhase: 'acceptance',
      summary: 'All durable work and verification steps passed.',
      stepUpdates: [
        { stepId: 'implement', status: 'completed', summary: 'Implementation accepted.' },
        { stepId: 'verify', status: 'completed', summary: 'Verification accepted.' },
      ],
      nextAction: '',
      blockers: [],
      evidence: [{ kind: 'hash', value: 'sha256:abc123' }],
      activeTaskIds: [],
    });
    if (!accepted.ok) throw new Error('acceptance checkpoint failed');
    const finished = await runtime.service.finishGoal(actor('session-a'), {
      goalId: created.value.goalId,
      leaseToken: created.value.leaseToken,
      expectedRevision: accepted.value.revision,
      status: 'completed',
      summary: 'All acceptance criteria passed.',
      evidence: [{ kind: 'hash', value: 'sha256:abc123' }],
    });
    expect(finished).toMatchObject({ ok: true, value: { status: 'completed', revision: 2 } });

    const rerun = await runtime.service.runGoal(actor('session-b'), { workspaceId: workspace.id, goalKey: createRequest.goalKey });
    expect(rerun).toMatchObject({ ok: true, value: { status: 'completed', acquired: false, goalId: created.value.goalId } });
    expect(rerun.ok && 'leaseToken' in rerun.value).toBe(false);
    runtime.database.close();
  });

  it('cascades goal completion to in-flight requests and goal-owned supporting tasks', async () => {
    const { filename, workspace } = await fixture();
    const now = new Date('2026-08-26T00:00:00.000Z');
    const taskCalls: Array<{ ownerClientId: string; workspaceId: string; taskIds: string[] }> = [];
    const taskCancellation: GoalTaskCancellationPort = {
      async cancelForGoal(ownerClientId, workspaceId, tasks) {
        const taskIds = tasks.map((task) => typeof task === 'string' ? task : task.taskId);
        taskCalls.push({ ownerClientId, workspaceId, taskIds });
        return tasks.map((task) => ({
          taskId: typeof task === 'string' ? task : task.taskId,
          status: 'cancelled' as const,
          providers: [],
        }));
      },
    };
    const requestCalls: string[] = [];
    const requestCancellation: GoalRequestCancellationPort = {
      register: () => ({ accepted: true, done: Promise.resolve(), release: () => undefined }),
      async cancelForGoal(goalId) {
        requestCalls.push(goalId);
        return { goalId, requested: 1, stopped: 1, remaining: 0, timedOut: false, requestIds: ['orphan-worker-call'] };
      },
    };
    const runtime = await open(filename, workspace, () => now, taskCancellation, requestCancellation);
    try {
      const created = await runtime.service.runGoal(actor('session-a'), createRequest);
      if (!created.ok || created.value.leaseToken === undefined) throw new Error('goal create failed');
      const checkpointed = await runtime.service.checkpointGoal(actor('session-a'), {
        goalId: created.value.goalId,
        leaseToken: created.value.leaseToken,
        expectedRevision: created.value.revision,
        currentPhase: 'acceptance',
        summary: 'Acceptance complete; only a goal-owned supporting worker remains.',
        stepUpdates: [
          { stepId: 'implement', status: 'completed', summary: 'Implementation accepted.' },
          { stepId: 'verify', status: 'completed', summary: 'Verification accepted.' },
        ],
        nextAction: '',
        blockers: [],
        evidence: [{ kind: 'note', value: 'ready' }],
        trackedTasks: [{ taskId: 'support-worker', provider: 'shell', role: 'supporting_service', cancelWithGoal: true }],
      });
      if (!checkpointed.ok) throw new Error('acceptance checkpoint failed');

      const finished = await runtime.service.finishGoal(actor('session-a'), {
        goalId: created.value.goalId,
        leaseToken: created.value.leaseToken,
        expectedRevision: checkpointed.value.revision,
        status: 'completed',
        summary: 'All acceptance criteria passed.',
        evidence: [{ kind: 'note', value: 'ready' }],
      });

      expect(finished).toMatchObject({
        ok: true,
        value: {
          status: 'completed',
          completionState: 'completed',
          allTasksStopped: true,
          allRequestsStopped: true,
          taskCancellations: [{ taskId: 'support-worker', status: 'cancelled' }],
          requestCancellation: { requested: 1, stopped: 1, remaining: 0, timedOut: false },
        },
      });
      expect(taskCalls).toEqual([{ ownerClientId: actor('session-a').clientId, workspaceId: workspace.id, taskIds: ['support-worker'] }]);
      expect(requestCalls).toEqual([created.value.goalId]);
    } finally {
      runtime.database.close();
    }
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

  it('keeps a cancelled goal wake cleanup-only until the exact recurring native task is non-runnable', async () => {
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
        dueAt: prepared.value.continuation.dueAt,
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
            action: 'make_native_task_non_runnable',
            nativeTaskId: 'native-cancel-me',
            receiptRequired: true,
            requiredEffect: 'non_runnable',
          },
        },
      });
      expect((await runtime.repository.observeGoalFencedMutations(created.value.goalId, '2026-08-26T00:00:06.000Z')).liveFencedCallCount).toBe(0);

      const lateWake = await runtime.scheduledService.claimScheduledContinuation(actor('session-c'), {
        continuationId: prepared.value.continuation.continuationId,
      });
      expect(lateWake).toMatchObject({
        ok: true,
        value: {
          outcome: 'terminal_cleanup_required',
          goal: { status: 'cancelled' },
          continuation: { status: 'cancel_required', nativeTaskId: 'native-cancel-me' },
        },
      });
      if (!lateWake.ok) throw new Error('late cleanup wake failed');
      expect('leaseToken' in lateWake.value).toBe(false);
      expect((await runtime.repository.getById(created.value.goalId))?.status).toBe('cancelled');
    } finally {
      runtime.database.close();
    }
  });

  it('persists Engineering Harness metadata across restart and stales only requirement-dependent gates', async () => {
    const { filename, workspace } = await fixture();
    let now = new Date('2026-08-26T00:00:00.000Z');
    const first = await open(filename, workspace, () => now);
    const engineering = {
      schemaVersion: 1 as const,
      primaryTaskKind: 'bugfix' as const,
      riskTier: 'high' as const,
      policyDigest: 'policy-digest-1',
      deliveryScope: 'local' as const,
      scopedPath: 'src/auth/session.ts',
      gates: [
        {
          id: 'diff', title: 'Diff check', applicability: 'required' as const, status: 'passed' as const,
          reason: 'Current diff was inspected.', basedOnUserIntentRevision: 0,
          evidence: { source: 'host_observed' as const, observedAt: now.toISOString(), workspaceId: workspace.id, command: 'git diff --check', exitCode: 0 },
        },
        {
          id: 'focused_validation', title: 'Focused validation', applicability: 'required' as const, status: 'passed' as const,
          reason: 'Focused regression passed.', basedOnUserIntentRevision: 0,
          evidence: { source: 'host_observed' as const, observedAt: now.toISOString(), workspaceId: workspace.id, command: 'pnpm test focused', exitCode: 0 },
        },
      ],
    };
    const created = await first.service.runGoal(actor('engineering-session-a'), {
      ...createRequest,
      goalKey: 'engineering-metadata-restart',
      engineering,
    });
    expect(created).toMatchObject({ ok: true, value: { acquired: true, engineering } });
    if (!created.ok) throw new Error('engineering goal create failed');
    const goalId = created.value.goalId;
    first.database.close();

    now = new Date('2026-08-26T00:01:01.000Z');
    const second = await open(filename, workspace, () => now);
    try {
      const resumed = await second.service.runGoal(actor('engineering-session-b'), {
        workspaceId: workspace.id,
        goalKey: 'engineering-metadata-restart',
        objective: createRequest.objective,
        leaseSeconds: 60,
      });
      expect(resumed).toMatchObject({ ok: true, value: { acquired: true, goalId, engineering } });
      if (!resumed.ok || resumed.value.leaseToken === undefined) throw new Error('engineering goal resume failed');

      const revised = await second.service.reviseGoalIntent(actor('engineering-session-b'), {
        goalId,
        leaseToken: resumed.value.leaseToken,
        expectedRevision: resumed.value.revision,
        expectedUserIntentRevision: 0,
        steering: 'Also preserve the new web-session requirement.',
        staleEngineeringGateIds: ['focused_validation'],
      });
      expect(revised).toMatchObject({
        ok: true,
        value: {
          userIntentRevision: 1,
          engineering: {
            policyDigest: 'policy-digest-1',
            gates: [
              { id: 'diff', status: 'passed', basedOnUserIntentRevision: 0, evidence: expect.any(Object) },
              { id: 'focused_validation', status: 'stale', basedOnUserIntentRevision: 1 },
            ],
          },
        },
      });
      if (!revised.ok) throw new Error('engineering intent revision failed');
      expect(revised.value.engineering?.gates[1]).not.toHaveProperty('evidence');

      const unknownGate = await second.service.reviseGoalIntent(actor('engineering-session-b'), {
        goalId,
        leaseToken: resumed.value.leaseToken,
        expectedRevision: revised.value.revision,
        expectedUserIntentRevision: 1,
        steering: 'This invalid gate id must not mutate state.',
        staleEngineeringGateIds: ['missing-gate'],
      });
      expect(unknownGate).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally {
      second.database.close();
    }
  });

  it('enforces Engineering DoD and only accepts host-observed command evidence that matches the checkpoint', async () => {
    const { filename, workspace } = await fixture();
    const now = new Date('2026-08-26T00:00:00.000Z');
    const runtime = await open(filename, workspace, () => now);
    try {
      const created = await runtime.service.runGoal(actor('engineering-dod'), {
        workspaceId: workspace.id,
        goalKey: 'engineering-dod',
        objective: 'Fix local behavior safely.',
        plan: { steps: [{ id: 'implement', title: 'Implement the change' }] },
        leaseSeconds: 60,
        engineering: {
          schemaVersion: 1,
          primaryTaskKind: 'bugfix',
          riskTier: 'medium',
          policyDigest: 'policy-digest-dod',
          deliveryScope: 'local',
          gates: [
            { id: 'diff', title: 'Diff check', applicability: 'required', status: 'pending', reason: 'Inspect the exact diff.', basedOnUserIntentRevision: 0 },
            { id: 'docs_impact', title: 'Docs impact', applicability: 'required', status: 'pending', reason: 'Record documentation impact.', basedOnUserIntentRevision: 0 },
            { id: 'architecture', title: 'Architecture check', applicability: 'required', status: 'pending', reason: 'Run the configured check.', basedOnUserIntentRevision: 0, checkCommand: 'pnpm lint:arch' },
          ],
        },
      });
      expect(created).toMatchObject({ ok: true, value: { acquired: true } });
      if (!created.ok || created.value.leaseToken === undefined) throw new Error('engineering DoD goal create failed');
      const { goalId, leaseToken } = created.value;

      const planOnly = await runtime.service.checkpointGoal(actor('engineering-dod'), {
        goalId, leaseToken, expectedRevision: 0, expectedUserIntentRevision: 0,
        currentPhase: 'validate', summary: 'Implementation is complete.',
        stepUpdates: [{ stepId: 'implement', status: 'completed', summary: 'Implemented.' }],
        nextAction: 'Record validation evidence.', blockers: [], evidence: [],
      });
      expect(planOnly).toMatchObject({ ok: true, value: { revision: 1 } });

      const pendingGateFinish = await runtime.service.finishGoal(actor('engineering-dod'), {
        goalId, leaseToken, expectedRevision: 1, status: 'completed', summary: 'Not ready.', evidence: [],
      });
      expect(pendingGateFinish).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

      const dismissedRequiredGate = await runtime.service.checkpointGoal(actor('engineering-dod'), {
        goalId, leaseToken, expectedRevision: 1, expectedUserIntentRevision: 0,
        currentPhase: 'validate', summary: 'Attempt to dismiss required diff gate.', stepUpdates: [], nextAction: 'Validate.', blockers: [], evidence: [],
        engineeringGateUpdates: [{ gateId: 'diff', status: 'not_applicable', reason: 'Skip this check.' }],
      });
      expect(dismissedRequiredGate).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

      const wrongArchitectureCommand = await runtime.service.checkpointGoal(actor('engineering-dod'), {
        goalId, leaseToken, expectedRevision: 1, expectedUserIntentRevision: 0,
        currentPhase: 'validate', summary: 'Try an unrelated architecture check.', stepUpdates: [], nextAction: 'Run the declared command.', blockers: [], evidence: [],
        resumeContext: { changedFiles: [], commands: [{ command: 'pnpm test', status: 'passed', exitCode: 0, result: 'passed' }], decisions: [], failedAttempts: [], pendingValidation: [], resumePrerequisites: [], stateFacts: [], artifacts: [] },
        engineeringGateUpdates: [{ gateId: 'architecture', status: 'passed', evidence: { source: 'host_observed', observedAt: now.toISOString(), workspaceId: workspace.id, command: 'pnpm test', runId: 'host-task-1', exitCode: 0 } }],
      });
      expect(wrongArchitectureCommand).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

      const unmatchedObservation = await runtime.service.checkpointGoal(actor('engineering-dod'), {
        goalId, leaseToken, expectedRevision: 1, expectedUserIntentRevision: 0,
        currentPhase: 'validate', summary: 'Try unmatched observation.', stepUpdates: [], nextAction: 'Validate.', blockers: [], evidence: [],
        resumeContext: {
          changedFiles: ['src/example.ts'], commands: [], decisions: [], failedAttempts: [], pendingValidation: [], resumePrerequisites: [], stateFacts: [], artifacts: [],
        },
        engineeringGateUpdates: [{
          gateId: 'diff', status: 'passed',
          evidence: { source: 'host_observed', observedAt: now.toISOString(), workspaceId: workspace.id, command: 'git diff --check', exitCode: 0 },
        }],
      });
      expect(unmatchedObservation).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

      const runIdOnlyObservation = await runtime.service.checkpointGoal(actor('engineering-dod'), {
        goalId, leaseToken, expectedRevision: 1, expectedUserIntentRevision: 0,
        currentPhase: 'validate', summary: 'Reject unverified run-id-only evidence.', stepUpdates: [], nextAction: 'Validate.', blockers: [], evidence: [],
        resumeContext: {
          changedFiles: ['src/example.ts'], commands: [], decisions: [], failedAttempts: [], pendingValidation: [], resumePrerequisites: [], stateFacts: [{ kind: 'task', value: 'run-123' }], artifacts: [],
        },
        engineeringGateUpdates: [{
          gateId: 'diff', status: 'passed',
          evidence: { source: 'host_observed', observedAt: now.toISOString(), workspaceId: workspace.id, runId: 'run-123' },
        }],
      });
      expect(runIdOnlyObservation).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

      const userAttested = await runtime.service.checkpointGoal(actor('engineering-dod'), {
        goalId, leaseToken, expectedRevision: 1, expectedUserIntentRevision: 0,
        currentPhase: 'validate', summary: 'Record user-attested diff evidence.', stepUpdates: [], nextAction: 'Replace with host observation.', blockers: [], evidence: [],
        engineeringGateUpdates: [
          { gateId: 'diff', status: 'passed', evidence: { source: 'user_attested', observedAt: now.toISOString(), workspaceId: workspace.id } },
          { gateId: 'docs_impact', status: 'not_applicable', reason: 'No user-facing or configuration behavior changed.' },
        ],
      });
      expect(userAttested).toMatchObject({ ok: true, value: { revision: 2 } });
      const userAttestedFinish = await runtime.service.finishGoal(actor('engineering-dod'), {
        goalId, leaseToken, expectedRevision: 2, status: 'completed', summary: 'Still not ready.', evidence: [],
      });
      expect(userAttestedFinish).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

      const observed = await runtime.service.checkpointGoal(actor('engineering-dod'), {
        goalId, leaseToken, expectedRevision: 2, expectedUserIntentRevision: 0,
        currentPhase: 'review', summary: 'Validated exact diff.', stepUpdates: [], nextAction: 'Finish.', blockers: [], evidence: [],
        resumeContext: {
          changedFiles: ['src/example.ts'],
          commands: [
            { command: 'git diff --check', status: 'passed', exitCode: 0, result: 'clean' },
            { command: 'pnpm lint:arch', status: 'passed', exitCode: 0, result: 'passed' },
          ],
          decisions: [], failedAttempts: [], pendingValidation: [], resumePrerequisites: [], stateFacts: [], artifacts: [],
        },
        engineeringGateUpdates: [
          { gateId: 'diff', status: 'passed', evidence: { source: 'host_observed', observedAt: now.toISOString(), workspaceId: workspace.id, command: 'git diff --check', runId: 'host-task-1', exitCode: 0 } },
          { gateId: 'architecture', status: 'passed', evidence: { source: 'host_observed', observedAt: now.toISOString(), workspaceId: workspace.id, command: 'pnpm lint:arch', runId: 'host-task-1', exitCode: 0 } },
        ],
      });
      expect(observed).toMatchObject({ ok: true, value: { revision: 3, engineering: { gates: [{ id: 'diff', status: 'passed' }, { id: 'docs_impact', status: 'not_applicable' }, { id: 'architecture', status: 'passed', checkCommand: 'pnpm lint:arch' }] } } });

      const reviewFinding = await runtime.service.checkpointGoal(actor('engineering-dod'), {
        goalId, leaseToken, expectedRevision: 3, expectedUserIntentRevision: 0,
        currentPhase: 'review', summary: 'Independent review found a blocking issue.', stepUpdates: [], nextAction: 'Resolve review finding.', blockers: [], evidence: [],
        engineeringReviewFindings: [{ id: 'review-1', title: 'Potential regression', severity: 'blocking', state: 'validated', reason: 'Reviewer reproduced a behavioral regression.', source: 'independent-review' }],
      });
      expect(reviewFinding).toMatchObject({ ok: true, value: { revision: 4, engineering: { reviewFindings: [{ id: 'review-1', state: 'validated' }] } } });
      const blockedByReview = await runtime.service.finishGoal(actor('engineering-dod'), {
        goalId, leaseToken, expectedRevision: 4, status: 'completed', summary: 'Blocked by review.', evidence: [],
      });
      expect(blockedByReview).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

      const rejectedFinding = await runtime.service.checkpointGoal(actor('engineering-dod'), {
        goalId, leaseToken, expectedRevision: 4, expectedUserIntentRevision: 0,
        currentPhase: 'review', summary: 'Review finding was verified as a false positive.', stepUpdates: [], nextAction: 'Finish.', blockers: [], evidence: [],
        engineeringReviewFindings: [{ id: 'review-1', title: 'Potential regression', severity: 'blocking', state: 'rejected', reason: 'The reported path is unreachable under the verified contract.', source: 'independent-review' }],
      });
      expect(rejectedFinding).toMatchObject({ ok: true, value: { revision: 5, engineering: { reviewFindings: [{ id: 'review-1', state: 'rejected' }] } } });

      const finished = await runtime.service.finishGoal(actor('engineering-dod'), {
        goalId, leaseToken, expectedRevision: 5, status: 'completed', summary: 'Engineering DoD satisfied.', evidence: [{ kind: 'note', value: 'Focused local verification complete.' }],
      });
      expect(finished).toMatchObject({ ok: true, value: { status: 'completed', completionState: 'completed' } });
    } finally {
      runtime.database.close();
    }
  });

  it('persists v5 orchestration state, fences stale intent, and completes only after acceptance', async () => {
    const { filename, workspace } = await fixture();
    const now = new Date('2026-08-26T00:00:00.000Z');
    const runtime = await open(filename, workspace, () => now);
    try {
      const created = await runtime.service.runGoal(actor('session-v5'), {
        ...createRequest,
        goalKey: 'release-v5-orchestration',
        acceptanceCriteria: [{ id: 'verified', title: 'Verification evidence is complete' }],
        iterationPolicy: { mode: 'iterate', maxIterations: 2, stopOnNoNewEvidence: true },
      });
      expect(created).toMatchObject({
        ok: true,
        value: {
          revision: 0,
          userIntentRevision: 0,
          acceptanceCriteria: [{ id: 'verified', status: 'pending' }],
          iterationPolicy: { mode: 'iterate', maxIterations: 2, currentIteration: 0, stopOnNoNewEvidence: true },
        },
      });
      if (!created.ok || created.value.leaseToken === undefined) throw new Error('v5 goal create failed');
      const { goalId, leaseToken } = created.value;

      for (const state of ['reserved', 'attempted_unresolved', 'dispatched_unresolved'] as const) {
        const receipt = await runtime.service.recordDeliveryReceipt(actor('session-v5'), {
          receiptId: 'delivery-v5', goalId, channel: 'native-host', state, basedOnUserIntentRevision: 0,
        });
        expect(receipt).toMatchObject({ ok: true, value: { state } });
      }

      const revised = await runtime.service.reviseGoalIntent(actor('session-v5'), {
        goalId, leaseToken, expectedRevision: 0, expectedUserIntentRevision: 0,
        steering: 'Keep the newer user request authoritative.',
        nextAction: 'Continue against intent revision 1.',
      });
      expect(revised).toMatchObject({ ok: true, value: { revision: 1, userIntentRevision: 1 } });
      if (!revised.ok) throw new Error('intent revision failed');
      expect(await runtime.service.listDeliveryReceipts(actor('session-v5'), goalId)).toMatchObject({
        ok: true,
        value: [{ id: 'delivery-v5', state: 'retired', basedOnUserIntentRevision: 0 }],
      });

      const stale = await runtime.service.checkpointGoal(actor('session-v5'), {
        goalId, leaseToken, expectedRevision: revised.value.revision, expectedUserIntentRevision: 0,
        currentPhase: 'stale', summary: 'This must lose to newer user intent.', stepUpdates: [], nextAction: 'none', blockers: [], evidence: [],
      });
      expect(stale).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

      const capsule = await runtime.service.createContextCapsule(actor('session-v5'), {
        goalId, leaseToken, expectedRevision: revised.value.revision, expectedUserIntentRevision: 1,
        userSteering: ['Keep the newer user request authoritative.'],
        completedWork: ['Durable v5 state is persisted.'],
        decisions: ['Native host continuation only; no browser or DOM automation.'],
        validation: [{ kind: 'note', value: 'typecheck passed' }],
        changedFiles: ['packages/storage/src/goal-repository.ts'],
      });
      expect(capsule).toMatchObject({
        ok: true,
        value: { capsule: { sourceGoalRevision: 1, sourceUserIntentRevision: 1 }, goal: { revision: 2, currentContextCapsuleId: expect.any(String) } },
      });
      if (!capsule.ok) throw new Error('context capsule failed');
      const capsuleId = capsule.value.capsule.id;
      expect(await runtime.service.getContextCapsule(actor('session-v5'), capsuleId)).toMatchObject({ ok: true, value: { id: capsuleId, goalId } });
      expect(await runtime.service.listContextCapsules(actor('session-v5'), goalId)).toMatchObject({ ok: true, value: [{ id: capsuleId }] });

      const planned = await runtime.service.updateGoalPlan(actor('session-v5'), {
        goalId, leaseToken, expectedRevision: 2, expectedUserIntentRevision: 1,
        steps: [
          { id: 'implement', title: 'Implement typed persistence', status: 'completed', summary: 'Done.' },
          { id: 'verify', title: 'Run verification', status: 'completed', summary: 'Done.' },
        ],
      });
      expect(planned).toMatchObject({ ok: true, value: { revision: 3 } });

      const premature = await runtime.service.finishGoal(actor('session-v5'), {
        goalId, leaseToken, expectedRevision: 3, status: 'completed', summary: 'Too early.', evidence: [],
      });
      expect(premature).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

      const accepted = await runtime.service.updateGoalAcceptance(actor('session-v5'), {
        goalId, leaseToken, expectedRevision: 3, expectedUserIntentRevision: 1,
        updates: [{ criterionId: 'verified', status: 'completed', evidence: [{ kind: 'note', value: 'focused tests passed' }] }],
      });
      expect(accepted).toMatchObject({ ok: true, value: { revision: 4, acceptanceCriteria: [{ status: 'completed' }] } });

      const iteration = await runtime.service.advanceGoalIteration(actor('session-v5'), {
        goalId, leaseToken, expectedRevision: 4, expectedUserIntentRevision: 1, evidenceAdded: true, nextAction: 'Run bounded review.',
      });
      expect(iteration).toMatchObject({ ok: true, value: { revision: 5, iterationPolicy: { mode: 'iterate', currentIteration: 1 } } });
      const stopped = await runtime.service.advanceGoalIteration(actor('session-v5'), {
        goalId, leaseToken, expectedRevision: 5, expectedUserIntentRevision: 1, evidenceAdded: false, nextAction: 'Stop iterating.',
      });
      expect(stopped).toMatchObject({ ok: true, value: { revision: 6, iterationPolicy: { mode: 'outcome', currentIteration: 1 } } });

      const finished = await runtime.service.finishGoal(actor('session-v5'), {
        goalId, leaseToken, expectedRevision: 6, status: 'completed', summary: 'v5 orchestration acceptance passed.', evidence: [{ kind: 'note', value: 'verified' }],
      });
      expect(finished).toMatchObject({ ok: true, value: { status: 'completed', revision: 7 } });
    } finally {
      runtime.database.close();
    }
  });
});
