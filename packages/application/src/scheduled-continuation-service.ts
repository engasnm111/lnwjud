import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  GoalStateError,
  appError,
  err,
  ok,
  type GoalEvidence,
  type GoalPlan,
  type GoalRecord,
  type GoalStepUpdate,
  type GoalTrackedTask,
  type Result,
  type ScheduledContinuationExecutionPreference,
  type ScheduledContinuationCancellationOutcome,
  type ScheduledContinuationExpediteReason,
  type ScheduledContinuationNativeCancellationReceipt,
  type ScheduledContinuationNativeRunReceipt,
  type ScheduledContinuationReceiptOutcome,
  type ScheduledContinuationRepository,
  type ScheduledContinuationRunsOn,
  type ScheduledContinuationSnapshot,
  type ScheduledContinuationWorkerLivenessPort,
  type ScheduledTaskCancellationInstruction,
} from '@lnwjud/domain';
import type { FileActor } from './file-service.js';
import type { GoalSnapshot, RunGoalResult } from './goal-continuation-service.js';

export const DEFAULT_SUCCESSOR_DELAY_MINUTES = 10;
export const MIN_SUCCESSOR_DELAY_MINUTES = 2;
export const MAX_SUCCESSOR_DELAY_MINUTES = 25;
/** @deprecated Compatibility fallback only. New omitted-delay preparation is lease-aligned. */
export const SUCCESSOR_DELAY_MINUTES = DEFAULT_SUCCESSOR_DELAY_MINUTES;
export const SCHEDULED_WAKE_EARLY_TOLERANCE_SECONDS = 120;
export const SCHEDULED_RECEIPT_TIME_TOLERANCE_SECONDS = 1;
const MIN_EXPEDITE_LEAD_SECONDS = SCHEDULED_WAKE_EARLY_TOLERANCE_SECONDS + 30;
const MAX_EXPEDITE_LEAD_SECONDS = 5 * 60;

const MAX_ID = 128;
const MAX_TEXT = 2_048;
const MAX_NATIVE_TASK_ID = 512;
const MAX_RECEIPT_DETAIL = 1_024;

export interface PrepareScheduledContinuationRequest {
  readonly goalId: string;
  readonly leaseToken: string;
  readonly expectedRevision: number;
  readonly currentPhase: string;
  readonly summary: string;
  readonly stepUpdates: readonly GoalStepUpdate[];
  readonly nextAction: string;
  readonly blockers: readonly string[];
  readonly evidence: readonly GoalEvidence[];
  readonly activeTaskIds?: readonly string[];
  readonly trackedTasks?: readonly GoalTrackedTask[];
  readonly successorDelayMinutes?: number;
  readonly executionPreference?: 'cloud';
}

export interface ScheduledContinuationRequest {
  readonly provider: 'chatgpt_scheduled_task';
  readonly occurrence: 'once';
  /** Canonical absolute instant retained for durable comparison and receipts. */
  readonly dueAt: string;
  /** Host-ready VEVENT with an explicit IANA TZID. Pass this schedule verbatim; dueAt remains the canonical absolute instant. */
  readonly schedule: string;
  readonly scheduleTimeZone: string;
  readonly destination: 'current_chat';
  readonly executionPreference: ScheduledContinuationExecutionPreference;
  readonly continuationId: string;
  readonly name: string;
  readonly prompt: string;
}

export interface ScheduledContinuationTaskUpdateRequest {
  readonly provider: 'chatgpt_scheduled_task';
  readonly operation: 'update';
  readonly occurrence: 'once';
  readonly dueAt: string;
  readonly schedule: string;
  readonly scheduleTimeZone: string;
  readonly destination: 'current_chat';
  readonly executionPreference: 'cloud';
  readonly continuationId: string;
  readonly nativeTaskId: string;
  readonly expectedContinuationVersion: number;
  readonly name: string;
  readonly prompt: string;
}

export interface PrepareScheduledContinuationResult {
  readonly outcome: 'prepared' | 'already_prepared';
  readonly watchdogAction: 'create' | 'retime' | 'reuse' | 'reconcile';
  readonly goal: GoalSnapshot;
  readonly continuation: ScheduledContinuationSnapshot;
  /** Present only when no live native watchdog exists and a fresh host task may be created. */
  readonly scheduleRequest?: ScheduledContinuationRequest;
  /** Present only for a confirmed still-pending native watchdog that needs a same-ID schedule update. */
  readonly taskUpdateRequest?: ScheduledContinuationTaskUpdateRequest;
  readonly currentRunMayContinue: true;
  readonly handoffReady: boolean;
  readonly nativeTaskConfirmationRequired: boolean;
  readonly nextRequiredAction:
    | 'create_native_task_and_record_receipt_before_yield'
    | 'update_same_pending_native_task_and_record_receipt_before_yield'
    | 'continue_with_existing_pending_watchdog'
    | 'reconcile_existing_native_watchdog_before_create_update_or_yield';
  readonly handoffDeadlineAt: string;
}

export interface RecordScheduledContinuationReceiptRequest {
  readonly continuationId: string;
  readonly expectedVersion: number;
  readonly outcome: ScheduledContinuationReceiptOutcome;
  readonly nativeTaskId?: string;
  readonly dueAt?: string;
  readonly runsOn?: ScheduledContinuationRunsOn;
  readonly nativeRunReceipt?: ScheduledContinuationNativeRunReceipt;
  readonly nativeCancellationReceipt?: ScheduledContinuationNativeCancellationReceipt;
  readonly detail?: string;
}

export type CancelScheduledContinuationRequest =
  | { readonly continuationId: string; readonly expectedVersion: number }
  | { readonly goalId: string; readonly latest: true; readonly expectedVersion: number };

export interface CancelScheduledContinuationResult {
  readonly outcome: ScheduledContinuationCancellationOutcome;
  readonly continuation: ScheduledContinuationSnapshot;
  readonly cancellation: ScheduledTaskCancellationInstruction;
}

export interface ClaimScheduledContinuationRequest {
  readonly continuationId: string;
  readonly leaseSeconds?: number;
}

