import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  GoalStateError,
  appError,
  err,
  mayMarkEngineeringGateNotApplicable,
  ok,
  type GoalCheckpointRecord,
  type GoalCheckpointResumeContext,
  type GoalEvidence,
  type GoalAcceptanceCriterion,
  type GoalContextCapsulePayload,
  type GoalContextCapsuleRecord,
  type GoalDeliveryReceipt,
  type GoalDeliveryState,
  type GoalIterationPolicy,
  type EngineeringGoalMetadata,
  type EngineeringGateEvidence,
  type EngineeringGateStatus,
  type EngineeringReviewFinding,
  type GoalLeaseRecoveryEvidence,
  type GoalReconciliationReason,
  type GoalPlan,
  type GoalPlanStep,
  type GoalPonytailMode,
  type GoalRecord,
  type StoredWorkflowMetadata,
  type GoalRepository,
  type GoalStatus,
  type GoalStepStatus,
  type GoalStepUpdate,
  type GoalTrackedTask,
  type GoalTerminalStatus,
  type Result,
  type ScheduledContinuationRecord,
  type ScheduledContinuationRepository,
  type ScheduledContinuationWorkerLivenessPort,
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
const MAX_ACCEPTANCE_CRITERIA = 50;
const MAX_ACCEPTANCE_ID = 128;
const MAX_ACCEPTANCE_TITLE = 512;
const MAX_USER_STEERING = 50;
const MAX_CONTEXT_ITEMS = 100;
const MAX_CONTEXT_ITEM = 1_024;
const MAX_DELIVERY_CHANNEL = 128;
const MAX_DELIVERY_DETAIL = 2_048;

export interface GoalPlanInputStep {
  readonly id: string;
  readonly title: string;
}

export interface GoalPlanInput {
  readonly steps: readonly GoalPlanInputStep[];
}

export interface GoalAcceptanceInput {
  readonly id: string;
  readonly title: string;
}

export interface GoalIterationPolicyInput {
  readonly mode: 'outcome' | 'iterate';
  readonly maxIterations?: number;
  readonly stopOnNoNewEvidence?: boolean;
}

export type GoalPonytailModeOverride = 'inherit' | GoalPonytailMode;

export interface RunGoalRequest {
  readonly workspaceId: string;
  readonly goalKey: string;
  readonly objective?: string;
  readonly plan?: GoalPlanInput;
  readonly acceptanceCriteria?: readonly GoalAcceptanceInput[];
  readonly iterationPolicy?: GoalIterationPolicyInput;
  readonly engineering?: EngineeringGoalMetadata;
  readonly ponytailMode?: GoalPonytailModeOverride;
  readonly leaseSeconds?: number;
  readonly workflow?: StoredWorkflowMetadata;
}

export interface GetGoalRequest {
  readonly goalId?: string;
  readonly workspaceId?: string;
  readonly goalKey?: string;
}

export interface ValidateGoalLeaseRequest {
  readonly goalId: string;
  readonly leaseToken: string;
}

export interface EngineeringGateUpdate {
  readonly gateId: string;
  readonly status: EngineeringGateStatus;
  readonly reason?: string;
  readonly evidence?: EngineeringGateEvidence;
}

export interface CheckpointGoalRequest {
  readonly goalId: string;
  readonly leaseToken: string;
  readonly expectedRevision: number;
  readonly expectedUserIntentRevision?: number;
  readonly currentPhase: string;
  readonly summary: string;
  readonly stepUpdates: readonly GoalStepUpdate[];
  readonly nextAction: string;
  readonly blockers: readonly string[];
  readonly evidence: readonly GoalEvidence[];
  readonly activeTaskIds?: readonly string[];
  readonly trackedTasks?: readonly GoalTrackedTask[];
  readonly resumeContext?: GoalCheckpointResumeContext;
  readonly engineeringGateUpdates?: readonly EngineeringGateUpdate[];
  readonly engineeringReviewFindings?: readonly EngineeringReviewFinding[];
  readonly engineering?: EngineeringGoalMetadata;
  readonly ponytailMode?: GoalPonytailModeOverride;
  readonly releaseLease?: boolean;
}

export interface UpdateGoalPlanRequest {
  readonly goalId: string;
  readonly leaseToken: string;
  readonly expectedRevision: number;
  readonly expectedUserIntentRevision?: number;
  readonly steps: readonly GoalPlanStep[];
  readonly summary?: string;
}

export interface GoalAcceptanceUpdate {
  readonly criterionId: string;
  readonly status: GoalAcceptanceCriterion['status'];
  readonly evidence?: readonly GoalEvidence[];
}

export interface UpdateGoalAcceptanceRequest {
  readonly goalId: string;
  readonly leaseToken: string;
  readonly expectedRevision: number;
  readonly expectedUserIntentRevision?: number;
  readonly updates: readonly GoalAcceptanceUpdate[];
  readonly summary?: string;
}

export interface ReviseGoalIntentRequest {
  readonly goalId: string;
  readonly leaseToken: string;
  readonly expectedRevision: number;
  readonly expectedUserIntentRevision: number;
  readonly steering: string;
  readonly nextAction?: string;
  readonly staleEngineeringGateIds?: readonly string[];
}

export interface CreateGoalContextCapsuleRequest {
  readonly goalId: string;
  readonly leaseToken: string;
  readonly expectedRevision: number;
  readonly expectedUserIntentRevision: number;
  readonly userSteering?: readonly string[];
  readonly completedWork?: readonly string[];
  readonly decisions?: readonly string[];
  readonly validation?: readonly GoalEvidence[];
  readonly changedFiles?: readonly string[];
  readonly artifacts?: readonly GoalEvidence[];
}

export interface RecordGoalDeliveryRequest {
  readonly receiptId: string;
  readonly goalId: string;
  readonly channel: string;
  readonly state: GoalDeliveryState;
  readonly basedOnUserIntentRevision: number;
  readonly externalId?: string;
  readonly detail?: string;
}

