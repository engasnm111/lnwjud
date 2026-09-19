import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { AutomationGoalIntegrationService } from './automation-goal-integration-service.js';
import {
  AutomationOrchestratorService,
  type AutomationAuthorityCursor,
} from './automation-orchestrator-service.js';
import {
  AutomationScheduledResumeService,
  type AutomationScheduledResumeRequest,
} from './automation-scheduled-resume-service.js';
import {
  AutomationTaskSupervisorService,
  type AutomationCancelTaskOutcome,
  type AutomationResolveDispatchOutcome,
  type AutomationTaskLaunchOutcome,
  type AutomationTaskObservationOutcome,
  type AutomationTaskRuntimePort,
} from './automation-task-supervisor-service.js';
import { GoalContinuationService, type GoalSnapshot } from './goal-continuation-service.js';
import type { FileActor } from './file-service.js';

const roots: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const actor: FileActor = {
  clientId: 'm6-resume-test',
  clientName: 'm6-resume-test',
  sessionId: 'session-a',
};

function milestone(): AutomationMilestoneSpec {
  return {
    id: 'm1',
    title: 'M6 milestone',
    dependsOn: [],
    executionIntent: 'Execute the persisted M6 milestone.',
    verificationRequirements: [{
      id: 'verify-m1',
      title: 'Verify M6 milestone',
      kind: 'evidence',
      specification: 'tests pass',
    }],
    retryPolicy: { classification: 'workspace_mutation', maxAttempts: 1 },
  };
}

