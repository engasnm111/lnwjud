import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  GoalStateError,
  appError,
  err,
  ok,
  type GoalCheckpointRecord,
  type GoalEvidence,
  type GoalPlan,
  type GoalPlanStep,
  type GoalRecord,
  type GoalRepository,
  type GoalStatus,
  type GoalStepStatus,
  type GoalStepUpdate,
  type GoalTrackedTask,
  type GoalTerminalStatus,
  type Result,
  type ScheduledContinuationRecord,
  type ScheduledContinuationRepository,
  type ScheduledTaskCancellationInstruction,
} from '@lnwjud/domain';
import type { WorkspaceRepository } from '@lnwjud/workspace';
import type { FileActor } from './file-service.js';
import {
  failedGoalTaskCancellation,
  isGoalTaskStopped,
  skippedGoalTaskCancellation,
  type GoalTaskCancellationPort,
  type GoalTaskCancellationResult,
} from './goal-task-cancellation-service.js';
import type { GoalRequestCancellationPort, GoalRequestCancellationResult } from './goal-request-cancellation-service.js';

export const DEFAULT_GOAL_LEASE_SECONDS = 600;
export const MIN_GOAL_LEASE_SECONDS = 30;
export const MAX_GOAL_LEASE_SECONDS = 600;

const MAX_OWNER_CLIENT_ID = 128;
const MAX_GOAL_KEY = 128;
const MAX_OBJECTIVE = 4_096;
const MAX_PHASE = 256;
const MAX_SUMMARY = 2_048;
const MAX_NEXT_ACTION = 1_024;
const MAX_STEP_ID = 128;
const MAX_STEP_TITLE = 512;
const MAX_STEP_SUMMARY = 1_024;
const MAX_STEPS = 100;
const MAX_BLOCKERS = 20;
const MAX_BLOCKER = 512;
const MAX_EVIDENCE = 20;
const MAX_EVIDENCE_VALUE = 1_024;
const MAX_ACTIVE_TASKS = 50;
const MAX_TASK_ID = 256;

export interface GoalPlanInputStep {
  readonly id: string;
  readonly title: string;
}

export interface GoalPlanInput {
  readonly steps: readonly GoalPlanInputStep[];
}

export interface RunGoalRequest {
  readonly workspaceId: string;
  readonly goalKey: string;
  readonly objective?: string;
  readonly plan?: GoalPlanInput;
  readonly leaseSeconds?: number;
}

export interface GetGoalRequest {
  readonly goalId?: string;
  readonly workspaceId?: string;
  readonly goalKey?: string;
}

export interface CheckpointGoalRequest {
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
  readonly releaseLease?: boolean;
}

export interface FinishGoalRequest {
  readonly goalId: string;
  readonly leaseToken: string;
  readonly expectedRevision: number;
  readonly status: GoalTerminalStatus;
  readonly summary: string;
  readonly evidence: readonly GoalEvidence[];
}

export interface CancelGoalRequest {
  readonly goalId: string;
  readonly expectedRevision: number;
  readonly summary: string;
  readonly evidence: readonly GoalEvidence[];
}

export interface ListGoalsRequest {
  readonly workspaceId?: string;
  readonly status?: GoalStatus;
  readonly limit?: number;
}

export interface GoalSnapshot {
  readonly goalId: string;
  readonly goalKey: string;
  readonly workspaceId: string;
  readonly objective: string;
  readonly status: GoalStatus;
  readonly revision: number;
  readonly currentPhase: string;
  readonly plan: GoalPlan;
  readonly completedSteps: readonly GoalPlanStep[];
  readonly pendingSteps: readonly GoalPlanStep[];
  readonly nextAction: string;
  readonly blockers: readonly string[];
  readonly activeTaskIds: readonly string[];
  readonly trackedTasks: readonly GoalTrackedTask[];
  readonly lastCheckpoint: GoalCheckpointRecord | null;
  readonly leaseGeneration: number;
  readonly leaseActivitySeq: number;
  readonly leaseExpiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalSummary?: string;
  readonly terminalEvidence?: readonly GoalEvidence[];
  readonly terminalAt?: string;
}

