import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appError,
  err,
  type AutomationMilestoneSpec,
  type GoalLeaseProof,
  type Result,
} from '@lnwjud/domain';
import {
  SqliteAutomationRepository,
  SqliteDatabase,
  SqliteGoalRepository,
  SqliteWorkspaceRepository,
} from '@lnwjud/storage';
import {
  AutomationGoalIntegrationService,
  type AutomationGoalContinuationPort,
} from './automation-goal-integration-service.js';
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
import {
  GoalContinuationService,
  type GoalSnapshot,
} from './goal-continuation-service.js';
import type { FileActor } from './file-service.js';

const roots: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const actorA: FileActor = {
  clientId: 'm8-worker-a',
  clientName: 'm8-worker-a',
  sessionId: 'session-a',
};
const actorB: FileActor = {
  clientId: 'm8-worker-a',
  clientName: 'm8-worker-a-takeover',
  sessionId: 'session-b',
};

class ManualClock {
  public constructor(private value = Date.parse('2026-09-19T01:00:00.000Z')) {}
  public now(): Date { return new Date(this.value); }
  public advance(ms: number): void { this.value += ms; }
}

function milestone(): AutomationMilestoneSpec {
  return {
    id: 'm1',
    title: 'M8 fault-injection milestone',
    dependsOn: [],
    executionIntent: 'Exercise recovery without blind replay.',
    verificationRequirements: [{
      id: 'verify-m1',
      title: 'Verify recovered state',
      kind: 'evidence',
      specification: 'Fault-injection evidence is persisted.',
    }],
    retryPolicy: { classification: 'workspace_mutation', maxAttempts: 2 },
  };
}

