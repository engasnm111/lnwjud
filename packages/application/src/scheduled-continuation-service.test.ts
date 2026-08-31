import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScheduledContinuationWorkerLivenessPort } from '@lnwjud/domain';
import type { FileActor } from './file-service.js';
import { GoalContinuationService, type RunGoalResult } from './goal-continuation-service.js';
import { ScheduledContinuationService, type PrepareScheduledContinuationRequest } from './scheduled-continuation-service.js';
import { SqliteDatabase } from '../../storage/src/database.js';
import { SqliteGoalRepository } from '../../storage/src/goal-repository.js';
import { SqliteWorkspaceRepository } from '../../storage/src/workspace-repository.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const actor: FileActor = {
  clientId: 'chatgpt-web-client',
  clientName: 'ChatGPT Web',
  sessionId: 'scheduled-continuation-test',
};

interface ScheduledContinuationFixture {
  readonly database: SqliteDatabase;
  readonly repository: SqliteGoalRepository;
  readonly goals: GoalContinuationService;
  readonly scheduled: ScheduledContinuationService;
  readonly clock: { readonly now: () => Date; readonly set: (value: string) => void };
}

async function fixture(
  isoNow = '2026-08-27T10:00:00.000Z',
  workerLiveness?: ScheduledContinuationWorkerLivenessPort,
): Promise<ScheduledContinuationFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-scheduled-application-'));
  temporaryRoots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
  const workspaces = new SqliteWorkspaceRepository(database);
  await workspaces.insert({
    id: 'workspace-1',
    displayName: 'Fixture',
    rootPath: root,
    realRootPath: root,
    createdAt: isoNow,
  });
  const repository = new SqliteGoalRepository(database);
  let now = new Date(isoNow);
  const clock = {
    now: (): Date => now,
    set: (value: string): void => { now = new Date(value); },
  };
  const goals = new GoalContinuationService(workspaces, repository, {
    now: clock.now,
    scheduledContinuations: repository,
  });
  const scheduled = new ScheduledContinuationService(repository, {
    now: clock.now,
    ...(workerLiveness === undefined ? {} : { workerLiveness }),
  });
  return { database, repository, goals, scheduled, clock };
}

async function startGoal(goals: GoalContinuationService, objective = 'Finish the durable goal safely.'): Promise<RunGoalResult> {
  const result = await goals.runGoal(actor, {
    workspaceId: 'workspace-1',
    goalKey: 'scheduled-application-test',
    objective,
    plan: { steps: [{ id: 'implement', title: 'Implement the continuation path' }] },
    leaseSeconds: 600,
  });
  expect(result.ok).toBe(true);
  if (!result.ok || result.value.leaseToken === undefined) throw new Error('failed to start goal');
  return result.value;
}

function validPrepare(started: Awaited<ReturnType<typeof startGoal>>, overrides: Record<string, unknown> = {}): PrepareScheduledContinuationRequest {
  return {
    goalId: started.goalId,
    leaseToken: started.leaseToken!,
    expectedRevision: started.revision,
    currentPhase: 'implementation',
    summary: 'Implementation is ready for a successor.',
    stepUpdates: [],
    nextAction: 'Continue implementation from the current checkpoint.',
    blockers: [],
    evidence: [],
    activeTaskIds: [],
    successorDelayMinutes: 25,
    executionPreference: 'cloud',
    ...overrides,
  };
}