export interface FinishGoalResult extends GoalSnapshot {
  readonly scheduledTaskCancellation: ScheduledTaskCancellationInstruction;
}

export interface CancelGoalResult extends GoalSnapshot {
  readonly trackedTaskIds: readonly string[];
  readonly trackedTasks: readonly GoalTrackedTask[];
  readonly taskCancellations: readonly GoalTaskCancellationResult[];
  readonly allTasksStopped: boolean;
  readonly requestCancellation: GoalRequestCancellationResult;
  readonly allRequestsStopped: boolean;
  readonly scheduledTaskCancellation: ScheduledTaskCancellationInstruction;
}

export interface RunGoalResult extends Omit<GoalSnapshot, 'workspaceId' | 'objective' | 'createdAt' | 'updatedAt' | 'terminalSummary' | 'terminalEvidence' | 'terminalAt'> {
  readonly acquired: boolean;
  readonly leaseToken?: string;
  readonly retryAfterSeconds?: number;
}

export interface ListGoalsResult {
  readonly goals: readonly GoalSnapshot[];
}

export interface GoalContinuationServiceOptions {
  readonly now?: () => Date;
  readonly scheduledContinuations?: Pick<ScheduledContinuationRepository, 'markGoalFinishedForScheduledContinuation'>;
  readonly taskCancellation?: Pick<GoalTaskCancellationPort, 'cancelForGoal'>;
  readonly requestCancellation?: Pick<GoalRequestCancellationPort, 'cancelForGoal'>;
}