export interface AdvanceGoalIterationRequest {
  readonly goalId: string;
  readonly leaseToken: string;
  readonly expectedRevision: number;
  readonly expectedUserIntentRevision: number;
  readonly evidenceAdded: boolean;
  readonly nextAction: string;
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

export interface ReconcileGoalsRequest {
  readonly workspaceId: string;
  readonly goalIds: readonly string[];
  readonly reason: GoalReconciliationReason;
  readonly summary: string;
  readonly apply?: boolean;
  readonly supersededByGoalId?: string;
}

export type GoalReconciliationDisposition =
  | 'eligible'
  | 'reconciled'
  | 'not_active'
  | 'live_lease'
  | 'live_worker'
  | 'liveness_unavailable'
  | 'liveness_untrusted'
  | 'native_cleanup_required'
  | 'concurrent_change';

export interface GoalReconciliationEntry {
  readonly goalId: string;
  readonly goalKey?: string;
  readonly disposition: GoalReconciliationDisposition;
  readonly reason?: string;
  readonly snapshot?: GoalSnapshot;
  readonly continuationId?: string;
  readonly nativeTaskId?: string;
}

export interface ReconcileGoalsResult {
  readonly apply: boolean;
  readonly reason: GoalReconciliationReason;
  readonly results: readonly GoalReconciliationEntry[];
}

export interface ListGoalsRequest {
  readonly workspaceId?: string;
  readonly status?: GoalStatus;
  readonly limit?: number;
}

export interface PendingScheduledTaskCleanup {
  readonly continuationId: string;
  readonly nativeTaskId: string;
  readonly expectedContinuationVersion: number;
  readonly provider: 'chatgpt_scheduled_task';
  readonly requiredEffect: 'non_runnable';
  readonly state: 'required' | 'failed' | 'uncertain';
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
  readonly acceptanceCriteria: readonly GoalAcceptanceCriterion[];
  readonly userIntentRevision: number;
  readonly iterationPolicy: GoalIterationPolicy;
  readonly engineering?: EngineeringGoalMetadata;
  readonly workflow?: StoredWorkflowMetadata;
  readonly currentContextCapsuleId?: string;
  readonly completedSteps: readonly GoalPlanStep[];
  readonly pendingSteps: readonly GoalPlanStep[];
  readonly nextAction: string;
  readonly blockers: readonly string[];
  readonly activeTaskIds: readonly string[];
  readonly trackedTasks: readonly GoalTrackedTask[];
  readonly ponytailMode: GoalPonytailModeOverride;
  readonly lastCheckpoint: GoalCheckpointRecord | null;
  readonly leaseGeneration: number;
  readonly leaseActivitySeq: number;
  readonly leaseExpiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalSummary?: string;
  readonly terminalEvidence?: readonly GoalEvidence[];
  readonly terminalAt?: string;
  readonly pendingScheduledTaskCleanup?: PendingScheduledTaskCleanup;
}

export type FinishGoalCompletionState = 'completed' | 'pending_native_cleanup';

export interface FinishGoalResult extends GoalSnapshot {
  /** Present after the terminal CAS; pending native cleanup has not cascaded yet. */
  readonly trackedTaskIds?: readonly string[];
  readonly trackedTasks: readonly GoalTrackedTask[];
  readonly taskCancellations?: readonly GoalTaskCancellationResult[];
  readonly allTasksStopped?: boolean;
  readonly requestCancellation?: GoalRequestCancellationResult;
  readonly allRequestsStopped?: boolean;
  readonly scheduledTaskCancellation: ScheduledTaskCancellationInstruction;
  readonly completionState: FinishGoalCompletionState;
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
  readonly leaseRecovery?: 'stale_worker_recovered';
}

export interface ListGoalsResult {
  readonly goals: readonly GoalSnapshot[];
}

export interface EngineeringGateEvidenceVerifier {
  verify(
    workspaceId: string,
    evidence: EngineeringGateEvidence,
    gateId: string,
    requiredPlatforms?: readonly ('win32' | 'darwin' | 'linux')[],
  ): Promise<boolean>;
}

export interface GoalContinuationServiceOptions {
  readonly now?: () => Date;
  readonly engineeringEvidenceVerifier?: EngineeringGateEvidenceVerifier;
  readonly scheduledContinuations?: Pick<ScheduledContinuationRepository, 'markGoalFinishedForScheduledContinuation' | 'getLiveScheduledContinuation'>;
  readonly workerLiveness?: ScheduledContinuationWorkerLivenessPort;
  readonly taskCancellation?: Pick<GoalTaskCancellationPort, 'cancelForGoal'>;
  readonly requestCancellation?: Pick<GoalRequestCancellationPort, 'cancelForGoal'>;
}

export class GoalContinuationService {
  private readonly now: () => Date;
  private readonly engineeringEvidenceVerifier: EngineeringGateEvidenceVerifier | undefined;
  private readonly scheduledContinuations: Pick<ScheduledContinuationRepository, 'markGoalFinishedForScheduledContinuation' | 'getLiveScheduledContinuation'> | undefined;
  private readonly workerLiveness: ScheduledContinuationWorkerLivenessPort | undefined;
  private readonly taskCancellation: Pick<GoalTaskCancellationPort, 'cancelForGoal'> | undefined;
  private readonly requestCancellation: Pick<GoalRequestCancellationPort, 'cancelForGoal'> | undefined;

  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly goals: GoalRepository,
    options: GoalContinuationServiceOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
    this.engineeringEvidenceVerifier = options.engineeringEvidenceVerifier;
    this.scheduledContinuations = options.scheduledContinuations;
    this.workerLiveness = options.workerLiveness;
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
      const acceptanceCriteria = request.acceptanceCriteria === undefined ? undefined : normalizeAcceptanceCriteria(request.acceptanceCriteria);
      const iterationPolicy = request.iterationPolicy === undefined ? undefined : normalizeIterationPolicyInput(request.iterationPolicy);
      const ponytailMode = request.ponytailMode === undefined ? undefined : normalizeGoalPonytailModeOverride(request.ponytailMode);
      if (existing !== null && ponytailMode !== undefined && ponytailMode !== (existing.ponytailMode ?? 'inherit')) {
        return err(appError('INVALID_INPUT', 'ponytailMode can only change through a leased goal checkpoint'));
      }
      const leaseSeconds = normalizeLeaseSeconds(request.leaseSeconds);
      let recoveryEvidence: GoalLeaseRecoveryEvidence | undefined;
      if (existing?.status === 'active' && existing.leaseExpiresAt !== undefined && this.workerLiveness !== undefined) {
        const expiresAtMs = Date.parse(existing.leaseExpiresAt);
        if (Number.isFinite(expiresAtMs) && expiresAtMs > this.now().getTime()) {
          try {
            // Observe real fenced worker/task liveness even when this goal has no
            // scheduled continuation. A foreground worker can disappear while
            // leaving a long lease behind; requiring a watchdog here made that
            // lease impossible to recover until its TTL expired.
            const trackedTasks = existing.trackedTasks ?? existing.activeTaskIds.map((taskId) => ({
              taskId,
              provider: 'legacy_auto' as const,
              role: 'blocking_job' as const,
              cancelWithGoal: true as const,
            }));
            const observed = await this.workerLiveness.observe(existing.id, trackedTasks);
            recoveryEvidence = {
              trustworthy: observed.trustworthy,
              observedAt: observed.observedAt,
              leaseGeneration: observed.leaseGeneration,
              leaseActivitySeq: observed.leaseActivitySeq,
              liveFencedCallCount: observed.liveFencedCallCount,
              blockingTaskStates: observed.blockingTaskStates
                ?? observed.activeTaskStates?.map((entry) => ({ ...entry, provider: 'legacy_auto' as const }))
                ?? [],
            };
          } catch {
            recoveryEvidence = undefined;
          }
        }
      }

      const leaseToken = createLeaseToken();
      const acquired = await this.goals.acquire({
        goalId: randomUUID(),
        workspaceId,
        goalKey,
        ownerClientId,
        ownerSessionId: stableOwnerSessionId(actor),
        ...(objective === undefined ? {} : { objective }),
        ...(plan === undefined ? {} : { plan }),
        ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
        ...(iterationPolicy === undefined ? {} : { iterationPolicy }),
        ...(request.engineering === undefined ? {} : { engineering: request.engineering }),
        ...(request.workflow === undefined ? {} : { workflow: request.workflow }),
        ...(ponytailMode === undefined || ponytailMode === 'inherit' ? {} : { ponytailMode }),
        leaseTokenHash: hashLeaseToken(leaseToken),
        leaseSeconds,
        ...(recoveryEvidence === undefined ? {} : { recoveryEvidence }),
        now: this.now().toISOString(),
      });
      const base = toRunSnapshot(acquired.goal);
      return ok({
        ...base,
        acquired: acquired.acquired,
        ...(acquired.acquired ? { leaseToken } : {}),
        ...(acquired.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: acquired.retryAfterSeconds }),
        ...(acquired.leaseRecovery === undefined ? {} : { leaseRecovery: acquired.leaseRecovery }),
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
      const snapshot = toSnapshot(goal);
      if (this.scheduledContinuations === undefined) return ok(snapshot);
      const liveContinuation = await this.scheduledContinuations.getLiveScheduledContinuation(goal.id);
      const pendingScheduledTaskCleanup = pendingScheduledTaskCleanupFrom(liveContinuation);
      return ok(pendingScheduledTaskCleanup === undefined
        ? snapshot
        : { ...snapshot, pendingScheduledTaskCleanup });
    } catch (error: unknown) {
      return this.mapError(error);
    }
  }

