import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AutomationMilestoneSpec,
  type AutomationRetryClass,
} from '@lnwjud/domain';
import {
  SqliteAutomationRepository,
  SqliteDatabase,
  SqliteGoalRepository,
} from '@lnwjud/storage';
import { AutomationOrchestratorService } from './automation-orchestrator-service.js';
import {
  AutomationTaskSupervisorService,
  classifyAutomationRecovery,
  type AutomationCancelTaskOutcome,
  type AutomationResolveDispatchOutcome,
  type AutomationTaskLaunchOutcome,
  type AutomationTaskLaunchPortRequest,
  type AutomationTaskObservationOutcome,
  type AutomationTaskObservePortRequest,
  type AutomationTaskRuntimePort,
  type AutomationResolveDispatchPortRequest,
  type AutomationCancelTaskPortRequest,
} from './automation-task-supervisor-service.js';

const roots: string[] = [];
const AUTHORITY = { goalRevision: 0, userIntentRevision: 0 } as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MutableClock {
  public constructor(private value: number = Date.parse('2026-09-19T01:00:00.000Z')) {}
  public now(): Date { return new Date(this.value); }
  public advance(ms: number): void { this.value += ms; }
}

class FakeTaskRuntime implements AutomationTaskRuntimePort {
  public readonly launchCalls: AutomationTaskLaunchPortRequest[] = [];
  public readonly observeCalls: AutomationTaskObservePortRequest[] = [];
  public readonly resolveCalls: AutomationResolveDispatchPortRequest[] = [];
  public readonly cancelCalls: AutomationCancelTaskPortRequest[] = [];

  public launchOutcomes: AutomationTaskLaunchOutcome[] = [
    { kind: 'started', taskId: 'task-1' },
  ];
  public observeOutcomes: AutomationTaskObservationOutcome[] = [
    { kind: 'observed', state: 'running' },
  ];
  public resolveOutcomes: AutomationResolveDispatchOutcome[] = [
    { kind: 'unknown' },
  ];
  public cancelOutcomes: AutomationCancelTaskOutcome[] = [
    { kind: 'requested' },
  ];

  public async launch(request: AutomationTaskLaunchPortRequest): Promise<AutomationTaskLaunchOutcome> {
    this.launchCalls.push(request);
    return this.launchOutcomes.shift() ?? { kind: 'uncertain', detail: 'no fake launch outcome' };
  }

  public async observe(request: AutomationTaskObservePortRequest): Promise<AutomationTaskObservationOutcome> {
    this.observeCalls.push(request);
    return this.observeOutcomes.shift() ?? { kind: 'timeout', detail: 'no fake observation outcome' };
  }

  public async resolveDispatch(request: AutomationResolveDispatchPortRequest): Promise<AutomationResolveDispatchOutcome> {
    this.resolveCalls.push(request);
    return this.resolveOutcomes.shift() ?? { kind: 'unknown', detail: 'no fake resolution outcome' };
  }

  public async cancel(request: AutomationCancelTaskPortRequest): Promise<AutomationCancelTaskOutcome> {
    this.cancelCalls.push(request);
    return this.cancelOutcomes.shift() ?? { kind: 'unknown', detail: 'no fake cancellation outcome' };
  }
}

interface Fixture {
  readonly database: SqliteDatabase;
  readonly automation: SqliteAutomationRepository;
  readonly orchestrator: AutomationOrchestratorService;
  readonly supervisor: AutomationTaskSupervisorService;
  readonly runtime: FakeTaskRuntime;
  readonly clock: MutableClock;
  readonly dispatchRevision: number;
}

