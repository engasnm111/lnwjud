import { randomUUID } from 'node:crypto';
import {
  AutomationStateError,
  type AutomationRepository,
  type AutomationRunSnapshot,
  type GoalEvidence,
  type GoalLeaseProof,
  type GoalStepUpdate,
  type GoalTrackedTask,
} from '@lnwjud/domain';
import type { FileActor } from './file-service.js';
import type {
  FinishGoalResult,
  GoalAcceptanceUpdate,
  GoalContinuationService,
  GoalSnapshot,
} from './goal-continuation-service.js';
import {
  AutomationOrchestratorService,
  type AutomationAuthorityCursor,
} from './automation-orchestrator-service.js';

const MAX_GOAL_EVIDENCE = 20;
const MAX_GOAL_EVIDENCE_VALUE = 1_024;

export type AutomationGoalContinuationPort = Pick<
  GoalContinuationService,
  'getGoal' | 'checkpointGoal' | 'updateGoalAcceptance' | 'finishGoal'
>;

export interface AutomationGoalMutationRequest {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly authority: AutomationAuthorityCursor;
  readonly lease?: GoalLeaseProof;
}

export type AutomationCheckpointTaskRequest = AutomationGoalMutationRequest;

export interface AutomationVerifyMilestoneRequest extends AutomationGoalMutationRequest {
  readonly evidence: readonly GoalEvidence[];
}

export interface AutomationAcceptanceCompletion {
  readonly criterionId: string;
  readonly evidence: readonly GoalEvidence[];
}

export interface AutomationFinalizeRequest extends AutomationGoalMutationRequest {
  readonly summary: string;
  readonly finalReviewEvidence: readonly GoalEvidence[];
  readonly acceptance: readonly AutomationAcceptanceCompletion[];
}

export type AutomationRecoverCheckpointedVerificationRequest = AutomationGoalMutationRequest;

export interface AutomationTerminalReadbackRequest {
  readonly runId: string;
  readonly expectedRevision: number;
}

export interface AutomationGoalCheckpointResult {
  readonly run: AutomationRunSnapshot;
  readonly goal: GoalSnapshot;
}

export interface AutomationFinalizeResult {
  readonly run: AutomationRunSnapshot;
  readonly goal: GoalSnapshot;
  readonly completionState: 'completed' | 'pending_native_cleanup';
  readonly scheduledTaskCancellation?: FinishGoalResult['scheduledTaskCancellation'];
}

export interface AutomationGoalIntegrationServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

/**
 * Bridges native automation state into the existing durable-goal authority.
 *
 * The goal remains authoritative for user-facing plan, acceptance, blockers,
 * tracked tasks, lease ownership, and terminal state. Automation checkpoints
 * are projections only: they never invent plan steps or acceptance criteria.
 */