  /**
   * Validate the current session-bound lease without renewing or mutating it.
   * Application services use this as the single ownership fence before a
   * goal-relative mutation; trusted host authorization is intentionally not
   * part of this check.
   */
  public async validateGoalLease(actor: FileActor, request: ValidateGoalLeaseRequest): Promise<Result<GoalSnapshot>> {
    try {
      const goalId = requiredBounded(request.goalId, 'goalId', 128);
      const current = await this.goals.getById(goalId);
      if (current === null) return err(appError('INVALID_INPUT', 'Goal was not found'));
      if (current.ownerClientId !== stableOwnerClientId(actor)) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      assertLeaseSnapshot(current, actor, request.leaseToken, this.now().toISOString());
      return ok(toSnapshot(current));
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
      const resumeContext = normalizeCheckpointResumeContext(request.resumeContext);
      if (request.engineering !== undefined && (request.engineeringGateUpdates !== undefined || request.engineeringReviewFindings !== undefined)) throw new Error('engineering metadata cannot be supplied with Engineering Harness updates');
      let engineering = request.engineeringGateUpdates === undefined
        ? request.engineering
        : await applyEngineeringGateUpdates(current.engineering, request.engineeringGateUpdates, current.workspaceId, current.userIntentRevision, resumeContext, this.engineeringEvidenceVerifier);
      if (request.engineeringReviewFindings !== undefined) {
        const baseEngineering = engineering ?? current.engineering;
        if (baseEngineering === undefined) throw new Error('engineeringReviewFindings require an Engineering Harness goal');
        engineering = { ...baseEngineering, reviewFindings: normalizeEngineeringReviewFindings(request.engineeringReviewFindings) };
      }
      const requestedPonytailMode = request.ponytailMode === undefined ? undefined : normalizeGoalPonytailModeOverride(request.ponytailMode);
      const ponytailMode = requestedPonytailMode === undefined
        ? current.ponytailMode ?? null
        : requestedPonytailMode === 'inherit' ? null : requestedPonytailMode;
      const goal = await this.goals.checkpoint({
        checkpointId: randomUUID(),
        goalId,
        ownerClientId,
        ownerSessionId: stableOwnerSessionId(actor),
        leaseTokenHash: hashLeaseToken(requiredBounded(request.leaseToken, 'leaseToken', 256)),
        expectedRevision: request.expectedRevision,
        ...(request.expectedUserIntentRevision === undefined ? {} : { expectedUserIntentRevision: request.expectedUserIntentRevision }),
        plan: updatedPlan,
        currentPhase: safeText(request.currentPhase, MAX_PHASE, 'currentPhase'),
        summary: safeText(request.summary, MAX_SUMMARY, 'summary'),
        stepUpdates,
        nextAction: safeText(request.nextAction, MAX_NEXT_ACTION, 'nextAction', true),
        blockers: normalizeStrings(request.blockers, MAX_BLOCKERS, MAX_BLOCKER, 'blockers'),
        evidence: normalizeEvidence(request.evidence),
        activeTaskIds: blockingTaskIds(trackedTasks),
        trackedTasks,
        ...(resumeContext === undefined ? {} : { resumeContext }),
        ...(engineering === undefined ? {} : { engineering }),
        ponytailMode,
        releaseLease: request.releaseLease === true,
        now: this.now().toISOString(),
      });
      return ok(toSnapshot(goal));
    } catch (error: unknown) {
      return this.mapError(error);
    }
  }

  public async updateGoalPlan(actor: FileActor, request: UpdateGoalPlanRequest): Promise<Result<GoalSnapshot>> {
    try {
      const ownerClientId = stableOwnerClientId(actor);
      const goalId = requiredBounded(request.goalId, 'goalId', 128);
      const current = await this.goals.getById(goalId);
      if (current === null) return err(appError('INVALID_INPUT', 'Goal was not found'));
      if (current.ownerClientId !== ownerClientId) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      const plan = normalizeFullPlan(request.steps);
      const stepUpdates = plan.steps.map((step) => ({ stepId: step.id, status: step.status, ...(step.summary === undefined ? {} : { summary: step.summary }) }));
      const trackedTasks = current.trackedTasks ?? legacyTrackedTasks(current.activeTaskIds);
      const goal = await this.goals.checkpoint({
        checkpointId: randomUUID(), goalId, ownerClientId, ownerSessionId: stableOwnerSessionId(actor),
        leaseTokenHash: hashLeaseToken(requiredBounded(request.leaseToken, 'leaseToken', 256)), expectedRevision: request.expectedRevision,
        ...(request.expectedUserIntentRevision === undefined ? {} : { expectedUserIntentRevision: request.expectedUserIntentRevision }),
        plan, currentPhase: current.currentPhase,
        summary: safeText(request.summary ?? 'Goal plan updated', MAX_SUMMARY, 'summary'), stepUpdates,
        nextAction: nextActionFromPlan(plan), blockers: current.blockers, evidence: [], activeTaskIds: blockingTaskIds(trackedTasks), trackedTasks,
        ponytailMode: current.ponytailMode ?? null, releaseLease: false, now: this.now().toISOString(),
      });
      return ok(toSnapshot(goal));
    } catch (error: unknown) { return this.mapError(error); }
  }

  public async updateGoalAcceptance(actor: FileActor, request: UpdateGoalAcceptanceRequest): Promise<Result<GoalSnapshot>> {
    try {
      const ownerClientId = stableOwnerClientId(actor);
      const goalId = requiredBounded(request.goalId, 'goalId', 128);
      const current = await this.goals.getById(goalId);
      if (current === null) return err(appError('INVALID_INPUT', 'Goal was not found'));
      if (current.ownerClientId !== ownerClientId) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      const acceptanceCriteria = applyAcceptanceUpdates(current.acceptanceCriteria, request.updates);
      const trackedTasks = current.trackedTasks ?? legacyTrackedTasks(current.activeTaskIds);
      const goal = await this.goals.checkpoint({
        checkpointId: randomUUID(), goalId, ownerClientId, ownerSessionId: stableOwnerSessionId(actor),
        leaseTokenHash: hashLeaseToken(requiredBounded(request.leaseToken, 'leaseToken', 256)), expectedRevision: request.expectedRevision,
        ...(request.expectedUserIntentRevision === undefined ? {} : { expectedUserIntentRevision: request.expectedUserIntentRevision }),
        plan: current.plan, acceptanceCriteria, currentPhase: current.currentPhase,
        summary: safeText(request.summary ?? 'Goal acceptance criteria updated', MAX_SUMMARY, 'summary'), stepUpdates: [],
        nextAction: current.nextAction, blockers: current.blockers, evidence: [], activeTaskIds: blockingTaskIds(trackedTasks), trackedTasks,
        ponytailMode: current.ponytailMode ?? null, releaseLease: false, now: this.now().toISOString(),
      });
      return ok(toSnapshot(goal));
    } catch (error: unknown) { return this.mapError(error); }
  }

