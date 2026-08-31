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
  type ScheduledContinuationSnapshot,
  type ScheduledContinuationWorkerLivenessPort,
  type ScheduledTaskCancellationInstruction,
} from '@lnwjud/domain';
import type { FileActor } from './file-service.js';
import type { GoalSnapshot, RunGoalResult } from './goal-continuation-service.js';

export const DEFAULT_SUCCESSOR_DELAY_MINUTES = 2;
export const MIN_SUCCESSOR_DELAY_MINUTES = 2;
export const MAX_SUCCESSOR_DELAY_MINUTES = 25;
/** @deprecated Use DEFAULT_SUCCESSOR_DELAY_MINUTES for the fail-safe handoff default. */
export const SUCCESSOR_DELAY_MINUTES = DEFAULT_SUCCESSOR_DELAY_MINUTES;
export const COLLISION_RESCHEDULE_MINUTES = 2;
export const SCHEDULED_WAKE_EARLY_TOLERANCE_SECONDS = 120;

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
  readonly dueAt: string;
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
  readonly goal: GoalSnapshot;
  readonly continuation: ScheduledContinuationSnapshot;
  readonly scheduleRequest: ScheduledContinuationRequest;
  readonly currentRunMayContinue: true;
  readonly handoffDeadlineAt: string;
}

export interface RecordScheduledContinuationReceiptRequest {
  readonly continuationId: string;
  readonly expectedVersion: number;
  readonly outcome: ScheduledContinuationReceiptOutcome;
  readonly nativeTaskId?: string;
  readonly dueAt?: string;
  readonly runsOn?: 'cloud';
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
      readonly goal: Omit<RunGoalResult, 'leaseToken'>;
      readonly leaseToken: string;
      readonly leaseGeneration: number;
      readonly acquisition: 'normal' | 'expired_lease' | 'orphan_recovered';
    }
  | {
      readonly outcome: 'successor_required';
      readonly continuation: ScheduledContinuationSnapshot;
      readonly successor: ScheduledContinuationSnapshot;
      readonly goal: GoalSnapshot;
      readonly retryAfterSeconds: 120;
      readonly scheduleRequest: ScheduledContinuationRequest;
    }
  | {
      readonly outcome: 'receipt_required';
      readonly reason: 'native_task_unconfirmed';
      readonly continuation: ScheduledContinuationSnapshot;
      readonly goal: GoalSnapshot;
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
}

export class ScheduledContinuationService {
  private readonly now: () => Date;
  private readonly workerLiveness: ScheduledContinuationWorkerLivenessPort;