export class AutomationGoalIntegrationService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  public constructor(
    private readonly repository: AutomationRepository,
    private readonly orchestrator: AutomationOrchestratorService,
    private readonly goals: AutomationGoalContinuationPort,
    options: AutomationGoalIntegrationServiceOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  public async checkpointTaskBound(
    actor: FileActor,
    request: AutomationCheckpointTaskRequest,
  ): Promise<AutomationGoalCheckpointResult> {
    const run = await this.loadExpectedRun(request);
    if (run.status !== 'waiting_task' || run.currentAttemptId === undefined) {
      throw new AutomationStateError('conflict', 'Automation run has no durable task waiting to be checkpointed');
    }
    const lease = requireLease(request.lease, run.goalId);
    const goal = await this.loadActiveGoal(actor, run, request.authority, lease);
    const binding = run.taskBindings.find((candidate) => (
      candidate.attemptId === run.currentAttemptId
      && candidate.role === 'blocking_job'
    ));
    if (binding === undefined) {
      throw new AutomationStateError('corrupt', 'Automation waiting task has no blocking durable task binding');
    }

    const stepUpdates = progressStepUpdates(goal, run);
    const trackedTasks = mergeTrackedTasks(goal, run);
    const checkpoint = requireGoalResult(
      await this.goals.checkpointGoal(actor, {
        goalId: goal.goalId,
        leaseToken: lease.leaseToken,
        expectedRevision: goal.revision,
        expectedUserIntentRevision: goal.userIntentRevision,
        currentPhase: boundedPhase(`automation:${run.currentMilestoneId ?? 'task'}`),
        summary: boundedSummary(`Automation task bound for run ${run.id}`),
        stepUpdates,
        nextAction: 'observe durable automation task',
        blockers: goal.blockers,
        evidence: [{
          kind: 'task',
          value: boundedEvidenceValue(`${binding.provider}:${binding.taskId}`),
        }],
        trackedTasks,
        releaseLease: false,
      }),
      'Durable goal task checkpoint failed',
    );

    const synced = await this.syncRunToGoal(run, checkpoint, 'automation_task_checkpointed', {
      activeAutomationTasks: activeAutomationBindings(run).length,
      leaseGeneration: lease.leaseGeneration,
    });
    return { run: synced, goal: checkpoint };
  }

  public async verifyAndCompleteMilestone(
    actor: FileActor,
    request: AutomationVerifyMilestoneRequest,
  ): Promise<AutomationGoalCheckpointResult> {
    if (request.evidence.length === 0) {
      throw new AutomationStateError(
        'conflict',
        'Automation milestone completion requires persisted verification evidence',
      );
    }

    const run = await this.loadExpectedRun(request);
    if (
      run.status !== 'verifying'
      || run.currentMilestoneId === undefined
      || run.currentAttemptId === undefined
    ) {
      throw new AutomationStateError('conflict', 'Automation run is not ready for verified checkpointing');
    }
    const milestone = run.milestones.find((candidate) => candidate.id === run.currentMilestoneId);
    const attempt = run.attempts.find((candidate) => candidate.id === run.currentAttemptId);
    if (milestone === undefined || attempt === undefined) {
      throw new AutomationStateError('corrupt', 'Automation verification references missing milestone or attempt');
    }
    if (milestone.status !== 'verifying' || attempt.status !== 'verifying') {
      throw new AutomationStateError('conflict', 'Automation milestone verification is not active');
    }

    const lease = requireLease(request.lease, run.goalId);
    const goal = await this.loadActiveGoal(actor, run, request.authority, lease);
    const stepUpdates = verifiedStepUpdates(goal, run.currentMilestoneId, milestone.title);
    const trackedTasks = mergeTrackedTasks(goal, run);
    const checkpointEvidence = projectedVerificationEvidence(
      run.id,
      milestone.id,
      attempt.id,
      request.evidence,
    );
    const remainingMilestones = run.milestones.filter((candidate) => (
      candidate.id !== milestone.id && candidate.status !== 'completed'
    ));

    const checkpoint = requireGoalResult(
      await this.goals.checkpointGoal(actor, {
        goalId: goal.goalId,
        leaseToken: lease.leaseToken,
        expectedRevision: goal.revision,
        expectedUserIntentRevision: goal.userIntentRevision,
        currentPhase: boundedPhase(`automation:${milestone.id}:verified`),
        summary: boundedSummary(`Automation milestone verified: ${milestone.title}`),
        stepUpdates,
        nextAction: remainingMilestones.length === 0
          ? 'run final acceptance and finish durable goal'
          : 'continue native automation run',
        blockers: goal.blockers,
        evidence: checkpointEvidence,
        trackedTasks,
        releaseLease: false,
      }),
      'Durable goal verification checkpoint failed',
    );

    const synced = await this.syncRunToGoal(run, checkpoint, 'milestone_verification_checkpointed', {
      verificationEvidenceCount: request.evidence.length,
      projectedStepUpdates: stepUpdates.length,
      leaseGeneration: lease.leaseGeneration,
    });
    const completed = await this.orchestrator.completeCurrentMilestone({
      runId: synced.id,
      expectedRevision: synced.revision,
      authority: {
        goalRevision: checkpoint.revision,
        userIntentRevision: checkpoint.userIntentRevision,
      },
      evidence: request.evidence,
    });
    return { run: completed, goal: checkpoint };
  }

  public async recoverCheckpointedVerification(
    actor: FileActor,
    request: AutomationRecoverCheckpointedVerificationRequest,
  ): Promise<AutomationGoalCheckpointResult | null> {
    const run = await this.loadExpectedRun(request);
    if (
      run.status !== 'verifying'
      || run.currentMilestoneId === undefined
      || run.currentAttemptId === undefined
    ) return null;

    const goal = await this.loadGoal(actor, run.goalId);
    assertGoalIdentity(run, goal);
    if (goal.status !== 'active') return null;
    assertAuthority(run, goal, request.authority);

    const milestone = run.milestones.find((candidate) => candidate.id === run.currentMilestoneId);
    const attempt = run.attempts.find((candidate) => candidate.id === run.currentAttemptId);
    if (milestone === undefined || attempt === undefined) {
      throw new AutomationStateError('corrupt', 'Automation verification recovery references missing milestone or attempt');
    }
    if (milestone.status !== 'verifying' || attempt.status !== 'verifying') return null;

    const planStep = goal.plan.steps.find((candidate) => candidate.id === milestone.id);
    if (planStep?.status !== 'completed') return null;

    const checkpoint = goal.lastCheckpoint;
    if (checkpoint === null) return null;
    const markerValue = verificationMarker(run.id, milestone.id, attempt.id);
    const markerPresent = checkpoint.evidence.some((entry) => (
      entry.kind === 'note' && entry.value === markerValue
    ));
    if (!markerPresent) return null;

    const recoveredEvidence = checkpoint.evidence.length > 0
      ? checkpoint.evidence
      : [{ kind: 'note' as const, value: markerValue }];
    const completed = await this.orchestrator.completeCurrentMilestone({
      runId: run.id,
      expectedRevision: run.revision,
      authority: request.authority,
      evidence: recoveredEvidence,
    });
    return { run: completed, goal };
  }

  public async reconcileTerminalReadback(
    actor: FileActor,
    request: AutomationTerminalReadbackRequest,
  ): Promise<AutomationGoalCheckpointResult> {
    const run = await this.orchestrator.get(request.runId);
    if (run.revision !== request.expectedRevision) {
      throw new AutomationStateError('conflict', 'Automation run revision changed concurrently');
    }
    const goal = await this.loadGoal(actor, run.goalId);
    assertGoalIdentity(run, goal);
    assertTerminalReadback(goal, run);
    if (run.status !== 'completed') assertRunReadyForFinalization(run);
    const completed = await this.completeRunAfterTerminalReadback(
      run,
      goal,
      goal.terminalEvidence?.length ?? 0,
    );
    return { run: completed, goal };
  }

  public async finalize(
    actor: FileActor,
    request: AutomationFinalizeRequest,
  ): Promise<AutomationFinalizeResult> {
    validateFinalReview(request);
    let run = await this.loadExpectedRun(request);
    let goal = await this.loadGoal(actor, run.goalId);
    assertGoalIdentity(run, goal);

    if (goal.status === 'completed') {
      assertTerminalReadback(goal, run);
      if (run.status !== 'completed') assertRunReadyForFinalization(run);
      run = await this.completeRunAfterTerminalReadback(run, goal, request.finalReviewEvidence.length);
      return { run, goal, completionState: 'completed' };
    }
    if (goal.status !== 'active') {
      throw new AutomationStateError(
        'conflict',
        `Durable goal is terminal as ${goal.status}; automation cannot complete as successful`,
      );
    }

    assertAuthority(run, goal, request.authority);
    const lease = requireLease(request.lease, run.goalId);
    assertLeaseGeneration(goal, lease);
    assertRunReadyForFinalization(run);

    const stepUpdates = finalStepUpdates(goal, run);
    const trackedTasks = mergeTrackedTasks(goal, run);
    const acceptanceUpdates = finalAcceptanceUpdates(goal, request.acceptance);
    assertProspectiveGoalCompletion(goal, stepUpdates, acceptanceUpdates, trackedTasks);

    goal = requireGoalResult(
      await this.goals.checkpointGoal(actor, {
        goalId: goal.goalId,
        leaseToken: lease.leaseToken,
        expectedRevision: goal.revision,
        expectedUserIntentRevision: goal.userIntentRevision,
        currentPhase: 'automation:final-review',
        summary: boundedSummary(`Automation final review passed for run ${run.id}`),
        stepUpdates,
        nextAction: 'finish durable goal and confirm terminal readback',
        blockers: goal.blockers,
        evidence: request.finalReviewEvidence,
        trackedTasks,
        releaseLease: false,
      }),
      'Durable goal final-review checkpoint failed',
    );
    run = await this.syncRunToGoal(run, goal, 'final_review_checkpointed', {
      finalReviewEvidenceCount: request.finalReviewEvidence.length,
      projectedStepUpdates: stepUpdates.length,
      leaseGeneration: lease.leaseGeneration,
    });

    const pendingAcceptanceUpdates = acceptanceUpdates.filter((update) => {
      const criterion = goal.acceptanceCriteria.find((candidate) => candidate.id === update.criterionId);
      return criterion?.status !== 'completed';
    });
    if (pendingAcceptanceUpdates.length > 0) {
      goal = requireGoalResult(
        await this.goals.updateGoalAcceptance(actor, {
          goalId: goal.goalId,
          leaseToken: lease.leaseToken,
          expectedRevision: goal.revision,
          expectedUserIntentRevision: goal.userIntentRevision,
          updates: pendingAcceptanceUpdates,
          summary: 'Automation final acceptance verified',
        }),
        'Durable goal acceptance update failed',
      );
      run = await this.syncRunToGoal(run, goal, 'final_acceptance_checkpointed', {
        acceptanceUpdates: pendingAcceptanceUpdates.length,
        leaseGeneration: lease.leaseGeneration,
      });
    }

    const readyGoal = await this.loadGoal(actor, run.goalId);
    assertGoalIdentity(run, readyGoal);
    assertGoalReadyNow(readyGoal);

    const finished = requireGoalResult(
      await this.goals.finishGoal(actor, {
        goalId: readyGoal.goalId,
        leaseToken: lease.leaseToken,
        expectedRevision: readyGoal.revision,
        status: 'completed',
        summary: boundedSummary(request.summary),
        evidence: request.finalReviewEvidence,
      }),
      'Durable goal completion failed',
    );

    if (finished.completionState === 'pending_native_cleanup') {
      return {
        run,
        goal: finished,
        completionState: 'pending_native_cleanup',
        scheduledTaskCancellation: finished.scheduledTaskCancellation,
      };
    }

    const readback = await this.loadGoal(actor, run.goalId);
    assertTerminalReadback(readback, run);
    run = await this.completeRunAfterTerminalReadback(
      run,
      readback,
      request.finalReviewEvidence.length,
    );
    return {
      run,
      goal: readback,
      completionState: 'completed',
      scheduledTaskCancellation: finished.scheduledTaskCancellation,
    };
  }

  private async loadExpectedRun(
    request: AutomationGoalMutationRequest,
  ): Promise<AutomationRunSnapshot> {
    const run = await this.orchestrator.get(request.runId);
    if (run.revision !== request.expectedRevision) {
      throw new AutomationStateError('conflict', 'Automation run revision changed concurrently');
    }
    if (run.basedOnUserIntentRevision !== request.authority.userIntentRevision) {
      throw new AutomationStateError(
        'conflict',
        'Durable goal user intent changed; reload the goal before continuing automation',
      );
    }
    return run;
  }

  private async loadGoal(actor: FileActor, goalId: string): Promise<GoalSnapshot> {
    return requireGoalResult(
      await this.goals.getGoal(actor, { goalId }),
      'Durable goal read failed',
    );
  }

  private async loadActiveGoal(
    actor: FileActor,
    run: AutomationRunSnapshot,
    authority: AutomationAuthorityCursor,
    lease: GoalLeaseProof,
  ): Promise<GoalSnapshot> {
    const goal = await this.loadGoal(actor, run.goalId);
    assertGoalIdentity(run, goal);
    if (goal.status !== 'active') {
      throw new AutomationStateError('conflict', 'Durable goal is no longer active');
    }
    assertAuthority(run, goal, authority);
    assertLeaseGeneration(goal, lease);
    return goal;
  }

  private async syncRunToGoal(
    run: AutomationRunSnapshot,
    goal: GoalSnapshot,
    reason: string,
    metadata: Readonly<Record<string, string | number | boolean | null>>,
  ): Promise<AutomationRunSnapshot> {
    return this.repository.commitTransition({
      runId: run.id,
      expectedRevision: run.revision,
      runPatch: {
        basedOnGoalRevision: goal.revision,
        basedOnUserIntentRevision: goal.userIntentRevision,
      },
      event: {
        id: this.idFactory(),
        ...(run.currentMilestoneId === undefined ? {} : { milestoneId: run.currentMilestoneId }),
        ...(run.currentAttemptId === undefined ? {} : { attemptId: run.currentAttemptId }),
        type: 'checkpoint_committed',
        reason,
        metadata: {
          goalRevision: goal.revision,
          userIntentRevision: goal.userIntentRevision,
          ...metadata,
        },
      },
      now: this.now().toISOString(),
    });
  }

  private async completeRunAfterTerminalReadback(
    run: AutomationRunSnapshot,
    goal: GoalSnapshot,
    finalReviewEvidenceCount: number,
  ): Promise<AutomationRunSnapshot> {
    if (run.status === 'completed') return run;
    if (run.status !== 'completing') {
      throw new AutomationStateError(
        'conflict',
        'Automation run must be completing before durable-goal terminal confirmation',
      );
    }
    return this.repository.commitTransition({
      runId: run.id,
      expectedRevision: run.revision,
      runPatch: {
        status: 'completed',
        basedOnGoalRevision: goal.revision,
        basedOnUserIntentRevision: goal.userIntentRevision,
        currentMilestoneId: null,
        currentAttemptId: null,
        lastRecoveryDecision: null,
        terminalAt: goal.terminalAt ?? this.now().toISOString(),
      },
      event: {
        id: this.idFactory(),
        type: 'run_terminal',
        reason: 'goal_terminal_readback_confirmed',
        metadata: {
          goalRevision: goal.revision,
          userIntentRevision: goal.userIntentRevision,
          finalReviewEvidenceCount,
        },
      },
      now: this.now().toISOString(),
    });
  }
}