  public async reviseGoalIntent(actor: FileActor, request: ReviseGoalIntentRequest): Promise<Result<GoalSnapshot>> {
    try {
      const ownerClientId = stableOwnerClientId(actor);
      const goalId = requiredBounded(request.goalId, 'goalId', 128);
      const current = await this.goals.getById(goalId);
      if (current === null) return err(appError('INVALID_INPUT', 'Goal was not found'));
      if (current.ownerClientId !== ownerClientId) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      if (request.expectedUserIntentRevision !== current.userIntentRevision) return err(appError('INVALID_INPUT', 'Goal user intent revision is stale'));
      const steering = safeText(request.steering, MAX_CONTEXT_ITEM, 'steering');
      const trackedTasks = current.trackedTasks ?? legacyTrackedTasks(current.activeTaskIds);
      const nextUserIntentRevision = current.userIntentRevision + 1;
      const engineering = staleEngineeringGates(current.engineering, request.staleEngineeringGateIds ?? [], nextUserIntentRevision);
      const now = this.now().toISOString();
      const goal = await this.goals.checkpoint({
        checkpointId: randomUUID(), goalId, ownerClientId, ownerSessionId: stableOwnerSessionId(actor),
        leaseTokenHash: hashLeaseToken(requiredBounded(request.leaseToken, 'leaseToken', 256)), expectedRevision: request.expectedRevision,
        expectedUserIntentRevision: request.expectedUserIntentRevision, userIntentRevision: nextUserIntentRevision,
        plan: current.plan, ...(engineering === undefined ? {} : { engineering }), currentPhase: current.currentPhase,
        summary: `User steering accepted: ${steering}`,
        stepUpdates: [], nextAction: safeText(request.nextAction ?? current.nextAction, MAX_NEXT_ACTION, 'nextAction', true),
        blockers: current.blockers, evidence: [{ kind: 'note', value: steering }], activeTaskIds: blockingTaskIds(trackedTasks), trackedTasks,
        ponytailMode: current.ponytailMode ?? null, releaseLease: false, now,
      });
      if (this.goals.listDeliveryReceipts !== undefined && this.goals.recordDeliveryReceipt !== undefined) {
        const receipts = await this.goals.listDeliveryReceipts(goalId, 100);
        for (const receipt of receipts) {
          if (receipt.basedOnUserIntentRevision >= goal.userIntentRevision || isTerminalDeliveryState(receipt.state)) continue;
          await this.goals.recordDeliveryReceipt({
            id: receipt.id, goalId, channel: receipt.channel, state: 'retired', basedOnUserIntentRevision: receipt.basedOnUserIntentRevision,
            ...(receipt.externalId === undefined ? {} : { externalId: receipt.externalId }), detail: 'Retired by newer accepted user intent', now,
          });
        }
      }
      return ok(toSnapshot(goal));
    } catch (error: unknown) { return this.mapError(error); }
  }

  public async createContextCapsule(actor: FileActor, request: CreateGoalContextCapsuleRequest): Promise<Result<{ readonly capsule: GoalContextCapsuleRecord; readonly goal: GoalSnapshot }>> {
    try {
      if (this.goals.createContextCapsule === undefined) return err(appError('INTERNAL_ERROR', 'Context capsule storage is unavailable', true));
      const ownerClientId = stableOwnerClientId(actor);
      const goalId = requiredBounded(request.goalId, 'goalId', 128);
      const current = await this.goals.getById(goalId);
      if (current === null) return err(appError('INVALID_INPUT', 'Goal was not found'));
      if (current.ownerClientId !== ownerClientId) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      if (request.expectedRevision !== current.revision || request.expectedUserIntentRevision !== current.userIntentRevision) return err(appError('INVALID_INPUT', 'Goal or user intent revision is stale'));
      assertLeaseSnapshot(current, actor, request.leaseToken, this.now().toISOString());
      const payload: GoalContextCapsulePayload = {
        objective: current.objective,
        userSteering: normalizeStrings(request.userSteering ?? [], MAX_USER_STEERING, MAX_CONTEXT_ITEM, 'userSteering'),
        currentPhase: current.currentPhase,
        plan: current.plan,
        acceptanceCriteria: current.acceptanceCriteria,
        completedWork: normalizeStrings(request.completedWork ?? current.plan.steps.filter((step) => step.status === 'completed').map((step) => step.summary ?? step.title), MAX_CONTEXT_ITEMS, MAX_CONTEXT_ITEM, 'completedWork'),
        remainingWork: current.plan.steps.filter((step) => step.status !== 'completed').map((step) => step.title),
        decisions: normalizeStrings(request.decisions ?? [], MAX_CONTEXT_ITEMS, MAX_CONTEXT_ITEM, 'decisions'),
        validation: normalizeEvidence(request.validation ?? []),
        changedFiles: normalizeStrings(request.changedFiles ?? [], MAX_CONTEXT_ITEMS, MAX_CONTEXT_ITEM, 'changedFiles'),
        artifacts: normalizeEvidence(request.artifacts ?? []),
        blockers: current.blockers,
        nextAction: current.nextAction || nextActionFromPlan(current.plan),
      };
      validateContextCapsuleQuality(payload);
      const capsule = await this.goals.createContextCapsule({
        id: randomUUID(), goalId, sourceGoalRevision: current.revision, sourceUserIntentRevision: current.userIntentRevision,
        ...(current.currentContextCapsuleId === undefined ? {} : { previousCapsuleId: current.currentContextCapsuleId }), payload, createdAt: this.now().toISOString(),
      });
      const trackedTasks = current.trackedTasks ?? legacyTrackedTasks(current.activeTaskIds);
      const linked = await this.goals.checkpoint({
        checkpointId: randomUUID(), goalId, ownerClientId, ownerSessionId: stableOwnerSessionId(actor),
        leaseTokenHash: hashLeaseToken(requiredBounded(request.leaseToken, 'leaseToken', 256)), expectedRevision: current.revision,
        expectedUserIntentRevision: current.userIntentRevision, currentContextCapsuleId: capsule.id,
        plan: current.plan, currentPhase: current.currentPhase, summary: 'Published bounded context capsule', stepUpdates: [],
        nextAction: current.nextAction, blockers: current.blockers, evidence: [{ kind: 'note', value: `context-capsule:${capsule.id}` }],
        activeTaskIds: blockingTaskIds(trackedTasks), trackedTasks, ponytailMode: current.ponytailMode ?? null, releaseLease: false, now: this.now().toISOString(),
      });
      return ok({ capsule, goal: toSnapshot(linked) });
    } catch (error: unknown) { return this.mapError(error); }
  }

  public async getContextCapsule(actor: FileActor, capsuleId: string): Promise<Result<GoalContextCapsuleRecord | null>> {
    try {
      if (this.goals.getContextCapsule === undefined) return err(appError('INTERNAL_ERROR', 'Context capsule storage is unavailable', true));
      const capsule = await this.goals.getContextCapsule(requiredBounded(capsuleId, 'capsuleId', 128));
      if (capsule === null) return ok(null);
      const goal = await this.goals.getById(capsule.goalId);
      if (goal === null || goal.ownerClientId !== stableOwnerClientId(actor)) return err(appError('PERMISSION_DENIED', 'Context capsule belongs to another client'));
      return ok(capsule);
    } catch (error: unknown) { return this.mapError(error); }
  }

  public async listContextCapsules(actor: FileActor, goalId: string, limit = 20): Promise<Result<readonly GoalContextCapsuleRecord[]>> {
    try {
      if (this.goals.listContextCapsules === undefined) return err(appError('INTERNAL_ERROR', 'Context capsule storage is unavailable', true));
      const current = await this.goals.getById(requiredBounded(goalId, 'goalId', 128));
      if (current === null) return err(appError('INVALID_INPUT', 'Goal was not found'));
      if (current.ownerClientId !== stableOwnerClientId(actor)) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      return ok(await this.goals.listContextCapsules(current.id, Math.max(1, Math.min(100, Math.trunc(limit)))));
    } catch (error: unknown) { return this.mapError(error); }
  }