function milestone(
  retryClass: AutomationRetryClass = 'workspace_mutation',
  maxAttempts = 2,
): AutomationMilestoneSpec {
  return {
    id: 'm1',
    title: 'Run durable task',
    dependsOn: [],
    executionIntent: 'Run a durable background build task.',
    verificationRequirements: [{
      id: 'verify',
      title: 'Verify task output',
      kind: 'evidence',
      specification: 'Task must complete before verification.',
    }],
    retryPolicy: {
      classification: retryClass,
      maxAttempts,
    },
  };
}
async function fixture(
  retryClass: AutomationRetryClass = 'workspace_mutation',
  maxAttempts = 2,
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-task-supervisor-'));
  roots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
  database.connection.prepare(`
    INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('workspace-1', 'Task Supervisor Fixture', root, root, '2026-09-19T00:00:00.000Z');

  const goals = new SqliteGoalRepository(database);
  const acquired = await goals.acquire({
    goalId: 'goal-1',
    workspaceId: 'workspace-1',
    goalKey: 'm3-task-supervisor',
    ownerClientId: 'chatgpt-web-client',
    ownerSessionId: 'session-a',
    objective: 'Exercise durable task supervision.',
    plan: {
      steps: [{ id: 'm1', title: 'Run durable task', status: 'pending' }],
    },
    acceptanceCriteria: [],
    leaseTokenHash: 'lease-hash-a',
    leaseSeconds: 600,
    now: '2026-09-19T00:00:00.000Z',
  });
  expect(acquired.acquired).toBe(true);

  const automation = new SqliteAutomationRepository(database);
  const clock = new MutableClock();
  let orchestratorId = 0;
  const orchestrator = new AutomationOrchestratorService(automation, {
    now: (): Date => clock.now(),
    idFactory: (): string => `orch-${++orchestratorId}`,
  });
  await orchestrator.create({
    runId: 'run-1',
    goalId: 'goal-1',
    workspaceId: 'workspace-1',
    policyProfile: 'coding_guarded',
    authority: AUTHORITY,
    milestones: [milestone(retryClass, maxAttempts)],
  });
  const ready = await orchestrator.advance({
    runId: 'run-1',
    expectedRevision: 0,
    authority: AUTHORITY,
  });
  const started = await orchestrator.startCurrentAttempt({
    runId: 'run-1',
    expectedRevision: ready.revision,
    authority: AUTHORITY,
  });

  const runtime = new FakeTaskRuntime();
  let supervisorId = 0;
  const supervisor = new AutomationTaskSupervisorService(
    automation,
    orchestrator,
    runtime,
    {
      now: (): Date => clock.now(),
      idFactory: (): string => `sup-${++supervisorId}`,
    },
  );

  return {
    database,
    automation,
    orchestrator,
    supervisor,
    runtime,
    clock,
    dispatchRevision: started.revision,
  };
}

function dispatchRequest(expectedRevision: number, deadlineMs = 60_000): {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly authority: typeof AUTHORITY;
  readonly provider: 'shell';
  readonly operationKey: string;
  readonly idempotencyKey: string;
  readonly deadlineMs: number;
} {
  return {
    runId: 'run-1',
    expectedRevision,
    authority: AUTHORITY,
    provider: 'shell' as const,
    operationKey: 'build',
    idempotencyKey: 'dispatch-build-attempt-1',
    deadlineMs,
  };
}

describe('AutomationTaskSupervisorService dispatch', () => {
  it('reserves before launch, binds the durable handle, persists deadline, and replays without relaunch', async () => {
    const { database, supervisor, runtime, dispatchRevision } = await fixture();
    try {
      const dispatched = await supervisor.dispatchCurrentAttempt(dispatchRequest(dispatchRevision));

      expect(dispatched).toMatchObject({
        status: 'waiting_task',
        currentMilestoneId: 'm1',
      });
      expect(dispatched.taskBindings).toEqual([
        expect.objectContaining({
          provider: 'shell',
          taskId: 'task-1',
          role: 'blocking_job',
          cancelWithGoal: true,
          deadlineAt: '2026-09-19T01:01:00.000Z',
        }),
      ]);
      expect(dispatched.dispatchReceipts).toEqual([
        expect.objectContaining({
          state: 'confirmed',
          provider: 'shell',
          idempotencyKey: 'dispatch-build-attempt-1',
          externalId: 'task-1',
          deadlineAt: '2026-09-19T01:01:00.000Z',
        }),
      ]);
      expect(runtime.launchCalls).toHaveLength(1);

      const replayed = await supervisor.dispatchCurrentAttempt(dispatchRequest(dispatched.revision));
      expect(replayed.revision).toBe(dispatched.revision);
      expect(runtime.launchCalls).toHaveLength(1);
      expect(runtime.resolveCalls).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('resolves a pre-reserved dispatch after restart instead of blindly launching again', async () => {
    const { database, automation, supervisor, runtime, dispatchRevision } = await fixture();
    try {
      const reservedAt = '2026-09-19T01:00:00.000Z';
      const current = await automation.getRunById('run-1');
      expect(current).not.toBeNull();
      if (current === null || current.currentAttemptId === undefined) throw new Error('missing attempt fixture');

      const reserved = await automation.commitTransition({
        runId: 'run-1',
        expectedRevision: dispatchRevision,
        dispatchReceipts: [{
          id: 'receipt-restart',
          milestoneId: 'm1',
          attemptId: current.currentAttemptId,
          operationKey: 'build',
          state: 'reserved',
          provider: 'shell',
          idempotencyKey: 'dispatch-build-attempt-1',
          deadlineAt: '2026-09-19T01:01:00.000Z',
        }],
        event: {
          id: 'event-reserved-restart',
          milestoneId: 'm1',
          attemptId: current.currentAttemptId,
          type: 'dispatch_recorded',
          reason: 'simulated_crash_after_reservation',
        },
        now: reservedAt,
      });

      runtime.resolveOutcomes = [{ kind: 'found', taskId: 'task-recovered' }];
      const recovered = await supervisor.dispatchCurrentAttempt(dispatchRequest(reserved.revision));

      expect(runtime.launchCalls).toHaveLength(0);
      expect(runtime.resolveCalls).toHaveLength(1);
      expect(recovered.status).toBe('waiting_task');
      expect(recovered.taskBindings[0]).toMatchObject({
        taskId: 'task-recovered',
        deadlineAt: '2026-09-19T01:01:00.000Z',
      });
    } finally {
      database.close();
    }
  });
  it('blocks on uncertain launch and never converts transport ambiguity into an automatic retry', async () => {
    const { database, supervisor, runtime, dispatchRevision } = await fixture('safe_read');
    try {
      runtime.launchOutcomes = [{ kind: 'uncertain', detail: 'connection dropped after send' }];
      const unresolved = await supervisor.dispatchCurrentAttempt(dispatchRequest(dispatchRevision));

      expect(unresolved.status).toBe('blocked');
      expect(unresolved.attempts[0]).toMatchObject({ status: 'dispatch_unresolved' });
      expect(unresolved.dispatchReceipts[0]).toMatchObject({
        state: 'dispatched_unresolved',
        provider: 'shell',
      });
      expect(unresolved.taskBindings).toHaveLength(0);
      expect(unresolved.lastRecoveryDecision).toContain('dispatch_uncertain:block_reconciliation');
    } finally {
      database.close();
    }
  });

  it('retries only after provider proves an unresolved dispatch is absent', async () => {
    const { database, supervisor, runtime, dispatchRevision } = await fixture('workspace_mutation', 2);
    try {
      runtime.launchOutcomes = [{ kind: 'uncertain', detail: 'lost launch response' }];
      const unresolved = await supervisor.dispatchCurrentAttempt(dispatchRequest(dispatchRevision));
      runtime.resolveOutcomes = [{ kind: 'absent', detail: 'idempotency lookup returned no task' }];

      const recovered = await supervisor.recoverUnresolvedDispatch({
        runId: 'run-1',
        expectedRevision: unresolved.revision,
        authority: AUTHORITY,
        operationKey: 'build',
      });

      expect(recovered.status).toBe('running');
      expect(recovered.currentAttemptId).toBeUndefined();
      expect(recovered.milestones[0]).toMatchObject({ status: 'retry_ready' });
      expect(recovered.attempts[0]).toMatchObject({
        status: 'failed',
        failureCode: 'dispatch_absent',
      });
      expect(runtime.resolveCalls).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});

describe('AutomationTaskSupervisorService observation and recovery', () => {
  it('moves a completed durable task into verification and persists terminal observation', async () => {
    const { database, supervisor, runtime, dispatchRevision } = await fixture();
    try {
      const dispatched = await supervisor.dispatchCurrentAttempt(dispatchRequest(dispatchRevision));
      runtime.observeOutcomes = [{
        kind: 'observed',
        state: 'completed',
        terminalAt: '2026-09-19T01:00:30.000Z',
      }];

      const verifying = await supervisor.observeCurrentTask({
        runId: 'run-1',
        expectedRevision: dispatched.revision,
        authority: AUTHORITY,
      });

      expect(verifying.status).toBe('verifying');
      expect(verifying.milestones[0]).toMatchObject({ status: 'verifying' });
      expect(verifying.attempts[0]).toMatchObject({ status: 'verifying' });
      expect(verifying.taskBindings[0]).toMatchObject({
        lastState: 'completed',
        terminalAt: '2026-09-19T01:00:00.000Z',
      });
    } finally {
      database.close();
    }
  });

  it('treats observation timeout as transport evidence, not task failure or replay authority', async () => {
    const { database, supervisor, runtime, dispatchRevision } = await fixture('safe_read');
    try {
      const dispatched = await supervisor.dispatchCurrentAttempt(dispatchRequest(dispatchRevision));
      runtime.observeOutcomes = [{ kind: 'timeout', detail: 'status request exceeded 5s' }];

      const observed = await supervisor.observeCurrentTask({
        runId: 'run-1',
        expectedRevision: dispatched.revision,
        authority: AUTHORITY,
      });

      expect(observed.status).toBe('waiting_task');
      expect(observed.attempts[0]).toMatchObject({ status: 'waiting_task' });
      expect(observed.taskBindings[0]?.lastState).toBeUndefined();
      expect(observed.lastRecoveryDecision).toContain('observation_timeout:continue_observing');
      expect(runtime.launchCalls).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('uses retry budget for a safe terminal task failure', async () => {
    const { database, supervisor, runtime, dispatchRevision } = await fixture('safe_read', 2);
    try {
      const dispatched = await supervisor.dispatchCurrentAttempt(dispatchRequest(dispatchRevision));
      runtime.observeOutcomes = [{ kind: 'observed', state: 'failed', detail: 'read probe failed' }];

      const recovered = await supervisor.observeCurrentTask({
        runId: 'run-1',
        expectedRevision: dispatched.revision,
        authority: AUTHORITY,
      });

      expect(recovered.status).toBe('running');
      expect(recovered.currentAttemptId).toBeUndefined();
      expect(recovered.milestones[0]).toMatchObject({ status: 'retry_ready' });
      expect(recovered.attempts[0]).toMatchObject({
        status: 'failed',
        failureCode: 'task_failed',
      });
      expect(recovered.taskBindings[0]).toMatchObject({ lastState: 'failed' });
    } finally {
      database.close();
    }
  });
  it('blocks reconciliation instead of replaying a failed workspace mutation', async () => {
    const { database, supervisor, runtime, dispatchRevision } = await fixture('workspace_mutation', 3);
    try {
      const dispatched = await supervisor.dispatchCurrentAttempt(dispatchRequest(dispatchRevision));
      runtime.observeOutcomes = [{ kind: 'observed', state: 'failed', detail: 'compiler wrote partial outputs' }];

      const blocked = await supervisor.observeCurrentTask({
        runId: 'run-1',
        expectedRevision: dispatched.revision,
        authority: AUTHORITY,
      });

      expect(blocked.status).toBe('blocked');
      expect(blocked.currentAttemptId).toBeDefined();
      expect(blocked.milestones[0]).toMatchObject({ status: 'waiting_task' });
      expect(blocked.attempts[0]).toMatchObject({
        status: 'failed',
        failureCode: 'task_failed',
      });
      expect(blocked.lastRecoveryDecision).toContain('task_failed:block_reconciliation');
      expect(runtime.launchCalls).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('requests cancellation at deadline and waits for a verified terminal observation before retry', async () => {
    const { database, supervisor, runtime, clock, dispatchRevision } = await fixture('safe_read', 2);
    try {
      const dispatched = await supervisor.dispatchCurrentAttempt(dispatchRequest(dispatchRevision, 1_000));
      clock.advance(1_001);
      runtime.observeOutcomes = [{ kind: 'observed', state: 'running' }];
      runtime.cancelOutcomes = [{ kind: 'requested', detail: 'cancel signal accepted' }];

      const cancelling = await supervisor.observeCurrentTask({
        runId: 'run-1',
        expectedRevision: dispatched.revision,
        authority: AUTHORITY,
      });

      expect(cancelling.status).toBe('waiting_task');
      expect(cancelling.lastRecoveryDecision).toContain('task_deadline_exceeded:cancel_and_reobserve');
      expect(runtime.cancelCalls).toHaveLength(1);

      runtime.observeOutcomes = [{ kind: 'observed', state: 'cancelled' }];
      const retried = await supervisor.observeCurrentTask({
        runId: 'run-1',
        expectedRevision: cancelling.revision,
        authority: AUTHORITY,
      });
      expect(retried.milestones[0]).toMatchObject({ status: 'retry_ready' });
      expect(retried.currentAttemptId).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('blocks when deadline cancellation cannot be verified', async () => {
    const { database, supervisor, runtime, clock, dispatchRevision } = await fixture('safe_read');
    try {
      const dispatched = await supervisor.dispatchCurrentAttempt(dispatchRequest(dispatchRevision, 1_000));
      clock.advance(1_001);
      runtime.observeOutcomes = [{ kind: 'observed', state: 'running' }];
      runtime.cancelOutcomes = [{ kind: 'unknown', detail: 'cancel transport disconnected' }];

      const blocked = await supervisor.observeCurrentTask({
        runId: 'run-1',
        expectedRevision: dispatched.revision,
        authority: AUTHORITY,
      });

      expect(blocked.status).toBe('blocked');
      expect(blocked.lastRecoveryDecision).toContain('transport_interrupted:block_reconciliation');
      expect(blocked.attempts[0]).toMatchObject({ status: 'waiting_task' });
    } finally {
      database.close();
    }
  });

  it('blocks on a missing durable task handle rather than treating absence as completion', async () => {
    const { database, supervisor, runtime, dispatchRevision } = await fixture('safe_read');
    try {
      const dispatched = await supervisor.dispatchCurrentAttempt(dispatchRequest(dispatchRevision));
      runtime.observeOutcomes = [{ kind: 'not_found', detail: 'task registry has no matching handle' }];

      const blocked = await supervisor.observeCurrentTask({
        runId: 'run-1',
        expectedRevision: dispatched.revision,
        authority: AUTHORITY,
      });

      expect(blocked.status).toBe('blocked');
      expect(blocked.taskBindings[0]).toMatchObject({ lastState: 'not_found' });
      expect(blocked.lastRecoveryDecision).toContain('task_missing:block_reconciliation');
    } finally {
      database.close();
    }
  });
});

describe('automation recovery taxonomy', () => {
  it('separates observation transport failures, dispatch ambiguity, and safe terminal retries', () => {
    expect(classifyAutomationRecovery('observation_timeout', 'safe_read')).toMatchObject({
      action: 'continue_observing',
      retryable: false,
    });
    expect(classifyAutomationRecovery('dispatch_uncertain', 'safe_read')).toMatchObject({
      action: 'block_reconciliation',
      retryable: false,
    });
    expect(classifyAutomationRecovery('task_timed_out', 'safe_read')).toMatchObject({
      action: 'retry_attempt',
      retryable: true,
    });
    expect(classifyAutomationRecovery('task_timed_out', 'workspace_mutation')).toMatchObject({
      action: 'block_reconciliation',
      retryable: false,
    });
    expect(classifyAutomationRecovery('task_deadline_exceeded', 'safe_read')).toMatchObject({
      action: 'cancel_and_reobserve',
      retryable: false,
    });
  });
});