function requireGoalResult<T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly message: string } },
  prefix: string,
): T {
  if (result.ok) return result.value;
  throw new AutomationStateError('conflict', `${prefix}: ${result.error.message}`);
}

function requireLease(lease: GoalLeaseProof | undefined, goalId: string): GoalLeaseProof {
  if (lease === undefined) {
    throw new AutomationStateError(
      'conflict',
      'Current goalLease proof is required before durable automation checkpointing',
    );
  }
  if (lease.goalId !== goalId) {
    throw new AutomationStateError('conflict', 'Automation goal lease proof belongs to another durable goal');
  }
  return lease;
}

function assertLeaseGeneration(goal: GoalSnapshot, lease: GoalLeaseProof): void {
  if (goal.leaseGeneration !== lease.leaseGeneration) {
    throw new AutomationStateError(
      'conflict',
      'Durable goal lease generation changed; reacquire the current goal before continuing',
    );
  }
}

function assertGoalIdentity(run: AutomationRunSnapshot, goal: GoalSnapshot): void {
  if (goal.goalId !== run.goalId || goal.workspaceId !== run.workspaceId) {
    throw new AutomationStateError('corrupt', 'Automation run and durable goal identity do not match');
  }
  if (goal.userIntentRevision !== run.basedOnUserIntentRevision) {
    throw new AutomationStateError(
      'conflict',
      'Durable goal user intent changed; automation must be reconciled or replanned',
    );
  }
}