  public async recordDeliveryReceipt(actor: FileActor, request: RecordGoalDeliveryRequest): Promise<Result<GoalDeliveryReceipt>> {
    try {
      if (this.goals.recordDeliveryReceipt === undefined) return err(appError('INTERNAL_ERROR', 'Delivery receipt storage is unavailable', true));
      const current = await this.goals.getById(requiredBounded(request.goalId, 'goalId', 128));
      if (current === null) return err(appError('INVALID_INPUT', 'Goal was not found'));
      if (current.ownerClientId !== stableOwnerClientId(actor)) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      return ok(await this.goals.recordDeliveryReceipt({
        id: requiredBounded(request.receiptId, 'receiptId', 128), goalId: current.id,
        channel: requiredBounded(request.channel, 'channel', MAX_DELIVERY_CHANNEL), state: request.state,
        basedOnUserIntentRevision: request.basedOnUserIntentRevision,
        ...(request.externalId === undefined ? {} : { externalId: requiredBounded(request.externalId, 'externalId', 512) }),
        ...(request.detail === undefined ? {} : { detail: safeText(request.detail, MAX_DELIVERY_DETAIL, 'detail', true) }),
        now: this.now().toISOString(),
      }));
    } catch (error: unknown) { return this.mapError(error); }
  }

  public async listDeliveryReceipts(actor: FileActor, goalId: string, limit = 20): Promise<Result<readonly GoalDeliveryReceipt[]>> {
    try {
      if (this.goals.listDeliveryReceipts === undefined) return err(appError('INTERNAL_ERROR', 'Delivery receipt storage is unavailable', true));
      const current = await this.goals.getById(requiredBounded(goalId, 'goalId', 128));
      if (current === null) return err(appError('INVALID_INPUT', 'Goal was not found'));
      if (current.ownerClientId !== stableOwnerClientId(actor)) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      return ok(await this.goals.listDeliveryReceipts(current.id, Math.max(1, Math.min(100, Math.trunc(limit)))));
    } catch (error: unknown) { return this.mapError(error); }
  }

  public async advanceGoalIteration(actor: FileActor, request: AdvanceGoalIterationRequest): Promise<Result<GoalSnapshot>> {
    try {
      const ownerClientId = stableOwnerClientId(actor);
      const goalId = requiredBounded(request.goalId, 'goalId', 128);
      const current = await this.goals.getById(goalId);
      if (current === null) return err(appError('INVALID_INPUT', 'Goal was not found'));
      if (current.ownerClientId !== ownerClientId) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      if (request.expectedUserIntentRevision !== current.userIntentRevision) return err(appError('INVALID_INPUT', 'Goal user intent revision is stale'));
      if (current.iterationPolicy.mode !== 'iterate') return err(appError('INVALID_INPUT', 'Goal iteration mode is not enabled'));
      const stopForNoEvidence = current.iterationPolicy.stopOnNoNewEvidence && !request.evidenceAdded;
      if (!stopForNoEvidence && current.iterationPolicy.currentIteration >= current.iterationPolicy.maxIterations) return err(appError('INVALID_INPUT', 'Goal iteration limit has been reached'));
      const iterationPolicy: GoalIterationPolicy = stopForNoEvidence
        ? { ...current.iterationPolicy, mode: 'outcome' }
        : { ...current.iterationPolicy, currentIteration: current.iterationPolicy.currentIteration + 1 };
      const trackedTasks = current.trackedTasks ?? legacyTrackedTasks(current.activeTaskIds);
      const goal = await this.goals.checkpoint({
        checkpointId: randomUUID(), goalId, ownerClientId, ownerSessionId: stableOwnerSessionId(actor),
        leaseTokenHash: hashLeaseToken(requiredBounded(request.leaseToken, 'leaseToken', 256)), expectedRevision: request.expectedRevision,
        expectedUserIntentRevision: request.expectedUserIntentRevision, iterationPolicy,
        plan: current.plan, currentPhase: stopForNoEvidence ? current.currentPhase : `iteration-${iterationPolicy.currentIteration}`,
        summary: stopForNoEvidence ? 'Iteration stopped because no new evidence was produced' : `Started bounded iteration ${iterationPolicy.currentIteration}/${iterationPolicy.maxIterations}`,
        stepUpdates: [], nextAction: safeText(request.nextAction, MAX_NEXT_ACTION, 'nextAction'), blockers: current.blockers, evidence: [],
        activeTaskIds: blockingTaskIds(trackedTasks), trackedTasks, ponytailMode: current.ponytailMode ?? null, releaseLease: false, now: this.now().toISOString(),
      });
      return ok(toSnapshot(goal));
    } catch (error: unknown) { return this.mapError(error); }
  }