export type ClaimScheduledContinuationResult =
  | {
      readonly outcome: 'acquired';
      readonly continuation: ScheduledContinuationSnapshot;
      readonly successor: ScheduledContinuationSnapshot;
      readonly goal: Omit<RunGoalResult, 'leaseToken'>;
      readonly leaseToken: string;
      readonly leaseGeneration: number;
      readonly acquisition: 'normal' | 'expired_lease' | 'orphan_recovered';
      readonly scheduleRequest: ScheduledContinuationRequest;
      readonly handoffReady: false;
      readonly currentWakeMayReturn: false;
      readonly nextRequiredAction: 'create_native_task_and_record_receipt_before_current_wake_returns';
    }
  | {
      readonly outcome: 'successor_required';
      readonly continuation: ScheduledContinuationSnapshot;
      readonly successor: ScheduledContinuationSnapshot;
      readonly goal: GoalSnapshot;
      readonly retryAfterSeconds: number;
      readonly scheduleRequest: ScheduledContinuationRequest;
      readonly handoffReady: false;
      readonly currentWakeMayReturn: false;
      readonly nextRequiredAction: 'create_native_task_and_record_receipt_before_current_wake_returns';
    }
  | {
      readonly outcome: 'successor_required';
      readonly reason: 'native_task_creation_uncertain' | 'native_task_id_already_recorded' | 'native_task_receipt_missing';
      readonly continuation: ScheduledContinuationSnapshot;
      readonly successor: ScheduledContinuationSnapshot;
      readonly goal: GoalSnapshot;
      readonly retryAfterSeconds: number;
      readonly handoffReady: false;
      readonly currentWakeMayReturn: false;
      readonly nextRequiredAction: 'reconcile_reserved_successor_native_receipt_before_create_or_return';
    }
  | {
      readonly outcome: 'reschedule_required';
      readonly continuation: ScheduledContinuationSnapshot;
      readonly goal: GoalSnapshot;
      readonly retryAfterSeconds: number;
      readonly taskUpdateRequest: ScheduledContinuationTaskUpdateRequest;
      readonly handoffReady: false;
      readonly currentWakeMayReturn: false;
      readonly nextRequiredAction: 'update_same_native_task_and_record_receipt_before_current_wake_returns';
    }
  | {
      readonly outcome: 'receipt_required';
      readonly reason: 'native_task_unconfirmed';
      readonly continuation: ScheduledContinuationSnapshot;
      readonly goal: GoalSnapshot;
      readonly handoffReady: false;
      readonly currentWakeMayReturn: false;
      readonly nextRequiredAction: 'reconcile_native_task_receipt_before_mutation_or_return';
    }
  | {
      readonly outcome: 'already_claimed' | 'terminal_noop';
      readonly continuation: ScheduledContinuationSnapshot;
      readonly goal: GoalSnapshot;
    }
  | {
      readonly outcome: 'not_due';
      readonly continuation: ScheduledContinuationSnapshot;
      readonly goal: GoalSnapshot;
      readonly retryAfterSeconds: number;
      readonly taskUpdateRequest: ScheduledContinuationTaskUpdateRequest;
      readonly handoffReady: false;
      readonly currentWakeMayReturn: false;
      readonly nextRequiredAction: 'reschedule_same_native_task_to_safe_due_time';
    };

export type GetScheduledContinuationRequest =
  | { readonly continuationId: string }
  | { readonly goalId: string; readonly latest: true };

export interface ExpediteScheduledContinuationRequest {
  readonly goalId: string;
  readonly continuationId: string;
  readonly leaseToken: string;
  readonly expectedLeaseGeneration: number;
  readonly expectedGoalRevision: number;
  readonly expectedContinuationVersion: number;
  readonly reason: ScheduledContinuationExpediteReason;
}

export type ExpediteScheduledContinuationResult =
  | {
      readonly outcome: 'update_required';
      readonly continuation: ScheduledContinuationSnapshot;
      readonly handoffDeadlineAt: string;
      readonly taskUpdateRequest: ScheduledContinuationTaskUpdateRequest;
    }
  | {
      readonly outcome: 'unchanged';
      readonly reason: 'already_due_within_two_minutes';
      readonly continuation: ScheduledContinuationSnapshot;
    };

export interface ScheduledContinuationServiceOptions {
  readonly now?: () => Date;
  readonly workerLiveness?: ScheduledContinuationWorkerLivenessPort;
  /** IANA zone used in native ChatGPT VEVENT schedules. Defaults to the machine's resolved zone. */
  readonly hostTimeZone?: string;
}

export class ScheduledContinuationService {
  private readonly now: () => Date;
  private readonly workerLiveness: ScheduledContinuationWorkerLivenessPort;
  private readonly hostTimeZone: string;

