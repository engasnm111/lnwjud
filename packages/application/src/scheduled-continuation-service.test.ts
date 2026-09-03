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
    hostTimeZone: 'Asia/Bangkok',
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
  it('defaults an omitted successor delay to the current 10-minute goal lease', async () => {
    const { database, goals, scheduled } = await fixture();
    try {
      const started = await startGoal(goals);
      const result = await scheduled.prepareScheduledContinuation(actor, validPrepare(started, { successorDelayMinutes: undefined }));
      expect(result).toMatchObject({
        ok: true,
        value: {
          outcome: 'prepared',
          currentRunMayContinue: true,
          handoffReady: false,
          nativeTaskConfirmationRequired: true,
          nextRequiredAction: 'create_native_task_and_record_receipt_before_yield',
          handoffDeadlineAt: '2026-08-27T10:10:00.000Z',
          scheduleRequest: { dueAt: '2026-08-27T10:10:00.000Z' },
          goal: { revision: 1, leaseExpiresAt: '2026-08-27T10:10:00.000Z' },
        },
      });
    } finally {
      database.close();
    }
  });

  it('emits an explicit host-timezone VEVENT while keeping dueAt as the canonical absolute instant', async () => {
    const { database, goals, scheduled } = await fixture('2026-08-27T10:00:00.750Z');
    try {
      const started = await startGoal(goals);
      const prepared = await scheduled.prepareScheduledContinuation(actor, validPrepare(started));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('prepare failed');
      expect(prepared.value.scheduleRequest).toMatchObject({
        dueAt: '2026-08-27T10:25:00.750Z',
        scheduleTimeZone: 'Asia/Bangkok',
        schedule: 'BEGIN:VEVENT\nDTSTART;TZID=Asia/Bangkok:20260827T172500\nEND:VEVENT',
      });

      await expect(scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-time-contract',
        dueAt: '2026-08-27T17:25:03+07:00',
        runsOn: 'cloud',
      })).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

      await expect(scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-time-contract',
        dueAt: '2026-08-27T17:25:00+07:00',
        runsOn: 'cloud',
      })).resolves.toMatchObject({
        ok: true,
        value: { status: 'scheduled', dueAt: '2026-08-27T10:25:00.750Z', confirmedRunsOn: 'cloud' },
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
          handoffReady: false,
          nativeTaskConfirmationRequired: true,
          nextRequiredAction: 'create_native_task_and_record_receipt_before_yield',
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
      expect(result.value.scheduleRequest.prompt).toContain('120 seconds early is a safety tolerance, not a scheduling cadence');
      expect(result.value.scheduleRequest.prompt).toContain('one-time task that has fired is consumed transport identity');
      expect(result.value.scheduleRequest.prompt).toContain('fresh lease-aligned successor');
      expect(result.value.scheduleRequest.prompt).toContain('do not call prepare_scheduled_continuation again');
      expect(result.value.scheduleRequest.prompt).toContain('successor_required');
      expect(result.value.scheduleRequest.prompt).toContain('deterministic adaptive successor');
      expect(result.value.scheduleRequest.prompt).toContain('never create blindly');
      expect(result.value.scheduleRequest.prompt).toContain('native_task_receipt_missing');
      expect(result.value.scheduleRequest.prompt).toContain('reschedule_required is legacy compatibility only');
      expect(result.value.scheduleRequest.prompt).toContain('expedite_scheduled_continuation may update only a still-pending future native task');
      expect(result.value.scheduleRequest.prompt).toContain('actual native Scheduled Task operation from the current ChatGPT host/tool registry');
      expect(result.value.scheduleRequest.prompt).toContain('never assume or hard-code an internal host operation name');
      expect(result.value.scheduleRequest.prompt).toContain('immediately record create_failed');
      expect(result.value.scheduleRequest.prompt).toContain('record create_uncertain only when host creation may actually have succeeded');
      expect(result.value.scheduleRequest.prompt).not.toContain('Automations.create');
      expect(result.value.scheduleRequest.prompt).not.toContain('Automations.update');
      expect(result.value.scheduleRequest.prompt).toContain('Never send a completion response while get_goal still reports active');
      expect(result.value.scheduleRequest.prompt).toContain('finish_goal');
      expect(result.value.scheduleRequest.prompt).toContain('matching native host deletion receipt');
      expect(result.value.scheduleRequest.prompt).toContain('claim returns terminal_noop');
      expect(result.value.scheduleRequest.prompt).toContain('let the already-firing one-time host task return naturally');
      expect(result.value.scheduleRequest.prompt).toContain('Windows Task Scheduler');
      expect(result.value.scheduleRequest.prompt).toContain(started.goalId);
      expect(result.value.scheduleRequest.prompt).toContain('workspace-1');
    } finally {
      database.close();
    }
  });

  it('retires a firing one-time task and reserves a fresh adaptive successor on collision', async () => {
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
        dueAt: prepared.value.continuation.dueAt,
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
          retryAfterSeconds: 240,
          continuation: {
            continuationId: prepared.value.continuation.continuationId,
            nativeTaskId: 'native-task-b',
            status: 'superseded',
          },
          successor: {
            generation: 2,
            status: 'prepared',
            dueAt: '2026-08-27T10:29:00.000Z',
          },
          scheduleRequest: {
            dueAt: '2026-08-27T10:29:00.000Z',
            occurrence: 'once',
            destination: 'current_chat',
            executionPreference: 'cloud',
          },
          handoffReady: false,
          currentWakeMayReturn: false,
          nextRequiredAction: 'create_native_task_and_record_receipt_before_current_wake_returns',
        },
      });
      if (!collision.ok || collision.value.outcome !== 'successor_required') throw new Error('fresh collision successor missing');
      expect(collision.value.successor.continuationId).not.toBe(prepared.value.continuation.continuationId);
      expect(collision.value.scheduleRequest?.prompt).toContain('one-time task that has fired is consumed transport identity');
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

  it('retires a one-time task that fires outside the early-jitter window and reserves fresh coverage', async () => {
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
        nativeTaskId: 'native-task-too-early',
        dueAt: prepared.value.continuation.dueAt,
        runsOn: 'cloud',
      });
      expect(created.ok).toBe(true);

      clock.set('2026-08-27T10:02:00.000Z');
      const earlyWake = await scheduled.claimScheduledContinuation(actor, {
        continuationId: prepared.value.continuation.continuationId,
      });
      expect(earlyWake).toMatchObject({
        ok: true,
        value: {
          outcome: 'successor_required',
          retryAfterSeconds: 600,
          continuation: {
            continuationId: prepared.value.continuation.continuationId,
            nativeTaskId: 'native-task-too-early',
            status: 'superseded',
          },
          successor: {
            generation: 2,
            status: 'prepared',
            dueAt: '2026-08-27T10:12:00.000Z',
          },
          scheduleRequest: {
            dueAt: '2026-08-27T10:12:00.000Z',
            scheduleTimeZone: 'Asia/Bangkok',
          },
          handoffReady: false,
          currentWakeMayReturn: false,
          nextRequiredAction: 'create_native_task_and_record_receipt_before_current_wake_returns',
        },
      });
      expect(JSON.stringify(earlyWake)).not.toContain('taskUpdateRequest');
      expect(JSON.stringify(earlyWake)).not.toContain('nativeTaskId":"native-task-too-early","dueAt":"2026-08-27T10:25');
    } finally {
      database.close();
    }
  });

  it('accepts host-confirmed task coverage when execution mode is unreported, rejects explicit local, and claims the wake normally', async () => {
    const { database, goals, scheduled, clock } = await fixture('2026-08-27T10:00:46.000Z');
    const successorActor: FileActor = { ...actor, sessionId: 'scheduled-continuation-unverified-wake' };
    try {
      const started = await startGoal(goals);
      const prepared = await scheduled.prepareScheduledContinuation(actor, validPrepare(started));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('prepare failed');

      await expect(scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-explicit-local',
        dueAt: prepared.value.continuation.dueAt,
        runsOn: 'local',
      })).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

      const receipt = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-host-mode-unreported',
        dueAt: prepared.value.continuation.dueAt,
        runsOn: 'unverified',
      });
      expect(receipt).toMatchObject({
        ok: true,
        value: {
          status: 'scheduled',
          nativeTaskId: 'native-task-host-mode-unreported',
          confirmedRunsOn: 'unverified',
        },
      });

      database.connection.prepare('UPDATE goals SET lease_expires_at = ? WHERE id = ?')
        .run('2026-08-27T10:24:00.000Z', started.goalId);
      clock.set('2026-08-27T10:24:32.000Z');
      const acquired = await scheduled.claimScheduledContinuation(successorActor, {
        continuationId: prepared.value.continuation.continuationId,
      });
      expect(acquired).toMatchObject({
        ok: true,
        value: {
          outcome: 'acquired',
          acquisition: 'expired_lease',
          continuation: { status: 'claimed', confirmedRunsOn: 'unverified' },
          successor: { generation: 2, status: 'prepared' },
          scheduleRequest: { provider: 'chatgpt_scheduled_task', occurrence: 'once', destination: 'current_chat' },
        },
      });
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
        dueAt: prepared.value.continuation.dueAt,
        runsOn: 'cloud',
      });
      expect(receipt.ok).toBe(true);
      database.connection.prepare('UPDATE goals SET lease_expires_at = ? WHERE id = ?')
        .run('2026-08-27T10:24:00.000Z', started.goalId);

      clock.set('2026-08-27T10:24:32.000Z');
      const acquired = await scheduled.claimScheduledContinuation(successorActor, {
        continuationId: prepared.value.continuation.continuationId,
      });
      expect(acquired).toMatchObject({
        ok: true,
        value: {
          outcome: 'acquired',
          acquisition: 'expired_lease',
          goal: { status: 'active' },
          continuation: { status: 'claimed' },
          successor: {
            generation: 2,
            status: 'prepared',
            dueAt: '2026-08-27T10:34:32.000Z',
          },
          scheduleRequest: {
            provider: 'chatgpt_scheduled_task',
            occurrence: 'once',
            destination: 'current_chat',
            dueAt: '2026-08-27T10:34:32.000Z',
          },
          handoffReady: false,
          currentWakeMayReturn: false,
          nextRequiredAction: 'create_native_task_and_record_receipt_before_current_wake_returns',
        },
      });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok || acquired.value.outcome !== 'acquired') throw new Error('claim did not acquire');
      expect(acquired.value.scheduleRequest.prompt).toContain('fresh lease-aligned successor');
      expect(acquired.value.scheduleRequest.prompt).toContain('do not call prepare_scheduled_continuation again');
    } finally {
      database.close();
    }
  });

  it.each([
    ['without a recorded native task ID', undefined, 'native_task_creation_uncertain'],
    ['with a recorded native task ID', 'native-task-uncertain-successor', 'native_task_id_already_recorded'],
  ])('requires host reconciliation for an uncertain claimed successor %s', async (_caseName, nativeTaskId, reason) => {
    const { database, goals, scheduled, clock } = await fixture();
    const successorActor: FileActor = { ...actor, sessionId: 'scheduled-continuation-uncertain-successor' };
    try {
      const started = await startGoal(goals);
      const prepared = await scheduled.prepareScheduledContinuation(actor, validPrepare(started));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('prepare failed');
      const created = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-firing-uncertain-successor',
        dueAt: prepared.value.continuation.dueAt,
        runsOn: 'cloud',
      });
      expect(created.ok).toBe(true);

      clock.set('2026-08-27T10:25:00.000Z');
      const acquired = await scheduled.claimScheduledContinuation(successorActor, {
        continuationId: prepared.value.continuation.continuationId,
      });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok || acquired.value.outcome !== 'acquired') throw new Error('claim did not acquire');
      const uncertain = await scheduled.recordScheduledContinuationReceipt(successorActor, {
        continuationId: acquired.value.successor.continuationId,
        expectedVersion: acquired.value.successor.version,
        outcome: 'create_uncertain',
        ...(nativeTaskId === undefined ? {} : { nativeTaskId }),
        runsOn: 'cloud',
      });
      expect(uncertain.ok).toBe(true);

      clock.set('2026-08-27T10:25:10.000Z');
      const replay = await scheduled.claimScheduledContinuation(successorActor, {
        continuationId: prepared.value.continuation.continuationId,
      });
      expect(replay).toMatchObject({
        ok: true,
        value: {
          outcome: 'successor_required',
          reason,
          successor: {
            continuationId: acquired.value.successor.continuationId,
            status: 'create_uncertain',
            ...(nativeTaskId === undefined ? {} : { nativeTaskId }),
          },
          handoffReady: false,
          currentWakeMayReturn: false,
          nextRequiredAction: 'reconcile_reserved_successor_native_receipt_before_create_or_return',
        },
      });
      expect(JSON.stringify(replay)).not.toContain('scheduleRequest');
    } finally {
      database.close();
    }
  });

  it('requires reconciliation for a stale prepared successor because host creation may have succeeded before its receipt', async () => {
    const { database, goals, scheduled, clock } = await fixture();
    const successorActor: FileActor = { ...actor, sessionId: 'scheduled-continuation-stale-successor' };
    try {
      const started = await startGoal(goals);
      const prepared = await scheduled.prepareScheduledContinuation(actor, validPrepare(started));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('prepare failed');
      const created = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-firing-stale-successor',
        dueAt: prepared.value.continuation.dueAt,
        runsOn: 'cloud',
      });
      expect(created.ok).toBe(true);

      clock.set('2026-08-27T10:25:00.000Z');
      const acquired = await scheduled.claimScheduledContinuation(successorActor, {
        continuationId: prepared.value.continuation.continuationId,
      });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok || acquired.value.outcome !== 'acquired') throw new Error('claim did not acquire');
      expect(acquired.value.successor.dueAt).toBe('2026-08-27T10:35:00.000Z');

      clock.set('2026-08-27T10:30:00.000Z');
      const replay = await scheduled.claimScheduledContinuation(successorActor, {
        continuationId: prepared.value.continuation.continuationId,
      });
      expect(replay).toMatchObject({
        ok: true,
        value: {
          outcome: 'successor_required',
          reason: 'native_task_receipt_missing',
          successor: {
            continuationId: acquired.value.successor.continuationId,
            status: 'prepared',
            dueAt: '2026-08-27T10:35:00.000Z',
          },
          nextRequiredAction: 'reconcile_reserved_successor_native_receipt_before_create_or_return',
        },
      });
      expect(JSON.stringify(replay)).not.toContain('scheduleRequest');
    } finally {
      database.close();
    }
  });

  it('refreshes a truthfully failed claimed-successor creation to a fresh lease-aligned retry', async () => {
    const { database, goals, scheduled, clock } = await fixture();
    const successorActor: FileActor = { ...actor, sessionId: 'scheduled-continuation-failed-successor' };
    try {
      const started = await startGoal(goals);
      const prepared = await scheduled.prepareScheduledContinuation(actor, validPrepare(started));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('prepare failed');
      const created = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-firing-failed-successor',
        dueAt: prepared.value.continuation.dueAt,
        runsOn: 'cloud',
      });
      expect(created.ok).toBe(true);

      clock.set('2026-08-27T10:25:00.000Z');
      const acquired = await scheduled.claimScheduledContinuation(successorActor, {
        continuationId: prepared.value.continuation.continuationId,
      });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok || acquired.value.outcome !== 'acquired') throw new Error('claim did not acquire');
      const failed = await scheduled.recordScheduledContinuationReceipt(successorActor, {
        continuationId: acquired.value.successor.continuationId,
        expectedVersion: acquired.value.successor.version,
        outcome: 'create_failed',
        detail: 'Native host confirmed that no task was created.',
      });
      expect(failed).toMatchObject({ ok: true, value: { status: 'create_failed' } });

      clock.set('2026-08-27T10:25:30.000Z');
      const beforeDueReplay = await scheduled.claimScheduledContinuation(successorActor, {
        continuationId: prepared.value.continuation.continuationId,
      });
      expect(beforeDueReplay).toMatchObject({
        ok: true,
        value: {
          outcome: 'successor_required',
          successor: {
            continuationId: acquired.value.successor.continuationId,
            status: 'create_failed',
            dueAt: '2026-08-27T10:35:00.000Z',
          },
          scheduleRequest: { dueAt: '2026-08-27T10:35:00.000Z' },
          nextRequiredAction: 'create_native_task_and_record_receipt_before_current_wake_returns',
        },
      });

      clock.set('2026-08-27T10:36:00.000Z');
      const replay = await scheduled.claimScheduledContinuation(successorActor, {
        continuationId: prepared.value.continuation.continuationId,
      });
      expect(replay).toMatchObject({
        ok: true,
        value: {
          outcome: 'successor_required',
          successor: {
            continuationId: acquired.value.successor.continuationId,
            status: 'prepared',
            dueAt: '2026-08-27T10:46:00.000Z',
          },
          scheduleRequest: { dueAt: '2026-08-27T10:46:00.000Z' },
          nextRequiredAction: 'create_native_task_and_record_receipt_before_current_wake_returns',
        },
      });
    } finally {
      database.close();
    }
  });

  it('retires a wake that fires outside the 120-second early-jitter window and reserves fresh adaptive coverage', async () => {
    const { database, goals, scheduled, clock } = await fixture('2026-08-27T10:00:46.000Z');
    try {
      const started = await startGoal(goals);
      const prepared = await scheduled.prepareScheduledContinuation(actor, validPrepare(started));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('prepare failed');
      const created = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-too-early-boundary',
        dueAt: prepared.value.continuation.dueAt,
        runsOn: 'cloud',
      });
      expect(created.ok).toBe(true);

      clock.set('2026-08-27T10:23:45.000Z');
      await expect(scheduled.claimScheduledContinuation(actor, {
        continuationId: prepared.value.continuation.continuationId,
      })).resolves.toMatchObject({
        ok: true,
        value: {
          outcome: 'successor_required',
          retryAfterSeconds: 240,
          continuation: {
            nativeTaskId: 'native-task-too-early-boundary',
            status: 'superseded',
          },
          successor: {
            generation: 2,
            status: 'prepared',
            dueAt: '2026-08-27T10:27:45.000Z',
          },
          scheduleRequest: {
            dueAt: '2026-08-27T10:27:45.000Z',
            scheduleTimeZone: 'Asia/Bangkok',
          },
          handoffReady: false,
          currentWakeMayReturn: false,
          nextRequiredAction: 'create_native_task_and_record_receipt_before_current_wake_returns',
        },
      });
    } finally {
      database.close();
    }
  });

  it('samples claim time after async worker liveness so a fresh observation is never rejected as from the future', async () => {
    const setClockRef: { current?: (value: string) => void } = {};
    let expectedLeaseGeneration = 0;
    let expectedLeaseActivitySeq = 0;
    const workerLiveness: ScheduledContinuationWorkerLivenessPort = {
      observe: async () => {
        setClockRef.current?.('2026-08-27T10:25:00.010Z');
        return {
          trustworthy: true,
          observedAt: '2026-08-27T10:25:00.010Z',
          leaseGeneration: expectedLeaseGeneration,
          leaseActivitySeq: expectedLeaseActivitySeq,
          liveFencedCallCount: 0,
          blockingTaskStates: [],
        };
      },
    };
    const { database, goals, scheduled, clock } = await fixture('2026-08-27T10:00:00.000Z', workerLiveness);
    setClockRef.current = clock.set;
    try {
      const started = await startGoal(goals);
      expectedLeaseGeneration = started.leaseGeneration;
      expectedLeaseActivitySeq = started.leaseActivitySeq;
      const prepared = await scheduled.prepareScheduledContinuation(actor, validPrepare(started));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('prepare failed');
      const created = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-liveness-order',
        dueAt: prepared.value.continuation.dueAt,
        runsOn: 'cloud',
      });
      expect(created.ok).toBe(true);

      clock.set('2026-08-27T10:25:00.000Z');
      await expect(scheduled.claimScheduledContinuation({ ...actor, sessionId: 'liveness-order-successor' }, {
        continuationId: prepared.value.continuation.continuationId,
      })).resolves.toMatchObject({
        ok: true,
        value: { outcome: 'acquired', acquisition: 'expired_lease' },
      });
    } finally {
      database.close();
    }
  });

  it('marks only the transaction winner create-safe when concurrent claims replay one successor', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let observations = 0;
    let observedGeneration = 1;
    let observedActivitySeq = 0;
    const workerLiveness: ScheduledContinuationWorkerLivenessPort = {
      observe: async () => {
        observations += 1;
        if (observations === 2) release();
        await gate;
        return {
          trustworthy: true,
          observedAt: '2026-08-27T10:25:00.000Z',
          leaseGeneration: observedGeneration,
          leaseActivitySeq: observedActivitySeq,
          liveFencedCallCount: 0,
          blockingTaskStates: [],
        };
      },
    };
    const { database, goals, scheduled, repository, clock } = await fixture('2026-08-27T10:00:00.000Z', workerLiveness);
    try {
      const started = await startGoal(goals);
      const prepared = await scheduled.prepareScheduledContinuation(actor, validPrepare(started));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('prepare failed');
      const created = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-concurrent-firing',
        dueAt: prepared.value.continuation.dueAt,
        runsOn: 'cloud',
      });
      expect(created.ok).toBe(true);
      const currentGoal = await repository.getById(started.goalId);
      if (currentGoal === null) throw new Error('goal disappeared');
      observedGeneration = currentGoal.leaseGeneration;
      observedActivitySeq = currentGoal.leaseActivitySeq;

      clock.set('2026-08-27T10:25:00.000Z');
      const results = await Promise.all([
        scheduled.claimScheduledContinuation(actor, { continuationId: prepared.value.continuation.continuationId }),
        scheduled.claimScheduledContinuation(actor, { continuationId: prepared.value.continuation.continuationId }),
      ]);
      expect(observations).toBe(2);
      const values = results.map((result) => {
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('concurrent claim failed');
        return result.value;
      });
      expect(values.filter((value) => 'scheduleRequest' in value)).toHaveLength(1);
      expect(values.filter((value) => value.outcome === 'successor_required' && 'reason' in value && value.reason === 'native_task_receipt_missing')).toHaveLength(1);
      expect(values.every((value) => 'successor' in value)).toBe(true);
      const successorIds = values.map((value) => 'successor' in value ? value.successor.continuationId : 'missing');
      expect(new Set(successorIds).size).toBe(1);
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
        dueAt: prepared.value.continuation.dueAt,
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

  it('reconciles an already-consumed native successor after pending finish without fake deletion or reopening the goal', async () => {
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
        dueAt: prepared.value.continuation.dueAt,
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
          status: 'active',
          completionState: 'pending_native_cleanup',
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

      const completed = await goals.finishGoal(actor, {
        goalId: started.goalId,
        leaseToken: started.leaseToken!,
        expectedRevision: prepared.value.goal.revision,
        status: 'completed',
        summary: 'Completed after the native successor run was reconciled.',
        evidence: [],
      });
      expect(completed).toMatchObject({
        ok: true,
        value: {
          status: 'completed',
          completionState: 'completed',
          scheduledTaskCancellation: { action: 'none', reason: 'no_live_task' },
        },
      });
      await expect(goals.getGoal(actor, { goalId: started.goalId }))
        .resolves.toMatchObject({ ok: true, value: { status: 'completed' } });
    } finally {
      database.close();
    }
  });

  it('keeps the goal active until the pending native successor has a deletion receipt', async () => {
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
        nativeTaskId: 'native-task-completion-barrier',
        dueAt: prepared.value.continuation.dueAt,
        runsOn: 'cloud',
      });
      expect(created).toMatchObject({ ok: true, value: { status: 'scheduled', version: 1 } });
      if (!created.ok) throw new Error('created receipt failed');

      clock.set('2026-08-27T10:00:10.000Z');
      const pending = await goals.finishGoal(actor, {
        goalId: started.goalId,
        leaseToken: started.leaseToken!,
        expectedRevision: prepared.value.goal.revision,
        status: 'completed',
        summary: 'Work is complete but the native successor still needs cleanup.',
        evidence: [],
      });
      expect(pending).toMatchObject({
        ok: true,
        value: {
          status: 'active',
          completionState: 'pending_native_cleanup',
          scheduledTaskCancellation: {
            action: 'delete_native_task',
            nativeTaskId: 'native-task-completion-barrier',
            receiptRequired: true,
          },
        },
      });
      await expect(goals.getGoal(actor, { goalId: started.goalId }))
        .resolves.toMatchObject({ ok: true, value: { status: 'active' } });

      const cancellation = await scheduled.getScheduledContinuation(actor, { goalId: started.goalId, latest: true });
      expect(cancellation).toMatchObject({ ok: true, value: { status: 'cancel_required', version: 2 } });
      if (!cancellation.ok) throw new Error('cancel-required continuation missing');
      const cancelled = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: cancellation.value.continuationId,
        expectedVersion: cancellation.value.version,
        outcome: 'cancelled',
        nativeTaskId: 'native-task-completion-barrier',
        nativeCancellationReceipt: {
          provider: 'chatgpt_scheduled_task',
          operation: 'delete',
          nativeTaskId: 'native-task-completion-barrier',
          state: 'deleted',
          observedAt: '2026-08-27T10:00:12.000Z',
        },
      });
      expect(cancelled).toMatchObject({ ok: true, value: { status: 'cancelled', version: 3 } });

      const finished = await goals.finishGoal(actor, {
        goalId: started.goalId,
        leaseToken: started.leaseToken!,
        expectedRevision: prepared.value.goal.revision,
        status: 'completed',
        summary: 'Work and native successor cleanup are complete.',
        evidence: [],
      });
      expect(finished).toMatchObject({
        ok: true,
        value: {
          status: 'completed',
          completionState: 'completed',
          scheduledTaskCancellation: { action: 'none', reason: 'no_live_task' },
        },
      });
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
        dueAt: prepared.value.continuation.dueAt,
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
          status: 'active',
          completionState: 'pending_native_cleanup',
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

      const completed = await goals.finishGoal(actor, {
        goalId: started.goalId,
        leaseToken: started.leaseToken!,
        expectedRevision: prepared.value.goal.revision,
        status: 'completed',
        summary: 'Completed after successor C was deleted with a host receipt.',
        evidence: [],
      });
      expect(completed).toMatchObject({
        ok: true,
        value: {
          status: 'completed',
          completionState: 'completed',
          scheduledTaskCancellation: { action: 'none', reason: 'no_live_task' },
        },
      });

      clock.set('2026-08-27T10:02:00.000Z');
      await expect(scheduled.claimScheduledContinuation(lateWakeActor, {
        continuationId: prepared.value.continuation.continuationId,
      })).resolves.toMatchObject({ ok: true, value: { outcome: 'terminal_noop', goal: { status: 'completed' } } });
    } finally {
      database.close();
    }
  });

  it('requires host reconciliation instead of deleting an overdue native task whose run state is unknown', async () => {
    const { database, goals, scheduled, clock } = await fixture();
    try {
      const started = await startGoal(goals);
      const prepared = await scheduled.prepareScheduledContinuation(actor, validPrepare(started, { successorDelayMinutes: 2 }));
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error('prepare failed');
      const created = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: prepared.value.continuation.continuationId,
        expectedVersion: prepared.value.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-overdue-host-unknown',
        dueAt: prepared.value.continuation.dueAt,
        runsOn: 'cloud',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error('create receipt failed');

      clock.set('2026-08-27T10:03:00.000Z');
      const resumed = await startGoal(goals);
      const finished = await goals.finishGoal(actor, {
        goalId: resumed.goalId,
        leaseToken: resumed.leaseToken!,
        expectedRevision: resumed.revision,
        status: 'completed',
        summary: 'Finished after the scheduled due time without native host run evidence.',
        evidence: [],
      });
      expect(finished).toMatchObject({
        ok: true,
        value: {
          status: 'active',
          completionState: 'pending_native_cleanup',
          scheduledTaskCancellation: {
            action: 'none',
            nativeTaskId: 'native-overdue-host-unknown',
            reason: 'native_task_unverified',
          },
        },
      });
      await expect(scheduled.getScheduledContinuation(actor, { goalId: started.goalId, latest: true }))
        .resolves.toMatchObject({ ok: true, value: { status: 'cancel_uncertain', nativeTaskId: 'native-overdue-host-unknown' } });

      const continuation = await scheduled.getScheduledContinuation(actor, { goalId: started.goalId, latest: true });
      expect(continuation).toMatchObject({ ok: true });
      if (!continuation.ok) throw new Error('uncertain continuation missing');
      const consumed = await scheduled.recordScheduledContinuationReceipt(actor, {
        continuationId: continuation.value.continuationId,
        expectedVersion: continuation.value.version,
        outcome: 'consumed',
        nativeRunReceipt: {
          provider: 'chatgpt_scheduled_task',
          operation: 'run',
          nativeTaskId: 'native-overdue-host-unknown',
          state: 'consumed',
          observedAt: '2026-08-27T10:03:01.000Z',
        },
      });
      expect(consumed).toMatchObject({ ok: true, value: { status: 'superseded' } });

      const completed = await goals.finishGoal(actor, {
        goalId: started.goalId,
        leaseToken: resumed.leaseToken!,
        expectedRevision: resumed.revision,
        status: 'completed',
        summary: 'Completed after exact host run reconciliation.',
        evidence: [],
      });
      expect(completed).toMatchObject({
        ok: true,
        value: { status: 'completed', completionState: 'completed' },
      });
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
        dueAt: prepared.value.continuation.dueAt,
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
        dueAt: prepared.value.continuation.dueAt,
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