function assertAuthority(
  run: AutomationRunSnapshot,
  goal: GoalSnapshot,
  authority: AutomationAuthorityCursor,
): void {
  if (
    run.basedOnGoalRevision !== authority.goalRevision
    || goal.revision !== authority.goalRevision
  ) {
    throw new AutomationStateError(
      'conflict',
      'Durable goal revision changed; reload automation and goal state before continuing',
    );
  }
  if (
    run.basedOnUserIntentRevision !== authority.userIntentRevision
    || goal.userIntentRevision !== authority.userIntentRevision
  ) {
    throw new AutomationStateError(
      'conflict',
      'Durable goal user intent changed; automation must be reconciled or replanned',
    );
  }
}

function progressStepUpdates(
  goal: GoalSnapshot,
  run: AutomationRunSnapshot,
): readonly GoalStepUpdate[] {
  if (run.currentMilestoneId === undefined) return [];
  const milestone = run.milestones.find((candidate) => candidate.id === run.currentMilestoneId);
  const step = goal.plan.steps.find((candidate) => candidate.id === run.currentMilestoneId);
  if (
    milestone === undefined
    || step === undefined
    || step.status === 'completed'
    || step.status === 'blocked'
    || step.status === 'in_progress'
  ) return [];
  return [{
    stepId: step.id,
    status: 'in_progress',
    summary: boundedStepSummary(`Automation executing: ${milestone.title}`),
  }];
}