  public constructor(
    private readonly goals: ScheduledContinuationRepository & {
      getById(goalId: string): Promise<GoalRecord | null>;
    },
    options: ScheduledContinuationServiceOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
    this.hostTimeZone = normalizeHostTimeZone(options.hostTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    this.workerLiveness = options.workerLiveness ?? {
      observe: async (goalId, trackedTasks): ReturnType<ScheduledContinuationWorkerLivenessPort['observe']> => {
        const goal = await this.goals.getById(goalId);
        return {
          trustworthy: trackedTasks.every((task) => task.role !== 'blocking_job'),
          observedAt: this.now().toISOString(),
          leaseGeneration: goal?.leaseGeneration ?? 0,
          leaseActivitySeq: goal?.leaseActivitySeq ?? 0,
          liveFencedCallCount: 0,
          blockingTaskStates: trackedTasks
            .filter((task) => task.role === 'blocking_job')
            .map((task) => ({ taskId: task.taskId, provider: task.provider, state: 'unknown' as const })),
        };
      },
    };
  }

  public async prepareScheduledContinuation(
    actor: FileActor,
    request: PrepareScheduledContinuationRequest,
  ): Promise<Result<PrepareScheduledContinuationResult>> {
    try {
      if ('releaseLease' in (request as object)) throw new Error('releaseLease is internal and cannot be supplied by callers');
      const goalId = required(request.goalId, 'goalId', MAX_ID);
      const current = await this.requireOwnedGoal(actor, goalId);
      if (current.status !== 'active') return err(appError('CONFLICT', 'Goal is already terminal'));
      if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 0) throw new Error('expectedRevision is invalid');
      const successorDelayMinutes = normalizeSuccessorDelay(request.successorDelayMinutes, current.leaseDurationSeconds);
      const nextAction = safeText(request.nextAction, 1_024, 'nextAction');
      const currentPhase = safeText(request.currentPhase, 256, 'currentPhase');
      const summary = safeText(request.summary, MAX_TEXT, 'summary');
      const stepUpdates = normalizeStepUpdates(request.stepUpdates, current.plan);
      const plan = applyStepUpdates(current.plan, stepUpdates);
      const blockers = normalizeStrings(request.blockers, 20, 512, 'blockers');
      const evidence = normalizeEvidence(request.evidence);
      const trackedTasks = normalizeTrackedTasks(request.trackedTasks, request.activeTaskIds);
      const activeTaskIds = blockingTaskIds(trackedTasks);
      const executionPreference = request.executionPreference ?? 'cloud';
      if (executionPreference !== 'cloud') throw new Error('Scheduled continuation requires cloud execution');
      const now = this.now();
      const nowIso = now.toISOString();
      const dueAt = new Date(now.getTime() + successorDelayMinutes * 60_000).toISOString();
      const requestFingerprint = createHash('sha256').update(JSON.stringify({
        goalId,
        expectedRevision: request.expectedRevision,
        currentPhase,
        summary,
        stepUpdates,
        nextAction,
        blockers,
        evidence,
        activeTaskIds,
        trackedTasks,
        successorDelayMinutes,
        executionPreference,
      })).digest('hex');
      const prepared = await this.goals.prepareScheduledContinuation({
        continuationId: randomUUID(),
        checkpointId: randomUUID(),
        goalId,
        ownerClientId: owner(actor),
        ownerSessionId: ownerSession(actor),
        leaseTokenHash: hashLeaseToken(required(request.leaseToken, 'leaseToken', 256)),
        expectedRevision: request.expectedRevision,
        plan,
        currentPhase,
        summary,
        stepUpdates,
        nextAction,
        blockers,
        evidence,
        activeTaskIds,
        trackedTasks,
        dueAt,
        executionPreference,
        requestFingerprint,
        now: nowIso,
      });
      const continuation = toPublicContinuation(prepared.continuation);
      const goal = toGoalSnapshot(prepared.goal);
      const outcome = prepared.alreadyPrepared ? 'already_prepared' : 'prepared';
      if (!prepared.alreadyPrepared) {
        return ok({
          outcome,
          watchdogAction: 'create',
          goal,
          continuation,
          scheduleRequest: buildScheduleRequest(continuation, prepared.goal.workspaceId, this.hostTimeZone),
          currentRunMayContinue: true,
          handoffReady: false,
          nativeTaskConfirmationRequired: true,
          nextRequiredAction: 'create_native_task_and_record_receipt_before_yield',
          handoffDeadlineAt: continuation.dueAt,
        });
      }
      if (continuation.status === 'scheduled') {
        return ok({
          outcome,
          watchdogAction: 'reuse',
          goal,
          continuation,
          currentRunMayContinue: true,
          handoffReady: true,
          nativeTaskConfirmationRequired: false,
          nextRequiredAction: 'continue_with_existing_pending_watchdog',
          handoffDeadlineAt: continuation.dueAt,
        });
      }
      if (continuation.status === 'reschedule_required' || continuation.status === 'reschedule_failed') {
        return ok({
          outcome,
          watchdogAction: 'retime',
          goal,
          continuation,
          taskUpdateRequest: buildTaskUpdateRequest(continuation, prepared.goal.workspaceId, this.hostTimeZone),
          currentRunMayContinue: true,
          handoffReady: false,
          nativeTaskConfirmationRequired: false,
          nextRequiredAction: 'update_same_pending_native_task_and_record_receipt_before_yield',
          handoffDeadlineAt: continuation.pendingDueAt ?? continuation.dueAt,
        });
      }
      return ok({
        outcome,
        watchdogAction: 'reconcile',
        goal,
        continuation,
        currentRunMayContinue: true,
        handoffReady: false,
        nativeTaskConfirmationRequired: continuation.nativeTaskId === undefined,
        nextRequiredAction: 'reconcile_existing_native_watchdog_before_create_update_or_yield',
        handoffDeadlineAt: continuation.pendingDueAt ?? continuation.dueAt,
      });
    } catch (error: unknown) {
      return mapError(error);
    }
  }

