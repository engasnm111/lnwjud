import { describe, expect, it, vi } from 'vitest';
import type {
  AutomationEventRecord,
  AutomationRepository,
  AutomationRunSnapshot,
  CommitAutomationTransitionRequest,
  CreateAutomationRunRecordRequest,
} from '@lnwjud/domain';
import {
  AutomationObservabilityService,
  ObservableAutomationRepository,
  projectAutomationEvent,
} from './automation-observability-service.js';

const RUN: AutomationRunSnapshot = {
  id: 'run-1',
  goalId: 'goal-1',
  workspaceId: 'workspace-1',
  policyProfile: 'coding_guarded',
  revision: 3,
  status: 'waiting_task',
  basedOnGoalRevision: 7,
  basedOnUserIntentRevision: 1,
  currentMilestoneId: 'm1',
  currentAttemptId: 'attempt-2',
  createdAt: '2026-09-19T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:12.000Z',
  milestones: [{
    id: 'm1',
    runId: 'run-1',
    ordinal: 0,
    title: 'Build',
    dependsOn: [],
    executionIntent: 'Build project',
    verificationRequirements: [],
    retryPolicy: { classification: 'workspace_mutation', maxAttempts: 3 },
    status: 'waiting_task',
    currentAttemptId: 'attempt-2',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:12.000Z',
  }],
  attempts: [{
    id: 'attempt-1',
    runId: 'run-1',
    milestoneId: 'm1',
    sequence: 1,
    basedOnRunRevision: 1,
    basedOnGoalRevision: 7,
    basedOnUserIntentRevision: 1,
    status: 'failed',
    failureCode: 'task_failed',
    verificationEvidence: [],
    startedAt: '2026-09-19T00:00:01.000Z',
    updatedAt: '2026-09-19T00:00:05.000Z',
    finishedAt: '2026-09-19T00:00:05.000Z',
  }, {
    id: 'attempt-2',
    runId: 'run-1',
    milestoneId: 'm1',
    sequence: 2,
    basedOnRunRevision: 2,
    basedOnGoalRevision: 7,
    basedOnUserIntentRevision: 1,
    status: 'waiting_task',
    verificationEvidence: [],
    startedAt: '2026-09-19T00:00:06.000Z',
    updatedAt: '2026-09-19T00:00:12.000Z',
  }],
  taskBindings: [{
    attemptId: 'attempt-2',
    provider: 'shell',
    taskId: 'task-2',
    role: 'blocking_job',
    cancelWithGoal: true,
    boundAt: '2026-09-19T00:00:10.000Z',
    lastObservedAt: '2026-09-19T00:00:12.000Z',
    lastState: 'running',
  }],
  dispatchReceipts: [{
    id: 'receipt-2',
    runId: 'run-1',
    milestoneId: 'm1',
    attemptId: 'attempt-2',
    operationKey: 'build',
    state: 'confirmed',
    provider: 'shell',
    externalId: 'task-2',
    createdAt: '2026-09-19T00:00:09.000Z',
    updatedAt: '2026-09-19T00:00:10.000Z',
  }],
};

const EVENT: AutomationEventRecord = {
  id: 'event-3',
  runId: 'run-1',
  milestoneId: 'm1',
  attemptId: 'attempt-2',
  revisionBefore: 2,
  revisionAfter: 3,
  type: 'task_recovery_decision',
  reason: 'task_timeout_reconciled',
  metadata: {
    classification: 'task_timed_out',
    action: 'retry_attempt',
    retryable: true,
    provider: 'shell',
    taskId: 'task-2',
    leaseGeneration: 9,
  },
  createdAt: '2026-09-19T00:00:12.000Z',
};

function repository(events: readonly AutomationEventRecord[] = [EVENT]): AutomationRepository {
  return {
    async createRun(): Promise<AutomationRunSnapshot> { return RUN; },
    async getRunById(): Promise<AutomationRunSnapshot | null> { return RUN; },
    async getRunByGoalId(): Promise<AutomationRunSnapshot | null> { return RUN; },
    async listRuns(): Promise<readonly AutomationRunSnapshot[]> { return [RUN]; },
    async commitTransition(): Promise<AutomationRunSnapshot> { return RUN; },
    async listEvents(): Promise<readonly AutomationEventRecord[]> { return events; },
  };
}