function verifiedStepUpdates(
  goal: GoalSnapshot,
  milestoneId: string,
  milestoneTitle: string,
): readonly GoalStepUpdate[] {
  const step = goal.plan.steps.find((candidate) => candidate.id === milestoneId);
  if (step === undefined || step.status === 'completed' || step.status === 'blocked') return [];
  return [{
    stepId: step.id,
    status: 'completed',
    summary: boundedStepSummary(`Automation verified: ${milestoneTitle}`),
  }];
}

function finalStepUpdates(
  goal: GoalSnapshot,
  run: AutomationRunSnapshot,
): readonly GoalStepUpdate[] {
  const milestones = new Map(run.milestones.map((milestone) => [milestone.id, milestone]));
  return goal.plan.steps.flatMap((step) => {
    const milestone = milestones.get(step.id);
    if (
      milestone === undefined
      || milestone.status !== 'completed'
      || step.status === 'completed'
      || step.status === 'blocked'
    ) return [];
    return [{
      stepId: step.id,
      status: 'completed' as const,
      summary: boundedStepSummary(`Automation verified: ${milestone.title}`),
    }];
  });
}

function finalAcceptanceUpdates(
  goal: GoalSnapshot,
  completions: readonly AutomationAcceptanceCompletion[],
): readonly GoalAcceptanceUpdate[] {
  const byId = new Map(goal.acceptanceCriteria.map((criterion) => [criterion.id, criterion]));
  const seen = new Set<string>();
  return completions.map((completion) => {
    if (seen.has(completion.criterionId)) {
      throw new AutomationStateError('conflict', `Duplicate final acceptance criterion: ${completion.criterionId}`);
    }
    seen.add(completion.criterionId);
    if (!byId.has(completion.criterionId)) {
      throw new AutomationStateError('conflict', `Unknown final acceptance criterion: ${completion.criterionId}`);
    }
    if (completion.evidence.length === 0) {
      throw new AutomationStateError(
        'conflict',
        `Final acceptance criterion ${completion.criterionId} requires evidence`,
      );
    }
    return {
      criterionId: completion.criterionId,
      status: 'completed' as const,
      evidence: completion.evidence,
    };
  });
}