export class GoalContinuationService {
  private readonly now: () => Date;
  private readonly scheduledContinuations: Pick<ScheduledContinuationRepository, 'markGoalFinishedForScheduledContinuation'> | undefined;
  private readonly taskCancellation: Pick<GoalTaskCancellationPort, 'cancelForGoal'> | undefined;
  private readonly requestCancellation: Pick<GoalRequestCancellationPort, 'cancelForGoal'> | undefined;

  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly goals: GoalRepository,
    options: GoalContinuationServiceOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
    this.scheduledContinuations = options.scheduledContinuations;
    this.taskCancellation = options.taskCancellation;
    this.requestCancellation = options.requestCancellation;
  }

  public async runGoal(actor: FileActor, request: RunGoalRequest): Promise<Result<RunGoalResult>> {
    try {
      const ownerClientId = stableOwnerClientId(actor);
      const workspaceId = requiredBounded(request.workspaceId, 'workspaceId', 128);
      if (await this.workspaces.get(workspaceId) === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
      const goalKey = normalizeGoalKey(request.goalKey);
      const existing = await this.goals.getByKey(workspaceId, goalKey);
      if (existing !== null && existing.ownerClientId !== ownerClientId) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      if (existing === null && request.objective === undefined) return err(appError('INVALID_INPUT', 'objective is required when creating a goal'));

      const objective = request.objective === undefined ? undefined : safeText(request.objective, MAX_OBJECTIVE, 'objective');
      const plan = request.plan === undefined
        ? (existing === null ? { steps: [] } : undefined)
        : normalizePlan(request.plan);
      const leaseSeconds = normalizeLeaseSeconds(request.leaseSeconds);
      const leaseToken = createLeaseToken();
      const acquired = await this.goals.acquire({
        goalId: randomUUID(),
        workspaceId,
        goalKey,
        ownerClientId,
        ownerSessionId: stableOwnerSessionId(actor),
        ...(objective === undefined ? {} : { objective }),
        ...(plan === undefined ? {} : { plan }),
        leaseTokenHash: hashLeaseToken(leaseToken),
        leaseSeconds,
        now: this.now().toISOString(),
      });
      const base = toRunSnapshot(acquired.goal);
      return ok({
        ...base,
        acquired: acquired.acquired,
        ...(acquired.acquired ? { leaseToken } : {}),
        ...(acquired.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: acquired.retryAfterSeconds }),
      });
    } catch (error: unknown) {
      return this.mapError(error);
    }
  }

  public async getGoal(actor: FileActor, request: GetGoalRequest): Promise<Result<GoalSnapshot>> {
    try {
      const ownerClientId = stableOwnerClientId(actor);
      const byId = request.goalId !== undefined;
      const byKey = request.workspaceId !== undefined || request.goalKey !== undefined;
      if (byId === byKey) return err(appError('INVALID_INPUT', 'Use goalId or workspaceId + goalKey, but not both'));
      if (!byId) {
        const workspaceId = requiredBounded(request.workspaceId!, 'workspaceId', 128);
        if (await this.workspaces.get(workspaceId) === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
      }
      const goal = byId
        ? await this.goals.getById(requiredBounded(request.goalId!, 'goalId', 128))
        : await this.goals.getByKey(
          requiredBounded(request.workspaceId!, 'workspaceId', 128),
          normalizeGoalKey(request.goalKey!),
        );
      if (goal === null) return err(appError('INVALID_INPUT', 'Goal was not found'));
      if (goal.ownerClientId !== ownerClientId) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      return ok(toSnapshot(goal));
    } catch (error: unknown) {
      return this.mapError(error);
    }
  }

  public async checkpointGoal(actor: FileActor, request: CheckpointGoalRequest): Promise<Result<GoalSnapshot>> {
    try {
      const ownerClientId = stableOwnerClientId(actor);
      const goalId = requiredBounded(request.goalId, 'goalId', 128);
      const current = await this.goals.getById(goalId);
      if (current === null) return err(appError('INVALID_INPUT', 'Goal was not found'));
      if (current.ownerClientId !== ownerClientId) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 0) return err(appError('INVALID_INPUT', 'expectedRevision is invalid'));
      const stepUpdates = normalizeStepUpdates(request.stepUpdates, current.plan);
      const updatedPlan = applyStepUpdates(current.plan, stepUpdates);
      const trackedTasks = normalizeTrackedTasks(request.trackedTasks, request.activeTaskIds);
      const goal = await this.goals.checkpoint({
        checkpointId: randomUUID(),
        goalId,
        ownerClientId,
        ownerSessionId: stableOwnerSessionId(actor),
        leaseTokenHash: hashLeaseToken(requiredBounded(request.leaseToken, 'leaseToken', 256)),
        expectedRevision: request.expectedRevision,
        plan: updatedPlan,
        currentPhase: safeText(request.currentPhase, MAX_PHASE, 'currentPhase'),
        summary: safeText(request.summary, MAX_SUMMARY, 'summary'),
        stepUpdates,
        nextAction: safeText(request.nextAction, MAX_NEXT_ACTION, 'nextAction', true),
        blockers: normalizeStrings(request.blockers, MAX_BLOCKERS, MAX_BLOCKER, 'blockers'),
        evidence: normalizeEvidence(request.evidence),
        activeTaskIds: blockingTaskIds(trackedTasks),
        trackedTasks,
        releaseLease: request.releaseLease === true,
        now: this.now().toISOString(),
      });
      return ok(toSnapshot(goal));
    } catch (error: unknown) {
      return this.mapError(error);
    }
  }

  public async finishGoal(actor: FileActor, request: FinishGoalRequest): Promise<Result<FinishGoalResult>> {
    try {
      const ownerClientId = stableOwnerClientId(actor);
      const goalId = requiredBounded(request.goalId, 'goalId', 128);
      const current = await this.goals.getById(goalId);
      if (current === null) return err(appError('INVALID_INPUT', 'Goal was not found'));
      if (current.ownerClientId !== ownerClientId) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 0) return err(appError('INVALID_INPUT', 'expectedRevision is invalid'));
      const now = this.now().toISOString();
      const goal = await this.goals.finish({
        checkpointId: randomUUID(),
        goalId,
        ownerClientId,
        ownerSessionId: stableOwnerSessionId(actor),
        leaseTokenHash: hashLeaseToken(requiredBounded(request.leaseToken, 'leaseToken', 256)),
        expectedRevision: request.expectedRevision,
        status: request.status,
        summary: safeText(request.summary, MAX_SUMMARY, 'summary'),
        evidence: normalizeEvidence(request.evidence),
        now,
      });

      let scheduledTaskCancellation: ScheduledTaskCancellationInstruction = {
        action: 'none',
        reason: 'no_live_task',
      };
      if (this.scheduledContinuations !== undefined) {
        try {
          const marked = await this.scheduledContinuations.markGoalFinishedForScheduledContinuation(goalId, now);
          scheduledTaskCancellation = cancellationInstruction(marked.continuation);
        } catch {
          scheduledTaskCancellation = { action: 'none', reason: 'native_task_unverified' };
        }
      }
      return ok({ ...toSnapshot(goal), scheduledTaskCancellation });
    } catch (error: unknown) {
      return this.mapError(error);
    }
  }

  public async cancelGoal(actor: FileActor, request: CancelGoalRequest): Promise<Result<CancelGoalResult>> {
    try {
      const ownerClientId = stableOwnerClientId(actor);
      const goalId = requiredBounded(request.goalId, 'goalId', 128);
      const current = await this.goals.getById(goalId);
      if (current === null) return err(appError('INVALID_INPUT', 'Goal was not found'));
      if (current.ownerClientId !== ownerClientId) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 0) return err(appError('INVALID_INPUT', 'expectedRevision is invalid'));
      const now = this.now().toISOString();
      const cancelled = await this.goals.cancel({
        checkpointId: randomUUID(),
        goalId,
        ownerClientId,
        expectedRevision: request.expectedRevision,
        summary: safeText(request.summary, MAX_SUMMARY, 'summary'),
        evidence: normalizeEvidence(request.evidence),
        now,
      });
      const [requestCancellation, taskCancellations] = await Promise.all([
        this.cancelInFlightRequests(goalId),
        this.cancelTrackedTasks(ownerClientId, cancelled.goal.workspaceId, cancelled.trackedTasks ?? legacyTrackedTasks(cancelled.trackedTaskIds)),
      ]);
      let scheduledTaskCancellation: ScheduledTaskCancellationInstruction = {
        action: 'none',
        reason: 'no_live_task',
      };
      if (this.scheduledContinuations !== undefined) {
        try {
          const marked = await this.scheduledContinuations.markGoalFinishedForScheduledContinuation(goalId, now);
          scheduledTaskCancellation = cancellationInstruction(marked.continuation);
        } catch {
          scheduledTaskCancellation = { action: 'none', reason: 'native_task_unverified' };
        }
      }
      return ok({
        ...toSnapshot(cancelled.goal),
        trackedTaskIds: cancelled.trackedTaskIds,
        trackedTasks: cancelled.trackedTasks ?? legacyTrackedTasks(cancelled.trackedTaskIds),
        taskCancellations,
        allTasksStopped: taskCancellations.every((entry) => isGoalTaskStopped(entry.status)),
        requestCancellation,
        allRequestsStopped: requestCancellation.remaining === 0,
        scheduledTaskCancellation,
      });
    } catch (error: unknown) {
      return this.mapError(error);
    }
  }

  public async listGoals(actor: FileActor, request: ListGoalsRequest): Promise<Result<ListGoalsResult>> {
    try {
      const ownerClientId = stableOwnerClientId(actor);
      const limit = request.limit === undefined ? 50 : request.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return err(appError('INVALID_INPUT', 'limit must be between 1 and 100'));
      let workspaceId: string | undefined;
      if (request.workspaceId !== undefined) {
        workspaceId = requiredBounded(request.workspaceId, 'workspaceId', 128);
        if (await this.workspaces.get(workspaceId) === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
      }
      const goals = await this.goals.list({
        ownerClientId,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(request.status === undefined ? {} : { status: request.status }),
        limit,
      });
      return ok({ goals: goals.map(toSnapshot) });
    } catch (error: unknown) {
      return this.mapError(error);
    }
  }

  private mapError(error: unknown): Result<never> {
    if (error instanceof GoalStateError) {
      switch (error.reason) {
        case 'owner_mismatch': return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
        case 'lease_invalid': return err(appError('PERMISSION_DENIED', 'Goal lease is invalid or expired', true));
        case 'conflict': return err(appError('CONFLICT', 'Goal state changed concurrently; read the latest revision and retry', true));
        case 'terminal': return err(appError('CONFLICT', 'Goal is already terminal'));
        case 'not_found': return err(appError('INVALID_INPUT', 'Goal was not found'));
        case 'corrupt': return err(appError('INTERNAL_ERROR', 'Durable goal state is corrupt and was rejected'));
      }
    }
    if (error instanceof Error) return err(appError('INVALID_INPUT', 'Durable goal input is invalid'));
    return err(appError('INTERNAL_ERROR', 'Durable goal operation failed'));
  }

  private async cancelTrackedTasks(
    ownerClientId: string,
    workspaceId: string,
    trackedTasks: readonly GoalTrackedTask[],
  ): Promise<readonly GoalTaskCancellationResult[]> {
    const cancellationTargets = trackedTasks.filter((task) => task.cancelWithGoal);
    const skippedTasks = trackedTasks.filter((task) => !task.cancelWithGoal);
    if (this.taskCancellation === undefined) {
      return trackedTasks.map((task) => task.cancelWithGoal
        ? failedGoalTaskCancellation(task.taskId, 'Goal task cancellation service is unavailable', task.provider)
        : skippedGoalTaskCancellation(task));
    }
    if (cancellationTargets.length === 0) return skippedTasks.map(skippedGoalTaskCancellation);
    try {
      const cancellationInputs = cancellationTargets.map((task) => task.provider === 'legacy_auto' ? task.taskId : task);
      const results = await this.taskCancellation.cancelForGoal(ownerClientId, workspaceId, cancellationInputs);
      const byTask = new Map(results.map((entry) => [`${entry.provider ?? 'legacy_auto'}\0${entry.taskId}`, entry]));
      return trackedTasks.map((task) => task.cancelWithGoal
        ? byTask.get(`${task.provider}\0${task.taskId}`)
          ?? byTask.get(`legacy_auto\0${task.taskId}`)
          ?? failedGoalTaskCancellation(task.taskId, 'Task cancellation provider omitted a tracked task', task.provider)
        : skippedGoalTaskCancellation(task));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Goal task cancellation failed';
      return trackedTasks.map((task) => task.cancelWithGoal
        ? failedGoalTaskCancellation(task.taskId, message, task.provider)
        : skippedGoalTaskCancellation(task));
    }
  }

  private async cancelInFlightRequests(goalId: string): Promise<GoalRequestCancellationResult> {
    if (this.requestCancellation === undefined) {
      return { goalId, requested: 0, stopped: 0, remaining: 0, timedOut: false, requestIds: [] };
    }
    try {
      return await this.requestCancellation.cancelForGoal(goalId);
    } catch {
      return { goalId, requested: 0, stopped: 0, remaining: 0, timedOut: true, requestIds: [] };
    }
  }
}