describe('AutomationObservabilityService', () => {
  it('builds a bounded dashboard/read model with required trace dimensions', async () => {
    const service = new AutomationObservabilityService(
      repository(),
      () => new Date('2026-09-19T00:00:20.000Z'),
    );

    const view = await service.readRun('run-1');
    expect(view).toMatchObject({
      runId: 'run-1',
      goalId: 'goal-1',
      workspaceId: 'workspace-1',
      status: 'waiting_task',
      currentMilestoneId: 'm1',
      currentAttemptId: 'attempt-2',
      latestTransition: 'task_recovery_decision',
      latestReason: 'task_timeout_reconciled',
      latestRecoveryClassification: 'task_timed_out',
      elapsedDurationMs: 20_000,
      retryCount: 1,
      milestones: [{
        id: 'm1',
        attemptCount: 2,
        retryCount: 1,
        tasks: [expect.objectContaining({
          provider: 'shell',
          taskId: 'task-2',
          state: 'running',
        })],
      }],
      recentEvents: [expect.objectContaining({
        milestoneId: 'm1',
        attemptId: 'attempt-2',
        taskProvider: 'shell',
        taskId: 'task-2',
        leaseGeneration: 9,
        recoveryClassification: 'task_timed_out',
        elapsedDurationMs: 12_000,
        retryCount: 1,
      })],
    });

    const dashboard = await service.dashboard(10, 10);
    expect(dashboard).toMatchObject({
      activeCount: 1,
      blockedCount: 0,
      waitingTaskCount: 1,
      completingCount: 0,
      recentRuns: [expect.objectContaining({ runId: 'run-1' })],
    });
    expect(JSON.stringify(dashboard)).not.toContain('leaseToken');
    expect(JSON.stringify(dashboard)).not.toContain('idempotencyKey');
  });

  it('projects policy and verification outcomes from stable journal events', () => {
    const policy = projectAutomationEvent(RUN, {
      ...EVENT,
      id: 'policy',
      type: 'policy_denied',
      reason: 'browser_or_desktop_control_denied',
      metadata: { provider: 'shell' },
    });
    const verification = projectAutomationEvent(RUN, {
      ...EVENT,
      id: 'verify',
      type: 'verification_passed',
      reason: 'verification_passed',
      metadata: {},
    });

    expect(policy.policyDecision).toBe('browser_or_desktop_control_denied');
    expect(verification.verificationOutcome).toBe('passed');
  });
});

describe('ObservableAutomationRepository', () => {
  it('emits committed transitions to audit without exposing raw lease material', async () => {
    const delegate = repository();
    const recordAutomationEvent = vi.fn(async () => undefined);
    const observed = new ObservableAutomationRepository(
      delegate,
      { recordAutomationEvent },
      { actorId: 'actor-1', actorName: 'test', sessionId: 'session-1' },
    );
    const request: CommitAutomationTransitionRequest = {
      runId: 'run-1',
      expectedRevision: 2,
      event: {
        id: 'event-3',
        milestoneId: 'm1',
        attemptId: 'attempt-2',
        type: 'task_recovery_decision',
        reason: 'task_timeout_reconciled',
        metadata: {
          classification: 'task_timed_out',
          leaseGeneration: 9,
        },
      },
      now: '2026-09-19T00:00:12.000Z',
    };

    await observed.commitTransition(request);

    expect(recordAutomationEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'event-3',
      runId: 'run-1',
      goalId: 'goal-1',
      milestoneId: 'm1',
      attemptId: 'attempt-2',
      taskProvider: 'shell',
      taskId: 'task-2',
      leaseGeneration: 9,
      recoveryClassification: 'task_timed_out',
      elapsedDurationMs: 12_000,
      retryCount: 1,
      resultCode: 'UNKNOWN',
    }));
    expect(JSON.stringify(recordAutomationEvent.mock.calls)).not.toContain('leaseToken');
  });

  it('does not roll back authoritative state when the audit sink fails', async () => {
    const onAuditError = vi.fn();
    const observed = new ObservableAutomationRepository(
      repository(),
      { async recordAutomationEvent(): Promise<void> { throw new Error('audit unavailable'); } },
      { actorId: 'actor-1', actorName: 'test' },
      { onAuditError },
    );

    await expect(observed.commitTransition({
      runId: 'run-1',
      expectedRevision: 2,
      event: {
        id: 'event-3',
        type: 'task_observed',
        reason: 'task_still_running',
      },
      now: '2026-09-19T00:00:12.000Z',
    })).resolves.toBe(RUN);
    expect(onAuditError).toHaveBeenCalledTimes(1);
  });

  it('keeps committed state successful even when the audit diagnostic callback also throws', async () => {
    const observed = new ObservableAutomationRepository(
      repository(),
      { async recordAutomationEvent(): Promise<void> { throw new Error('audit unavailable'); } },
      { actorId: 'actor-1', actorName: 'test' },
      { onAuditError: (): void => { throw new Error('diagnostic unavailable'); } },
    );

    await expect(observed.commitTransition({
      runId: 'run-1',
      expectedRevision: 2,
      event: {
        id: 'event-3',
        type: 'task_observed',
        reason: 'task_still_running',
      },
      now: '2026-09-19T00:00:12.000Z',
    })).resolves.toBe(RUN);
  });

  it('does not duplicate run-created audit projection on idempotent create replay', async () => {
    const createRequest: CreateAutomationRunRecordRequest = {
      runId: 'run-1',
      goalId: 'goal-1',
      workspaceId: 'workspace-1',
      policyProfile: 'coding_guarded',
      basedOnGoalRevision: 7,
      basedOnUserIntentRevision: 1,
      milestones: [],
      createdAt: RUN.createdAt,
      eventId: 'created-event',
    };
    const delegate: AutomationRepository = {
      ...repository(),
      async getRunByGoalId(): Promise<AutomationRunSnapshot | null> { return RUN; },
    };
    const recordAutomationEvent = vi.fn(async () => undefined);
    const observed = new ObservableAutomationRepository(
      delegate,
      { recordAutomationEvent },
      { actorId: 'actor-1', actorName: 'test' },
    );

    await observed.createRun(createRequest);
    expect(recordAutomationEvent).not.toHaveBeenCalled();
  });
});