function assertProspectiveGoalCompletion(
  goal: GoalSnapshot,
  stepUpdates: readonly GoalStepUpdate[],
  acceptanceUpdates: readonly GoalAcceptanceUpdate[],
  trackedTasks: readonly GoalTrackedTask[],
): void {
  const completedSteps = new Set(stepUpdates.map((update) => update.stepId));
  const unfinishedSteps = goal.plan.steps.filter((step) => (
    step.status !== 'completed' && !completedSteps.has(step.id)
  ));
  if (unfinishedSteps.length > 0) {
    throw new AutomationStateError(
      'conflict',
      `Durable goal plan still has unfinished steps: ${unfinishedSteps.map((step) => step.id).join(', ')}`,
    );
  }

  const completedAcceptance = new Set(acceptanceUpdates.map((update) => update.criterionId));
  const unfinishedAcceptance = goal.acceptanceCriteria.filter((criterion) => (
    criterion.status !== 'completed' && !completedAcceptance.has(criterion.id)
  ));
  if (unfinishedAcceptance.length > 0) {
    throw new AutomationStateError(
      'conflict',
      `Durable goal acceptance criteria still need evidence: ${unfinishedAcceptance.map((criterion) => criterion.id).join(', ')}`,
    );
  }
  if (goal.blockers.length > 0) {
    throw new AutomationStateError('conflict', 'Durable goal blockers must be cleared before automation completion');
  }
  if (trackedTasks.some((task) => task.role === 'blocking_job')) {
    throw new AutomationStateError(
      'conflict',
      'Durable goal still has blocking tasks that must reach a trusted terminal state',
    );
  }
}

