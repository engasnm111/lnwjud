import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AutomationMilestoneSpec,
  GoalLeaseProof,
  Result,
} from '@lnwjud/domain';
import {
  SqliteAutomationRepository,
  SqliteDatabase,
  SqliteGoalRepository,
  SqliteWorkspaceRepository,
} from '@lnwjud/storage';
import {
  AutomationGoalIntegrationService,
} from './automation-goal-integration-service.js';
import {
  AutomationOrchestratorService,
  type AutomationAuthorityCursor,
} from './automation-orchestrator-service.js';
import {
  AutomationTaskSupervisorService,
  type AutomationTaskRuntimePort,
} from './automation-task-supervisor-service.js';
import { GoalContinuationService } from './goal-continuation-service.js';
import type { FileActor } from './file-service.js';

const temporaryRoots: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const actor: FileActor = {
  clientId: 'automation-goal-test',
  clientName: 'automation-goal-test',
  sessionId: 'session-a',
};

function milestone(id = 'm1'): AutomationMilestoneSpec {
  return {
    id,
    title: `Milestone ${id}`,
    dependsOn: [],
    executionIntent: `Execute ${id}`,
    verificationRequirements: [{
      id: `verify-${id}`,
      title: `Verify ${id}`,
      kind: 'evidence',
      specification: `evidence:${id}`,
    }],
    retryPolicy: {
      classification: 'workspace_mutation',
      maxAttempts: 1,
    },
  };
}

interface Fixture {
  readonly database: SqliteDatabase;
  readonly goals: GoalContinuationService;
  readonly automation: SqliteAutomationRepository;
  readonly orchestrator: AutomationOrchestratorService;
  readonly integration: AutomationGoalIntegrationService;
  readonly lease: GoalLeaseProof;
  readonly authority: AutomationAuthorityCursor;
  readonly initialRunRevision: number;
}