  public async recordScheduledContinuationReceipt(
    actor: FileActor,
    request: RecordScheduledContinuationReceiptRequest,
  ): Promise<Result<ScheduledContinuationSnapshot>> {
    try {
      const continuationId = required(request.continuationId, 'continuationId', MAX_ID);
      if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 0) throw new Error('expectedVersion is invalid');
      const suppliedNativeTaskId = request.nativeTaskId === undefined ? undefined : required(request.nativeTaskId, 'nativeTaskId', MAX_NATIVE_TASK_ID);
      const suppliedDueAt = request.dueAt === undefined ? undefined : requiredIso(request.dueAt, 'dueAt');
      if ((request.outcome === 'created' || request.outcome === 'rescheduled') && suppliedDueAt === undefined) {
        throw new Error(`${request.outcome} requires the native host scheduled dueAt`);
      }
      const nativeRunReceipt = request.nativeRunReceipt === undefined
        ? undefined
        : normalizeNativeRunReceipt(request.nativeRunReceipt);
      const nativeCancellationReceipt = request.nativeCancellationReceipt === undefined
        ? undefined
        : normalizeNativeCancellationReceipt(request.nativeCancellationReceipt);
      if (request.outcome === 'consumed' && nativeRunReceipt === undefined) {
        throw new Error('consumed requires a native host run receipt');
      }
      if (request.outcome !== 'consumed' && nativeRunReceipt !== undefined) {
        throw new Error('nativeRunReceipt is only valid for consumed');
      }
      if (request.outcome === 'cancelled' && nativeCancellationReceipt === undefined) {
        throw new Error('cancelled requires native host evidence that the task is non-runnable');
      }
      if (request.outcome !== 'cancelled' && nativeCancellationReceipt !== undefined) {
        throw new Error('nativeCancellationReceipt is only valid for cancelled');
      }
      if (
        suppliedNativeTaskId !== undefined
        && nativeRunReceipt !== undefined
        && suppliedNativeTaskId !== nativeRunReceipt.nativeTaskId
      ) {
        throw new Error('native run receipt task ID does not match nativeTaskId');
      }
      if (
        suppliedNativeTaskId !== undefined
        && nativeCancellationReceipt !== undefined
        && suppliedNativeTaskId !== nativeCancellationReceipt.nativeTaskId
      ) {
        throw new Error('native cancellation receipt task ID does not match nativeTaskId');
      }
      const nativeTaskId = nativeRunReceipt?.nativeTaskId ?? nativeCancellationReceipt?.nativeTaskId ?? suppliedNativeTaskId;
      const detail = request.detail === undefined ? undefined : safeText(request.detail, MAX_RECEIPT_DETAIL, 'detail', true);
      const record = await this.goals.recordScheduledContinuationReceipt({
        continuationId,
        ownerClientId: owner(actor),
        expectedVersion: request.expectedVersion,
        outcome: request.outcome,
        ...(nativeTaskId === undefined ? {} : { nativeTaskId }),
        ...(suppliedDueAt === undefined ? {} : { dueAt: suppliedDueAt }),
        ...(request.runsOn === undefined ? {} : { runsOn: request.runsOn }),
        ...(nativeRunReceipt === undefined ? {} : { nativeRunReceipt }),
        ...(nativeCancellationReceipt === undefined ? {} : { nativeCancellationReceipt }),
        ...(detail === undefined ? {} : { detail }),
        now: this.now().toISOString(),
      });
      return ok(toPublicContinuation(record));
    } catch (error: unknown) {
      return mapError(error);
    }
  }

  public async cancelScheduledContinuation(
    actor: FileActor,
    request: CancelScheduledContinuationRequest,
  ): Promise<Result<CancelScheduledContinuationResult>> {
    try {
      if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 0) throw new Error('expectedVersion is invalid');
      const target = 'continuationId' in request
        ? { continuationId: required(request.continuationId, 'continuationId', MAX_ID) }
        : { goalId: required(request.goalId, 'goalId', MAX_ID), latest: true as const };
      const cancelled = await this.goals.cancelScheduledContinuation({
        ...target,
        ownerClientId: owner(actor),
        expectedVersion: request.expectedVersion,
        now: this.now().toISOString(),
      });
      const continuation = toPublicContinuation(cancelled.continuation);
      return ok({
        outcome: cancelled.outcome,
        continuation,
        cancellation: scheduledTaskCancellationInstruction(cancelled.continuation),
      });
    } catch (error: unknown) {
      return mapError(error);
    }
  }

  public async claimScheduledContinuation(
    actor: FileActor,
    request: ClaimScheduledContinuationRequest,
  ): Promise<Result<ClaimScheduledContinuationResult>> {
    try {
      const continuationId = required(request.continuationId, 'continuationId', MAX_ID);
      const leaseSeconds = request.leaseSeconds ?? 600;
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) throw new Error('leaseSeconds is out of range');
      const currentContinuation = await this.goals.getScheduledContinuation({ continuationId });
      if (currentContinuation === null) throw new GoalStateError('not_found', 'Scheduled continuation was not found');
      const currentGoal = await this.requireOwnedGoal(actor, currentContinuation.goalId);
      const claimSuccessorRequestFingerprint = createHash('sha256')
        .update(`claimed-successor-v1\0${continuationId}`)
        .digest('hex');
      const claimSuccessorId = `wake-${claimSuccessorRequestFingerprint.slice(0, 48)}`;
      const trackedTasks = currentGoal.trackedTasks ?? currentGoal.activeTaskIds.map((taskId) => legacyTrackedTask(taskId));
      // Liveness may perform async probes. Sample the authoritative transition time only after
      // those probes finish so a fresh observedAt cannot appear to come from the future.
      const liveness = await this.workerLiveness.observe(currentGoal.id, trackedTasks);
      const nowDate = this.now();
      const now = nowDate.toISOString();
      const leaseToken = randomBytes(32).toString('base64url');
      const claimSuccessorDelayMinutes = Math.min(
        MAX_SUCCESSOR_DELAY_MINUTES,
        Math.max(MIN_SUCCESSOR_DELAY_MINUTES, Math.ceil(leaseSeconds / 60)),
      );
      const claimSuccessorDueAt = new Date(nowDate.getTime() + claimSuccessorDelayMinutes * 60_000).toISOString();
      const claimed = await this.goals.claimScheduledContinuation({
        continuationId,
        ownerClientId: owner(actor),
        ownerSessionId: ownerSession(actor),
        leaseTokenHash: hashLeaseToken(leaseToken),
        leaseSeconds,
        earlyToleranceSeconds: SCHEDULED_WAKE_EARLY_TOLERANCE_SECONDS,
        liveness,
        now,
        claimSuccessorId,
        claimSuccessorDueAt,
        claimSuccessorRequestFingerprint,
      });
      const continuation = toPublicContinuation(claimed.continuation);
      const goal = toGoalSnapshot(claimed.goal);
      if (claimed.outcome === 'acquired') {
        const successor = toPublicContinuation(claimed.successor);
        return ok({
          outcome: 'acquired',
          continuation,
          successor,
          goal: { ...toRunSnapshot(goal), acquired: true },
          leaseToken,
          leaseGeneration: claimed.goal.leaseGeneration,
          acquisition: claimed.acquisition,
          scheduleRequest: buildScheduleRequest(successor, claimed.goal.workspaceId, this.hostTimeZone),
          handoffReady: false,
          currentWakeMayReturn: false,
          nextRequiredAction: 'create_native_task_and_record_receipt_before_current_wake_returns',
        });
      }
      if (claimed.outcome === 'successor_required') {
        const successor = toPublicContinuation(claimed.successor);
        if (claimed.successorDisposition === 'existing_unconfirmed') {
          return ok({
            outcome: 'successor_required',
            reason: successor.nativeTaskId !== undefined
              ? 'native_task_id_already_recorded'
              : successor.status === 'create_uncertain'
                ? 'native_task_creation_uncertain'
                : 'native_task_receipt_missing',
            continuation,
            successor,
            goal,
            retryAfterSeconds: claimed.retryAfterSeconds,
            handoffReady: false,
            currentWakeMayReturn: false,
            nextRequiredAction: 'reconcile_reserved_successor_native_receipt_before_create_or_return',
          });
        }
        return ok({
          outcome: 'successor_required',
          continuation,
          successor,
          goal,
          retryAfterSeconds: claimed.retryAfterSeconds,
          scheduleRequest: buildScheduleRequest(successor, claimed.goal.workspaceId, this.hostTimeZone),
          handoffReady: false,
          currentWakeMayReturn: false,
          nextRequiredAction: 'create_native_task_and_record_receipt_before_current_wake_returns',
        });
      }
      if (claimed.outcome === 'reschedule_required') {
        return ok({
          outcome: 'reschedule_required',
          continuation,
          goal,
          retryAfterSeconds: claimed.retryAfterSeconds,
          taskUpdateRequest: buildTaskUpdateRequest(continuation, claimed.goal.workspaceId, this.hostTimeZone),
          handoffReady: false,
          currentWakeMayReturn: false,
          nextRequiredAction: 'update_same_native_task_and_record_receipt_before_current_wake_returns',
        });
      }
      if (claimed.outcome === 'receipt_required') {
        return ok({
          outcome: 'receipt_required',
          reason: claimed.reason,
          continuation,
          goal,
          handoffReady: false,
          currentWakeMayReturn: false,
          nextRequiredAction: 'reconcile_native_task_receipt_before_mutation_or_return',
        });
      }
      if (claimed.outcome === 'already_claimed' || claimed.outcome === 'terminal_noop') {
        return ok({ outcome: claimed.outcome, continuation, goal });
      }
      if (claimed.outcome !== 'not_due') throw new GoalStateError('corrupt', 'Unexpected scheduled continuation claim outcome');
      return ok({
        outcome: 'not_due',
        continuation,
        goal,
        retryAfterSeconds: claimed.retryAfterSeconds,
        taskUpdateRequest: buildTaskUpdateRequest(continuation, claimed.goal.workspaceId, this.hostTimeZone, continuation.pendingDueAt ?? continuation.dueAt),
        handoffReady: false,
        currentWakeMayReturn: false,
        nextRequiredAction: 'reschedule_same_native_task_to_safe_due_time',
      });
    } catch (error: unknown) {
      return mapError(error);
    }
  }

  public async expediteScheduledContinuation(
    actor: FileActor,
    request: ExpediteScheduledContinuationRequest,
  ): Promise<Result<ExpediteScheduledContinuationResult>> {
    try {
      const goalId = required(request.goalId, 'goalId', MAX_ID);
      const continuationId = required(request.continuationId, 'continuationId', MAX_ID);
      if (!Number.isInteger(request.expectedLeaseGeneration) || request.expectedLeaseGeneration < 0) throw new Error('expectedLeaseGeneration is invalid');
      if (!Number.isInteger(request.expectedGoalRevision) || request.expectedGoalRevision < 0) throw new Error('expectedGoalRevision is invalid');
      if (!Number.isInteger(request.expectedContinuationVersion) || request.expectedContinuationVersion < 0) throw new Error('expectedContinuationVersion is invalid');
      const reasons: readonly ScheduledContinuationExpediteReason[] = [
        'host_deadline_warning',
        'host_budget_warning',
        'tool_access_degradation',
        'turn_yield_signal',
      ];
      if (!reasons.includes(request.reason)) throw new Error('reason is invalid');
      const currentGoal = await this.requireOwnedGoal(actor, goalId);
      const now = this.now();
      const expediteLeadSeconds = adaptiveExpediteLeadSeconds(currentGoal, continuationId, now);
      const candidateDueAt = new Date(now.getTime() + expediteLeadSeconds * 1_000).toISOString();
      const expedited = await this.goals.expediteScheduledContinuation({
        goalId,
        continuationId,
        ownerClientId: owner(actor),
        ownerSessionId: ownerSession(actor),
        leaseTokenHash: hashLeaseToken(required(request.leaseToken, 'leaseToken', 256)),
        expectedLeaseGeneration: request.expectedLeaseGeneration,
        expectedGoalRevision: request.expectedGoalRevision,
        expectedContinuationVersion: request.expectedContinuationVersion,
        reason: request.reason,
        dueAt: candidateDueAt,
        now: now.toISOString(),
      });
      const continuation = toPublicContinuation(expedited.continuation);
      if (expedited.outcome === 'unchanged') {
        return ok({ outcome: 'unchanged', reason: expedited.reason, continuation });
      }
      return ok({
        outcome: 'update_required',
        continuation,
        handoffDeadlineAt: continuation.pendingDueAt ?? continuation.dueAt,
        taskUpdateRequest: buildTaskUpdateRequest(continuation, expedited.goal.workspaceId, this.hostTimeZone),
      });
    } catch (error: unknown) {
      return mapError(error);
    }
  }

  public async getScheduledContinuation(
    actor: FileActor,
    request: GetScheduledContinuationRequest,
  ): Promise<Result<ScheduledContinuationSnapshot>> {
    try {
      const record = await this.goals.getScheduledContinuation(
        'continuationId' in request
          ? { continuationId: required(request.continuationId, 'continuationId', MAX_ID) }
          : { goalId: required(request.goalId, 'goalId', MAX_ID), latest: true },
      );
      if (record === null) return err(appError('INVALID_INPUT', 'Scheduled continuation was not found'));
      const goal = await this.requireOwnedGoal(actor, record.goalId);
      if (goal.id !== record.goalId) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      return ok(toPublicContinuation(record));
    } catch (error: unknown) {
      return mapError(error);
    }
  }

  /**
   * Runtime safety gate for workspace mutations while a rolling scheduled goal is active.
   * Once a goal has entered scheduled-continuation mode, only the unexpired lease-owning
   * MCP session may mutate that workspace. Reads remain outside this gate.
   */
  public async authorizeWorkspaceMutation(
    actor: FileActor,
    workspaceId: string,
  ): Promise<Result<{ readonly allowed: true; readonly goalId?: string }>> {
    try {
      const boundedWorkspaceId = required(workspaceId, 'workspaceId', MAX_ID);
      const fence = await this.goals.getWorkspaceMutationFence(boundedWorkspaceId);
      if (fence === null) return ok({ allowed: true });
      const goal = fence.goal;
      if (goal.ownerClientId !== owner(actor)) {
        return err(appError('CONFLICT', 'Workspace is reserved by another rolling scheduled goal owner', true));
      }
      const nowMs = this.now().getTime();
      const expiresMs = goal.leaseExpiresAt === undefined ? Number.NaN : Date.parse(goal.leaseExpiresAt);
      if (
        goal.leaseOwnerClientId !== owner(actor)
        || goal.leaseOwnerSessionId !== ownerSession(actor)
        || !Number.isFinite(expiresMs)
        || expiresMs <= nowMs
      ) {
        return err(appError(
          'CONFLICT',
          'Workspace mutation is blocked by the scheduled-continuation fence. The current run must own an unexpired claimed goal lease before mutating files, Git, or processes.',
          true,
        ));
      }
      return ok({ allowed: true, goalId: goal.id });
    } catch (error: unknown) {
      return mapError(error);
    }
  }

  private async requireOwnedGoal(actor: FileActor, goalId: string): Promise<GoalRecord> {
    const goal = await this.goals.getById(goalId);
    if (goal === null) throw new GoalStateError('not_found', 'Goal was not found');
    if (goal.ownerClientId !== owner(actor)) throw new GoalStateError('owner_mismatch', 'Goal belongs to another client');
    return goal;
  }
}