function assertGoalReadyNow(goal: GoalSnapshot): void {
  if (goal.status !== 'active') {
    throw new AutomationStateError('conflict', 'Durable goal changed terminal state before completion');
  }
  if (goal.plan.steps.some((step) => step.status !== 'completed')) {
    throw new AutomationStateError('conflict', 'Durable goal plan is not fully completed');
  }
  if (goal.acceptanceCriteria.some((criterion) => criterion.status !== 'completed')) {
    throw new AutomationStateError('conflict', 'Durable goal acceptance criteria are not fully completed');
  }
  if (goal.blockers.length > 0 || goal.activeTaskIds.length > 0) {
    throw new AutomationStateError('conflict', 'Durable goal has blockers or blocking tasks');
  }
}

function assertRunReadyForFinalization(run: AutomationRunSnapshot): void {
  if (run.status !== 'completing') {
    throw new AutomationStateError('conflict', 'Automation run is not in final completion state');
  }
  if (run.currentMilestoneId !== undefined || run.currentAttemptId !== undefined) {
    throw new AutomationStateError('corrupt', 'Completing automation run still has a current milestone or attempt');
  }
  const incomplete = run.milestones.filter((milestone) => milestone.status !== 'completed');
  if (incomplete.length > 0) {
    throw new AutomationStateError(
      'conflict',
      `Automation milestones are not fully completed: ${incomplete.map((milestone) => milestone.id).join(', ')}`,
    );
  }
  if (run.attempts.some((attempt) => attempt.status === 'dispatch_unresolved')) {
    throw new AutomationStateError('conflict', 'Automation still has an unresolved dispatch attempt');
  }
  if (run.dispatchReceipts.some((receipt) => (
    receipt.state === 'reserved' || receipt.state === 'dispatched_unresolved'
  ))) {
    throw new AutomationStateError('conflict', 'Automation still has an unresolved dispatch receipt');
  }
  const blocking = activeAutomationBindings(run).filter((binding) => binding.role === 'blocking_job');
  if (blocking.length > 0) {
    throw new AutomationStateError(
      'conflict',
      'Automation still has blocking tasks without trusted terminal observations',
    );
  }
}

function assertTerminalReadback(goal: GoalSnapshot, run: AutomationRunSnapshot): void {
  if (goal.status !== 'completed') {
    throw new AutomationStateError('conflict', 'Durable goal terminal readback did not confirm completed status');
  }
  if (goal.userIntentRevision !== run.basedOnUserIntentRevision) {
    throw new AutomationStateError('conflict', 'Durable goal intent changed before terminal readback');
  }
  if (
    goal.plan.steps.some((step) => step.status !== 'completed')
    || goal.acceptanceCriteria.some((criterion) => criterion.status !== 'completed')
    || goal.blockers.length > 0
    || goal.activeTaskIds.length > 0
  ) {
    throw new AutomationStateError('corrupt', 'Completed durable goal readback violates completion invariants');
  }
}