interface Fixture {
  readonly database: SqliteDatabase;
  readonly repository: SqliteAutomationRepository;
  readonly orchestrator: AutomationOrchestratorService;
  readonly goals: GoalContinuationService;
  readonly integration: AutomationGoalIntegrationService;
  readonly clock: ManualClock;
  readonly authority: AutomationAuthorityCursor;
  readonly lease: GoalLeaseProof;
  readonly readyRevision: number;
  readonly goalKey: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-m8-fault-'));
  roots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
  databases.push(database);
  database.connection.prepare(`
    INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('workspace-1', 'M8 Fault Injection', root, root, '2026-09-19T01:00:00.000Z');

  const clock = new ManualClock();
  const workspaceRepository = new SqliteWorkspaceRepository(database);
  const goalRepository = new SqliteGoalRepository(database);
  const goals = new GoalContinuationService(workspaceRepository, goalRepository, {
    now: (): Date => clock.now(),
  });
  const goalKey = 'm8-fault-injection';
  const acquired = requireOk(await goals.runGoal(actorA, {
    workspaceId: 'workspace-1',
    goalKey,
    objective: 'Exercise M8 crash and ambiguity recovery.',
    plan: { steps: [{ id: 'm1', title: 'M8 fault-injection milestone' }] },
    leaseSeconds: 30,
  }));
  if (!acquired.acquired || acquired.leaseToken === undefined) {
    throw new Error('M8 fixture failed to acquire a durable goal');
  }

  const repository = new SqliteAutomationRepository(database);
  let id = 0;
  const orchestrator = new AutomationOrchestratorService(repository, {
    now: (): Date => clock.now(),
    idFactory: (): string => `m8-orch-${++id}`,
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
  const authority = {
    goalRevision: acquired.revision,
    userIntentRevision: acquired.userIntentRevision,
  } as const;
  const lease = {
    goalId: acquired.goalId,
    leaseToken: acquired.leaseToken,
    leaseGeneration: acquired.leaseGeneration,
  } as const;  return {
    database,
    repository,
    orchestrator,
    goals,
    integration: new AutomationGoalIntegrationService(repository, orchestrator, goals, {
      now: (): Date => clock.now(),
      idFactory: (): string => `m8-goal-${++id}`,
    }),
    clock,
    authority,
    lease,
    readyRevision: ready.revision,
    goalKey,
  };
}

function taskRuntime(overrides: Partial<AutomationTaskRuntimePort> = {}): AutomationTaskRuntimePort {
  return {
    async launch(): Promise<AutomationTaskLaunchOutcome> {
      return { kind: 'started', taskId: 'task-1' };
    },
    async observe(): Promise<AutomationTaskObservationOutcome> {
      return { kind: 'observed', state: 'running' };
    },
    async resolveDispatch(): Promise<AutomationResolveDispatchOutcome> {
      return { kind: 'unknown', detail: 'provider lookup unavailable' };
    },    async cancel(): Promise<AutomationCancelTaskOutcome> {
      return { kind: 'requested' };
    },
    ...overrides,
  };
}

function supervisor(
  fx: Fixture,
  runtime: AutomationTaskRuntimePort,
  prefix = 'm8-supervisor',
): AutomationTaskSupervisorService {
  let id = 0;
  return new AutomationTaskSupervisorService(
    fx.repository,
    fx.orchestrator,
    runtime,
    {
      now: (): Date => fx.clock.now(),
      idFactory: (): string => `${prefix}-${++id}`,
    },
  );
}

async function goalSnapshot(fx: Fixture): Promise<GoalSnapshot> {
  return requireOk(await fx.goals.getGoal(actorA, { goalId: fx.lease.goalId }));
}

function acquiredRequest(goal: GoalSnapshot, lease: GoalLeaseProof): AutomationScheduledResumeRequest {  return {
    claimOutcome: 'recurring_acquired',
    goalId: goal.goalId,
    goalStatus: goal.status,
    goalRevision: goal.revision,
    userIntentRevision: goal.userIntentRevision,
    lease,
    acquisition: 'normal',
    runKey: '2026-09-19T01',
  };
}

function resumeService(
  fx: Fixture,
  runtime: AutomationTaskRuntimePort,
): AutomationScheduledResumeService {
  return new AutomationScheduledResumeService(
    fx.repository,
    fx.orchestrator,
    supervisor(fx, runtime, 'm8-resume-supervisor'),
    fx.integration,
    {
      now: (): Date => fx.clock.now(),
      idFactory: (): string => 'm8-resume-event',
    },
  );
}

describe('M8 native automation fault injection', () => {
  it('recovers a crash before child dispatch only after provider proves the reserved dispatch is absent', async () => {
    const fx = await fixture();
    const started = await fx.orchestrator.startCurrentAttempt({
      runId: 'run-1',
      expectedRevision: fx.readyRevision,
      authority: fx.authority,
    });
    if (started.currentAttemptId === undefined) throw new Error('missing attempt');
    const reserved = await fx.repository.commitTransition({
      runId: 'run-1',
      expectedRevision: started.revision,
      dispatchReceipts: [{
        id: 'receipt-before-child-dispatch',
        milestoneId: 'm1',
        attemptId: started.currentAttemptId,
        operationKey: 'build',
        state: 'reserved',
        provider: 'shell',
        idempotencyKey: 'build-before-dispatch',
      }],
      event: {
        id: 'event-before-child-dispatch',
        milestoneId: 'm1',
        attemptId: started.currentAttemptId,
        type: 'dispatch_recorded',
        reason: 'fault_injected_before_child_dispatch',
      },
      now: fx.clock.now().toISOString(),
    });

    const launch = vi.fn<AutomationTaskRuntimePort['launch']>();
    const resolveDispatch = vi.fn<AutomationTaskRuntimePort['resolveDispatch']>(async () => ({
      kind: 'absent',
      detail: 'provider proves no child task exists',
    }));
    const recovered = await supervisor(
      fx,
      taskRuntime({ launch, resolveDispatch }),
    ).dispatchCurrentAttempt({
      runId: 'run-1',
      expectedRevision: reserved.revision,
      authority: fx.authority,
      provider: 'shell',
      operationKey: 'build',
      idempotencyKey: 'build-before-dispatch',
    });

    expect(recovered.status).toBe('running');
    expect(recovered.currentAttemptId).toBeUndefined();
    expect(recovered.milestones[0]).toMatchObject({ status: 'retry_ready' });
    expect(resolveDispatch).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
  });

  it('recovers a crash after child dispatch but before receipt persistence by binding the discovered task', async () => {
    const fx = await fixture();
    const started = await fx.orchestrator.startCurrentAttempt({
      runId: 'run-1',
      expectedRevision: fx.readyRevision,
      authority: fx.authority,
    });
    if (started.currentAttemptId === undefined) throw new Error('missing attempt');
    const reserved = await fx.repository.commitTransition({
      runId: 'run-1',
      expectedRevision: started.revision,
      dispatchReceipts: [{
        id: 'receipt-before-dispatch-crash',
        milestoneId: 'm1',
        attemptId: started.currentAttemptId,
        operationKey: 'build',
        state: 'reserved',
        provider: 'shell',
        idempotencyKey: 'build-attempt-1',
      }],
      event: {
        id: 'event-before-dispatch-crash',
        milestoneId: 'm1',
        attemptId: started.currentAttemptId,
        type: 'dispatch_recorded',
        reason: 'fault_injected_before_child_dispatch',
      },
      now: fx.clock.now().toISOString(),
    });
    const launch = vi.fn<AutomationTaskRuntimePort['launch']>();
    const resolveDispatch = vi.fn<AutomationTaskRuntimePort['resolveDispatch']>(async () => ({
      kind: 'found',
      taskId: 'recovered-task',
    }));
    const recovered = await supervisor(
      fx,
      taskRuntime({ launch, resolveDispatch }),
    ).dispatchCurrentAttempt({
      runId: 'run-1',
      expectedRevision: reserved.revision,
      authority: fx.authority,
      provider: 'shell',
      operationKey: 'build',
      idempotencyKey: 'build-attempt-1',
    });

    expect(recovered.status).toBe('waiting_task');
    expect(recovered.taskBindings[0]).toMatchObject({ taskId: 'recovered-task' });
    expect(resolveDispatch).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
  });

  it('fails closed after dispatch transport ambiguity and never replays the external mutation', async () => {
    const fx = await fixture();
    const started = await fx.orchestrator.startCurrentAttempt({      runId: 'run-1',
      expectedRevision: fx.readyRevision,
      authority: fx.authority,
    });
    const launch = vi.fn<AutomationTaskRuntimePort['launch']>(async () => ({
      kind: 'uncertain',
      detail: 'transport disconnected after provider accepted the request',
    }));
    const first = supervisor(fx, taskRuntime({ launch }));
    const unresolved = await first.dispatchCurrentAttempt({
      runId: 'run-1',
      expectedRevision: started.revision,
      authority: fx.authority,
      provider: 'shell',
      operationKey: 'mutate-workspace',
      idempotencyKey: 'mutation-attempt-1',
    });
    expect(unresolved.status).toBe('blocked');
    expect(unresolved.dispatchReceipts[0]).toMatchObject({ state: 'dispatched_unresolved' });

    const replayLaunch = vi.fn<AutomationTaskRuntimePort['launch']>();
    const resolveDispatch = vi.fn<AutomationTaskRuntimePort['resolveDispatch']>(async () => ({
      kind: 'unknown',
      detail: 'provider cannot prove whether the mutation ran',
    }));    const recovered = await supervisor(
      fx,
      taskRuntime({ launch: replayLaunch, resolveDispatch }),
      'm8-restart',
    ).recoverUnresolvedDispatch({
      runId: 'run-1',
      expectedRevision: unresolved.revision,
      authority: fx.authority,
      operationKey: 'mutate-workspace',
    });

    expect(recovered.status).toBe('blocked');
    expect(recovered.lastRecoveryDecision).toContain('block_reconciliation');
    expect(resolveDispatch).toHaveBeenCalledTimes(1);
    expect(replayLaunch).not.toHaveBeenCalled();
  });

  it('resumes after task-terminal crash at verification rather than relaunching or reobserving work', async () => {
    const fx = await fixture();
    const started = await fx.orchestrator.startCurrentAttempt({
      runId: 'run-1',
      expectedRevision: fx.readyRevision,
      authority: fx.authority,
    });
    const first = supervisor(fx, taskRuntime());
    const waiting = await first.dispatchCurrentAttempt({
      runId: 'run-1',
      expectedRevision: started.revision,
      authority: fx.authority,
      provider: 'shell',
      operationKey: 'build',
      idempotencyKey: 'build-attempt-1',
    });
    const terminal = supervisor(fx, taskRuntime({
      async observe(): Promise<AutomationTaskObservationOutcome> {
        return {
          kind: 'observed',
          state: 'completed',
          terminalAt: fx.clock.now().toISOString(),
        };
      },
    }));
    const verifying = await terminal.observeCurrentTask({
      runId: 'run-1',
      expectedRevision: waiting.revision,
      authority: fx.authority,
    });
    expect(verifying.status).toBe('verifying');

    const launch = vi.fn<AutomationTaskRuntimePort['launch']>();
    const observe = vi.fn<AutomationTaskRuntimePort['observe']>();
    const goal = await goalSnapshot(fx);
    const resumed = await resumeService(
      fx,
      taskRuntime({ launch, observe }),
    ).resumeAfterClaim(actorA, acquiredRequest(goal, fx.lease));

    expect(resumed.action).toBe('verify_current_milestone');
    expect(resumed.run?.status).toBe('verifying');
    expect(launch).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it('keeps the automation run unchanged when durable-goal checkpoint storage fails', async () => {
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
    const failingGoals: AutomationGoalContinuationPort = {
      getGoal: (...args) => fx.goals.getGoal(...args),
      checkpointGoal: async () => err(appError(
        'INTERNAL_ERROR',
        'injected checkpoint storage failure',
        true,
      )),
      updateGoalAcceptance: (...args) => fx.goals.updateGoalAcceptance(...args),
      finishGoal: (...args) => fx.goals.finishGoal(...args),
    };
    const integration = new AutomationGoalIntegrationService(
      fx.repository,
      fx.orchestrator,
      failingGoals,
    );
    await expect(integration.verifyAndCompleteMilestone(actorA, {
      runId: 'run-1',
      expectedRevision: verifying.revision,
      authority: fx.authority,
      lease: fx.lease,
      evidence: [{ kind: 'note', value: 'verification passed before storage fault' }],
    })).rejects.toThrow(/checkpoint storage failure/i);

    const after = await fx.orchestrator.get('run-1');
    expect(after.revision).toBe(verifying.revision);
    expect(after.status).toBe('verifying');
    expect(after.milestones[0]).toMatchObject({ status: 'verifying' });
  });

  it('treats duplicate scheduled wakes as no-ops without advancing the automation revision', async () => {
    const fx = await fixture();
    const before = await fx.orchestrator.get('run-1');
    const goal = await goalSnapshot(fx);
    const launch = vi.fn<AutomationTaskRuntimePort['launch']>();
    const observed = await resumeService(
      fx,
      taskRuntime({ launch }),
    ).resumeAfterClaim(actorA, {
      claimOutcome: 'already_claimed',
      goalId: goal.goalId,
      goalStatus: goal.status,
      goalRevision: goal.revision,
      userIntentRevision: goal.userIntentRevision,
      runKey: '2026-09-19T01',
    });
    const after = await fx.orchestrator.get('run-1');

    expect(observed.action).toBe('scheduled_noop');
    expect(after.revision).toBe(before.revision);
    expect(launch).not.toHaveBeenCalled();
  });
  it('rejects an old worker lease generation after takeover even with the current authority cursor', async () => {
    const fx = await fixture();
    const started = await fx.orchestrator.startCurrentAttempt({
      runId: 'run-1',
      expectedRevision: fx.readyRevision,
      authority: fx.authority,
    });
    const waiting = await supervisor(fx, taskRuntime()).dispatchCurrentAttempt({
      runId: 'run-1',
      expectedRevision: started.revision,
      authority: fx.authority,
      provider: 'shell',
      operationKey: 'build',
      idempotencyKey: 'build-attempt-1',
    });

    fx.clock.advance(31_000);
    const takeover = requireOk(await fx.goals.runGoal(actorB, {
      workspaceId: 'workspace-1',
      goalKey: fx.goalKey,
      leaseSeconds: 30,
    }));
    expect(takeover.acquired).toBe(true);
    expect(takeover.leaseGeneration).toBeGreaterThan(fx.lease.leaseGeneration);
    const synced = await fx.repository.commitTransition({
      runId: 'run-1',
      expectedRevision: waiting.revision,
      runPatch: {
        basedOnGoalRevision: takeover.revision,
        basedOnUserIntentRevision: takeover.userIntentRevision,
      },
      event: {
        id: 'm8-takeover-sync',
        milestoneId: 'm1',
        attemptId: waiting.currentAttemptId,
        type: 'recovery_reconciled',
        reason: 'fault_test_takeover_authority_sync',
      },
      now: fx.clock.now().toISOString(),
    });

    await expect(fx.integration.checkpointTaskBound(actorB, {
      runId: 'run-1',
      expectedRevision: synced.revision,
      authority: {
        goalRevision: takeover.revision,
        userIntentRevision: takeover.userIntentRevision,
      },
      lease: fx.lease,
    })).rejects.toThrow(/lease generation changed/i);
    expect((await fx.orchestrator.get('run-1')).revision).toBe(synced.revision);
  });

  it('treats long-build observation disconnect as observation evidence and does not relaunch', async () => {
    const fx = await fixture();
    const started = await fx.orchestrator.startCurrentAttempt({
      runId: 'run-1',
      expectedRevision: fx.readyRevision,
      authority: fx.authority,
    });
    const launch = vi.fn<AutomationTaskRuntimePort['launch']>(async () => ({
      kind: 'started',
      taskId: 'long-build-task',
    }));
    const observe = vi.fn<AutomationTaskRuntimePort['observe']>(async () => ({
      kind: 'timeout',
      detail: 'transport disconnected while build continues',
    }));
    const runtime = taskRuntime({ launch, observe });
    const service = supervisor(fx, runtime);
    const waiting = await service.dispatchCurrentAttempt({
      runId: 'run-1',
      expectedRevision: started.revision,
      authority: fx.authority,
      provider: 'shell',
      operationKey: 'long-build',
      idempotencyKey: 'long-build-attempt-1',
    });
    const observed = await service.observeCurrentTask({
      runId: 'run-1',
      expectedRevision: waiting.revision,
      authority: fx.authority,
    });

    expect(observed.status).toBe('waiting_task');
    expect(observed.lastRecoveryDecision).toContain('observation_timeout:continue_observing');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it('records verification failure after a successful mutation without reporting milestone success', async () => {
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
    const failed = await fx.orchestrator.failCurrentAttempt({
      runId: 'run-1',
      expectedRevision: verifying.revision,
      authority: fx.authority,
      failureCode: 'verification_failed_after_mutation',
      failureDetail: 'post-mutation verification did not satisfy acceptance',
      retryable: false,
    });

    expect(failed.status).toBe('failed');
    expect(failed.milestones[0]).toMatchObject({ status: 'failed' });
    expect(failed.attempts[0]).toMatchObject({
      status: 'failed',
      failureCode: 'verification_failed_after_mutation',
    });
    const events = await fx.repository.listEvents('run-1', 50);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'verification_failed',
        reason: 'verification_failed_after_mutation',
      }),
    ]));
  });
});

function requireOk<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