describe('ScheduledContinuationService', () => {
  it('defaults an omitted successor delay to the fail-safe two-minute handoff', async () => {
    const { database, goals, scheduled } = await fixture();
    try {
      const started = await startGoal(goals);
      const result = await scheduled.prepareScheduledContinuation(actor, validPrepare(started, { successorDelayMinutes: undefined }));
      expect(result).toMatchObject({
        ok: true,
        value: {
          outcome: 'prepared',
          currentRunMayContinue: true,
          handoffDeadlineAt: '2026-08-27T10:02:00.000Z',
          scheduleRequest: { dueAt: '2026-08-27T10:02:00.000Z' },
          goal: { revision: 1, leaseExpiresAt: '2026-08-27T10:02:00.000Z' },
        },
      });
    } finally {
      database.close();
    }
  });

  it('allows an explicit 25-minute watchdog while the current run remains healthy', async () => {
    const { database, goals, scheduled } = await fixture();
    try {
      const started = await startGoal(goals);
      const result = await scheduled.prepareScheduledContinuation(actor, validPrepare(started));
      expect(result).toMatchObject({
        ok: true,
        value: {
          outcome: 'prepared',
          currentRunMayContinue: true,
          handoffDeadlineAt: '2026-08-27T10:25:00.000Z',
          scheduleRequest: {
            provider: 'chatgpt_scheduled_task',
            occurrence: 'once',
            destination: 'current_chat',
            dueAt: '2026-08-27T10:25:00.000Z',
            executionPreference: 'cloud',
          },
          goal: { revision: 1, leaseExpiresAt: '2026-08-27T10:10:00.000Z' },
        },
      });
    } finally {
      database.close();
    }
  });

  it('uses an adaptive five-minute successor for bounded near-term work', async () => {
    const { database, goals, scheduled } = await fixture();
    try {
      const started = await startGoal(goals);
      const result = await scheduled.prepareScheduledContinuation(actor, validPrepare(started, {
        successorDelayMinutes: 5,
        currentPhase: 'final-verification',
        nextAction: 'Read the running package result and close the goal.',
      }));
      expect(result).toMatchObject({
        ok: true,
        value: {
          handoffDeadlineAt: '2026-08-27T10:05:00.000Z',
          scheduleRequest: { dueAt: '2026-08-27T10:05:00.000Z' },
          goal: { leaseExpiresAt: '2026-08-27T10:05:00.000Z' },
        },
      });
    } finally {
      database.close();
    }
  });

  it('rejects successor delays outside the adaptive two-to-25-minute window, non-cloud execution, empty nextAction, stale revision, and caller-controlled releaseLease', async () => {
    const { database, goals, scheduled } = await fixture();
    try {
      const started = await startGoal(goals);
      for (const successorDelayMinutes of [1, 2.5, 26]) {
        const result = await scheduled.prepareScheduledContinuation(actor, validPrepare(started, { successorDelayMinutes }));
        expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      }
      for (const executionPreference of ['auto', 'local']) {
        const result = await scheduled.prepareScheduledContinuation(actor, validPrepare(started, { executionPreference }));
        expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      }
      await expect(scheduled.prepareScheduledContinuation(actor, validPrepare(started, { nextAction: '   ' })))
        .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      await expect(scheduled.prepareScheduledContinuation(actor, validPrepare(started, { expectedRevision: 1 })))
        .resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      await expect(scheduled.prepareScheduledContinuation(actor, {
        ...validPrepare(started),
        releaseLease: true,
      } as never)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally {
      database.close();
    }
  });

  it('rejects prepare after the goal is terminal', async () => {
    const { database, goals, scheduled } = await fixture();
    try {
      const started = await startGoal(goals);
      const finished = await goals.finishGoal(actor, {
        goalId: started.goalId,
        leaseToken: started.leaseToken!,
        expectedRevision: started.revision,
        status: 'completed',
        summary: 'Done before scheduling.',
        evidence: [],
      });
      expect(finished.ok).toBe(true);
      await expect(scheduled.prepareScheduledContinuation(actor, validPrepare(started)))
        .resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    } finally {
      database.close();
    }
  });

  it('never puts objective, nextAction, summary, evidence, lease token, or arbitrary work text in the native prompt', async () => {
    const { database, goals, scheduled } = await fixture();
    try {
      const markers = {
        objective: 'OBJECTIVE_MARKER_73491',
        summary: 'SUMMARY_MARKER_73492',
        next: 'NEXT_MARKER_73493',
        evidence: 'EVIDENCE_MARKER_73494',
      };
      const started = await startGoal(goals, markers.objective);
      const result = await scheduled.prepareScheduledContinuation(actor, validPrepare(started, {
        summary: markers.summary,
        nextAction: markers.next,
        evidence: [{ kind: 'note', value: markers.evidence }],
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('prepare failed');
      const serialized = JSON.stringify(result.value.scheduleRequest);
      for (const marker of Object.values(markers)) expect(serialized).not.toContain(marker);
      expect(serialized).not.toContain(started.leaseToken!);
      expect(result.value.scheduleRequest.prompt).toContain('claim_scheduled_continuation');
      expect(result.value.scheduleRequest.prompt).toContain('successor_required');
      expect(result.value.scheduleRequest.prompt).toContain('consumed wake ticket');
      expect(result.value.scheduleRequest.prompt).toContain('must never be reused as a future successor');
      expect(result.value.scheduleRequest.prompt).toContain('do not update or re-arm the firing native task');
      expect(result.value.scheduleRequest.prompt).toContain('adaptive delay between 2 and 25 minutes');
      expect(result.value.scheduleRequest.prompt).toContain('Omitted delay fails safe to +2 minutes');
      expect(result.value.scheduleRequest.prompt).toContain('5/10/25 minutes only as an explicit watchdog');
      expect(result.value.scheduleRequest.prompt).toContain('no worker will remain after the response');
      expect(result.value.scheduleRequest.prompt).toContain('Never send a completion response while get_goal still reports active');
      expect(result.value.scheduleRequest.prompt).toContain('finish_goal');
      expect(result.value.scheduleRequest.prompt).toContain('Never report cancellation as successful');
      expect(result.value.scheduleRequest.prompt).toContain('native host deletion receipt');
      expect(result.value.scheduleRequest.prompt).toContain('claim returns terminal_noop');
      expect(result.value.scheduleRequest.prompt).toContain('do not delete, disable, pause, or reschedule the current host task');
      expect(result.value.scheduleRequest.prompt).toContain('return naturally so the host can mark the one-time run completed');
      expect(result.value.scheduleRequest.prompt).toContain('Never use Windows Task Scheduler');
      expect(result.value.scheduleRequest.prompt).toContain(started.goalId);
      expect(result.value.scheduleRequest.prompt).toContain('workspace-1');
    } finally {
      database.close();
    }
  });

  it('consumes a firing one-time wake and returns a fresh +2 successor when a live worker owns the lease', async () => {
    const { database, goals, scheduled, clock } = await fixture();
    const successorActor: FileActor = { ...actor, sessionId: 'scheduled-continuation-successor' };
    try {
      const started = await startGoal(goals);
      const prepared = await scheduled.prepareScheduledContinuation(actor, validPrepare(started));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('prepare failed');
      const receipt = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-b',
        runsOn: 'cloud',
      });
      expect(receipt.ok).toBe(true);
      database.connection.prepare('UPDATE goals SET lease_expires_at = ? WHERE id = ?')
        .run('2026-08-27T10:30:00.000Z', started.goalId);

      clock.set('2026-08-27T10:25:00.000Z');
      const collision = await scheduled.claimScheduledContinuation(successorActor, {
        continuationId: prepared.value.continuation.continuationId,
      });
      expect(collision).toMatchObject({
        ok: true,
        value: {
          outcome: 'successor_required',
          retryAfterSeconds: 120,
          continuation: {
            continuationId: prepared.value.continuation.continuationId,
            nativeTaskId: 'native-task-b',
            status: 'superseded',
          },
          successor: {
            generation: prepared.value.continuation.generation + 1,
            status: 'prepared',
            dueAt: '2026-08-27T10:27:00.000Z',
          },
          scheduleRequest: {
            occurrence: 'once',
            dueAt: '2026-08-27T10:27:00.000Z',
            destination: 'current_chat',
            executionPreference: 'cloud',
          },
        },
      });
      if (!collision.ok || collision.value.outcome !== 'successor_required') throw new Error('fresh collision successor missing');
      expect(collision.value.successor.nativeTaskId).toBeUndefined();
      expect(collision.value.scheduleRequest.continuationId).toBe(collision.value.successor.continuationId);
      expect(collision.value.scheduleRequest.prompt).toContain('consumed wake ticket');
      expect(collision.value.scheduleRequest.prompt).toContain('successor_required');
      expect(collision.value.scheduleRequest.prompt).toContain('do not update or re-arm the firing native task');
      expect(JSON.stringify(collision.value.scheduleRequest)).not.toContain('native-task-b');

      const created = await scheduled.recordScheduledContinuationReceipt(successorActor, {
        continuationId: collision.value.successor.continuationId,
        expectedVersion: collision.value.successor.version,
        outcome: 'created',
        nativeTaskId: 'native-task-c',
        runsOn: 'cloud',
      });
      expect(created).toMatchObject({ ok: true, value: { status: 'scheduled', nativeTaskId: 'native-task-c' } });

      const repeated = await scheduled.claimScheduledContinuation(successorActor, {
        continuationId: prepared.value.continuation.continuationId,
      });
      expect(repeated).toMatchObject({ ok: true, value: { outcome: 'already_claimed' } });
    } finally {
      database.close();
    }
  });

  it('rejects scheduled-wake lease requests above the 10-minute maximum', async () => {
    const { database, scheduled } = await fixture();
    try {
      await expect(scheduled.claimScheduledContinuation(actor, {
        continuationId: 'any-continuation',
        leaseSeconds: 601,
      })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      await expect(scheduled.claimScheduledContinuation(actor, {
        continuationId: 'any-continuation',
        leaseSeconds: 3_600,
      })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    } finally {
      database.close();
    }
  });

  it('does not create a retry task before the T+25 successor is due', async () => {
    const { database, goals, scheduled, clock } = await fixture();
    try {
      const started = await startGoal(goals);
      const prepared = await scheduled.prepareScheduledContinuation(actor, validPrepare(started));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('prepare failed');

      clock.set('2026-08-27T10:02:00.000Z');
      const earlyWake = await scheduled.claimScheduledContinuation(actor, {
        continuationId: prepared.value.continuation.continuationId,
      });
      expect(earlyWake).toMatchObject({
        ok: true,
        value: {
          outcome: 'not_due',
          retryAfterSeconds: 1_380,
          continuation: { continuationId: prepared.value.continuation.continuationId },
        },
      });
      expect(JSON.stringify(earlyWake)).not.toContain('retry_prepared');
      expect(JSON.stringify(earlyWake)).not.toContain('previousContinuationId');
    } finally {
      database.close();
    }
  });

  it('accepts an observed 74-second early cloud wake within the 120-second jitter tolerance', async () => {
    const { database, goals, scheduled, clock } = await fixture('2026-08-27T10:00:46.000Z');
    const successorActor: FileActor = { ...actor, sessionId: 'scheduled-continuation-early-wake' };
    try {
      const started = await startGoal(goals);
      const prepared = await scheduled.prepareScheduledContinuation(actor, validPrepare(started));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('prepare failed');
      const receipt = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-early-wake',
        runsOn: 'cloud',
      });
      expect(receipt.ok).toBe(true);
      database.connection.prepare('UPDATE goals SET lease_expires_at = ? WHERE id = ?')
        .run('2026-08-27T10:24:00.000Z', started.goalId);

      clock.set('2026-08-27T10:24:32.000Z');
      await expect(scheduled.claimScheduledContinuation(successorActor, {
        continuationId: prepared.value.continuation.continuationId,
      })).resolves.toMatchObject({
        ok: true,
        value: {
          outcome: 'acquired',
          acquisition: 'expired_lease',
          goal: { status: 'active' },
        },
      });
    } finally {
      database.close();
    }
  });

  it('keeps a wake more than 120 seconds early in not_due state', async () => {
    const { database, goals, scheduled, clock } = await fixture('2026-08-27T10:00:46.000Z');
    try {
      const started = await startGoal(goals);
      const prepared = await scheduled.prepareScheduledContinuation(actor, validPrepare(started));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('prepare failed');

      clock.set('2026-08-27T10:23:45.000Z');
      await expect(scheduled.claimScheduledContinuation(actor, {
        continuationId: prepared.value.continuation.continuationId,
      })).resolves.toMatchObject({
        ok: true,
        value: { outcome: 'not_due', retryAfterSeconds: 121 },
      });
    } finally {
      database.close();
    }
  });

  it('reconciles a host-consumed task without claiming goal completion, then allows a fresh successor and clean finish', async () => {
    const { database, goals, scheduled, clock } = await fixture();
    try {
      const started = await startGoal(goals);
      const prepared = await scheduled.prepareScheduledContinuation(actor, validPrepare(started));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('prepare failed');
      const created = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-consumed',
        runsOn: 'cloud',
      });
      expect(created).toMatchObject({ ok: true, value: { status: 'scheduled', version: 1 } });
      if (!created.ok) throw new Error('created receipt failed');

      await expect(scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: created.value.continuationId,
        expectedVersion: created.value.version,
        outcome: 'consumed',
      })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

      clock.set('2026-08-27T10:00:06.000Z');
      const consumed = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: created.value.continuationId,
        expectedVersion: created.value.version,
        outcome: 'consumed',
        nativeRunReceipt: {
          provider: 'chatgpt_scheduled_task',
          operation: 'run',
          nativeTaskId: 'native-task-consumed',
          state: 'consumed',
          observedAt: '2026-08-27T10:00:05.000Z',
        },
      });
      expect(consumed).toMatchObject({ ok: true, value: { status: 'superseded', nativeTaskId: 'native-task-consumed' } });

      const replacement = await scheduled.prepareScheduledContinuation(actor, validPrepare(started, {
        expectedRevision: prepared.value.goal.revision,
        currentPhase: 'host-consumption-recovery',
        summary: 'The native host consumed the previous one-time task before claim completed.',
        nextAction: 'Create a fresh successor without treating the consumed task as completed work.',
        successorDelayMinutes: 10,
      }));
      expect(replacement).toMatchObject({
        ok: true,
        value: { outcome: 'prepared', continuation: { generation: 2, status: 'prepared' }, goal: { revision: 2 } },
      });
      if (!replacement.ok) throw new Error('replacement prepare failed');

      const finished = await goals.finishGoal(actor, {
        goalId: started.goalId,
        leaseToken: started.leaseToken!,
        expectedRevision: replacement.value.goal.revision,
        status: 'completed',
        summary: 'Goal completed after host-consumption recovery.',
        evidence: [],
      });
      expect(finished).toMatchObject({
        ok: true,
        value: { status: 'completed', scheduledTaskCancellation: { action: 'none', reason: 'no_live_task' } },
      });
    } finally {
      database.close();
    }
  });

  it('reconciles an already-consumed native successor after finish without fake deletion or reopening the goal', async () => {
    const { database, goals, scheduled, clock } = await fixture();
    try {
      const started = await startGoal(goals);
      const prepared = await scheduled.prepareScheduledContinuation(actor, validPrepare(started));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('prepare failed');

      const created = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-finish-consumed',
        runsOn: 'cloud',
      });
      expect(created).toMatchObject({ ok: true, value: { status: 'scheduled' } });
      if (!created.ok) throw new Error('created receipt failed');

      clock.set('2026-08-27T10:00:10.000Z');
      const finished = await goals.finishGoal(actor, {
        goalId: started.goalId,
        leaseToken: started.leaseToken!,
        expectedRevision: prepared.value.goal.revision,
        status: 'completed',
        summary: 'Completed while the native successor was racing with its one-time host run.',
        evidence: [],
      });
      expect(finished).toMatchObject({
        ok: true,
        value: {
          status: 'completed',
          scheduledTaskCancellation: {
            action: 'delete_native_task',
            nativeTaskId: 'native-task-finish-consumed',
          },
        },
      });

      const cancelRequired = await scheduled.getScheduledContinuation(actor, { goalId: started.goalId, latest: true });
      expect(cancelRequired).toMatchObject({ ok: true, value: { status: 'cancel_required' } });
      if (!cancelRequired.ok) throw new Error('cancel-required continuation missing');

      clock.set('2026-08-27T10:00:12.000Z');
      const consumed = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: cancelRequired.value.continuationId,
        expectedVersion: cancelRequired.value.version,
        outcome: 'consumed',
        nativeRunReceipt: {
          provider: 'chatgpt_scheduled_task',
          operation: 'run',
          nativeTaskId: 'native-task-finish-consumed',
          state: 'consumed',
          observedAt: '2026-08-27T10:00:11.000Z',
        },
      });
      expect(consumed).toMatchObject({ ok: true, value: { status: 'superseded' } });
      await expect(goals.getGoal(actor, { goalId: started.goalId }))
        .resolves.toMatchObject({ ok: true, value: { status: 'completed' } });
    } finally {
      database.close();
    }
  });

  it('finishes first, returns exact native cancellation guidance, records cancellation, and terminal-noops a late wake', async () => {
    const { database, goals, scheduled, clock } = await fixture();
    const lateWakeActor: FileActor = { ...actor, sessionId: 'scheduled-continuation-late-wake' };
    try {
      const started = await startGoal(goals);
      const prepared = await scheduled.prepareScheduledContinuation(actor, validPrepare(started));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('prepare failed');

      clock.set('2026-08-27T10:00:05.000Z');
      const scheduledReceipt = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-c',
        runsOn: 'cloud',
      });
      expect(scheduledReceipt).toMatchObject({ ok: true, value: { status: 'scheduled', nativeTaskId: 'native-task-c' } });

      clock.set('2026-08-27T10:00:10.000Z');
      const finished = await goals.finishGoal(actor, {
        goalId: started.goalId,
        leaseToken: started.leaseToken!,
        expectedRevision: prepared.value.goal.revision,
        status: 'completed',
        summary: 'Completed while successor C was still pending.',
        evidence: [],
      });
      expect(finished).toMatchObject({
        ok: true,
        value: {
          status: 'completed',
          scheduledTaskCancellation: {
            action: 'delete_native_task',
            continuationId: prepared.value.continuation.continuationId,
            nativeTaskId: 'native-task-c',
            provider: 'chatgpt_scheduled_task',
            expectedContinuationVersion: 2,
            receiptRequired: true,
            reason: 'live_task_confirmed',
          },
        },
      });

      const cancelRequired = await scheduled.getScheduledContinuation(actor, { goalId: started.goalId, latest: true });
      expect(cancelRequired).toMatchObject({ ok: true, value: { status: 'cancel_required', nativeTaskId: 'native-task-c' } });
      if (!cancelRequired.ok) throw new Error('cancel-required continuation missing');

      clock.set('2026-08-27T10:00:15.000Z');
      const cancelled = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: cancelRequired.value.continuationId,
        expectedVersion: cancelRequired.value.version,
        outcome: 'cancelled',
        nativeCancellationReceipt: {
          provider: 'chatgpt_scheduled_task',
          operation: 'delete',
          nativeTaskId: 'native-task-c',
          state: 'deleted',
          observedAt: '2026-08-27T10:00:15.000Z',
        },
      });
      expect(cancelled).toMatchObject({ ok: true, value: { status: 'cancelled' } });

      clock.set('2026-08-27T10:02:00.000Z');
      await expect(scheduled.claimScheduledContinuation(lateWakeActor, {
        continuationId: prepared.value.continuation.continuationId,
      })).resolves.toMatchObject({ ok: true, value: { outcome: 'terminal_noop', goal: { status: 'completed' } } });
    } finally {
      database.close();
    }
  });

  it('refuses a bare cancellation claim and preserves the pending native deletion', async () => {
    const { database, goals, scheduled, clock } = await fixture();
    try {
      const started = await startGoal(goals);
      const prepared = await scheduled.prepareScheduledContinuation(actor, validPrepare(started));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('prepare failed');

      const created = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-unverified-cancel',
        runsOn: 'cloud',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error('created receipt failed');

      clock.set('2026-08-27T10:00:10.000Z');
      const finished = await goals.finishGoal(actor, {
        goalId: started.goalId,
        leaseToken: started.leaseToken!,
        expectedRevision: prepared.value.goal.revision,
        status: 'completed',
        summary: 'Finished before the native successor fired.',
        evidence: [],
      });
      expect(finished.ok).toBe(true);

      const cancellation = await scheduled.getScheduledContinuation(actor, { goalId: started.goalId, latest: true });
      expect(cancellation).toMatchObject({ ok: true, value: { status: 'cancel_required' } });
      if (!cancellation.ok) throw new Error('cancellation state missing');

      const falseClaim = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: cancellation.value.continuationId,
        expectedVersion: cancellation.value.version,
        outcome: 'cancelled',
        nativeTaskId: 'native-task-unverified-cancel',
      });
      expect(falseClaim).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

      await expect(scheduled.getScheduledContinuation(actor, { goalId: started.goalId, latest: true }))
        .resolves.toMatchObject({ ok: true, value: { status: 'cancel_required', nativeTaskId: 'native-task-unverified-cancel' } });
    } finally {
      database.close();
    }
  });

  it('cancels a scheduled continuation independently while leaving the active goal unchanged until a host receipt arrives', async () => {
    const { database, goals, scheduled } = await fixture();
    try {
      const started = await startGoal(goals);
      const prepared = await scheduled.prepareScheduledContinuation(actor, validPrepare(started));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('prepare failed');
      const created = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-independent-cancel',
        runsOn: 'cloud',
      });
      expect(created).toMatchObject({ ok: true, value: { status: 'scheduled', version: 1 } });
      if (!created.ok) throw new Error('create receipt failed');

      const requested = await scheduled.cancelScheduledContinuation(actor, {
        continuationId: created.value.continuationId,
        expectedVersion: created.value.version,
      });
      expect(requested).toMatchObject({
        ok: true,
        value: {
          outcome: 'delete_required',
          continuation: { status: 'cancel_required', nativeTaskId: 'native-independent-cancel', version: 2 },
          cancellation: {
            action: 'delete_native_task',
            nativeTaskId: 'native-independent-cancel',
            expectedContinuationVersion: 2,
            receiptRequired: true,
          },
        },
      });
      expect(await goals.getGoal(actor, { goalId: started.goalId })).toMatchObject({ ok: true, value: { status: 'active' } });
      if (!requested.ok) throw new Error('cancel request failed');

      const receipt = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: requested.value.continuation.continuationId,
        expectedVersion: requested.value.continuation.version,
        outcome: 'cancelled',
        nativeCancellationReceipt: {
          provider: 'chatgpt_scheduled_task',
          operation: 'delete',
          nativeTaskId: 'native-independent-cancel',
          state: 'deleted',
          observedAt: '2026-08-27T10:00:05.000Z',
        },
      });
      expect(receipt).toMatchObject({ ok: true, value: { status: 'cancelled' } });
    } finally {
      database.close();
    }
  });

  it('supersedes a prepared continuation with no native task without requesting a host deletion', async () => {
    const { database, goals, scheduled } = await fixture();
    try {
      const started = await startGoal(goals);
      const prepared = await scheduled.prepareScheduledContinuation(actor, validPrepare(started));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('prepare failed');

      const cancelled = await scheduled.cancelScheduledContinuation(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
      });
      expect(cancelled).toMatchObject({
        ok: true,
        value: {
          outcome: 'cancelled',
          continuation: { status: 'superseded' },
          cancellation: { action: 'none', reason: 'no_live_task' },
        },
      });
    } finally {
      database.close();
    }
  });
});