function cancellationInstruction(continuation: ScheduledContinuationRecord | null): ScheduledTaskCancellationInstruction {
  if (continuation === null || continuation.status === 'superseded') {
    return { action: 'none', reason: 'no_live_task' };
  }
  if (
    (continuation.status === 'cancel_required' || continuation.status === 'cancel_failed' || continuation.status === 'cancel_uncertain')
    && continuation.nativeTaskId !== undefined
  ) {
    return {
      action: 'delete_native_task',
      continuationId: continuation.continuationId,
      nativeTaskId: continuation.nativeTaskId,
      provider: 'chatgpt_scheduled_task',
      expectedContinuationVersion: continuation.version,
      receiptRequired: true,
      reason: 'live_task_confirmed',
    };
  }
  if (continuation.status === 'cancelled') {
    return {
      action: 'none',
      continuationId: continuation.continuationId,
      ...(continuation.nativeTaskId === undefined ? {} : { nativeTaskId: continuation.nativeTaskId }),
      reason: 'already_cancelled',
    };
  }
  if (continuation.status === 'claimed' || continuation.status === 'terminal_noop') {
    return {
      action: 'none',
      continuationId: continuation.continuationId,
      ...(continuation.nativeTaskId === undefined ? {} : { nativeTaskId: continuation.nativeTaskId }),
      reason: 'already_fired',
    };
  }
  return {
    action: 'none',
    continuationId: continuation.continuationId,
    ...(continuation.nativeTaskId === undefined ? {} : { nativeTaskId: continuation.nativeTaskId }),
    reason: 'native_task_unverified',
  };
}