  public constructor(
    private readonly goals: ScheduledContinuationRepository & {
      getById(goalId: string): Promise<GoalRecord | null>;
    },
    options: ScheduledContinuationServiceOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
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
      const successorDelayMinutes = normalizeSuccessorDelay(request.successorDelayMinutes);
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
      const scheduleRequest = buildScheduleRequest(continuation, prepared.goal.workspaceId);
      return ok({
        outcome: prepared.alreadyPrepared ? 'already_prepared' : 'prepared',
        goal: toGoalSnapshot(prepared.goal),
        continuation,
        scheduleRequest,
        currentRunMayContinue: true,
        handoffDeadlineAt: continuation.dueAt,
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
        throw new Error('cancelled requires a native host deletion receipt');
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
        ...(request.dueAt === undefined ? {} : { dueAt: requiredIso(request.dueAt, 'dueAt') }),
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
      const nowDate = this.now();
      const now = nowDate.toISOString();
      const trackedTasks = currentGoal.trackedTasks ?? currentGoal.activeTaskIds.map((taskId) => legacyTrackedTask(taskId));
      const liveness = await this.workerLiveness.observe(currentGoal.id, trackedTasks);
      const leaseToken = randomBytes(32).toString('base64url');
      const collisionIdentity = createHash('sha256')
        .update(`collision-successor-v1\0${continuationId}`)
        .digest('hex');
      const claimed = await this.goals.claimScheduledContinuation({
        continuationId,
        ownerClientId: owner(actor),
        ownerSessionId: ownerSession(actor),
        leaseTokenHash: hashLeaseToken(leaseToken),
        leaseSeconds,
        earlyToleranceSeconds: SCHEDULED_WAKE_EARLY_TOLERANCE_SECONDS,
        liveness,
        collisionSuccessorId: `wake-${collisionIdentity.slice(0, 48)}`,
        collisionSuccessorDueAt: new Date(nowDate.getTime() + COLLISION_RESCHEDULE_MINUTES * 60_000).toISOString(),
        collisionSuccessorRequestFingerprint: collisionIdentity,
        now,
      });
      const continuation = toPublicContinuation(claimed.continuation);
      const goal = toGoalSnapshot(claimed.goal);
      if (claimed.outcome === 'acquired') {
        return ok({
          outcome: 'acquired',
          continuation,
          goal: { ...toRunSnapshot(goal), acquired: true },
          leaseToken,
          leaseGeneration: claimed.goal.leaseGeneration,
          acquisition: claimed.acquisition,
        });
      }
      if (claimed.outcome === 'successor_required') {
        const successor = toPublicContinuation(claimed.successor);
        return ok({
          outcome: 'successor_required',
          continuation,
          successor,
          goal,
          retryAfterSeconds: 120,
          scheduleRequest: buildScheduleRequest(successor, claimed.goal.workspaceId),
        });
      }
      if (claimed.outcome === 'receipt_required') {
        return ok({
          outcome: 'receipt_required',
          reason: claimed.reason,
          continuation,
          goal,
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
      const now = this.now();
      const candidateDueAt = new Date(now.getTime() + COLLISION_RESCHEDULE_MINUTES * 60_000).toISOString();
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
        taskUpdateRequest: buildTaskUpdateRequest(continuation, expedited.goal.workspaceId),
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

function buildScheduleRequest(continuation: ScheduledContinuationSnapshot, workspaceId: string): ScheduledContinuationRequest {
  const prompt = `Call claim_scheduled_continuation first for continuation ${continuation.continuationId}, goal ${continuation.goalId}, workspace ${workspaceId}; native wake jitter up to 120 seconds early is accepted. A one-time task that is firing now is a consumed wake ticket and must never be reused as a future successor. If claim returns successor_required, create the fresh one-time cloud task exactly from the returned scheduleRequest, record created for the returned successor immediately, then let this current wake return naturally; do not update or re-arm the firing native task. If exact host metadata later proves a native task ran without claim completing, reconcile it as consumed with the exact host run receipt; consumed never means the goal work completed, and an active goal must reserve a fresh successor. If acquired, immediately arm exactly one cloud successor using an adaptive delay between 2 and 25 minutes and record its receipt before continuing the durable goal. Omitted delay fails safe to +2 minutes; use 5/10/25 minutes only as an explicit watchdog while this run will genuinely keep executing. If an acquired worker will end while unfinished or no worker will remain after the response, leave its still-pending successor at +2 or move that still-pending future task to now+2 through expedite_scheduled_continuation. Keep working or waiting on active task IDs until their terminal results are inspected. Never send a completion response while get_goal still reports active. When acceptance evidence is complete, call finish_goal even if the user disabled further scheduling, then require get_goal to be terminal. Delete the exact distinct pending successor through the native ChatGPT Scheduled Task host only when scheduledTaskCancellation requests it, record cancelled only with the native host deletion receipt, then read the continuation back and require status cancelled. If claim returns terminal_noop, do not delete, disable, pause, or reschedule the current host task; return naturally so the host can mark the one-time run completed. Never use pause/disable as deletion or completion proof. Never report cancellation as successful while deletion is failed, uncertain, or unverified. If the goal is terminal, stop and do not schedule again. Never use Windows Task Scheduler.`;
  return {
    provider: 'chatgpt_scheduled_task',
    occurrence: 'once',
    dueAt: continuation.dueAt,
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
): ScheduledContinuationTaskUpdateRequest {
  if (continuation.nativeTaskId === undefined || continuation.pendingDueAt === undefined || continuation.confirmedRunsOn !== 'cloud') {
    throw new GoalStateError('conflict', 'Same-task update requires a confirmed cloud native task ID and pending due time');
  }
  return {
    provider: 'chatgpt_scheduled_task',
    operation: 'update',
    occurrence: 'once',
    dueAt: continuation.pendingDueAt,
    destination: 'current_chat',
    executionPreference: 'cloud',
    continuationId: continuation.continuationId,
    nativeTaskId: continuation.nativeTaskId,
    expectedContinuationVersion: continuation.version,
    name: `Continue lnwjud goal ${continuation.goalId}`.slice(0, 120),
    prompt: `Wake the current chat for continuation ${continuation.continuationId}, goal ${continuation.goalId}, workspace ${workspaceId}. Call claim_scheduled_continuation first. This update applies only while the one-time task is still pending. Once it starts firing, treat it as a consumed disposable wake ticket: if claim returns successor_required, create the fresh +2-minute successor from scheduleRequest and let this current wake finish naturally. If claim returns terminal_noop, let this already-firing one-time host task return naturally; do not delete, disable, pause, or reschedule it.`,
  };
}

function scheduledTaskCancellationInstruction(record: ScheduledContinuationSnapshot): ScheduledTaskCancellationInstruction {
  if (record.status === 'superseded') return { action: 'none', reason: 'no_live_task' };
  if (
    (record.status === 'cancel_required' || record.status === 'cancel_failed' || record.status === 'cancel_uncertain')
    && record.nativeTaskId !== undefined
  ) {
    return {
      action: 'delete_native_task',
      continuationId: record.continuationId,
      nativeTaskId: record.nativeTaskId,
      provider: 'chatgpt_scheduled_task',
      expectedContinuationVersion: record.version,
      receiptRequired: true,
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

function normalizeSuccessorDelay(value: number | undefined): number {
  const delay = value ?? DEFAULT_SUCCESSOR_DELAY_MINUTES;
  if (!Number.isInteger(delay) || delay < MIN_SUCCESSOR_DELAY_MINUTES || delay > MAX_SUCCESSOR_DELAY_MINUTES) {
    throw new Error(`successorDelayMinutes must be between ${MIN_SUCCESSOR_DELAY_MINUTES} and ${MAX_SUCCESSOR_DELAY_MINUTES}`);
  }
  return delay;
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
  if (receipt.provider !== 'chatgpt_scheduled_task' || receipt.operation !== 'delete') {
    throw new Error('native cancellation receipt provider or operation is invalid');
  }
  if (receipt.state !== 'deleted' && receipt.state !== 'not_found') {
    throw new Error('native cancellation receipt state is invalid');
  }
  return {
    provider: 'chatgpt_scheduled_task',
    operation: 'delete',
    nativeTaskId: required(receipt.nativeTaskId, 'native cancellation receipt task ID', MAX_NATIVE_TASK_ID),
    state: receipt.state,
    observedAt: requiredIso(receipt.observedAt, 'native cancellation receipt observedAt'),
  };
}
function hashLeaseToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }

function mapError(error: unknown): Result<never> {
  if (error instanceof GoalStateError) {
    switch (error.reason) {
      case 'owner_mismatch': return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      case 'lease_invalid': return err(appError('PERMISSION_DENIED', 'Goal lease is invalid or expired', true));
      case 'conflict': return err(appError('CONFLICT', error.message, true));
      case 'terminal': return err(appError('CONFLICT', 'Goal is already terminal'));
      case 'not_found': return err(appError('INVALID_INPUT', 'Goal or continuation was not found'));
      case 'corrupt': return err(appError('INTERNAL_ERROR', 'Durable scheduled continuation state is corrupt and was rejected'));
    }
  }
  if (error instanceof Error) return err(appError('INVALID_INPUT', error.message));
  return err(appError('INTERNAL_ERROR', 'Scheduled continuation operation failed'));
}