function mergeTrackedTasks(
  goal: GoalSnapshot,
  run: AutomationRunSnapshot,
): readonly GoalTrackedTask[] {
  const knownAutomationKeys = new Set(run.taskBindings.map(bindingKey));
  const preserved = goal.trackedTasks.filter((task) => !knownAutomationKeys.has(bindingKey(task)));
  const active = activeAutomationBindings(run).map((binding): GoalTrackedTask => ({
    taskId: binding.taskId,
    provider: binding.provider,
    role: binding.role,
    cancelWithGoal: binding.cancelWithGoal,
  }));
  const merged = new Map<string, GoalTrackedTask>();
  for (const task of [...preserved, ...active]) merged.set(bindingKey(task), task);
  return [...merged.values()];
}

function activeAutomationBindings(run: AutomationRunSnapshot): AutomationRunSnapshot['taskBindings'][number][] {
  return run.taskBindings.filter((binding) => (
    binding.lastState !== 'completed'
    && binding.lastState !== 'failed'
    && binding.lastState !== 'cancelled'
    && binding.lastState !== 'timed_out'
  ));
}

function bindingKey(binding: { readonly provider: string; readonly taskId: string }): string {
  return `${binding.provider}\0${binding.taskId}`;
}

function verificationMarker(runId: string, milestoneId: string, attemptId: string): string {
  return boundedEvidenceValue(
    `automation_verified:run=${runId};milestone=${milestoneId};attempt=${attemptId}`,
  );
}

function projectedVerificationEvidence(
  runId: string,
  milestoneId: string,
  attemptId: string,
  evidence: readonly GoalEvidence[],
): readonly GoalEvidence[] {
  const marker: GoalEvidence = {
    kind: 'note',
    value: verificationMarker(runId, milestoneId, attemptId),
  };
  return [
    marker,
    ...evidence.slice(0, MAX_GOAL_EVIDENCE - 1).map((entry) => ({
      kind: entry.kind,
      value: boundedEvidenceValue(entry.value),
    })),
  ];
}

function validateFinalReview(request: AutomationFinalizeRequest): void {
  if (request.finalReviewEvidence.length === 0) {
    throw new AutomationStateError('conflict', 'Automation finalization requires final review evidence');
  }
  if (request.finalReviewEvidence.length > MAX_GOAL_EVIDENCE) {
    throw new AutomationStateError('conflict', 'Automation final review evidence exceeds the durable goal limit');
  }
  for (const evidence of request.finalReviewEvidence) {
    if (evidence.value.trim().length === 0 || evidence.value.length > MAX_GOAL_EVIDENCE_VALUE) {
      throw new AutomationStateError('conflict', 'Automation final review evidence is invalid');
    }
  }
  if (request.summary.trim().length === 0 || request.summary.length > 2_048) {
    throw new AutomationStateError('conflict', 'Automation final summary is invalid');
  }
  if (request.acceptance.length > 50) {
    throw new AutomationStateError('conflict', 'Automation final acceptance update count is invalid');
  }
  for (const completion of request.acceptance) {
    if (completion.evidence.length > MAX_GOAL_EVIDENCE) {
      throw new AutomationStateError('conflict', 'Automation acceptance evidence exceeds the durable goal limit');
    }
    for (const evidence of completion.evidence) {
      if (evidence.value.trim().length === 0 || evidence.value.length > MAX_GOAL_EVIDENCE_VALUE) {
        throw new AutomationStateError('conflict', 'Automation acceptance evidence is invalid');
      }
    }
  }
}

function boundedPhase(value: string): string {
  return value.slice(0, 256);
}

function boundedSummary(value: string): string {
  return value.slice(0, 2_048);
}

function boundedStepSummary(value: string): string {
  return value.slice(0, 1_024);
}

function boundedEvidenceValue(value: string): string {
  return value.slice(0, MAX_GOAL_EVIDENCE_VALUE);
}