function toRunSnapshot(goal: GoalRecord): Omit<RunGoalResult, 'acquired' | 'leaseToken' | 'retryAfterSeconds'> {
  const snapshot = toSnapshot(goal);
  return {
    goalId: snapshot.goalId,
    goalKey: snapshot.goalKey,
    status: snapshot.status,
    revision: snapshot.revision,
    currentPhase: snapshot.currentPhase,
    plan: snapshot.plan,
    completedSteps: snapshot.completedSteps,
    pendingSteps: snapshot.pendingSteps,
    nextAction: snapshot.nextAction,
    blockers: snapshot.blockers,
    activeTaskIds: snapshot.activeTaskIds,
    trackedTasks: snapshot.trackedTasks,
    lastCheckpoint: snapshot.lastCheckpoint,
    leaseGeneration: snapshot.leaseGeneration,
    leaseActivitySeq: snapshot.leaseActivitySeq,
    ...(snapshot.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: snapshot.leaseExpiresAt }),
  };
}

function toSnapshot(goal: GoalRecord): GoalSnapshot {
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
    nextAction: goal.nextAction || nextActionFromPlan(goal.plan),
    blockers: goal.blockers,
    activeTaskIds: goal.activeTaskIds,
    trackedTasks: goal.trackedTasks ?? legacyTrackedTasks(goal.activeTaskIds),
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

function normalizePlan(input: GoalPlanInput): GoalPlan {
  if (!Array.isArray(input.steps) || input.steps.length > MAX_STEPS) throw new Error('plan steps are invalid');
  const ids = new Set<string>();
  const steps = input.steps.map((step): GoalPlanStep => {
    const id = requiredBounded(step.id, 'step id', MAX_STEP_ID);
    if (ids.has(id)) throw new Error('plan step ids must be unique');
    ids.add(id);
    return { id, title: safeText(step.title, MAX_STEP_TITLE, 'step title'), status: 'pending' };
  });
  return { steps };
}

function normalizeStepUpdates(updates: readonly GoalStepUpdate[], plan: GoalPlan): readonly GoalStepUpdate[] {
  if (!Array.isArray(updates) || updates.length > MAX_STEPS) throw new Error('stepUpdates are invalid');
  const known = new Set(plan.steps.map((step) => step.id));
  const seen = new Set<string>();
  return updates.map((update) => {
    const stepId = requiredBounded(update.stepId, 'stepId', MAX_STEP_ID);
    if (!known.has(stepId)) throw new Error(`Unknown goal step: ${stepId}`);
    if (seen.has(stepId)) throw new Error(`Duplicate goal step update: ${stepId}`);
    seen.add(stepId);
    if (!isStepStatus(update.status)) throw new Error('Goal step status is invalid');
    return {
      stepId,
      status: update.status,
      ...(update.summary === undefined ? {} : { summary: safeText(update.summary, MAX_STEP_SUMMARY, 'step summary', true) }),
    };
  });
}

function applyStepUpdates(plan: GoalPlan, updates: readonly GoalStepUpdate[]): GoalPlan {
  const byId = new Map(updates.map((update) => [update.stepId, update]));
  return {
    steps: plan.steps.map((step) => {
      const update = byId.get(step.id);
      if (update === undefined) return step;
      return { ...step, status: update.status, ...(update.summary === undefined ? {} : { summary: update.summary }) };
    }),
  };
}

function normalizeEvidence(evidence: readonly GoalEvidence[]): readonly GoalEvidence[] {
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE) throw new Error('evidence is invalid');
  return evidence.map((entry) => {
    if (entry.kind !== 'path' && entry.kind !== 'hash' && entry.kind !== 'task' && entry.kind !== 'note') throw new Error('evidence kind is invalid');
    return { kind: entry.kind, value: safeText(entry.value, MAX_EVIDENCE_VALUE, 'evidence value') };
  });
}