interface Fixture {
  readonly database: SqliteDatabase;
  readonly repository: SqliteAutomationRepository;
  readonly orchestrator: AutomationOrchestratorService;
  readonly goals: GoalContinuationService;
  readonly goalIntegration: AutomationGoalIntegrationService;
  readonly authority: AutomationAuthorityCursor;
  readonly lease: GoalLeaseProof;
  readonly readyRevision: number;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-m6-resume-'));
  roots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
  databases.push(database);
  database.connection.prepare(`
    INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('workspace-1', 'M6 Resume', root, root, '2026-09-19T00:00:00.000Z');

  const workspaceRepository = new SqliteWorkspaceRepository(database);
  const goalRepository = new SqliteGoalRepository(database);
  let tick = 0;
  const now = (): Date => new Date(Date.parse('2026-09-19T00:00:00.000Z') + tick++ * 1_000);
  const goals = new GoalContinuationService(workspaceRepository, goalRepository, { now });
  const acquired = requireOk(await goals.runGoal(actor, {
    workspaceId: 'workspace-1',
    goalKey: 'm6-scheduled-resume',
    objective: 'Exercise M6 scheduled continuation recovery.',
    plan: { steps: [{ id: 'm1', title: 'M6 milestone' }] },
  }));
  if (!acquired.acquired || acquired.leaseToken === undefined) {
    throw new Error('Fixture failed to acquire goal');
  }

  const repository = new SqliteAutomationRepository(database);
  let id = 0;
  const orchestrator = new AutomationOrchestratorService(repository, {
    now,
    idFactory: (): string => `m6-orchestrator-${++id}`,
  });
  const created = await orchestrator.create({
    runId: 'run-1',
    goalId: acquired.goalId,
    workspaceId: 'workspace-1',
    policyProfile: 'coding_guarded',
    authority: {
      goalRevision: acquired.revision,
      userIntentRevision: acquired.userIntentRevision,
    },
    milestones: [milestone()],
  });
  const ready = await orchestrator.advance({
    runId: created.id,
    expectedRevision: created.revision,
    authority: {
      goalRevision: acquired.revision,
      userIntentRevision: acquired.userIntentRevision,
    },
  });

  return {
    database,
    repository,
    orchestrator,
    goals,
    goalIntegration: new AutomationGoalIntegrationService(repository, orchestrator, goals, {
      now,
      idFactory: (): string => `m6-goal-${++id}`,
    }),
    authority: {
      goalRevision: acquired.revision,
      userIntentRevision: acquired.userIntentRevision,
    },
    lease: {
      goalId: acquired.goalId,
      leaseToken: acquired.leaseToken,
      leaseGeneration: acquired.leaseGeneration,
    },
    readyRevision: ready.revision,
  };
}

function sequenceId(prefix: string): () => string {
  let value = 0;
  return (): string => `${prefix}-${++value}`;
}

function runtime(overrides: Partial<AutomationTaskRuntimePort> = {}): AutomationTaskRuntimePort {
  return {
    async launch(): Promise<AutomationTaskLaunchOutcome> {
      return { kind: 'started', taskId: 'shell-task-1' };
    },
    async observe(): Promise<AutomationTaskObservationOutcome> {
      return { kind: 'observed', state: 'running' };
    },
    async resolveDispatch(): Promise<AutomationResolveDispatchOutcome> {
      return { kind: 'unknown', detail: 'provider has no idempotency lookup' };
    },
    async cancel(): Promise<AutomationCancelTaskOutcome> {
      return { kind: 'requested' };
    },
    ...overrides,
  };
}

async function goalSnapshot(fx: Fixture): Promise<GoalSnapshot> {
  return requireOk(await fx.goals.getGoal(actor, { goalId: fx.lease.goalId }));
}

function resumeService(
  fx: Fixture,
  taskRuntime: AutomationTaskRuntimePort,
): AutomationScheduledResumeService {
  let id = 0;
  return new AutomationScheduledResumeService(
    fx.repository,
    fx.orchestrator,
    new AutomationTaskSupervisorService(
      fx.repository,
      fx.orchestrator,
      taskRuntime,
      {
        now: (): Date => new Date('2026-09-19T00:10:00.000Z'),
        idFactory: (): string => `m6-supervisor-${++id}`,
      },
    ),
    fx.goalIntegration,
    {
      now: (): Date => new Date('2026-09-19T00:10:01.000Z'),
      idFactory: (): string => `m6-resume-${++id}`,
    },
  );
}

function acquiredRequest(goal: GoalSnapshot, lease: GoalLeaseProof): AutomationScheduledResumeRequest {
  return {
    claimOutcome: 'recurring_acquired' as const,
    goalId: goal.goalId,
    goalStatus: goal.status,
    goalRevision: goal.revision,
    userIntentRevision: goal.userIntentRevision,
    lease,
    acquisition: 'orphan_recovered' as const,
    runKey: '2026-09-19T01',
  };
}

describe('AutomationScheduledResumeService', () => {
  it('observes the exact existing blocking task after a scheduled takeover and never relaunches it', async () => {
    const fx = await fixture();
    const started = await fx.orchestrator.startCurrentAttempt({
      runId: 'run-1',
      expectedRevision: fx.readyRevision,
      authority: fx.authority,
    });
    const dispatchSupervisor = new AutomationTaskSupervisorService(
      fx.repository,
      fx.orchestrator,
      runtime(),
      { now: (): Date => new Date('2026-09-19T00:04:00.000Z'), idFactory: sequenceId('dispatch') },
    );
    const waiting = await dispatchSupervisor.dispatchCurrentAttempt({
      runId: 'run-1',
      expectedRevision: started.revision,
      authority: fx.authority,
      provider: 'shell',
      operationKey: 'build',
      idempotencyKey: 'build-attempt-1',
    });
    const checkpointed = await fx.goalIntegration.checkpointTaskBound(actor, {
      runId: waiting.id,
      expectedRevision: waiting.revision,
      authority: fx.authority,
      lease: fx.lease,
    });

    const launch = vi.fn<AutomationTaskRuntimePort['launch']>(async () => ({ kind: 'started', taskId: 'must-not-launch' }));
    const observe = vi.fn<AutomationTaskRuntimePort['observe']>(async (request) => {
      expect(request).toMatchObject({ provider: 'shell', taskId: 'shell-task-1' });
      return {
        kind: 'observed',
        state: 'completed',
        terminalAt: '2026-09-19T00:09:59.000Z',
      };
    });
    const service = resumeService(fx, runtime({ launch, observe }));
    const goal = await goalSnapshot(fx);
    const resumed = await service.resumeAfterClaim(actor, acquiredRequest(goal, fx.lease));

    expect(checkpointed.run.status).toBe('waiting_task');
    expect(resumed.outcome).toBe('resumed');
    expect(resumed.action).toBe('verify_current_milestone');
    expect(resumed.recoveryAttempted).toBe('task_observation');
    expect(resumed.run?.status).toBe('verifying');
    expect(observe).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
  });

  it('recovers a verification checkpoint committed before a worker crash without checkpointing twice', async () => {
    const fx = await fixture();
    const started = await fx.orchestrator.startCurrentAttempt({
      runId: 'run-1',
      expectedRevision: fx.readyRevision,
      authority: fx.authority,
    });
    const verifying = await fx.orchestrator.beginVerification({
      runId: 'run-1',
      expectedRevision: started.revision,
      authority: fx.authority,
    });
    const marker = `automation_verified:run=run-1;milestone=m1;attempt=${verifying.currentAttemptId}`;
    const checkpoint = requireOk(await fx.goals.checkpointGoal(actor, {
      goalId: fx.lease.goalId,
      leaseToken: fx.lease.leaseToken,
      expectedRevision: fx.authority.goalRevision,
      expectedUserIntentRevision: fx.authority.userIntentRevision,
      currentPhase: 'automation:m1:verified',
      summary: 'Verification checkpoint committed before crash',
      stepUpdates: [{ stepId: 'm1', status: 'completed', summary: 'verified before crash' }],
      nextAction: 'finish automation milestone',
      blockers: [],
      evidence: [
        { kind: 'note', value: marker },
        { kind: 'note', value: 'tests passed before crash' },
      ],
      trackedTasks: [],
      releaseLease: false,
    }));

    const service = resumeService(fx, runtime());
    const resumed = await service.resumeAfterClaim(actor, acquiredRequest(checkpoint, fx.lease));

    expect(resumed.recoveryAttempted).toBe('verification_checkpoint_recovery');
    expect(resumed.action).toBe('finalize');
    expect(resumed.run?.status).toBe('completing');
    expect(resumed.run?.attempts[0]?.verificationEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'note', value: marker }),
    ]));
    const goal = await goalSnapshot(fx);
    expect(goal.revision).toBe(checkpoint.revision);
  });

  it('recovers AutomationRun completion from a durable goal that committed before the worker crashed', async () => {
    const fx = await fixture();
    const started = await fx.orchestrator.startCurrentAttempt({
      runId: 'run-1',
      expectedRevision: fx.readyRevision,
      authority: fx.authority,
    });
    const verifying = await fx.orchestrator.beginVerification({
      runId: 'run-1',
      expectedRevision: started.revision,
      authority: fx.authority,
    });
    const verified = await fx.goalIntegration.verifyAndCompleteMilestone(actor, {
      runId: 'run-1',
      expectedRevision: verifying.revision,
      authority: fx.authority,
      lease: fx.lease,
      evidence: [{ kind: 'note', value: 'verified before final crash' }],
    });
    const finished = requireOk(await fx.goals.finishGoal(actor, {
      goalId: fx.lease.goalId,
      leaseToken: fx.lease.leaseToken,
      expectedRevision: verified.goal.revision,
      status: 'completed',
      summary: 'Goal terminal commit happened before process crash',
      evidence: [{ kind: 'note', value: 'terminal evidence' }],
    }));

    const service = resumeService(fx, runtime());
    const recovered = await service.resumeAfterClaim(actor, {
      claimOutcome: 'terminal_noop',
      goalId: finished.goalId,
      goalStatus: finished.status,
      goalRevision: finished.revision,
      userIntentRevision: finished.userIntentRevision,
    });

    expect(recovered.outcome).toBe('terminal_reconciled');
    expect(recovered.action).toBe('terminal');
    expect(recovered.run?.status).toBe('completed');
    expect(recovered.run?.basedOnGoalRevision).toBe(finished.revision);
  });

  it('reconciles an unresolved dispatch receipt without blind payload replay', async () => {
    const fx = await fixture();
    const started = await fx.orchestrator.startCurrentAttempt({
      runId: 'run-1',
      expectedRevision: fx.readyRevision,
      authority: fx.authority,
    });
    const uncertainSupervisor = new AutomationTaskSupervisorService(
      fx.repository,
      fx.orchestrator,
      runtime({
        async launch(): Promise<AutomationTaskLaunchOutcome> {
          return { kind: 'uncertain', detail: 'connection lost after send' };
        },
      }),
      { now: (): Date => new Date('2026-09-19T00:04:00.000Z'), idFactory: sequenceId('uncertain') },
    );
    const unresolved = await uncertainSupervisor.dispatchCurrentAttempt({
      runId: 'run-1',
      expectedRevision: started.revision,
      authority: fx.authority,
      provider: 'shell',
      operationKey: 'build',
      idempotencyKey: 'build-attempt-1',
    });
    expect(unresolved.status).toBe('blocked');

    const launch = vi.fn<AutomationTaskRuntimePort['launch']>();
    const resolveDispatch = vi.fn<AutomationTaskRuntimePort['resolveDispatch']>(async () => ({
      kind: 'unknown',
      detail: 'no provider idempotency lookup',
    }));
    const service = resumeService(fx, runtime({ launch, resolveDispatch }));
    const goal = await goalSnapshot(fx);
    const resumed = await service.resumeAfterClaim(actor, acquiredRequest(goal, fx.lease));

    expect(resumed.action).toBe('reconciliation_required');
    expect(resumed.recoveryAttempted).toBe('dispatch_reconciliation');
    expect(resumed.operationKey).toBe('build');
    expect(resolveDispatch).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
  });

  it('preserves ordinary durable-goal scheduled continuation when no automation run exists', async () => {
    const fx = await fixture();
    const service = resumeService(fx, runtime());
    const otherGoal = {
      ...(await goalSnapshot(fx)),
      goalId: 'goal-without-automation',
    };

    const noRun = await service.resumeAfterClaim(actor, {
      claimOutcome: 'recurring_acquired',
      goalId: otherGoal.goalId,
      goalStatus: 'active',
      goalRevision: otherGoal.revision,
      userIntentRevision: otherGoal.userIntentRevision,
      lease: {
        goalId: otherGoal.goalId,
        leaseToken: 'compatibility-lease',
        leaseGeneration: 1,
      },
      acquisition: 'normal',
      runKey: '2026-09-19T02',
    });

    expect(noRun).toMatchObject({
      outcome: 'no_automation_run',
      action: 'no_automation_run',
    });
  });

  it('keeps historical one-time continuation acquisition on its scheduler handoff path', async () => {
    const fx = await fixture();
    const launch = vi.fn<AutomationTaskRuntimePort['launch']>();
    const service = resumeService(fx, runtime({ launch }));
    const goal = await goalSnapshot(fx);
    const before = await fx.orchestrator.get('run-1');

    const legacy = await service.resumeAfterClaim(actor, {
      claimOutcome: 'acquired',
      goalId: goal.goalId,
      goalStatus: goal.status,
      goalRevision: goal.revision,
      userIntentRevision: goal.userIntentRevision,
      lease: fx.lease,
      acquisition: 'normal',
    });
    const after = await fx.orchestrator.get('run-1');

    expect(legacy).toMatchObject({
      outcome: 'scheduled_noop',
      action: 'scheduled_noop',
    });
    expect(after.revision).toBe(before.revision);
    expect(launch).not.toHaveBeenCalled();
  });

  it('deduplicated or busy scheduled wakes never advance automation state', async () => {
    const fx = await fixture();
    const observe = vi.fn<AutomationTaskRuntimePort['observe']>();
    const service = resumeService(fx, runtime({ observe }));
    const goal = await goalSnapshot(fx);
    const before = await fx.orchestrator.get('run-1');

    const duplicate = await service.resumeAfterClaim(actor, {
      claimOutcome: 'already_claimed',
      goalId: goal.goalId,
      goalStatus: goal.status,
      goalRevision: goal.revision,
      userIntentRevision: goal.userIntentRevision,
      runKey: '2026-09-19T01',
    });
    const after = await fx.orchestrator.get('run-1');

    expect(duplicate.outcome).toBe('scheduled_noop');
    expect(duplicate.action).toBe('scheduled_noop');
    expect(after.revision).toBe(before.revision);
    expect(observe).not.toHaveBeenCalled();
  });

  it('fails closed on non-success terminal goal mismatch without rewriting automation state', async () => {
    const fx = await fixture();
    const service = resumeService(fx, runtime());
    const goal = await goalSnapshot(fx);
    const before = await fx.orchestrator.get('run-1');

    const mismatch = await service.resumeAfterClaim(actor, {
      claimOutcome: 'terminal_noop',
      goalId: goal.goalId,
      goalStatus: 'cancelled',
      goalRevision: goal.revision,
      userIntentRevision: goal.userIntentRevision,
    });
    const after = await fx.orchestrator.get('run-1');

    expect(mismatch).toMatchObject({
      outcome: 'scheduled_noop',
      action: 'reconciliation_required',
      reason: expect.stringContaining('fail closed'),
    });
    expect(after.revision).toBe(before.revision);
  });

  it('advances only to a safe dispatch boundary and requires explicit execution after takeover', async () => {
    const fx = await fixture();
    const launch = vi.fn<AutomationTaskRuntimePort['launch']>();
    const service = resumeService(fx, runtime({ launch }));
    const goal = await goalSnapshot(fx);

    const resumed = await service.resumeAfterClaim(actor, acquiredRequest(goal, fx.lease));

    expect(resumed.action).toBe('execution_required');
    expect(resumed.run?.currentAttemptId).toBeDefined();
    expect(resumed.run?.attempts[0]).toMatchObject({ status: 'dispatching' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('fails closed when the durable user intent revision changed while the worker was away', async () => {
    const fx = await fixture();
    const service = resumeService(fx, runtime());
    const goal = await goalSnapshot(fx);

    await expect(service.resumeAfterClaim(actor, {
      ...acquiredRequest(goal, fx.lease),
      userIntentRevision: goal.userIntentRevision + 1,
    })).rejects.toThrow(/user intent changed/i);
  });
});

function requireOk<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