function buildScheduleRequest(
  continuation: ScheduledContinuationSnapshot,
  workspaceId: string,
  hostTimeZone: string,
): ScheduledContinuationRequest {
  const prompt = `Call claim_scheduled_continuation first for continuation ${continuation.continuationId}, goal ${continuation.goalId}, workspace ${workspaceId}. Use every returned scheduleRequest.schedule verbatim with its explicit IANA TZID; dueAt remains the canonical absolute instant and host receipts must report the real absolute dueAt. Native wake jitter up to 120 seconds early is a safety tolerance, not a scheduling cadence. A one-time task that has fired is consumed transport identity: never try to re-arm or repeatedly update that firing nativeTaskId. If claim returns acquired, lnwjud already reserved a fresh lease-aligned successor; create that exact cloud one-time task, record its real host receipt, and do not call prepare_scheduled_continuation again. If claim returns successor_required with a scheduleRequest, create that exact deterministic adaptive successor and record its receipt. This outcome is also used when a firing wake collides with a live or uncertain worker, an expired lease still has blocking work, or the host fired outside the accepted early window. If successor_required reports native_task_receipt_missing, native_task_creation_uncertain, or native_task_id_already_recorded, reconcile exact host metadata before any create and never create blindly. A truthfully failed create with no native ID may be refreshed to the current adaptive lease-aligned deadline. reschedule_required means the exact confirmed native watchdog is still pending and must be retimed using the same nativeTaskId; apply only the returned taskUpdateRequest and never use this path for a one-time task that has already fired. expedite_scheduled_continuation may update only a still-pending future native task before it fires; its returned due time is adaptive and must be used verbatim. A prepared reservation is not handoff-ready. Resolve the actual native Scheduled Task operation from the current ChatGPT host/tool registry and never assume or hard-code an internal host operation name. If native creation is unavailable, rejected, not-found, or unsupported, immediately record create_failed for the current continuation version before checkpointing, yielding, or relying on that reservation; record create_uncertain only when host creation may actually have succeeded but exact identity is unknown. Keep useful fenced work running only while the current goal lease remains valid. Before any worker returns or yields with an active goal, require one confirmed cloud successor or a terminal goal. Keep waiting on blocking task IDs until terminal results are inspected. Never send a completion response while get_goal still reports active. When acceptance evidence is complete, call finish_goal. If it returns pending_native_cleanup, make the exact pending native task non-runnable using the strongest operation actually exposed by the host: prefer true delete, otherwise a host-confirmed disable is acceptable non-runnable evidence. Record the exact native receipt without relabeling disable as delete, then call finish_goal again. Report completion only after finish_goal completionState=completed and get_goal is terminal. If claim returns terminal_noop, let the already-firing one-time host task return naturally. Never report cleanup without exact host evidence and never use Windows Task Scheduler.`;
  return {
    provider: 'chatgpt_scheduled_task',
    occurrence: 'once',
    dueAt: continuation.dueAt,
    schedule: buildHostSchedule(continuation.dueAt, hostTimeZone),
    scheduleTimeZone: hostTimeZone,
    destination: 'current_chat',
    executionPreference: continuation.executionPreference,
    continuationId: continuation.continuationId,
    name: `Continue lnwjud goal ${continuation.goalId}`.slice(0, 120),
    prompt,
  };
}