function normalizeTaskIds(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > MAX_ACTIVE_TASKS) throw new Error('activeTaskIds are invalid');
  return [...new Set(values.map((value) => requiredBounded(value, 'task id', MAX_TASK_ID)))];
}

function normalizeTrackedTasks(
  trackedTasks: readonly GoalTrackedTask[] | undefined,
  activeTaskIds: readonly string[] | undefined,
): readonly GoalTrackedTask[] {
  if (trackedTasks !== undefined && activeTaskIds !== undefined && activeTaskIds.length > 0) {
    throw new Error('Use trackedTasks or activeTaskIds, not both');
  }
  if (trackedTasks !== undefined) {
    if (!Array.isArray(trackedTasks) || trackedTasks.length > MAX_ACTIVE_TASKS) throw new Error('trackedTasks are invalid');
    const seen = new Set<string>();
    return trackedTasks.map((entry) => {
      if (!isRecord(entry) || typeof entry.taskId !== 'string') throw new Error('tracked task is invalid');
      const taskId = requiredBounded(entry.taskId, 'task id', MAX_TASK_ID);
      const provider = entry.provider;
      if (provider !== 'process' && provider !== 'codex' && provider !== 'shell') throw new Error('tracked task provider is invalid');
      if (entry.role !== 'blocking_job' && entry.role !== 'supporting_service') throw new Error('tracked task role is invalid');
      if (typeof entry.cancelWithGoal !== 'boolean') throw new Error('tracked task cancellation policy is invalid');
      const key = `${provider}\0${taskId}`;
      if (seen.has(key)) throw new Error('tracked task bindings must be unique');
      seen.add(key);
      return { taskId, provider, role: entry.role, cancelWithGoal: entry.cancelWithGoal };
    });
  }
  return normalizeTaskIds(activeTaskIds).map((taskId) => legacyTrackedTask(taskId));
}