  public async finishGoal(actor: FileActor, request: FinishGoalRequest): Promise<Result<FinishGoalResult>> {
    try {
      const ownerClientId = stableOwnerClientId(actor);
      const goalId = requiredBounded(request.goalId, 'goalId', 128);
      const current = await this.goals.getById(goalId);
      if (current === null) return err(appError('INVALID_INPUT', 'Goal was not found'));
      if (current.ownerClientId !== ownerClientId) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 0) return err(appError('INVALID_INPUT', 'expectedRevision is invalid'));
      const trackedTasks = current.trackedTasks ?? legacyTrackedTasks(current.activeTaskIds);
      const now = this.now().toISOString();
      const finishRequest = {
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
      } as const;

      let scheduledTaskCancellation: ScheduledTaskCancellationInstruction = {
        action: 'none',
        reason: 'no_live_task',
      };
      if (this.scheduledContinuations !== undefined) {
        try {
          await this.goals.validateFinish(finishRequest);
        } catch (error: unknown) {
          return this.mapError(error);
        }
        try {
          const marked = await this.scheduledContinuations.markGoalFinishedForScheduledContinuation(goalId, now);
          scheduledTaskCancellation = cancellationInstruction(marked.continuation);
          if (requiresNativeCleanup(scheduledTaskCancellation)) {
            const pendingGoal = await this.goals.getById(goalId);
            if (pendingGoal === null) return err(appError('INVALID_INPUT', 'Goal was not found'));
            return ok({
              ...toSnapshot(pendingGoal),
              completionState: 'pending_native_cleanup',
              scheduledTaskCancellation,
            });
          }
        } catch {
          return err(appError(
            'CONFLICT',
            'Goal completion is waiting for scheduled-continuation cleanup to be verified',
            true,
          ));
        }
      }
      const goal = await this.goals.finish(finishRequest);
      // The durable transition is the linearization point. Once it succeeds,
      // stop every request/task still owned by the just-terminal goal so a
      // stale worker cannot continue into a later native wake.
      const [requestCancellation, taskCancellations] = await Promise.all([
        this.cancelInFlightRequests(goalId),
        this.cancelTrackedTasks(ownerClientId, goal.workspaceId, trackedTasks),
      ]);
      return ok({
        ...toSnapshot(goal),
        trackedTaskIds: trackedTasks.map((task) => task.taskId),
        trackedTasks,
        taskCancellations,
        allTasksStopped: taskCancellations.every((entry) => isGoalTaskStopped(entry.status)),
        requestCancellation,
        allRequestsStopped: requestCancellation.remaining === 0,
        completionState: 'completed',
        scheduledTaskCancellation,
      });
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

  public async reconcileGoals(actor: FileActor, request: ReconcileGoalsRequest): Promise<Result<ReconcileGoalsResult>> {
    try {
      const ownerClientId = stableOwnerClientId(actor);
      const workspaceId = requiredBounded(request.workspaceId, 'workspaceId', 128);
      if (await this.workspaces.get(workspaceId) === null) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found'));
      if (!Array.isArray(request.goalIds) || request.goalIds.length < 1 || request.goalIds.length > 20) {
        return err(appError('INVALID_INPUT', 'goalIds must contain between 1 and 20 exact durable goal IDs'));
      }
      const goalIds = [...new Set(request.goalIds.map((goalId) => requiredBounded(goalId, 'goalId', 128)))];
      const summary = safeText(request.summary, MAX_SUMMARY, 'summary');
      const apply = request.apply === true;
      const supersededByGoalId = request.supersededByGoalId === undefined
        ? undefined
        : requiredBounded(request.supersededByGoalId, 'supersededByGoalId', 128);
      if (request.reason === 'superseded' && supersededByGoalId === undefined) {
        return err(appError('INVALID_INPUT', 'supersededByGoalId is required when reason=superseded'));
      }
      const results: GoalReconciliationEntry[] = [];
      for (const goalId of goalIds) {
        const current = await this.goals.getById(goalId);
        if (current === null) {
          results.push({ goalId, disposition: 'not_active', reason: 'goal_not_found' });
          continue;
        }
        if (current.ownerClientId !== ownerClientId) return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
        if (current.workspaceId !== workspaceId) {
          results.push({ goalId, goalKey: current.goalKey, disposition: 'not_active', reason: 'workspace_mismatch' });
          continue;
        }
        if (current.status !== 'active') {
          results.push({ goalId, goalKey: current.goalKey, disposition: 'not_active', snapshot: toSnapshot(current) });
          continue;
        }
        const now = this.now();
        const expiresAtMs = current.leaseExpiresAt === undefined ? Number.NaN : Date.parse(current.leaseExpiresAt);
        if (Number.isFinite(expiresAtMs) && expiresAtMs > now.getTime()) {
          results.push({ goalId, goalKey: current.goalKey, disposition: 'live_lease', snapshot: toSnapshot(current) });
          continue;
        }
        if (this.workerLiveness === undefined || this.scheduledContinuations === undefined) {
          results.push({ goalId, goalKey: current.goalKey, disposition: 'liveness_unavailable', snapshot: toSnapshot(current) });
          continue;
        }
        const trackedTasks = current.trackedTasks ?? legacyTrackedTasks(current.activeTaskIds);
        const observed = await this.workerLiveness.observe(goalId, trackedTasks);
        if (!observed.trustworthy) {
          results.push({ goalId, goalKey: current.goalKey, disposition: 'liveness_untrusted', snapshot: toSnapshot(current) });
          continue;
        }
        if (observed.leaseGeneration !== current.leaseGeneration || observed.leaseActivitySeq !== current.leaseActivitySeq) {
          results.push({ goalId, goalKey: current.goalKey, disposition: 'concurrent_change', snapshot: toSnapshot(current) });
          continue;
        }
        const blockingStates = observed.blockingTaskStates
          ?? observed.activeTaskStates?.map((entry) => ({ ...entry, provider: 'legacy_auto' as const }))
          ?? [];
        if (observed.liveFencedCallCount > 0 || blockingStates.some((entry) => entry.state === 'running' || entry.state === 'unknown')) {
          results.push({ goalId, goalKey: current.goalKey, disposition: 'live_worker', snapshot: toSnapshot(current) });
          continue;
        }
        const liveContinuation = await this.scheduledContinuations.getLiveScheduledContinuation(goalId);
        if (liveContinuation !== null) {
          results.push({
            goalId,
            goalKey: current.goalKey,
            disposition: 'native_cleanup_required',
            reason: 'scheduled_continuation_must_be_made_historical_before_reconciliation',
            snapshot: toSnapshot(current),
            continuationId: liveContinuation.continuationId,
            ...(liveContinuation.nativeTaskId === undefined ? {} : { nativeTaskId: liveContinuation.nativeTaskId }),
          });
          continue;
        }
        if (!apply) {
          results.push({ goalId, goalKey: current.goalKey, disposition: 'eligible', snapshot: toSnapshot(current) });
          continue;
        }
        try {
          const evidence: GoalEvidence[] = [
            { kind: 'note', value: `reconciliation_liveness:gen=${observed.leaseGeneration};seq=${observed.leaseActivitySeq};fenced=${observed.liveFencedCallCount}` },
            ...(supersededByGoalId === undefined ? [] : [{ kind: 'note' as const, value: `superseded_by_goal:${supersededByGoalId}` }]),
          ];
          const reconciled = await this.goals.reconcile({
            checkpointId: randomUUID(),
            goalId,
            ownerClientId,
            expectedRevision: current.revision,
            expectedLeaseGeneration: current.leaseGeneration,
            expectedLeaseActivitySeq: current.leaseActivitySeq,
            reason: request.reason,
            summary,
            evidence,
            now: now.toISOString(),
          });
          results.push({ goalId, goalKey: reconciled.goalKey, disposition: 'reconciled', snapshot: toSnapshot(reconciled) });
        } catch (error: unknown) {
          if (error instanceof GoalStateError && (error.reason === 'conflict' || error.reason === 'terminal')) {
            const latest = await this.goals.getById(goalId);
            results.push({
              goalId,
              goalKey: current.goalKey,
              disposition: 'concurrent_change',
              ...(latest === null ? {} : { snapshot: toSnapshot(latest) }),
            });
            continue;
          }
          throw error;
        }
      }
      return ok({ apply, reason: request.reason, results });
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
        case 'lease_invalid': return err(appError('CONFLICT', `Goal lease is no longer valid (${error.message}); read the latest goal and reacquire or claim the scheduled continuation before retrying`, true));
        case 'conflict': return err(appError('CONFLICT', 'Goal state changed concurrently; read the latest revision and retry', true));
        case 'precondition': return err(appError('CONFLICT', error.message, true));
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

function pendingScheduledTaskCleanupFrom(continuation: ScheduledContinuationRecord | null): PendingScheduledTaskCleanup | undefined {
  if (continuation?.nativeTaskId === undefined) return undefined;
  const state = continuation.status === 'cancel_required'
    ? 'required'
    : continuation.status === 'cancel_failed'
      ? 'failed'
      : continuation.status === 'cancel_uncertain'
        ? 'uncertain'
        : undefined;
  if (state === undefined) return undefined;
  return {
    continuationId: continuation.continuationId,
    nativeTaskId: continuation.nativeTaskId,
    expectedContinuationVersion: continuation.version,
    provider: 'chatgpt_scheduled_task',
    requiredEffect: 'non_runnable',
    state,
  };
}

function cancellationInstruction(continuation: ScheduledContinuationRecord | null): ScheduledTaskCancellationInstruction {
  if (continuation === null || continuation.status === 'superseded') {
    return { action: 'none', reason: 'no_live_task' };
  }
  if (
    (continuation.status === 'cancel_required' || continuation.status === 'cancel_failed')
    && continuation.nativeTaskId !== undefined
  ) {
    return {
      action: 'make_native_task_non_runnable',
      continuationId: continuation.continuationId,
      nativeTaskId: continuation.nativeTaskId,
      provider: 'chatgpt_scheduled_task',
      expectedContinuationVersion: continuation.version,
      receiptRequired: true,
      requiredEffect: 'non_runnable',
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

function normalizeEngineeringReviewFindings(findings: readonly EngineeringReviewFinding[]): readonly EngineeringReviewFinding[] {
  if (findings.length > 100) throw new Error('engineeringReviewFindings are invalid');
  const ids = new Set<string>();
  return findings.map((finding) => {
    const id = requiredBounded(finding.id, 'engineering review finding id', 128);
    if (ids.has(id)) throw new Error('engineering review finding ids must be unique');
    ids.add(id);
    if (!['blocking', 'non_blocking'].includes(finding.severity)) throw new Error('engineering review finding severity is invalid');
    if (!['open', 'validated', 'rejected', 'resolved'].includes(finding.state)) throw new Error('engineering review finding state is invalid');
    const reason = safeText(finding.reason, MAX_CONTEXT_ITEM, 'engineering review finding reason');
    if (finding.state === 'rejected' && reason.trim().length === 0) throw new Error('rejected engineering review finding requires a reason');
    return {
      id,
      title: safeText(finding.title, 512, 'engineering review finding title'),
      severity: finding.severity,
      state: finding.state,
      reason,
      ...(finding.source === undefined ? {} : { source: safeText(finding.source, 1024, 'engineering review finding source') }),
    };
  });
}

async function applyEngineeringGateUpdates(
  engineering: EngineeringGoalMetadata | undefined,
  updates: readonly EngineeringGateUpdate[],
  workspaceId: string,
  userIntentRevision: number,
  resumeContext: GoalCheckpointResumeContext | undefined,
  evidenceVerifier: EngineeringGateEvidenceVerifier | undefined,
): Promise<EngineeringGoalMetadata> {
  if (engineering === undefined) throw new Error('engineeringGateUpdates require an Engineering Harness goal');
  if (updates.length > 100) throw new Error('engineeringGateUpdates are invalid');
  const byId = new Map(engineering.gates.map((gate) => [gate.id, gate] as const));
  const seen = new Set<string>();
  for (const update of updates) {
    const gateId = requiredBounded(update.gateId, 'engineering gate id', 128);
    if (seen.has(gateId)) throw new Error('engineering gate updates must be unique');
    seen.add(gateId);
    const current = byId.get(gateId);
    if (current === undefined) throw new Error(`engineering gate is unknown: ${gateId}`);
    if (update.status === 'not_applicable' && !mayMarkEngineeringGateNotApplicable(current)) {
      throw new Error(`required engineering gate cannot be marked not_applicable: ${gateId}`);
    }
    if (update.status === 'passed' && current.checkCommand !== undefined && update.evidence?.command !== current.checkCommand) {
      throw new Error(`engineering gate requires its declared check command: ${gateId}`);
    }
    if (update.status === 'not_applicable' && update.reason?.trim() === '') throw new Error('not_applicable engineering gate requires a reason');
    if (update.status === 'not_applicable' && update.reason === undefined) throw new Error('not_applicable engineering gate requires a reason');
    if (update.status === 'passed' && update.evidence === undefined) throw new Error('passed engineering gate requires observed evidence');
    if (update.evidence !== undefined) {
      if (update.evidence.workspaceId !== workspaceId) throw new Error('engineering gate evidence workspace does not match the goal');
      if (update.evidence.source === 'host_observed') {
        if (update.status === 'passed' && (update.evidence.command === undefined || update.evidence.runId === undefined)) {
          throw new Error('host-observed passed engineering evidence requires a command and host runId');
        }
        if (update.evidence.command !== undefined) {
          const observed = resumeContext?.commands.find((entry) => entry.command === update.evidence?.command && entry.status === 'passed');
          if (observed === undefined) throw new Error('host-observed command evidence is not present in the checkpoint resumeContext');
          if (update.evidence.exitCode !== undefined && observed.exitCode !== update.evidence.exitCode) throw new Error('engineering gate evidence exit code does not match the observed command');
        }
        if (update.status === 'passed') {
          if (evidenceVerifier === undefined || !(await evidenceVerifier.verify(workspaceId, update.evidence, gateId, current.requiredPlatforms))) {
            throw new Error('host-observed engineering evidence could not be verified against the host task runtime');
          }
        }
      }
    }
    const reason = update.reason === undefined ? current.reason : safeText(update.reason, MAX_CONTEXT_ITEM, 'engineering gate reason');
    const retainEvidence = update.status === 'passed' || update.status === 'failed' || update.status === 'blocked';
    const { evidence: previousEvidence, ...gateWithoutEvidence } = current;
    void previousEvidence;
    byId.set(gateId, {
      ...gateWithoutEvidence,
      status: update.status,
      reason,
      basedOnUserIntentRevision: userIntentRevision,
      ...(retainEvidence && update.evidence !== undefined ? { evidence: update.evidence } : {}),
    });
  }
  return { ...engineering, gates: engineering.gates.map((gate) => byId.get(gate.id) ?? gate) };
}

function staleEngineeringGates(engineering: EngineeringGoalMetadata | undefined, gateIds: readonly string[], nextUserIntentRevision: number): EngineeringGoalMetadata | undefined {
  if (engineering === undefined || gateIds.length === 0) return engineering;
  const requested = new Set(gateIds.map((id) => requiredBounded(id, 'engineering gate id', 128)));
  const known = new Set(engineering.gates.map((gate) => gate.id));
  for (const id of requested) if (!known.has(id)) throw new Error('engineering gate id is unknown');
  return {
    ...engineering,
    gates: engineering.gates.map((gate) => {
      if (!requested.has(gate.id) || gate.status === 'not_applicable') return gate;
      const { evidence: omittedEvidence, ...rest } = gate;
      void omittedEvidence;
      return { ...rest, status: 'stale' as const, basedOnUserIntentRevision: nextUserIntentRevision };
    }),
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
    acceptanceCriteria: snapshot.acceptanceCriteria,
    userIntentRevision: snapshot.userIntentRevision,
    iterationPolicy: snapshot.iterationPolicy,
    ...(snapshot.engineering === undefined ? {} : { engineering: snapshot.engineering }),
    ...(snapshot.workflow === undefined ? {} : { workflow: snapshot.workflow }),
    ...(snapshot.currentContextCapsuleId === undefined ? {} : { currentContextCapsuleId: snapshot.currentContextCapsuleId }),
    completedSteps: snapshot.completedSteps,
    pendingSteps: snapshot.pendingSteps,
    nextAction: snapshot.nextAction,
    blockers: snapshot.blockers,
    activeTaskIds: snapshot.activeTaskIds,
    trackedTasks: snapshot.trackedTasks,
    ponytailMode: snapshot.ponytailMode,
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
    acceptanceCriteria: goal.acceptanceCriteria,
    userIntentRevision: goal.userIntentRevision,
    iterationPolicy: goal.iterationPolicy,
    ...(goal.engineering === undefined ? {} : { engineering: goal.engineering }),
    ...(goal.workflow === undefined ? {} : { workflow: goal.workflow }),
    ...(goal.currentContextCapsuleId === undefined ? {} : { currentContextCapsuleId: goal.currentContextCapsuleId }),
    completedSteps: goal.plan.steps.filter((step) => step.status === 'completed'),
    pendingSteps: goal.plan.steps.filter((step) => step.status !== 'completed'),
    nextAction: goal.nextAction || nextActionFromPlan(goal.plan),
    blockers: goal.blockers,
    activeTaskIds: goal.activeTaskIds,
    trackedTasks: goal.trackedTasks ?? legacyTrackedTasks(goal.activeTaskIds),
    ponytailMode: goal.ponytailMode ?? 'inherit',
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

function normalizeAcceptanceCriteria(input: readonly GoalAcceptanceInput[]): readonly GoalAcceptanceCriterion[] {
  if (!Array.isArray(input) || input.length > MAX_ACCEPTANCE_CRITERIA) throw new Error('acceptanceCriteria are invalid');
  const ids = new Set<string>();
  return input.map((criterion) => {
    const id = requiredBounded(criterion.id, 'acceptance criterion id', MAX_ACCEPTANCE_ID);
    if (ids.has(id)) throw new Error('acceptance criterion ids must be unique');
    ids.add(id);
    return { id, title: safeText(criterion.title, MAX_ACCEPTANCE_TITLE, 'acceptance criterion title'), status: 'pending' as const };
  });
}

function normalizeIterationPolicyInput(input: GoalIterationPolicyInput): GoalIterationPolicy {
  if (input.mode !== 'outcome' && input.mode !== 'iterate') throw new Error('iteration mode is invalid');
  const maxIterations = input.mode === 'outcome' ? 1 : (input.maxIterations ?? 3);
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 100) throw new Error('maxIterations must be between 1 and 100');
  return { mode: input.mode, maxIterations, currentIteration: 0, stopOnNoNewEvidence: input.stopOnNoNewEvidence ?? true };
}

function normalizeFullPlan(stepsInput: readonly GoalPlanStep[]): GoalPlan {
  if (!Array.isArray(stepsInput) || stepsInput.length > MAX_STEPS) throw new Error('plan steps are invalid');
  const ids = new Set<string>();
  let inProgress = 0;
  const steps = stepsInput.map((step): GoalPlanStep => {
    const id = requiredBounded(step.id, 'step id', MAX_STEP_ID);
    if (ids.has(id)) throw new Error('plan step ids must be unique');
    ids.add(id);
    if (!isStepStatus(step.status)) throw new Error('Goal step status is invalid');
    if (step.status === 'in_progress') inProgress += 1;
    return {
      id,
      title: safeText(step.title, MAX_STEP_TITLE, 'step title'),
      status: step.status,
      ...(step.summary === undefined ? {} : { summary: safeText(step.summary, MAX_STEP_SUMMARY, 'step summary', true) }),
    };
  });
  if (inProgress > 1) throw new Error('Only one goal plan step may be in_progress');
  return { steps };
}

function applyAcceptanceUpdates(criteria: readonly GoalAcceptanceCriterion[], updates: readonly GoalAcceptanceUpdate[]): readonly GoalAcceptanceCriterion[] {
  if (!Array.isArray(updates) || updates.length > MAX_ACCEPTANCE_CRITERIA) throw new Error('acceptance updates are invalid');
  const known = new Set(criteria.map((criterion) => criterion.id));
  const seen = new Set<string>();
  const byId = new Map<string, GoalAcceptanceUpdate>();
  for (const update of updates) {
    const criterionId = requiredBounded(update.criterionId, 'criterionId', MAX_ACCEPTANCE_ID);
    if (!known.has(criterionId)) throw new Error(`Unknown acceptance criterion: ${criterionId}`);
    if (seen.has(criterionId)) throw new Error(`Duplicate acceptance criterion update: ${criterionId}`);
    seen.add(criterionId);
    if (update.status !== 'pending' && update.status !== 'completed' && update.status !== 'blocked') throw new Error('Acceptance criterion status is invalid');
    byId.set(criterionId, { criterionId, status: update.status, ...(update.evidence === undefined ? {} : { evidence: normalizeEvidence(update.evidence) }) });
  }
  return criteria.map((criterion) => {
    const update = byId.get(criterion.id);
    if (update === undefined) return criterion;
    return { ...criterion, status: update.status, ...(update.evidence === undefined ? {} : { evidence: update.evidence }) };
  });
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

function normalizeCheckpointResumeContext(value: GoalCheckpointResumeContext | undefined): GoalCheckpointResumeContext | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('resumeContext is invalid');
  const commands = value.commands;
  if (!Array.isArray(commands) || commands.length > 50) throw new Error('resumeContext commands are invalid');
  const normalized: GoalCheckpointResumeContext = {
    changedFiles: normalizeStrings(value.changedFiles, MAX_CONTEXT_ITEMS, 4_096, 'resumeContext changedFiles'),
    commands: commands.map((entry) => {
      if (!isRecord(entry) || typeof entry.command !== 'string') throw new Error('resumeContext command is invalid');
      if (entry.status !== 'passed' && entry.status !== 'failed' && entry.status !== 'running') throw new Error('resumeContext command status is invalid');
      const exitCode = entry.exitCode;
      if (exitCode !== undefined && (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || Math.abs(exitCode) > 2_147_483_647)) throw new Error('resumeContext exitCode is invalid');
      const result = entry.result;
      if (result !== undefined && typeof result !== 'string') throw new Error('resumeContext command result is invalid');
      return {
        command: safeText(entry.command, 2_048, 'resumeContext command'),
        status: entry.status,
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(result === undefined ? {} : { result: safeText(result, 2_048, 'resumeContext command result', true) }),
      };
    }),
    decisions: normalizeStrings(value.decisions, MAX_CONTEXT_ITEMS, MAX_CONTEXT_ITEM, 'resumeContext decisions'),
    failedAttempts: normalizeStrings(value.failedAttempts, MAX_CONTEXT_ITEMS, MAX_CONTEXT_ITEM, 'resumeContext failedAttempts'),
    pendingValidation: normalizeStrings(value.pendingValidation, MAX_CONTEXT_ITEMS, MAX_CONTEXT_ITEM, 'resumeContext pendingValidation'),
    resumePrerequisites: normalizeStrings(value.resumePrerequisites, MAX_CONTEXT_ITEMS, MAX_CONTEXT_ITEM, 'resumeContext resumePrerequisites'),
    stateFacts: normalizeEvidence(value.stateFacts),
    artifacts: normalizeEvidence(value.artifacts),
  };
  if (JSON.stringify(normalized).length > 64_000) throw new Error('resumeContext exceeds the 64 KB bounded payload limit');
  return normalized;
}

function normalizeTaskIds(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > MAX_ACTIVE_TASKS) throw new Error('activeTaskIds are invalid');
  return [...new Set(values.map((value) => requiredBounded(value, 'task id', MAX_TASK_ID)))];
}

function requiresNativeCleanup(instruction: ScheduledTaskCancellationInstruction): boolean {
  return instruction.action === 'make_native_task_non_runnable' || instruction.reason === 'native_task_unverified';
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

function isTerminalDeliveryState(state: GoalDeliveryState): boolean {
  return state === 'completed' || state === 'cancelled' || state === 'retired';
}

function assertLeaseSnapshot(goal: GoalRecord, actor: FileActor, leaseToken: string, now: string): void {
  if (goal.status !== 'active') throw new GoalStateError('terminal', 'Goal is already terminal');
  if (
    goal.leaseOwnerClientId !== stableOwnerClientId(actor)
    || goal.leaseOwnerSessionId !== stableOwnerSessionId(actor)
    || goal.leaseTokenHash !== hashLeaseToken(requiredBounded(leaseToken, 'leaseToken', 256))
  ) throw new GoalStateError('lease_invalid', 'Goal lease token or session is invalid');
  if (goal.leaseExpiresAt === undefined || Date.parse(goal.leaseExpiresAt) <= Date.parse(now)) throw new GoalStateError('lease_invalid', 'Goal lease has expired');
}

function validateContextCapsuleQuality(payload: GoalContextCapsulePayload): void {
  const serialized = JSON.stringify(payload);
  if (serialized.length > 64_000) throw new Error('Context capsule exceeds the 64 KB bounded payload limit');
  const taskSignalCount = payload.plan.steps.length + payload.completedWork.length + payload.remainingWork.length + payload.decisions.length + payload.validation.length;
  if (taskSignalCount >= 10 && serialized.length < 500) throw new Error('Context capsule is too small for the amount of task state it claims to summarize');
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

function normalizeGoalPonytailModeOverride(value: unknown): GoalPonytailModeOverride {
  if (value === 'inherit' || value === 'off' || value === 'lite' || value === 'full' || value === 'ultra') return value;
  throw new Error('ponytailMode is invalid');
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