function buildTaskUpdateRequest(
  continuation: ScheduledContinuationSnapshot,
  workspaceId: string,
  hostTimeZone: string,
  targetDueAt = continuation.pendingDueAt,
): ScheduledContinuationTaskUpdateRequest {
  if (continuation.nativeTaskId === undefined || targetDueAt === undefined || !isConfirmedNativeHostRunMode(continuation.confirmedRunsOn)) {
    throw new GoalStateError('conflict', 'Same-task update requires a confirmed native host task ID, compatible execution mode, and target due time');
  }
  return {
    provider: 'chatgpt_scheduled_task',
    operation: 'update',
    occurrence: 'once',
    dueAt: targetDueAt,
    schedule: buildHostSchedule(targetDueAt, hostTimeZone),
    scheduleTimeZone: hostTimeZone,
    destination: 'current_chat',
    executionPreference: 'cloud',
    continuationId: continuation.continuationId,
    nativeTaskId: continuation.nativeTaskId,
    expectedContinuationVersion: continuation.version,
    name: `Continue lnwjud goal ${continuation.goalId}`.slice(0, 120),
    prompt: `Wake the current chat for continuation ${continuation.continuationId}, goal ${continuation.goalId}, workspace ${workspaceId}. This update request is valid only while this exact native task is still pending before it fires. Apply taskUpdateRequest.schedule verbatim and record the host-reported absolute dueAt. When the task later fires, call claim_scheduled_continuation first and treat the firing one-time task as consumed transport identity. If claim returns successor_required, create the exact fresh adaptive successor returned by claim; never re-arm the firing task. If claim returns terminal_noop, let the firing one-time host task return naturally.`,
  };
}

function buildHostSchedule(dueAt: string, hostTimeZone: string): string {
  const parsed = new Date(requiredIso(dueAt, 'scheduled dueAt'));
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: hostTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(parsed);
  const value = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (part === undefined) throw new GoalStateError('corrupt', `Scheduled host time is missing ${type}`);
    return part;
  };
  const compactLocal = `${value('year')}${value('month')}${value('day')}T${value('hour')}${value('minute')}${value('second')}`;
  return `BEGIN:VEVENT\nDTSTART;TZID=${hostTimeZone}:${compactLocal}\nEND:VEVENT`;
}

function normalizeHostTimeZone(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) throw new Error('hostTimeZone is invalid');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    throw new Error('hostTimeZone must be a valid IANA time zone');
  }
}

function scheduledTaskCancellationInstruction(record: ScheduledContinuationSnapshot): ScheduledTaskCancellationInstruction {
  if (record.status === 'superseded') return { action: 'none', reason: 'no_live_task' };
  if (
    (record.status === 'cancel_required' || record.status === 'cancel_failed')
    && record.nativeTaskId !== undefined
  ) {
    return {
      action: 'make_native_task_non_runnable',
      continuationId: record.continuationId,
      nativeTaskId: record.nativeTaskId,
      provider: 'chatgpt_scheduled_task',
      expectedContinuationVersion: record.version,
      receiptRequired: true,
      requiredEffect: 'non_runnable',
      reason: 'live_task_confirmed',
    };
  }
  if (record.status === 'cancelled') {
    return {
      action: 'none',
      continuationId: record.continuationId,
      ...(record.nativeTaskId === undefined ? {} : { nativeTaskId: record.nativeTaskId }),
      reason: 'already_cancelled',
    };
  }
  if (record.status === 'claimed' || record.status === 'terminal_noop') {
    return {
      action: 'none',
      continuationId: record.continuationId,
      ...(record.nativeTaskId === undefined ? {} : { nativeTaskId: record.nativeTaskId }),
      reason: 'already_fired',
    };
  }
  return {
    action: 'none',
    continuationId: record.continuationId,
    ...(record.nativeTaskId === undefined ? {} : { nativeTaskId: record.nativeTaskId }),
    reason: 'native_task_unverified',
  };
}