function blockingTaskIds(tasks: readonly GoalTrackedTask[]): readonly string[] {
  return tasks.filter((task) => task.role === 'blocking_job').map((task) => task.taskId);
}

function legacyTrackedTask(taskId: string): GoalTrackedTask {
  return { taskId, provider: 'legacy_auto', role: 'blocking_job', cancelWithGoal: true };
}

function legacyTrackedTasks(taskIds: readonly string[]): readonly GoalTrackedTask[] {
  return taskIds.map((taskId) => legacyTrackedTask(taskId));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStrings(values: readonly string[], maxItems: number, maxLength: number, label: string): readonly string[] {
  if (!Array.isArray(values) || values.length > maxItems) throw new Error(`${label} are invalid`);
  return values.map((value) => safeText(value, maxLength, label));
}

function normalizeGoalKey(value: string): string {
  const key = requiredBounded(value, 'goalKey', MAX_GOAL_KEY);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(key)) throw new Error('goalKey must be a stable ASCII key');
  return key;
}

function normalizeLeaseSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_GOAL_LEASE_SECONDS;
  if (!Number.isInteger(value) || value < MIN_GOAL_LEASE_SECONDS || value > MAX_GOAL_LEASE_SECONDS) throw new Error('leaseSeconds is out of range');
  return value;
}

function nextActionFromPlan(plan: GoalPlan): string {
  const next = plan.steps.find((step) => step.status !== 'completed');
  return next === undefined ? '' : `Continue step ${next.id}: ${next.title}`;
}

function safeText(value: string, maxLength: number, label: string, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) throw new Error(`${label} is required`);
  if (trimmed.length > maxLength) throw new Error(`${label} exceeds the allowed length`);
  return redactSensitiveText(trimmed);
}

function requiredBounded(value: string, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) throw new Error(`${label} is invalid`);
  return trimmed;
}

function stableOwnerSessionId(actor: FileActor): string {
  return requiredBounded(actor.sessionId?.trim() || actor.clientId, 'session identity', 128);
}

function stableOwnerClientId(actor: FileActor): string {
  return requiredBounded(actor.clientId, 'client identity', MAX_OWNER_CLIENT_ID);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(\bauthorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b(token|secret|password|api[_-]?key|private[_-]?key|credential)\s*[:=]\s*[^\s]+/gi, '$1=[REDACTED]');
}

function createLeaseToken(): string { return randomBytes(32).toString('base64url'); }
function hashLeaseToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function isStepStatus(value: unknown): value is GoalStepStatus { return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'blocked'; }
