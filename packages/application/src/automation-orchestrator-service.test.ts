import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AutomationStateError,
  type AutomationMilestoneRecord,
  type AutomationMilestoneSpec,
} from '@lnwjud/domain';
import {
  SqliteAutomationRepository,
  SqliteDatabase,
  SqliteGoalRepository,
} from '@lnwjud/storage';
import {
  AutomationOrchestratorService,
  deterministicMilestoneOrder,
  projectDag,
} from './automation-orchestrator-service.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const AUTHORITY = {
  goalRevision: 0,
  userIntentRevision: 0,
} as const;

function spec(
  id: string,
  dependsOn: readonly string[] = [],
  maxAttempts = 1,
): AutomationMilestoneSpec {
  return {
    id,
    title: id,
    dependsOn,
    executionIntent: `Execute ${id}`,
    verificationRequirements: [{
      id: `verify-${id}`,
      title: `Verify ${id}`,
      kind: 'evidence',
      specification: `evidence:${id}`,
    }],
    retryPolicy: {
      classification: 'workspace_mutation',
      maxAttempts,
    },
  };
}
function record(
  milestone: AutomationMilestoneSpec,
  ordinal: number,
): AutomationMilestoneRecord {
  return {
    ...milestone,
    runId: 'run-order',
    ordinal,
    status: 'pending',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
  };
}

interface Fixture {
  readonly database: SqliteDatabase;
  readonly goals: SqliteGoalRepository;
  readonly automation: SqliteAutomationRepository;
  readonly orchestrator: AutomationOrchestratorService;
}