async function fixture(options: {
  readonly acceptance?: boolean;
  readonly blocker?: string;
} = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-automation-goal-m5-'));
  temporaryRoots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
  databases.push(database);
  database.connection.prepare(`
    INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    'workspace-1',
    'Automation Goal M5',
    root,
    root,
    '2026-09-19T00:00:00.000Z',
  );

  const workspaceRepository = new SqliteWorkspaceRepository(database);
  const goalRepository = new SqliteGoalRepository(database);
  let tick = 0;
  const now = (): Date => new Date(Date.parse('2026-09-19T00:00:00.000Z') + tick++ * 1000);
  const goals = new GoalContinuationService(workspaceRepository, goalRepository, { now });
  const acquired = requireOk(await goals.runGoal(actor, {
    workspaceId: 'workspace-1',
    goalKey: 'm5-native-automation',
    objective: 'Exercise M5 durable goal integration.',
    plan: { steps: [{ id: 'm1', title: 'Milestone m1' }] },
    ...(options.acceptance === true
      ? { acceptanceCriteria: [{ id: 'accept-1', title: 'Acceptance verified' }] }
      : {}),
  }));
  if (!acquired.acquired || acquired.leaseToken === undefined) {
    throw new Error('Fixture failed to acquire durable goal lease');
  }

  let goalRevision = acquired.revision;
  if (options.blocker !== undefined) {
    const blocked = requireOk(await goals.checkpointGoal(actor, {
      goalId: acquired.goalId,
      leaseToken: acquired.leaseToken,
      expectedRevision: acquired.revision,
      expectedUserIntentRevision: acquired.userIntentRevision,
      currentPhase: 'blocked-fixture',
      summary: 'Fixture blocker',
      stepUpdates: [],
      nextAction: 'resolve blocker',
      blockers: [options.blocker],
      evidence: [],
      trackedTasks: [],
    }));
    goalRevision = blocked.revision;
  }

  const automation = new SqliteAutomationRepository(database);
  let id = 0;
  const orchestrator = new AutomationOrchestratorService(automation, {
    now,
    idFactory: (): string => `m5-id-${++id}`,
  });
  const created = await orchestrator.create({
    runId: 'run-1',
    goalId: acquired.goalId,
    workspaceId: 'workspace-1',
    policyProfile: 'coding_guarded',
    authority: {
      goalRevision,
      userIntentRevision: acquired.userIntentRevision,
    },
    milestones: [milestone()],
  });
  const advanced = await orchestrator.advance({
    runId: created.id,
    expectedRevision: created.revision,
    authority: {
      goalRevision,
      userIntentRevision: acquired.userIntentRevision,
    },
  });

  const authority = {
    goalRevision,
    userIntentRevision: acquired.userIntentRevision,
  } as const;
  const lease = {
    goalId: acquired.goalId,
    leaseToken: acquired.leaseToken,
    leaseGeneration: acquired.leaseGeneration,
  } as const;
  return {
    database,
    goals,
    automation,
    orchestrator,
    integration: new AutomationGoalIntegrationService(automation, orchestrator, goals, {
      now,
      idFactory: (): string => `m5-integration-${++id}`,
    }),
    lease,
    authority,
    initialRunRevision: advanced.revision,
  };
}

async function enterVerification(
  fx: Fixture,
): Promise<{ readonly revision: number }> {
  const started = await fx.orchestrator.startCurrentAttempt({
    runId: 'run-1',
    expectedRevision: fx.initialRunRevision,
    authority: fx.authority,
  });
  const verifying = await fx.orchestrator.beginVerification({
    runId: 'run-1',
    expectedRevision: started.revision,
    authority: fx.authority,
  });
  return { revision: verifying.revision };
}

const startedRuntime: AutomationTaskRuntimePort = {
  async launch() {
    return { kind: 'started', taskId: 'shell-task-1' };
  },
  async observe() {
    return { kind: 'observed', state: 'running' };
  },
  async resolveDispatch() {
    return { kind: 'unknown' };
  },
  async cancel() {
    return { kind: 'requested' };
  },
};

describe('AutomationGoalIntegrationService', () => {
  it('checkpoints a newly bound blocking task into the durable goal without inventing plan steps', async () => {
    const fx = await fixture();
    const started = await fx.orchestrator.startCurrentAttempt({
      runId: 'run-1',
      expectedRevision: fx.initialRunRevision,
      authority: fx.authority,
    });
    let dispatchId = 0;
    const supervisor = new AutomationTaskSupervisorService(
      fx.automation,
      fx.orchestrator,
      startedRuntime,
      {
        now: (): Date => new Date('2026-09-19T00:05:00.000Z'),
        idFactory: (): string => `dispatch-id-${++dispatchId}`,
      },
    );
    const waiting = await supervisor.dispatchCurrentAttempt({
      runId: 'run-1',
      expectedRevision: started.revision,
      authority: fx.authority,
      provider: 'shell',
      operationKey: 'build',
      idempotencyKey: 'build-attempt-1',
    });

    const checkpointed = await fx.integration.checkpointTaskBound(actor, {
      runId: 'run-1',
      expectedRevision: waiting.revision,
      authority: fx.authority,
      lease: fx.lease,
    });

    expect(checkpointed.goal.revision).toBe(1);
    expect(checkpointed.goal.plan.steps).toEqual([
      expect.objectContaining({ id: 'm1', status: 'in_progress' }),
    ]);
    expect(checkpointed.goal.trackedTasks).toEqual([
      expect.objectContaining({
        taskId: 'shell-task-1',
        provider: 'shell',
        role: 'blocking_job',
        cancelWithGoal: true,
      }),
    ]);
    expect(checkpointed.run.basedOnGoalRevision).toBe(checkpointed.goal.revision);
    const events = await fx.automation.listEvents('run-1', 100);
    expect(events.some((event) => (
      event.type === 'checkpoint_committed'
      && event.reason === 'automation_task_checkpointed'
    ))).toBe(true);
  });

  it('checkpoints verification before milestone completion, then finalizes only after goal terminal readback', async () => {
    const fx = await fixture({ acceptance: true });
    const verifying = await enterVerification(fx);

    const verified = await fx.integration.verifyAndCompleteMilestone(actor, {
      runId: 'run-1',
      expectedRevision: verifying.revision,
      authority: fx.authority,
      lease: fx.lease,
      evidence: [{ kind: 'note', value: 'typecheck and tests passed' }],
    });

    expect(verified.goal.plan.steps[0]).toMatchObject({ id: 'm1', status: 'completed' });
    expect(verified.goal.lastCheckpoint?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'note', value: expect.stringContaining('automation_verified:') }),
    ]));
    expect(verified.run.status).toBe('completing');
    expect(verified.run.basedOnGoalRevision).toBe(verified.goal.revision);

    const finalized = await fx.integration.finalize(actor, {
      runId: 'run-1',
      expectedRevision: verified.run.revision,
      authority: {
        goalRevision: verified.goal.revision,
        userIntentRevision: verified.goal.userIntentRevision,
      },
      lease: fx.lease,
      summary: 'M5 acceptance complete',
      finalReviewEvidence: [{ kind: 'note', value: 'final review passed' }],
      acceptance: [{
        criterionId: 'accept-1',
        evidence: [{ kind: 'note', value: 'acceptance evidence' }],
      }],
    });

    expect(finalized.completionState).toBe('completed');
    expect(finalized.goal.status).toBe('completed');
    expect(finalized.goal.acceptanceCriteria[0]).toMatchObject({ id: 'accept-1', status: 'completed' });
    expect(finalized.run.status).toBe('completed');
    expect(finalized.run.basedOnGoalRevision).toBe(finalized.goal.revision);
    const events = await fx.automation.listEvents('run-1', 100);
    expect(events.some((event) => (
      event.type === 'run_terminal'
      && event.reason === 'goal_terminal_readback_confirmed'
    ))).toBe(true);
  });

  it('fails closed before final mutation when a durable blocker remains', async () => {
    const fx = await fixture({ blocker: 'human review still required' });
    const verifying = await enterVerification(fx);
    const verified = await fx.integration.verifyAndCompleteMilestone(actor, {
      runId: 'run-1',
      expectedRevision: verifying.revision,
      authority: fx.authority,
      lease: fx.lease,
      evidence: [{ kind: 'note', value: 'milestone passed' }],
    });

    await expect(fx.integration.finalize(actor, {
      runId: 'run-1',
      expectedRevision: verified.run.revision,
      authority: {
        goalRevision: verified.goal.revision,
        userIntentRevision: verified.goal.userIntentRevision,
      },
      lease: fx.lease,
      summary: 'should not finish',
      finalReviewEvidence: [{ kind: 'note', value: 'review evidence' }],
      acceptance: [],
    })).rejects.toThrow(/blockers must be cleared/i);

    const goal = requireOk(await fx.goals.getGoal(actor, { goalId: fx.lease.goalId }));
    expect(goal.status).toBe('active');
    expect(goal.blockers).toEqual(['human review still required']);
  });

  it('recovers a crash after finish_goal by confirming the terminal goal before completing the run', async () => {
    const fx = await fixture();
    const verifying = await enterVerification(fx);
    const verified = await fx.integration.verifyAndCompleteMilestone(actor, {
      runId: 'run-1',
      expectedRevision: verifying.revision,
      authority: fx.authority,
      lease: fx.lease,
      evidence: [{ kind: 'note', value: 'milestone passed' }],
    });

    const finished = requireOk(await fx.goals.finishGoal(actor, {
      goalId: fx.lease.goalId,
      leaseToken: fx.lease.leaseToken,
      expectedRevision: verified.goal.revision,
      status: 'completed',
      summary: 'Goal committed before simulated worker crash',
      evidence: [{ kind: 'note', value: 'terminal durable evidence' }],
    }));
    expect(finished.status).toBe('completed');

    const recovered = await fx.integration.finalize(actor, {
      runId: 'run-1',
      expectedRevision: verified.run.revision,
      authority: {
        goalRevision: verified.goal.revision,
        userIntentRevision: verified.goal.userIntentRevision,
      },
      summary: 'Recovered finalization',
      finalReviewEvidence: [{ kind: 'note', value: 'review was already complete' }],
      acceptance: [],
    });

    expect(recovered.goal.status).toBe('completed');
    expect(recovered.run.status).toBe('completed');
    expect(recovered.run.basedOnGoalRevision).toBe(recovered.goal.revision);
  });

  it('requires explicit final-review evidence before finishing the durable goal', async () => {
    const fx = await fixture();
    const verifying = await enterVerification(fx);
    const verified = await fx.integration.verifyAndCompleteMilestone(actor, {
      runId: 'run-1',
      expectedRevision: verifying.revision,
      authority: fx.authority,
      lease: fx.lease,
      evidence: [{ kind: 'note', value: 'milestone passed' }],
    });

    await expect(fx.integration.finalize(actor, {
      runId: 'run-1',
      expectedRevision: verified.run.revision,
      authority: {
        goalRevision: verified.goal.revision,
        userIntentRevision: verified.goal.userIntentRevision,
      },
      lease: fx.lease,
      summary: 'Missing review evidence',
      finalReviewEvidence: [],
      acceptance: [],
    })).rejects.toThrow(/finalization requires final review evidence/i);
  });
});

function requireOk<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