function toPublicContinuation(record: ScheduledContinuationSnapshot): ScheduledContinuationSnapshot {
  return {
    continuationId: record.continuationId,
    goalId: record.goalId,
    generation: record.generation,
    sourceGoalRevision: record.sourceGoalRevision,
    status: record.status,
    occurrence: 'once',
    destination: 'current_chat',
    executionPreference: record.executionPreference,
    ...(record.confirmedRunsOn === undefined ? {} : { confirmedRunsOn: record.confirmedRunsOn }),
    dueAt: record.dueAt,
    ...(record.pendingDueAt === undefined ? {} : { pendingDueAt: record.pendingDueAt }),
    ...(record.nativeTaskId === undefined ? {} : { nativeTaskId: record.nativeTaskId }),
    ...(record.rescheduleReason === undefined ? {} : { rescheduleReason: record.rescheduleReason }),
    rescheduleCount: record.rescheduleCount,
    ...(record.lastCollisionAt === undefined ? {} : { lastCollisionAt: record.lastCollisionAt }),
    ...(record.lastRescheduledAt === undefined ? {} : { lastRescheduledAt: record.lastRescheduledAt }),
    ...(record.orphanProbeStartedAt === undefined ? {} : { orphanProbeStartedAt: record.orphanProbeStartedAt }),
    ...(record.orphanProbeLeaseGeneration === undefined ? {} : { orphanProbeLeaseGeneration: record.orphanProbeLeaseGeneration }),
    ...(record.orphanProbeActivitySeq === undefined ? {} : { orphanProbeActivitySeq: record.orphanProbeActivitySeq }),
    orphanRecoveryCount: record.orphanRecoveryCount,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toGoalSnapshot(goal: GoalRecord): GoalSnapshot {
  return {
    goalId: goal.id,
    goalKey: goal.goalKey,
    workspaceId: goal.workspaceId,
    objective: goal.objective,
    status: goal.status,
    revision: goal.revision,
    currentPhase: goal.currentPhase,
    plan: goal.plan,
    completedSteps: goal.plan.steps.filter((step) => step.status === 'completed'),
    pendingSteps: goal.plan.steps.filter((step) => step.status !== 'completed'),
    nextAction: goal.nextAction,
    blockers: goal.blockers,
    activeTaskIds: goal.activeTaskIds,
    trackedTasks: goal.trackedTasks ?? goal.activeTaskIds.map((taskId) => legacyTrackedTask(taskId)),
    lastCheckpoint: goal.checkpoints.at(-1) ?? null,
    leaseGeneration: goal.leaseGeneration,
    leaseActivitySeq: goal.leaseActivitySeq,
    ...(goal.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: goal.leaseExpiresAt }),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    ...(goal.terminalSummary === undefined ? {} : { terminalSummary: goal.terminalSummary }),
    ...(goal.terminalEvidence === undefined ? {} : { terminalEvidence: goal.terminalEvidence }),
    ...(goal.terminalAt === undefined ? {} : { terminalAt: goal.terminalAt }),
  };
}

function toRunSnapshot(goal: GoalSnapshot): Omit<RunGoalResult, 'leaseToken' | 'acquired'> {
  return {
    goalId: goal.goalId,
    goalKey: goal.goalKey,
    status: goal.status,
    revision: goal.revision,
    currentPhase: goal.currentPhase,
    plan: goal.plan,
    completedSteps: goal.completedSteps,
    pendingSteps: goal.pendingSteps,
    nextAction: goal.nextAction,
    blockers: goal.blockers,
    activeTaskIds: goal.activeTaskIds,
    trackedTasks: goal.trackedTasks,
    lastCheckpoint: goal.lastCheckpoint,
    leaseGeneration: goal.leaseGeneration,
    leaseActivitySeq: goal.leaseActivitySeq,
    ...(goal.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: goal.leaseExpiresAt }),
  };
}

function normalizeSuccessorDelay(value: number | undefined, leaseDurationSeconds: number | undefined): number {
  const leaseAlignedDelay = Math.ceil((leaseDurationSeconds ?? DEFAULT_SUCCESSOR_DELAY_MINUTES * 60) / 60);
  const delay = value ?? Math.min(MAX_SUCCESSOR_DELAY_MINUTES, Math.max(MIN_SUCCESSOR_DELAY_MINUTES, leaseAlignedDelay));
  if (!Number.isInteger(delay) || delay < MIN_SUCCESSOR_DELAY_MINUTES || delay > MAX_SUCCESSOR_DELAY_MINUTES) {
    throw new Error(`successorDelayMinutes must be between ${MIN_SUCCESSOR_DELAY_MINUTES} and ${MAX_SUCCESSOR_DELAY_MINUTES}`);
  }
  return delay;
}

function adaptiveExpediteLeadSeconds(goal: GoalRecord, continuationId: string, now: Date): number {
  const remainingLeaseSeconds = goal.leaseExpiresAt === undefined
    ? DEFAULT_SUCCESSOR_DELAY_MINUTES * 60
    : Math.max(0, Math.ceil((new Date(goal.leaseExpiresAt).getTime() - now.getTime()) / 1000));
  const leaseProportionalLead = Math.ceil(remainingLeaseSeconds / 3);
  const deterministicSkewSeconds = Number.parseInt(createHash('sha256').update(continuationId).digest('hex').slice(0, 2), 16) % 31;
  return Math.min(
    MAX_EXPEDITE_LEAD_SECONDS,
    Math.max(MIN_EXPEDITE_LEAD_SECONDS, leaseProportionalLead + deterministicSkewSeconds),
  );
}

function normalizeStepUpdates(updates: readonly GoalStepUpdate[], plan: GoalPlan): readonly GoalStepUpdate[] {
  if (!Array.isArray(updates) || updates.length > 100) throw new Error('stepUpdates are invalid');
  const known = new Set(plan.steps.map((step) => step.id));
  const seen = new Set<string>();
  return updates.map((update) => {
    const stepId = required(update.stepId, 'stepId', 128);
    if (!known.has(stepId) || seen.has(stepId)) throw new Error('stepUpdates are invalid');
    seen.add(stepId);
    if (!['pending', 'in_progress', 'completed', 'blocked'].includes(update.status)) throw new Error('stepUpdates are invalid');
    return { stepId, status: update.status, ...(update.summary === undefined ? {} : { summary: safeText(update.summary, 1_024, 'step summary', true) }) };
  });
}

function applyStepUpdates(plan: GoalPlan, updates: readonly GoalStepUpdate[]): GoalPlan {
  const byId = new Map(updates.map((update) => [update.stepId, update]));
  return {
    steps: plan.steps.map((step) => {
      const update = byId.get(step.id);
      return update === undefined ? step : { ...step, status: update.status, ...(update.summary === undefined ? {} : { summary: update.summary }) };
    }),
  };
}