async function fixture(
  milestones: readonly AutomationMilestoneSpec[],
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-automation-orchestrator-'));
  temporaryRoots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
  database.connection.prepare(`
    INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    'workspace-1',
    'Automation Orchestrator Fixture',
    root,
    root,
    '2026-09-19T00:00:00.000Z',
  );

  const goals = new SqliteGoalRepository(database);
  const acquired = await goals.acquire({
    goalId: 'goal-1',
    workspaceId: 'workspace-1',
    goalKey: 'm2-orchestrator',
    ownerClientId: 'chatgpt-web-client',
    ownerSessionId: 'session-a',
    objective: 'Exercise the M2 application orchestrator.',
    plan: {
      steps: milestones.map((milestone) => ({
        id: milestone.id,
        title: milestone.title,
        status: 'pending' as const,
      })),
    },
    acceptanceCriteria: [],
    leaseTokenHash: 'lease-hash-a',
    leaseSeconds: 600,
    now: '2026-09-19T00:00:00.000Z',
  });
  expect(acquired.acquired).toBe(true);

  let nextId = 0;
  let nextTick = 0;
  const automation = new SqliteAutomationRepository(database);
  const orchestrator = new AutomationOrchestratorService(automation, {
    idFactory: (): string => `auto-id-${++nextId}`,
    now: (): Date => new Date(Date.parse('2026-09-19T00:01:00.000Z') + nextTick++ * 1000),
  });
  await orchestrator.create({
    runId: 'run-1',
    goalId: 'goal-1',
    workspaceId: 'workspace-1',
    policyProfile: 'coding_guarded',
    authority: AUTHORITY,
    milestones,
  });

  return { database, goals, automation, orchestrator };
}

async function startAndVerify(
  orchestrator: AutomationOrchestratorService,
  revision: number,
  authority = AUTHORITY,
): Promise<number> {
  const started = await orchestrator.startCurrentAttempt({
    runId: 'run-1',
    expectedRevision: revision,
    authority,
  });
  const verifying = await orchestrator.beginVerification({
    runId: 'run-1',
    expectedRevision: started.revision,
    authority,
  });
  return verifying.revision;
}

describe('deterministic milestone DAG', () => {
  it('uses stable topological order with declaration order as the ready-queue tie breaker', () => {
    const milestones = [
      record(spec('deploy', ['test']), 0),
      record(spec('lint'), 1),
      record(spec('test'), 2),
      record(spec('docs', ['lint']), 3),
    ];

    expect(deterministicMilestoneOrder(milestones)).toEqual([
      'lint',
      'test',
      'deploy',
      'docs',
    ]);
  });

  it('projects ready and blocked milestones without mutating the snapshot', () => {
    const milestones = [
      { ...record(spec('root'), 0), status: 'completed' as const },
      { ...record(spec('ready-child', ['root']), 1), status: 'pending' as const },
      { ...record(spec('failed-root'), 2), status: 'failed' as const },
      { ...record(spec('blocked-child', ['failed-root']), 3), status: 'pending' as const },
    ];
    const snapshot = {
      id: 'run-order',
      goalId: 'goal-order',
      workspaceId: 'workspace-order',
      policyProfile: 'coding_guarded',
      revision: 0,
      status: 'running' as const,
      basedOnGoalRevision: 0,
      basedOnUserIntentRevision: 0,
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z',
      milestones,
      attempts: [],
      taskBindings: [],
      dispatchReceipts: [],
    };

    const projection = projectDag(snapshot);
    expect(projection.newlyReady).toEqual(['ready-child']);
    expect(projection.newlyBlocked).toEqual(['blocked-child']);
    expect(projection.selectedMilestoneId).toBe('ready-child');
    expect(snapshot.milestones[1]?.status).toBe('pending');
    expect(snapshot.milestones[3]?.status).toBe('pending');
  });
});

describe('AutomationOrchestratorService', () => {
  it('marks all dependency-free milestones ready and selects the deterministic first milestone', async () => {
    const { database, orchestrator } = await fixture([
      spec('m3', ['m1']),
      spec('m1'),
      spec('m2'),
    ]);
    try {
      const advanced = await orchestrator.advance({
        runId: 'run-1',
        expectedRevision: 0,
        authority: AUTHORITY,
      });

      expect(advanced).toMatchObject({
        revision: 1,
        status: 'running',
        currentMilestoneId: 'm1',
      });
      expect(advanced.milestones.map((milestone) => ({
        id: milestone.id,
        status: milestone.status,
      }))).toEqual([
        { id: 'm3', status: 'pending' },
        { id: 'm1', status: 'ready' },
        { id: 'm2', status: 'ready' },
      ]);
      const replay = await orchestrator.advance({
        runId: 'run-1',
        expectedRevision: 1,
        authority: AUTHORITY,
      });
      expect(replay.revision).toBe(1);
      expect(replay.currentMilestoneId).toBe('m1');
    } finally {
      database.close();
    }
  });

  it('replays create by durable goal identity when the caller did not pin a run id', async () => {
    const milestones = [spec('only')];
    const { database, orchestrator } = await fixture(milestones);
    try {
      const replayed = await orchestrator.create({
        goalId: 'goal-1',
        workspaceId: 'workspace-1',
        policyProfile: 'coding_guarded',
        authority: AUTHORITY,
        milestones,
      });
      expect(replayed.id).toBe('run-1');
      expect(replayed.revision).toBe(0);
    } finally {
      database.close();
    }
  });

  it('advances immediately to the next deterministic milestone after verified completion', async () => {
    const { database, orchestrator } = await fixture([
      spec('m3', ['m1']),
      spec('m1'),
      spec('m2'),
    ]);
    try {
      const advanced = await orchestrator.advance({
        runId: 'run-1',
        expectedRevision: 0,
        authority: AUTHORITY,
      });
      const verificationRevision = await startAndVerify(
        orchestrator,
        advanced.revision,
      );
      const completed = await orchestrator.completeCurrentMilestone({
        runId: 'run-1',
        expectedRevision: verificationRevision,
        authority: AUTHORITY,
        evidence: [{ kind: 'note', value: 'm1 verified' }],
      });

      expect(completed.status).toBe('running');
      expect(completed.currentMilestoneId).toBe('m3');
      expect(completed.currentAttemptId).toBeUndefined();
      expect(completed.milestones.find((milestone) => milestone.id === 'm1'))
        .toMatchObject({ status: 'completed' });
      expect(completed.milestones.find((milestone) => milestone.id === 'm3'))
        .toMatchObject({ status: 'ready' });
      expect(completed.milestones.find((milestone) => milestone.id === 'm2'))
        .toMatchObject({ status: 'ready' });
      expect(completed.attempts[0]).toMatchObject({
        status: 'completed',
        verificationEvidence: [{ kind: 'note', value: 'm1 verified' }],
      });
      const events = await fixtureEvents(database, 'run-1');
      expect(events.find((event) => event.type === 'milestone_completed')).toMatchObject({
        type: 'milestone_completed',
        reason: 'verification_passed',
        metadata: expect.objectContaining({
          completedMilestoneId: 'm1',
          nextMilestoneId: 'm3',
          allCompleted: false,
        }),
      });
      expect(events.some((event) => event.type === 'verification_passed')).toBe(true);
      expect(events.some((event) => (
        event.type === 'milestone_ready'
        && event.metadata.selectedMilestoneId === 'm1'
      ))).toBe(true);
    } finally {
      database.close();
    }
  });

  it('enters completing immediately after the final milestone passes verification', async () => {
    const { database, orchestrator } = await fixture([spec('only')]);
    try {
      const advanced = await orchestrator.advance({
        runId: 'run-1',
        expectedRevision: 0,
        authority: AUTHORITY,
      });
      const verificationRevision = await startAndVerify(
        orchestrator,
        advanced.revision,
      );
      const completed = await orchestrator.completeCurrentMilestone({
        runId: 'run-1',
        expectedRevision: verificationRevision,
        authority: AUTHORITY,
      });

      expect(completed.status).toBe('completing');
      expect(completed.currentMilestoneId).toBeUndefined();
      expect(completed.currentAttemptId).toBeUndefined();
      expect(completed.milestones[0]).toMatchObject({
        id: 'only',
        status: 'completed',
      });
    } finally {
      database.close();
    }
  });
  it('uses retry_ready while budget remains and increments immutable attempt sequence', async () => {
    const { database, orchestrator } = await fixture([
      spec('retryable', [], 2),
    ]);
    try {
      const advanced = await orchestrator.advance({
        runId: 'run-1',
        expectedRevision: 0,
        authority: AUTHORITY,
      });
      const firstStarted = await orchestrator.startCurrentAttempt({
        runId: 'run-1',
        expectedRevision: advanced.revision,
        authority: AUTHORITY,
      });
      const firstFailed = await orchestrator.failCurrentAttempt({
        runId: 'run-1',
        expectedRevision: firstStarted.revision,
        authority: AUTHORITY,
        failureCode: 'transient',
        retryable: true,
      });

      expect(firstFailed.status).toBe('running');
      expect(firstFailed.currentMilestoneId).toBe('retryable');
      expect(firstFailed.currentAttemptId).toBeUndefined();
      expect(firstFailed.milestones[0]).toMatchObject({ status: 'retry_ready' });

      const secondStarted = await orchestrator.startCurrentAttempt({
        runId: 'run-1',
        expectedRevision: firstFailed.revision,
        authority: AUTHORITY,
      });
      expect(secondStarted.attempts.map((attempt) => ({
        sequence: attempt.sequence,
        status: attempt.status,
      }))).toEqual([
        { sequence: 1, status: 'failed' },
        { sequence: 2, status: 'dispatching' },
      ]);

      const exhausted = await orchestrator.failCurrentAttempt({
        runId: 'run-1',
        expectedRevision: secondStarted.revision,
        authority: AUTHORITY,
        failureCode: 'transient-again',
        retryable: true,
      });
      expect(exhausted.status).toBe('failed');
      expect(exhausted.milestones[0]).toMatchObject({ status: 'failed' });
      expect(exhausted.terminalAt).toBeDefined();
    } finally {
      database.close();
    }
  });

  it('continues independent work after one branch exhausts while blocking only downstream dependents', async () => {
    const { database, orchestrator } = await fixture([
      spec('dependent', ['critical']),
      spec('critical'),
      spec('independent'),
    ]);
    try {
      const advanced = await orchestrator.advance({
        runId: 'run-1',
        expectedRevision: 0,
        authority: AUTHORITY,
      });
      expect(advanced.currentMilestoneId).toBe('critical');

      const started = await orchestrator.startCurrentAttempt({
        runId: 'run-1',
        expectedRevision: advanced.revision,
        authority: AUTHORITY,
      });
      const failed = await orchestrator.failCurrentAttempt({
        runId: 'run-1',
        expectedRevision: started.revision,
        authority: AUTHORITY,
        failureCode: 'permanent',
        retryable: false,
      });

      expect(failed.status).toBe('running');
      expect(failed.currentMilestoneId).toBe('independent');
      expect(failed.milestones.find((milestone) => milestone.id === 'critical'))
        .toMatchObject({ status: 'failed' });
      expect(failed.milestones.find((milestone) => milestone.id === 'dependent'))
        .toMatchObject({ status: 'blocked' });
      expect(failed.milestones.find((milestone) => milestone.id === 'independent'))
        .toMatchObject({ status: 'ready' });

      const verificationRevision = await startAndVerify(
        orchestrator,
        failed.revision,
      );
      const afterIndependent = await orchestrator.completeCurrentMilestone({
        runId: 'run-1',
        expectedRevision: verificationRevision,
        authority: AUTHORITY,
      });
      expect(afterIndependent.status).toBe('failed');
      expect(afterIndependent.currentMilestoneId).toBeUndefined();
      expect(afterIndependent.terminalAt).toBeDefined();
      const terminalEvents = await fixtureEvents(database, 'run-1');
      expect(terminalEvents.some((event) => event.type === 'run_terminal')).toBe(true);
    } finally {
      database.close();
    }
  });
  it('fences mutations against durable goal revision changes and can synchronize to the latest authority', async () => {
    const { database, goals, orchestrator } = await fixture([spec('only')]);
    try {
      const goal = await goals.getById('goal-1');
      expect(goal).not.toBeNull();
      if (goal === null) throw new Error('Goal fixture missing');

      const checkpointed = await goals.checkpoint({
        checkpointId: 'goal-checkpoint-m2',
        goalId: 'goal-1',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-a',
        leaseTokenHash: 'lease-hash-a',
        expectedRevision: 0,
        expectedUserIntentRevision: 0,
        plan: goal.plan,
        currentPhase: 'm2',
        summary: 'Advance durable goal revision before orchestrator mutation.',
        stepUpdates: [],
        nextAction: 'Resume M2 orchestrator.',
        blockers: [],
        evidence: [],
        activeTaskIds: [],
        trackedTasks: [],
        ponytailMode: goal.ponytailMode ?? null,
        releaseLease: false,
        now: '2026-09-19T00:05:00.000Z',
      });
      expect(checkpointed.revision).toBe(1);

      await expect(orchestrator.advance({
        runId: 'run-1',
        expectedRevision: 0,
        authority: AUTHORITY,
      })).rejects.toMatchObject({
        name: 'AutomationStateError',
        reason: 'conflict',
      });

      const synchronized = await orchestrator.advance({
        runId: 'run-1',
        expectedRevision: 0,
        authority: {
          goalRevision: 1,
          userIntentRevision: 0,
        },
      });
      expect(synchronized).toMatchObject({
        revision: 1,
        basedOnGoalRevision: 1,
        currentMilestoneId: 'only',
      });

      const steeredGoal = await goals.checkpoint({
        checkpointId: 'goal-checkpoint-intent-change',
        goalId: 'goal-1',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-a',
        leaseTokenHash: 'lease-hash-a',
        expectedRevision: 1,
        expectedUserIntentRevision: 0,
        plan: checkpointed.plan,
        userIntentRevision: 1,
        currentPhase: 'm2-steered',
        summary: 'User intent changed and requires explicit automation reconciliation.',
        stepUpdates: [],
        nextAction: 'Reconcile or replan before continuing automation.',
        blockers: [],
        evidence: [],
        activeTaskIds: [],
        trackedTasks: [],
        ponytailMode: checkpointed.ponytailMode ?? null,
        releaseLease: false,
        now: '2026-09-19T00:06:00.000Z',
      });
      expect(steeredGoal.userIntentRevision).toBe(1);

      await expect(orchestrator.startCurrentAttempt({
        runId: 'run-1',
        expectedRevision: synchronized.revision,
        authority: {
          goalRevision: steeredGoal.revision,
          userIntentRevision: steeredGoal.userIntentRevision,
        },
      })).rejects.toMatchObject({
        reason: 'conflict',
      });
    } finally {
      database.close();
    }
  });

  it('rejects out-of-order verification and stale run revisions', async () => {
    const { database, orchestrator } = await fixture([spec('only')]);
    try {
      const advanced = await orchestrator.advance({
        runId: 'run-1',
        expectedRevision: 0,
        authority: AUTHORITY,
      });

      await expect(orchestrator.beginVerification({
        runId: 'run-1',
        expectedRevision: advanced.revision,
        authority: AUTHORITY,
      })).rejects.toMatchObject({ reason: 'conflict' });

      const started = await orchestrator.startCurrentAttempt({
        runId: 'run-1',
        expectedRevision: advanced.revision,
        authority: AUTHORITY,
      });
      await expect(orchestrator.startCurrentAttempt({
        runId: 'run-1',
        expectedRevision: advanced.revision,
        authority: AUTHORITY,
      })).rejects.toMatchObject({ reason: 'conflict' });

      const verifying = await orchestrator.beginVerification({
        runId: 'run-1',
        expectedRevision: started.revision,
        authority: AUTHORITY,
      });
      expect(verifying.status).toBe('verifying');

      let thrown: unknown;
      try {
        await orchestrator.completeCurrentMilestone({
          runId: 'run-1',
          expectedRevision: started.revision,
          authority: AUTHORITY,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AutomationStateError);
      expect((thrown as AutomationStateError).reason).toBe('conflict');
    } finally {
      database.close();
    }
  });
});

async function fixtureEvents(
  database: SqliteDatabase,
  runId: string,
): Promise<readonly {
  readonly type: string;
  readonly reason: string;
  readonly metadata: Record<string, unknown>;
}[]> {
  const repository = new SqliteAutomationRepository(database);
  const events = await repository.listEvents(runId, 50);
  return events.map((event) => ({
    type: event.type,
    reason: event.reason,
    metadata: event.metadata,
  }));
}
