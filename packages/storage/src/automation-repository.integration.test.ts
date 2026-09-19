import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AutomationStateError,
  type CreateAutomationRunRecordRequest,
} from '@lnwjud/domain';
import { SqliteAutomationRepository } from './automation-repository.js';
import { SqliteDatabase } from './database.js';
import { SqliteGoalRepository } from './goal-repository.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  database: SqliteDatabase;
  automation: SqliteAutomationRepository;
  goals: SqliteGoalRepository;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-automation-engine-'));
  temporaryRoots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
  database.connection.prepare(`
    INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    'workspace-1',
    'Automation Fixture',
    root,
    root,
    '2026-09-19T00:00:00.000Z',
  );

  const goals = new SqliteGoalRepository(database);
  const acquired = await goals.acquire({
    goalId: 'goal-1',
    workspaceId: 'workspace-1',
    goalKey: 'automation-m1',
    ownerClientId: 'chatgpt-web-client',
    ownerSessionId: 'session-a',
    objective: 'Implement native automation engine M1.',
    plan: {
      steps: [
        { id: 'm1', title: 'Persist automation state', status: 'pending' },
        { id: 'm2', title: 'Verify repository semantics', status: 'pending' },
      ],
    },
    acceptanceCriteria: [],
    leaseTokenHash: 'lease-hash-a',
    leaseSeconds: 600,
    now: '2026-09-19T00:00:00.000Z',
  });
  expect(acquired.acquired).toBe(true);

  return {
    database,
    automation: new SqliteAutomationRepository(database),
    goals,
  };
}

function createRequest(
  overrides: Partial<CreateAutomationRunRecordRequest> = {},
): CreateAutomationRunRecordRequest {
  return {
    runId: 'run-1',
    goalId: 'goal-1',
    workspaceId: 'workspace-1',
    policyProfile: 'coding_guarded',
    basedOnGoalRevision: 0,
    basedOnUserIntentRevision: 0,
    milestones: [
      {
        id: 'm1',
        title: 'Persist automation state',
        dependsOn: [],
        executionIntent: 'Create native automation persistence primitives.',
        verificationRequirements: [
          {
            id: 'storage-test',
            title: 'Storage integration tests pass',
            kind: 'command',
            specification: 'pnpm --filter @lnwjud/storage test',
          },
        ],
        retryPolicy: {
          classification: 'workspace_mutation',
          maxAttempts: 1,
        },
      },
      {
        id: 'm2',
        title: 'Verify repository semantics',
        dependsOn: ['m1'],
        executionIntent: 'Verify CAS, replay, and journal behavior.',
        verificationRequirements: [
          {
            id: 'cas-evidence',
            title: 'Stale CAS is rejected',
            kind: 'evidence',
            specification: 'Repository integration assertion',
          },
        ],
        retryPolicy: {
          classification: 'safe_read',
          maxAttempts: 2,
        },
      },
    ],
    createdAt: '2026-09-19T00:01:00.000Z',
    eventId: 'event-create',
    ...overrides,
  };
}

describe('native automation engine migration', () => {
  it('applies migration 019 and creates the automation tables', async () => {
    const { database } = await fixture();
    try {
      const migrationIds = database.connection.prepare(
        'SELECT id FROM schema_migrations ORDER BY id',
      ).all().map((row) => (row as { id: string }).id);
      const tables = database.connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ).all().map((row) => (row as { name: string }).name);

      expect(migrationIds).toContain('019_native_automation_engine');
      expect(tables).toEqual(expect.arrayContaining([
        'automation_runs',
        'automation_milestones',
        'automation_attempts',
        'automation_task_bindings',
        'automation_dispatch_receipts',
        'automation_events',
      ]));
    } finally {
      database.close();
    }
  });
});

describe('SqliteAutomationRepository', () => {
  it('creates one durable run per goal and replays an identical create idempotently', async () => {
    const { database, automation } = await fixture();
    try {
      const request = createRequest();
      const created = await automation.createRun(request);
      const replayed = await automation.createRun(request);

      expect(created).toEqual(replayed);
      expect(created).toMatchObject({
        id: 'run-1',
        goalId: 'goal-1',
        workspaceId: 'workspace-1',
        policyProfile: 'coding_guarded',
        revision: 0,
        status: 'planned',
        basedOnGoalRevision: 0,
        basedOnUserIntentRevision: 0,
      });
      expect(created.milestones.map((item) => ({
        id: item.id,
        ordinal: item.ordinal,
        status: item.status,
      }))).toEqual([
        { id: 'm1', ordinal: 0, status: 'pending' },
        { id: 'm2', ordinal: 1, status: 'pending' },
      ]);

      const events = await automation.listEvents('run-1', 10);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: 'event-create',
        revisionBefore: 0,
        revisionAfter: 0,
        type: 'run_created',
      });
    } finally {
      database.close();
    }
  });

  it('scopes milestone ids to their automation run', async () => {
    const { database, automation, goals } = await fixture();
    try {
      await automation.createRun(createRequest());
      const secondGoal = await goals.acquire({
        goalId: 'goal-2',
        workspaceId: 'workspace-1',
        goalKey: 'automation-m1-second',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-a',
        objective: 'Run the same milestone ids under another durable goal.',
        plan: {
          steps: [
            { id: 'm1', title: 'Persist automation state', status: 'pending' },
            { id: 'm2', title: 'Verify repository semantics', status: 'pending' },
          ],
        },
        acceptanceCriteria: [],
        leaseTokenHash: 'lease-hash-b',
        leaseSeconds: 600,
        now: '2026-09-19T00:00:30.000Z',
      });
      expect(secondGoal.acquired).toBe(true);

      const secondRun = await automation.createRun(createRequest({
        runId: 'run-2',
        goalId: 'goal-2',
        eventId: 'event-create-2',
      }));
      expect(secondRun.milestones.map((milestone) => milestone.id)).toEqual(['m1', 'm2']);
      expect((await automation.getRunById('run-1'))?.milestones.map((milestone) => milestone.id))
        .toEqual(['m1', 'm2']);
    } finally {
      database.close();
    }
  });

  it('rejects stale goal authority and invalid milestone graphs', async () => {
    const { database, automation } = await fixture();
    try {
      await expect(automation.createRun(createRequest({
        basedOnGoalRevision: 1,
      }))).rejects.toMatchObject({
        name: 'AutomationStateError',
        reason: 'conflict',
      });

      const invalid = createRequest({
        runId: 'run-cycle',
        eventId: 'event-cycle',
        milestones: [
          {
            id: 'a',
            title: 'A',
            dependsOn: ['b'],
            executionIntent: 'A',
            verificationRequirements: [],
            retryPolicy: { classification: 'safe_read', maxAttempts: 1 },
          },
          {
            id: 'b',
            title: 'B',
            dependsOn: ['a'],
            executionIntent: 'B',
            verificationRequirements: [],
            retryPolicy: { classification: 'safe_read', maxAttempts: 1 },
          },
        ],
      });
      await expect(automation.createRun(invalid)).rejects.toMatchObject({
        reason: 'invalid_graph',
      });
    } finally {
      database.close();
    }
  });
  it('fences transitions against the current durable goal revision while keeping create replay idempotent', async () => {
    const { database, automation, goals } = await fixture();
    try {
      const request = createRequest();
      await automation.createRun(request);
      const currentGoal = await goals.getById('goal-1');
      expect(currentGoal).not.toBeNull();
      if (currentGoal === null) throw new Error('Goal fixture was not created');

      const checkpointedGoal = await goals.checkpoint({
        checkpointId: 'goal-checkpoint-1',
        goalId: 'goal-1',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-a',
        leaseTokenHash: 'lease-hash-a',
        expectedRevision: 0,
        expectedUserIntentRevision: 0,
        plan: currentGoal.plan,
        currentPhase: 'automation-m1',
        summary: 'Advanced the durable goal before syncing automation state.',
        stepUpdates: [],
        nextAction: 'Synchronize the automation run revision.',
        blockers: [],
        evidence: [],
        activeTaskIds: [],
        trackedTasks: [],
        ponytailMode: currentGoal.ponytailMode ?? null,
        releaseLease: false,
        now: '2026-09-19T00:02:00.000Z',
      });
      expect(checkpointedGoal.revision).toBe(1);

      await expect(automation.commitTransition({
        runId: 'run-1',
        expectedRevision: 0,
        event: {
          id: 'event-stale-goal',
          type: 'recovery_reconciled',
          reason: 'stale_goal_revision',
        },
        now: '2026-09-19T00:02:01.000Z',
      })).rejects.toMatchObject({ reason: 'conflict' });

      const synchronized = await automation.commitTransition({
        runId: 'run-1',
        expectedRevision: 0,
        runPatch: {
          status: 'running',
          basedOnGoalRevision: 1,
          basedOnUserIntentRevision: 0,
        },
        event: {
          id: 'event-goal-sync',
          type: 'recovery_reconciled',
          reason: 'goal_revision_synchronized',
        },
        now: '2026-09-19T00:02:02.000Z',
      });
      expect(synchronized).toMatchObject({
        revision: 1,
        basedOnGoalRevision: 1,
        basedOnUserIntentRevision: 0,
      });

      const replayed = await automation.createRun(request);
      expect(replayed.revision).toBe(1);
      expect(replayed.basedOnGoalRevision).toBe(1);
    } finally {
      database.close();
    }
  });

  it('commits attempt, task, receipt, milestone, run, and event atomically under run CAS', async () => {
    const { database, automation } = await fixture();
    try {
      await automation.createRun(createRequest());
      const transitioned = await automation.commitTransition({
        runId: 'run-1',
        expectedRevision: 0,
        runPatch: {
          status: 'waiting_task',
          currentMilestoneId: 'm1',
          currentAttemptId: 'attempt-1',
        },
        createAttempt: {
          attemptId: 'attempt-1',
          milestoneId: 'm1',
          basedOnGoalRevision: 0,
          basedOnUserIntentRevision: 0,
          status: 'waiting_task',
          startedAt: '2026-09-19T00:02:00.000Z',
        },
        milestoneUpdates: [
          {
            milestoneId: 'm1',
            status: 'waiting_task',
            currentAttemptId: 'attempt-1',
          },
        ],
        taskBindings: [
          {
            attemptId: 'attempt-1',
            provider: 'shell',
            taskId: 'task-build-1',
            role: 'blocking_job',
            cancelWithGoal: true,
            boundAt: '2026-09-19T00:02:00.000Z',
          },
        ],
        dispatchReceipts: [
          {
            id: 'receipt-1',
            milestoneId: 'm1',
            attemptId: 'attempt-1',
            operationKey: 'build',
            state: 'confirmed',
            externalId: 'task-build-1',
          },
        ],
        event: {
          id: 'event-task-bound',
          milestoneId: 'm1',
          attemptId: 'attempt-1',
          type: 'task_bound',
          reason: 'background_build_bound',
          metadata: { taskId: 'task-build-1' },
        },
        now: '2026-09-19T00:02:00.000Z',
      });

      expect(transitioned).toMatchObject({
        revision: 1,
        status: 'waiting_task',
        currentMilestoneId: 'm1',
        currentAttemptId: 'attempt-1',
      });
      expect(transitioned.attempts).toEqual([
        expect.objectContaining({
          id: 'attempt-1',
          milestoneId: 'm1',
          sequence: 1,
          basedOnRunRevision: 0,
          status: 'waiting_task',
        }),
      ]);
      expect(transitioned.taskBindings).toEqual([
        expect.objectContaining({
          attemptId: 'attempt-1',
          provider: 'shell',
          taskId: 'task-build-1',
          role: 'blocking_job',
          cancelWithGoal: true,
        }),
      ]);
      expect(transitioned.dispatchReceipts).toEqual([
        expect.objectContaining({
          id: 'receipt-1',
          operationKey: 'build',
          state: 'confirmed',
          externalId: 'task-build-1',
        }),
      ]);
      expect(transitioned.milestones[0]).toMatchObject({
        id: 'm1',
        status: 'waiting_task',
        currentAttemptId: 'attempt-1',
      });

      const events = await automation.listEvents('run-1', 10);
      expect(events.map((event) => event.id)).toEqual([
        'event-task-bound',
        'event-create',
      ]);
      expect(events[0]).toMatchObject({
        revisionBefore: 0,
        revisionAfter: 1,
        type: 'task_bound',
      });
    } finally {
      database.close();
    }
  });

  it('rejects stale transitions without partially writing child records or events', async () => {
    const { database, automation } = await fixture();
    try {
      await automation.createRun(createRequest());
      await automation.commitTransition({
        runId: 'run-1',
        expectedRevision: 0,
        runPatch: { status: 'running', currentMilestoneId: 'm1' },
        milestoneUpdates: [{ milestoneId: 'm1', status: 'ready' }],
        event: {
          id: 'event-ready',
          milestoneId: 'm1',
          type: 'milestone_ready',
          reason: 'dependencies_satisfied',
        },
        now: '2026-09-19T00:02:00.000Z',
      });

      await expect(automation.commitTransition({
        runId: 'run-1',
        expectedRevision: 0,
        createAttempt: {
          attemptId: 'stale-attempt',
          milestoneId: 'm1',
          basedOnGoalRevision: 0,
          basedOnUserIntentRevision: 0,
          status: 'reserved',
          startedAt: '2026-09-19T00:03:00.000Z',
        },
        event: {
          id: 'stale-event',
          milestoneId: 'm1',
          attemptId: 'stale-attempt',
          type: 'attempt_started',
          reason: 'stale_worker',
        },
        now: '2026-09-19T00:03:00.000Z',
      })).rejects.toMatchObject({
        reason: 'conflict',
      });

      const snapshot = await automation.getRunById('run-1');
      expect(snapshot?.revision).toBe(1);
      expect(snapshot?.attempts).toHaveLength(0);
      const events = await automation.listEvents('run-1', 10);
      expect(events.map((event) => event.id)).toEqual([
        'event-ready',
        'event-create',
      ]);
    } finally {
      database.close();
    }
  });
  it('keeps dispatch receipt identity immutable across later transitions', async () => {
    const { database, automation } = await fixture();
    try {
      await automation.createRun(createRequest());
      await automation.commitTransition({
        runId: 'run-1',
        expectedRevision: 0,
        createAttempt: {
          attemptId: 'attempt-1',
          milestoneId: 'm1',
          basedOnGoalRevision: 0,
          basedOnUserIntentRevision: 0,
          status: 'dispatching',
          startedAt: '2026-09-19T00:02:00.000Z',
        },
        dispatchReceipts: [{
          id: 'receipt-1',
          milestoneId: 'm1',
          attemptId: 'attempt-1',
          operationKey: 'mutation-a',
          state: 'reserved',
        }],
        event: {
          id: 'event-dispatch',
          milestoneId: 'm1',
          attemptId: 'attempt-1',
          type: 'dispatch_recorded',
          reason: 'dispatch_reserved',
        },
        now: '2026-09-19T00:02:00.000Z',
      });

      let thrown: unknown;
      try {
        await automation.commitTransition({
          runId: 'run-1',
          expectedRevision: 1,
          dispatchReceipts: [{
            id: 'receipt-1',
            milestoneId: 'm1',
            attemptId: 'attempt-1',
            operationKey: 'different-operation',
            state: 'confirmed',
          }],
          event: {
            id: 'event-invalid-receipt',
            type: 'dispatch_recorded',
            reason: 'should_rollback',
          },
          now: '2026-09-19T00:03:00.000Z',
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AutomationStateError);
      expect((thrown as AutomationStateError).reason).toBe('conflict');

      const snapshot = await automation.getRunById('run-1');
      expect(snapshot?.revision).toBe(1);
      expect(snapshot?.dispatchReceipts).toEqual([
        expect.objectContaining({
          id: 'receipt-1',
          operationKey: 'mutation-a',
          state: 'reserved',
        }),
      ]);
      const events = await automation.listEvents('run-1', 10);
      expect(events.map((event) => event.id)).not.toContain('event-invalid-receipt');
    } finally {
      database.close();
    }
  });

  it('rolls back the whole transition when additional journal events reuse an id', async () => {
    const { database, automation } = await fixture();
    try {
      await automation.createRun(createRequest());
      await expect(automation.commitTransition({
        runId: 'run-1',
        expectedRevision: 0,
        runPatch: { status: 'running', currentMilestoneId: 'm1' },
        milestoneUpdates: [{ milestoneId: 'm1', status: 'ready' }],
        event: {
          id: 'event-duplicate',
          milestoneId: 'm1',
          type: 'milestone_ready',
          reason: 'primary_event',
        },
        additionalEvents: [{
          id: 'event-duplicate',
          milestoneId: 'm1',
          type: 'recovery_reconciled',
          reason: 'duplicate_event_id',
        }],
        now: '2026-09-19T00:04:00.000Z',
      })).rejects.toMatchObject({
        reason: 'conflict',
      });

      const snapshot = await automation.getRunById('run-1');
      expect(snapshot).toMatchObject({
        revision: 0,
        status: 'planned',
      });
      expect(snapshot?.milestones[0]).toMatchObject({ status: 'pending' });
      const events = await automation.listEvents('run-1', 10);
      expect(events.map((event) => event.id)).toEqual(['event-create']);
    } finally {
      database.close();
    }
  });
});