function normalizeEvidence(values: readonly GoalEvidence[]): readonly GoalEvidence[] {
  if (!Array.isArray(values) || values.length > 20) throw new Error('evidence is invalid');
  return values.map((value) => {
    if (!['path', 'hash', 'task', 'note'].includes(value.kind)) throw new Error('evidence is invalid');
    return { kind: value.kind, value: safeText(value.value, 1_024, 'evidence') };
  });
}

function normalizeStrings(values: readonly string[], maxItems: number, maxLength: number, label: string): readonly string[] {
  if (!Array.isArray(values) || values.length > maxItems) throw new Error(`${label} are invalid`);
  return [...new Set(values.map((value) => safeText(value, maxLength, label)))];
}

function normalizeTrackedTasks(
  trackedTasks: readonly GoalTrackedTask[] | undefined,
  activeTaskIds: readonly string[] | undefined,
): readonly GoalTrackedTask[] {
  if (trackedTasks !== undefined && activeTaskIds !== undefined && activeTaskIds.length > 0) {
    throw new Error('Use trackedTasks or activeTaskIds, not both');
  }
  if (trackedTasks !== undefined) {
    if (!Array.isArray(trackedTasks) || trackedTasks.length > 50) throw new Error('trackedTasks are invalid');
    const seen = new Set<string>();
    return trackedTasks.map((entry) => {
      const taskId = required(entry.taskId, 'task id', 256);
      if (entry.provider !== 'process' && entry.provider !== 'codex' && entry.provider !== 'shell') throw new Error('tracked task provider is invalid');
      if (entry.role !== 'blocking_job' && entry.role !== 'supporting_service') throw new Error('tracked task role is invalid');
      if (typeof entry.cancelWithGoal !== 'boolean') throw new Error('tracked task cancellation policy is invalid');
      const key = `${entry.provider}\0${taskId}`;
      if (seen.has(key)) throw new Error('tracked task bindings must be unique');
      seen.add(key);
      return { taskId, provider: entry.provider, role: entry.role, cancelWithGoal: entry.cancelWithGoal };
    });
  }
  return normalizeStrings(activeTaskIds ?? [], 50, 256, 'activeTaskIds').map((taskId) => legacyTrackedTask(taskId));
}

function blockingTaskIds(tasks: readonly GoalTrackedTask[]): readonly string[] {
  return tasks.filter((task) => task.role === 'blocking_job').map((task) => task.taskId);
}

function legacyTrackedTask(taskId: string): GoalTrackedTask {
  return { taskId, provider: 'legacy_auto', role: 'blocking_job', cancelWithGoal: true };
}

function owner(actor: FileActor): string { return required(actor.clientId, 'client identity', 128); }
function ownerSession(actor: FileActor): string { return required(actor.sessionId?.trim() || actor.clientId, 'session identity', 128); }
function required(value: string, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) throw new Error(`${label} is invalid`);
  return trimmed;
}
function safeText(value: string, maxLength: number, label: string, allowEmpty = false): string {
  const trimmed = requiredText(value, label).trim();
  if (!allowEmpty && trimmed.length === 0) throw new Error(`${label} is required`);
  if (trimmed.length > maxLength) throw new Error(`${label} exceeds the allowed length`);
  return redact(trimmed);
}
function requiredText(value: string, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  return value;
}
function redact(value: string): string {
  return value
    .replace(/(\bauthorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b(token|secret|password|api[_-]?key|private[_-]?key|credential)\s*[:=]\s*[^\s]+/gi, '$1=[REDACTED]');
}
function isConfirmedNativeHostRunMode(value: ScheduledContinuationRunsOn | undefined): boolean {
  return value === 'cloud' || value === 'unverified';
}

function requiredIso(value: string, label: string): string {
  const bounded = required(value, label, 64);
  if (Number.isNaN(Date.parse(bounded))) throw new Error(`${label} is invalid`);
  return bounded;
}

function normalizeNativeRunReceipt(
  receipt: ScheduledContinuationNativeRunReceipt,
): ScheduledContinuationNativeRunReceipt {
  if (receipt.provider !== 'chatgpt_scheduled_task' || receipt.operation !== 'run') {
    throw new Error('native run receipt provider or operation is invalid');
  }
  if (receipt.state !== 'consumed') throw new Error('native run receipt state is invalid');
  return {
    provider: 'chatgpt_scheduled_task',
    operation: 'run',
    nativeTaskId: required(receipt.nativeTaskId, 'native run receipt task ID', MAX_NATIVE_TASK_ID),
    state: 'consumed',
    observedAt: requiredIso(receipt.observedAt, 'native run receipt observedAt'),
  };
}

function normalizeNativeCancellationReceipt(
  receipt: ScheduledContinuationNativeCancellationReceipt,
): ScheduledContinuationNativeCancellationReceipt {
  if (receipt.provider !== 'chatgpt_scheduled_task') {
    throw new Error('native cancellation receipt provider is invalid');
  }
  const nativeTaskId = required(receipt.nativeTaskId, 'native cancellation receipt task ID', MAX_NATIVE_TASK_ID);
  const observedAt = requiredIso(receipt.observedAt, 'native cancellation receipt observedAt');
  if (receipt.operation === 'delete') {
    if (receipt.state !== 'deleted' && receipt.state !== 'not_found') {
      throw new Error('native deletion receipt state is invalid');
    }
    return { provider: 'chatgpt_scheduled_task', operation: 'delete', nativeTaskId, state: receipt.state, observedAt };
  }
  if (receipt.operation === 'disable') {
    if (receipt.state !== 'disabled') throw new Error('native disable receipt state is invalid');
    return { provider: 'chatgpt_scheduled_task', operation: 'disable', nativeTaskId, state: 'disabled', observedAt };
  }
  throw new Error('native cancellation receipt operation is invalid');
}
function hashLeaseToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }

function mapError(error: unknown): Result<never> {
  if (error instanceof GoalStateError) {
    switch (error.reason) {
      case 'owner_mismatch': return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      case 'lease_invalid': return err(appError('CONFLICT', `Goal lease is no longer valid (${error.message}); read the latest goal and reacquire or claim the scheduled continuation before retrying`, true));
      case 'conflict': return err(appError('CONFLICT', error.message, true));
      case 'terminal': return err(appError('CONFLICT', 'Goal is already terminal'));
      case 'not_found': return err(appError('INVALID_INPUT', 'Goal or continuation was not found'));
      case 'corrupt': return err(appError('INTERNAL_ERROR', 'Durable scheduled continuation state is corrupt and was rejected'));
    }
  }
  if (error instanceof Error) return err(appError('INVALID_INPUT', error.message));
  return err(appError('INTERNAL_ERROR', 'Scheduled continuation operation failed'));
}
