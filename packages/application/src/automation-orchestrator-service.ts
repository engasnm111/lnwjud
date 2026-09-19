import { randomUUID } from 'node:crypto';
import {
  AutomationStateError,
  validateAutomationMilestoneGraph,
  type AutomationAttemptRecord,
  type AutomationEventWrite,
  type AutomationMilestoneRecord,
  type AutomationMilestoneSpec,
  type AutomationRepository,
  type AutomationRunSnapshot,
  type CreateAutomationRunRecordRequest,
  type GoalEvidence,
} from '@lnwjud/domain';

export interface AutomationAuthorityCursor {
  readonly goalRevision: number;
  readonly userIntentRevision: number;
}

export interface AutomationCreateRequest {
  readonly goalId: string;
  readonly workspaceId: string;
  readonly policyProfile: string;
  readonly authority: AutomationAuthorityCursor;
  readonly milestones: readonly AutomationMilestoneSpec[];
  readonly runId?: string;
}

export interface AutomationMutationRequest {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly authority: AutomationAuthorityCursor;
}

export interface AutomationCompleteMilestoneRequest extends AutomationMutationRequest {
  readonly evidence?: readonly GoalEvidence[];
}

export interface AutomationFailAttemptRequest extends AutomationMutationRequest {
  readonly failureCode: string;
  readonly failureDetail?: string;
  readonly retryable: boolean;
}

export interface AutomationOrchestratorServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}
export interface AutomationDagProjection {
  readonly order: readonly string[];
  readonly newlyReady: readonly string[];
  readonly newlyBlocked: readonly string[];
  readonly selectedMilestoneId?: string;
  readonly allCompleted: boolean;
  readonly hasTerminalFailure: boolean;
}

/**
 * Durable orchestration state machine. M2 deliberately performs no workspace
 * mutation and starts no background process: later execution layers attach
 * real dispatch/task evidence to the attempt selected here.
 */
export class AutomationOrchestratorService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  public constructor(
    private readonly repository: AutomationRepository,
    options: AutomationOrchestratorServiceOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  public async create(request: AutomationCreateRequest): Promise<AutomationRunSnapshot> {
    validateAuthority(request.authority);
    validateAutomationMilestoneGraph(request.milestones);
    const existing = await this.repository.getRunByGoalId(request.goalId);
    if (existing !== null) {
      assertCreateMatchesExisting(existing, request);
      return existing;
    }

    const now = this.now().toISOString();
    const record: CreateAutomationRunRecordRequest = {
      runId: request.runId ?? this.idFactory(),
      goalId: request.goalId,
      workspaceId: request.workspaceId,
      policyProfile: request.policyProfile,
      basedOnGoalRevision: request.authority.goalRevision,
      basedOnUserIntentRevision: request.authority.userIntentRevision,
      milestones: request.milestones,
      createdAt: now,
      eventId: this.idFactory(),
    };
    try {
      return await this.repository.createRun(record);
    } catch (error) {
      if (error instanceof AutomationStateError && error.reason === 'conflict') {
        const raced = await this.repository.getRunByGoalId(request.goalId);
        if (raced !== null) {
          assertCreateMatchesExisting(raced, request);
          return raced;
        }
      }
      throw error;
    }
  }

  public async get(runId: string): Promise<AutomationRunSnapshot> {
    return requireRun(await this.repository.getRunById(runId));
  }
  public async pause(request: AutomationMutationRequest): Promise<AutomationRunSnapshot> {
    validateMutationRequest(request);
    const snapshot = await this.loadExpected(request);
    if (isTerminalRun(snapshot.status)) {
      throw new AutomationStateError('conflict', 'Automation run is already terminal');
    }
    if (snapshot.status === 'paused') return snapshot;
    return this.repository.commitTransition({
      runId: snapshot.id,
      expectedRevision: snapshot.revision,
      runPatch: {
        status: 'paused',
        basedOnGoalRevision: request.authority.goalRevision,
        basedOnUserIntentRevision: request.authority.userIntentRevision,
      },
      event: {
        id: this.idFactory(),
        ...(snapshot.currentMilestoneId === undefined ? {} : { milestoneId: snapshot.currentMilestoneId }),
        ...(snapshot.currentAttemptId === undefined ? {} : { attemptId: snapshot.currentAttemptId }),
        type: 'run_paused',
        reason: 'automation_paused',
      },
      now: this.now().toISOString(),
    });
  }

  public async resume(request: AutomationMutationRequest): Promise<AutomationRunSnapshot> {
    validateMutationRequest(request);
    const snapshot = await this.loadExpected(request);
    if (snapshot.status !== 'paused') {
      throw new AutomationStateError('conflict', 'Automation run is not paused');
    }
    const status = resumableRunStatus(snapshot);
    return this.repository.commitTransition({
      runId: snapshot.id,
      expectedRevision: snapshot.revision,
      runPatch: {
        status,
        basedOnGoalRevision: request.authority.goalRevision,
        basedOnUserIntentRevision: request.authority.userIntentRevision,
      },
      event: {
        id: this.idFactory(),
        ...(snapshot.currentMilestoneId === undefined ? {} : { milestoneId: snapshot.currentMilestoneId }),
        ...(snapshot.currentAttemptId === undefined ? {} : { attemptId: snapshot.currentAttemptId }),
        type: 'run_resumed',
        reason: 'automation_resumed',
        metadata: { resumedStatus: status },
      },
      now: this.now().toISOString(),
    });
  }

  public async advance(request: AutomationMutationRequest): Promise<AutomationRunSnapshot> {
    validateMutationRequest(request);
    const snapshot = await this.loadExpected(request);
    if (isTerminalRun(snapshot.status) || snapshot.status === 'paused') return snapshot;
    if (snapshot.currentAttemptId !== undefined) return snapshot;

    const current = currentMilestone(snapshot);
    if (
      current !== undefined
      && (current.status === 'ready' || current.status === 'retry_ready')
    ) {
      return snapshot;
    }

    const projection = projectDag(snapshot);
    if (
      projection.newlyReady.length === 0
      && projection.newlyBlocked.length === 0
      && projection.selectedMilestoneId === undefined
      && !projection.allCompleted
      && !projection.hasTerminalFailure
    ) {
      throw new AutomationStateError(
        'conflict',
        'Automation has no runnable milestone and no deterministic readiness transition',
      );
    }

    const milestoneUpdates = [
      ...projection.newlyReady.map((milestoneId) => ({
        milestoneId,
        status: 'ready' as const,
      })),
      ...projection.newlyBlocked.map((milestoneId) => ({
        milestoneId,
        status: 'blocked' as const,
      })),
    ];

    if (projection.allCompleted) {
      return this.repository.commitTransition({
        runId: snapshot.id,
        expectedRevision: snapshot.revision,
        runPatch: {
          status: 'completing',
          basedOnGoalRevision: request.authority.goalRevision,
          basedOnUserIntentRevision: request.authority.userIntentRevision,
          currentMilestoneId: null,
          currentAttemptId: null,
        },
        ...(milestoneUpdates.length === 0 ? {} : { milestoneUpdates }),
        event: {
          id: this.idFactory(),
          type: 'run_completing',
          reason: 'all_milestones_completed',
          metadata: { milestoneCount: snapshot.milestones.length },
        },
        additionalEvents: projectionTransitionEvents(projection, this.idFactory),
        now: this.now().toISOString(),
      });
    }
    if (projection.selectedMilestoneId !== undefined) {
      return this.repository.commitTransition({
        runId: snapshot.id,
        expectedRevision: snapshot.revision,
        runPatch: {
          status: 'running',
          basedOnGoalRevision: request.authority.goalRevision,
          basedOnUserIntentRevision: request.authority.userIntentRevision,
          currentMilestoneId: projection.selectedMilestoneId,
          currentAttemptId: null,
        },
        ...(milestoneUpdates.length === 0 ? {} : { milestoneUpdates }),
        event: {
          id: this.idFactory(),
          milestoneId: projection.selectedMilestoneId,
          type: 'milestone_ready',
          reason: 'deterministic_dag_selection',
          metadata: {
            selectedMilestoneId: projection.selectedMilestoneId,
            readyCount: countReadyAfterProjection(snapshot, projection),
          },
        },
        additionalEvents: projectionTransitionEvents(
          projection,
          this.idFactory,
          projection.selectedMilestoneId,
        ),
        now: this.now().toISOString(),
      });
    }

    const blockedId = projection.newlyBlocked[0];
    const transitionNow = this.now().toISOString();
    return this.repository.commitTransition({
      runId: snapshot.id,
      expectedRevision: snapshot.revision,
      runPatch: {
        status: projection.hasTerminalFailure ? 'failed' : 'blocked',
        basedOnGoalRevision: request.authority.goalRevision,
        basedOnUserIntentRevision: request.authority.userIntentRevision,
        currentMilestoneId: null,
        currentAttemptId: null,
        ...(projection.hasTerminalFailure ? { terminalAt: transitionNow } : {}),
      },
      ...(milestoneUpdates.length === 0 ? {} : { milestoneUpdates }),
      event: {
        id: this.idFactory(),
        ...(blockedId === undefined ? {} : { milestoneId: blockedId }),
        type: projection.hasTerminalFailure ? 'run_terminal' : 'milestone_blocked',
        reason: projection.hasTerminalFailure
          ? 'dependency_failure_exhausted'
          : 'dependency_blocked',
        metadata: {
          blockedCount: projection.newlyBlocked.length,
        },
      },
      additionalEvents: projectionTransitionEvents(
        projection,
        this.idFactory,
        projection.hasTerminalFailure ? undefined : blockedId,
      ),
      now: transitionNow,
    });
  }
  public async startCurrentAttempt(
    request: AutomationMutationRequest,
  ): Promise<AutomationRunSnapshot> {
    validateMutationRequest(request);
    const snapshot = await this.loadExpected(request);
    assertRunnableRun(snapshot);
    if (snapshot.status !== 'running') {
      throw new AutomationStateError('conflict', 'Automation run is not ready to start an attempt');
    }

    const milestone = currentMilestone(snapshot);
    if (
      milestone === undefined
      || (milestone.status !== 'ready' && milestone.status !== 'retry_ready')
    ) {
      throw new AutomationStateError(
        'conflict',
        'Automation current milestone is not ready for a new attempt',
      );
    }
    if (snapshot.currentAttemptId !== undefined) {
      throw new AutomationStateError('conflict', 'Automation already has a current attempt');
    }

    const attemptId = this.idFactory();
    const now = this.now().toISOString();
    return this.repository.commitTransition({
      runId: snapshot.id,
      expectedRevision: snapshot.revision,
      runPatch: {
        status: 'running',
        basedOnGoalRevision: request.authority.goalRevision,
        basedOnUserIntentRevision: request.authority.userIntentRevision,
        currentMilestoneId: milestone.id,
        currentAttemptId: attemptId,
      },
      milestoneUpdates: [{
        milestoneId: milestone.id,
        status: 'running',
        currentAttemptId: attemptId,
      }],
      // `dispatching` means the attempt is durably selected for a dispatcher;
      // this transition itself does not execute an external side effect.
      createAttempt: {
        attemptId,
        milestoneId: milestone.id,
        basedOnGoalRevision: request.authority.goalRevision,
        basedOnUserIntentRevision: request.authority.userIntentRevision,
        status: 'dispatching',
        startedAt: now,
      },
      event: {
        id: this.idFactory(),
        milestoneId: milestone.id,
        attemptId,
        type: 'attempt_started',
        reason: milestone.status === 'retry_ready' ? 'retry_attempt_started' : 'attempt_started',
        metadata: {
          milestoneId: milestone.id,
          priorAttemptCount: attemptsFor(snapshot, milestone.id).length,
        },
      },
      now,
    });
  }
  public async beginVerification(
    request: AutomationMutationRequest,
  ): Promise<AutomationRunSnapshot> {
    validateMutationRequest(request);
    const snapshot = await this.loadExpected(request);
    assertRunnableRun(snapshot);
    if (snapshot.status !== 'running' && snapshot.status !== 'waiting_task') {
      throw new AutomationStateError('conflict', 'Automation run cannot enter verification from its current state');
    }
    const { milestone, attempt } = requireCurrentAttempt(snapshot);
    if (
      (milestone.status !== 'running' && milestone.status !== 'waiting_task')
      || (attempt.status !== 'dispatching' && attempt.status !== 'waiting_task')
    ) {
      throw new AutomationStateError(
        'conflict',
        'Automation attempt cannot enter verification from its current state',
      );
    }

    const now = this.now().toISOString();
    return this.repository.commitTransition({
      runId: snapshot.id,
      expectedRevision: snapshot.revision,
      runPatch: {
        status: 'verifying',
        basedOnGoalRevision: request.authority.goalRevision,
        basedOnUserIntentRevision: request.authority.userIntentRevision,
      },
      milestoneUpdates: [{
        milestoneId: milestone.id,
        status: 'verifying',
        currentAttemptId: attempt.id,
      }],
      attemptUpdates: [{
        attemptId: attempt.id,
        status: 'verifying',
      }],
      event: {
        id: this.idFactory(),
        milestoneId: milestone.id,
        attemptId: attempt.id,
        type: 'verification_started',
        reason: 'execution_ready_for_verification',
      },
      now,
    });
  }

  public async completeCurrentMilestone(
    request: AutomationCompleteMilestoneRequest,
  ): Promise<AutomationRunSnapshot> {
    validateMutationRequest(request);
    const snapshot = await this.loadExpected(request);
    assertRunnableRun(snapshot);
    if (snapshot.status !== 'verifying') {
      throw new AutomationStateError('conflict', 'Automation run is not in verification');
    }
    const { milestone, attempt } = requireCurrentAttempt(snapshot);
    if (attempt.status !== 'verifying' || milestone.status !== 'verifying') {
      throw new AutomationStateError(
        'conflict',
        'Automation milestone can only complete after verification has started',
      );
    }
    const evidence = request.evidence ?? [];
    const projected = withProjectedCompletion(snapshot, milestone.id);
    const projection = projectDag(projected);
    const milestoneUpdates = [
      {
        milestoneId: milestone.id,
        status: 'completed' as const,
        currentAttemptId: null,
      },
      ...projection.newlyReady.map((milestoneId) => ({
        milestoneId,
        status: 'ready' as const,
      })),
      ...projection.newlyBlocked.map((milestoneId) => ({
        milestoneId,
        status: 'blocked' as const,
      })),
    ];
    const allCompleted = projection.allCompleted;
    const nextMilestoneId = projection.selectedMilestoneId;
    const terminalFailure = !allCompleted
      && nextMilestoneId === undefined
      && projection.hasTerminalFailure;
    const now = this.now().toISOString();

    return this.repository.commitTransition({
      runId: snapshot.id,
      expectedRevision: snapshot.revision,
      runPatch: {
        status: allCompleted
          ? 'completing'
          : nextMilestoneId !== undefined
            ? 'running'
            : terminalFailure ? 'failed' : 'blocked',
        basedOnGoalRevision: request.authority.goalRevision,
        basedOnUserIntentRevision: request.authority.userIntentRevision,
        currentMilestoneId: nextMilestoneId ?? null,
        currentAttemptId: null,
        ...(terminalFailure ? { terminalAt: now } : {}),
      },
      milestoneUpdates,
      attemptUpdates: [{
        attemptId: attempt.id,
        status: 'completed',
        verificationEvidence: evidence,
        finishedAt: now,
      }],
      event: {
        id: this.idFactory(),
        milestoneId: milestone.id,
        attemptId: attempt.id,
        type: 'milestone_completed',
        reason: 'verification_passed',
        metadata: {
          completedMilestoneId: milestone.id,
          nextMilestoneId: nextMilestoneId ?? null,
          allCompleted,
          terminalFailure,
          newlyReadyCount: projection.newlyReady.length,
        },
      },
      additionalEvents: [
        {
          id: this.idFactory(),
          milestoneId: milestone.id,
          attemptId: attempt.id,
          type: 'verification_passed',
          reason: 'verification_evidence_persisted',
          metadata: { evidenceCount: evidence.length },
        },
        ...(terminalFailure ? [{
          id: this.idFactory(),
          type: 'run_terminal' as const,
          reason: 'remaining_graph_contains_terminal_failure',
        }] : []),
        ...projectionTransitionEvents(projection, this.idFactory),
      ],
      now,
    });
  }
  public async failCurrentAttempt(
    request: AutomationFailAttemptRequest,
  ): Promise<AutomationRunSnapshot> {
    validateMutationRequest(request);
    if (request.failureCode.trim().length === 0 || request.failureCode.length > 256) {
      throw new AutomationStateError('conflict', 'Automation failure code is invalid');
    }
    if (request.failureDetail !== undefined && request.failureDetail.length > 2_048) {
      throw new AutomationStateError('conflict', 'Automation failure detail is too long');
    }

    const snapshot = await this.loadExpected(request);
    assertRunnableRun(snapshot);
    if (
      snapshot.status !== 'running'
      && snapshot.status !== 'waiting_task'
      && snapshot.status !== 'verifying'
    ) {
      throw new AutomationStateError('conflict', 'Automation run cannot fail an attempt from its current state');
    }
    const { milestone, attempt } = requireCurrentAttempt(snapshot);
    if (
      attempt.status !== 'dispatching'
      && attempt.status !== 'waiting_task'
      && attempt.status !== 'verifying'
    ) {
      throw new AutomationStateError(
        'conflict',
        'Automation attempt cannot fail from its current state',
      );
    }

    const attemptCount = attemptsFor(snapshot, milestone.id).length;
    const retryBudgetRemaining =
      request.retryable && attemptCount < milestone.retryPolicy.maxAttempts;
    const now = this.now().toISOString();

    if (retryBudgetRemaining) {
      return this.repository.commitTransition({
        runId: snapshot.id,
        expectedRevision: snapshot.revision,
        runPatch: {
          status: 'running',
          basedOnGoalRevision: request.authority.goalRevision,
          basedOnUserIntentRevision: request.authority.userIntentRevision,
          currentMilestoneId: milestone.id,
          currentAttemptId: null,
        },
        milestoneUpdates: [{
          milestoneId: milestone.id,
          status: 'retry_ready',
          currentAttemptId: null,
        }],
        attemptUpdates: [{
          attemptId: attempt.id,
          status: 'failed',
          failureCode: request.failureCode,
          failureDetail: request.failureDetail ?? null,
          finishedAt: now,
        }],
        event: {
          id: this.idFactory(),
          milestoneId: milestone.id,
          attemptId: attempt.id,
          type: 'attempt_failed',
          reason: 'retry_budget_available',
          metadata: {
            attemptCount,
            maxAttempts: milestone.retryPolicy.maxAttempts,
          },
        },
        additionalEvents: attempt.status === 'verifying' ? [{
          id: this.idFactory(),
          milestoneId: milestone.id,
          attemptId: attempt.id,
          type: 'verification_failed',
          reason: request.failureCode,
        }] : [],
        now,
      });
    }
    const projected = withProjectedFailure(snapshot, milestone.id);
    const projection = projectDag(projected);
    const milestoneUpdates = [
      {
        milestoneId: milestone.id,
        status: 'failed' as const,
        currentAttemptId: null,
      },
      ...projection.newlyBlocked.map((milestoneId) => ({
        milestoneId,
        status: 'blocked' as const,
      })),
    ];

    const nextMilestoneId = projection.selectedMilestoneId;
    const terminal = nextMilestoneId === undefined;
    return this.repository.commitTransition({
      runId: snapshot.id,
      expectedRevision: snapshot.revision,
      runPatch: {
        status: terminal ? 'failed' : 'running',
        basedOnGoalRevision: request.authority.goalRevision,
        basedOnUserIntentRevision: request.authority.userIntentRevision,
        currentMilestoneId: nextMilestoneId ?? null,
        currentAttemptId: null,
        ...(terminal ? { terminalAt: now } : {}),
      },
      milestoneUpdates,
      attemptUpdates: [{
        attemptId: attempt.id,
        status: 'failed',
        failureCode: request.failureCode,
        failureDetail: request.failureDetail ?? null,
        finishedAt: now,
      }],
      event: {
        id: this.idFactory(),
        milestoneId: milestone.id,
        attemptId: attempt.id,
        type: terminal ? 'run_terminal' : 'attempt_failed',
        reason: terminal
          ? request.retryable ? 'retry_budget_exhausted' : 'attempt_failure_not_retryable'
          : 'independent_milestone_remains_runnable',
        metadata: {
          attemptCount,
          maxAttempts: milestone.retryPolicy.maxAttempts,
          downstreamBlockedCount: projection.newlyBlocked.length,
          nextMilestoneId: nextMilestoneId ?? null,
        },
      },
      additionalEvents: [
        ...(attempt.status === 'verifying' ? [{
          id: this.idFactory(),
          milestoneId: milestone.id,
          attemptId: attempt.id,
          type: 'verification_failed' as const,
          reason: request.failureCode,
        }] : []),
        ...projectionTransitionEvents(projection, this.idFactory),
      ],
      now,
    });
  }

  private async loadExpected(
    request: AutomationMutationRequest,
  ): Promise<AutomationRunSnapshot> {
    const snapshot = requireRun(await this.repository.getRunById(request.runId));
    if (snapshot.revision !== request.expectedRevision) {
      throw new AutomationStateError(
        'conflict',
        'Automation run revision changed concurrently',
      );
    }
    if (snapshot.basedOnUserIntentRevision !== request.authority.userIntentRevision) {
      throw new AutomationStateError(
        'conflict',
        'Durable goal user intent changed; reconcile or replan the automation before continuing',
      );
    }
    return snapshot;
  }
}
export function deterministicMilestoneOrder(
  milestones: readonly AutomationMilestoneRecord[],
): readonly string[] {
  validateAutomationMilestoneGraph(milestones);
  const byId = new Map(milestones.map((milestone) => [milestone.id, milestone]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const milestone of milestones) {
    indegree.set(milestone.id, milestone.dependsOn.length);
    for (const dependencyId of milestone.dependsOn) {
      const list = dependents.get(dependencyId) ?? [];
      list.push(milestone.id);
      dependents.set(dependencyId, list);
    }
  }

  const byDeclaration = (left: string, right: string): number => {
    const leftMilestone = byId.get(left);
    const rightMilestone = byId.get(right);
    if (leftMilestone === undefined || rightMilestone === undefined) {
      throw new AutomationStateError('corrupt', 'Automation DAG order references a missing milestone');
    }
    const ordinalDifference = leftMilestone.ordinal - rightMilestone.ordinal;
    if (ordinalDifference !== 0) return ordinalDifference;
    return left < right ? -1 : left > right ? 1 : 0;
  };

  const queue = milestones
    .filter((milestone) => milestone.dependsOn.length === 0)
    .map((milestone) => milestone.id)
    .sort(byDeclaration);
  const order: string[] = [];
  while (queue.length > 0) {
    const milestoneId = queue.shift();
    if (milestoneId === undefined) break;
    order.push(milestoneId);
    const children = [...(dependents.get(milestoneId) ?? [])].sort(byDeclaration);
    for (const childId of children) {
      const remaining = (indegree.get(childId) ?? 0) - 1;
      indegree.set(childId, remaining);
      if (remaining === 0) {
        queue.push(childId);
        queue.sort(byDeclaration);
      }
    }
  }

  if (order.length !== milestones.length) {
    throw new AutomationStateError('invalid_graph', 'Automation milestone graph is not acyclic');
  }
  return order;
}
export function projectDag(snapshot: AutomationRunSnapshot): AutomationDagProjection {
  const order = deterministicMilestoneOrder(snapshot.milestones);
  const projectedStatus = new Map(
    snapshot.milestones.map((milestone) => [milestone.id, milestone.status]),
  );
  const newlyReady: string[] = [];
  const newlyBlocked: string[] = [];
  const byId = new Map(snapshot.milestones.map((milestone) => [milestone.id, milestone]));

  for (const milestoneId of order) {
    const milestone = byId.get(milestoneId);
    if (milestone === undefined) {
      throw new AutomationStateError('corrupt', 'Automation DAG projection lost a milestone');
    }
    const status = projectedStatus.get(milestoneId);
    if (status !== 'pending') continue;

    const dependencyStatuses = milestone.dependsOn.map((dependencyId) => {
      const dependencyStatus = projectedStatus.get(dependencyId);
      if (dependencyStatus === undefined) {
        throw new AutomationStateError('corrupt', 'Automation DAG projection lost a dependency');
      }
      return dependencyStatus;
    });

    if (dependencyStatuses.some((value) => value === 'failed' || value === 'blocked')) {
      projectedStatus.set(milestoneId, 'blocked');
      newlyBlocked.push(milestoneId);
      continue;
    }
    if (dependencyStatuses.every((value) => value === 'completed')) {
      projectedStatus.set(milestoneId, 'ready');
      newlyReady.push(milestoneId);
    }
  }

  const selectedMilestoneId = order.find((milestoneId) => {
    const status = projectedStatus.get(milestoneId);
    return status === 'ready' || status === 'retry_ready';
  });
  const allCompleted = order.every((milestoneId) => projectedStatus.get(milestoneId) === 'completed');
  const hasTerminalFailure = order.some((milestoneId) => projectedStatus.get(milestoneId) === 'failed');

  return {
    order,
    newlyReady,
    newlyBlocked,
    ...(selectedMilestoneId === undefined ? {} : { selectedMilestoneId }),
    allCompleted,
    hasTerminalFailure,
  };
}
function withProjectedCompletion(
  snapshot: AutomationRunSnapshot,
  milestoneId: string,
): AutomationRunSnapshot {
  return {
    ...snapshot,
    milestones: snapshot.milestones.map((milestone) => (
      milestone.id === milestoneId
        ? milestoneWithoutCurrentAttempt(milestone, 'completed')
        : milestone
    )),
  };
}

function withProjectedFailure(
  snapshot: AutomationRunSnapshot,
  milestoneId: string,
): AutomationRunSnapshot {
  return {
    ...snapshot,
    milestones: snapshot.milestones.map((milestone) => (
      milestone.id === milestoneId
        ? milestoneWithoutCurrentAttempt(milestone, 'failed')
        : milestone
    )),
  };
}

function projectionTransitionEvents(
  projection: AutomationDagProjection,
  idFactory: () => string,
  skipMilestoneId?: string,
): readonly AutomationEventWrite[] {
  const events: AutomationEventWrite[] = [];
  for (const milestoneId of projection.newlyReady) {
    if (milestoneId === skipMilestoneId) continue;
    events.push({
      id: idFactory(),
      milestoneId,
      type: 'milestone_ready',
      reason: 'dependencies_completed',
    });
  }
  for (const milestoneId of projection.newlyBlocked) {
    if (milestoneId === skipMilestoneId) continue;
    events.push({
      id: idFactory(),
      milestoneId,
      type: 'milestone_blocked',
      reason: 'dependency_failed_or_blocked',
    });
  }
  return events;
}

function milestoneWithoutCurrentAttempt(
  milestone: AutomationMilestoneRecord,
  status: 'completed' | 'failed',
): AutomationMilestoneRecord {
  const { currentAttemptId, ...rest } = milestone;
  if (currentAttemptId !== undefined && currentAttemptId.length === 0) {
    throw new AutomationStateError('corrupt', 'Automation current attempt id is empty');
  }
  return { ...rest, status };
}

function countReadyAfterProjection(
  snapshot: AutomationRunSnapshot,
  projection: AutomationDagProjection,
): number {
  const newlyReady = new Set(projection.newlyReady);
  return snapshot.milestones.filter((milestone) => (
    milestone.status === 'ready'
    || milestone.status === 'retry_ready'
    || newlyReady.has(milestone.id)
  )).length;
}

function currentMilestone(
  snapshot: AutomationRunSnapshot,
): AutomationMilestoneRecord | undefined {
  if (snapshot.currentMilestoneId === undefined) return undefined;
  const milestone = snapshot.milestones.find(
    (candidate) => candidate.id === snapshot.currentMilestoneId,
  );
  if (milestone === undefined) {
    throw new AutomationStateError('corrupt', 'Automation current milestone is missing');
  }
  return milestone;
}
function requireCurrentAttempt(snapshot: AutomationRunSnapshot): {
  readonly milestone: AutomationMilestoneRecord;
  readonly attempt: AutomationAttemptRecord;
} {
  const milestone = currentMilestone(snapshot);
  if (milestone === undefined || snapshot.currentAttemptId === undefined) {
    throw new AutomationStateError('conflict', 'Automation has no current attempt');
  }
  const attempt = snapshot.attempts.find(
    (candidate) => candidate.id === snapshot.currentAttemptId,
  );
  if (attempt === undefined) {
    throw new AutomationStateError('corrupt', 'Automation current attempt is missing');
  }
  if (attempt.milestoneId !== milestone.id) {
    throw new AutomationStateError(
      'corrupt',
      'Automation current attempt belongs to another milestone',
    );
  }
  return { milestone, attempt };
}

function attemptsFor(
  snapshot: AutomationRunSnapshot,
  milestoneId: string,
): readonly AutomationAttemptRecord[] {
  return snapshot.attempts
    .filter((attempt) => attempt.milestoneId === milestoneId)
    .sort((left, right) => left.sequence - right.sequence);
}

function assertCreateMatchesExisting(
  snapshot: AutomationRunSnapshot,
  request: AutomationCreateRequest,
): void {
  const sameDefinition =
    snapshot.workspaceId === request.workspaceId
    && snapshot.policyProfile === request.policyProfile
    && snapshot.milestones.length === request.milestones.length
    && snapshot.milestones.every((stored, index) => {
      const candidate = request.milestones[index];
      if (candidate === undefined) return false;
      return stored.id === candidate.id
        && stored.title === candidate.title
        && stored.executionIntent === candidate.executionIntent
        && JSON.stringify(stored.dependsOn) === JSON.stringify(candidate.dependsOn)
        && JSON.stringify(stored.verificationRequirements) === JSON.stringify(candidate.verificationRequirements)
        && JSON.stringify(stored.retryPolicy) === JSON.stringify(candidate.retryPolicy);
    });
  if (
    !sameDefinition
    || (request.runId !== undefined && request.runId !== snapshot.id)
  ) {
    throw new AutomationStateError(
      'conflict',
      'Existing automation run for this durable goal does not match the requested definition',
    );
  }
}

function resumableRunStatus(snapshot: AutomationRunSnapshot): AutomationRunSnapshot['status'] {
  if (snapshot.milestones.every((milestone) => milestone.status === 'completed')) return 'completing';
  if (snapshot.currentAttemptId !== undefined) {
    const attempt = snapshot.attempts.find((candidate) => candidate.id === snapshot.currentAttemptId);
    if (attempt === undefined) throw new AutomationStateError('corrupt', 'Automation current attempt is missing while resuming');
    if (attempt.status === 'waiting_task') return 'waiting_task';
    if (attempt.status === 'verifying') return 'verifying';
    if (attempt.status === 'dispatch_unresolved') return 'blocked';
    return 'running';
  }
  if (snapshot.currentMilestoneId !== undefined) {
    const milestone = snapshot.milestones.find((candidate) => candidate.id === snapshot.currentMilestoneId);
    if (milestone === undefined) throw new AutomationStateError('corrupt', 'Automation current milestone is missing while resuming');
    if (milestone.status === 'blocked') return 'blocked';
    if (milestone.status === 'verifying') return 'verifying';
    if (milestone.status === 'waiting_task') return 'waiting_task';
    return 'running';
  }
  return snapshot.milestones.some((milestone) => (
    milestone.status === 'ready'
    || milestone.status === 'retry_ready'
    || milestone.status === 'running'
  )) ? 'running' : 'planned';
}

function requireRun(
  snapshot: AutomationRunSnapshot | null,
): AutomationRunSnapshot {
  if (snapshot === null) {
    throw new AutomationStateError('not_found', 'Automation run was not found');
  }
  return snapshot;
}

function assertRunnableRun(snapshot: AutomationRunSnapshot): void {
  if (isTerminalRun(snapshot.status)) {
    throw new AutomationStateError('conflict', 'Automation run is already terminal');
  }
  if (snapshot.status === 'paused') {
    throw new AutomationStateError('conflict', 'Automation run is paused');
  }
  if (snapshot.status === 'completing') {
    throw new AutomationStateError(
      'conflict',
      'Automation run has completed all milestones and is awaiting final acceptance',
    );
  }
}
function isTerminalRun(status: AutomationRunSnapshot['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function validateMutationRequest(request: AutomationMutationRequest): void {
  if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 0) {
    throw new AutomationStateError('conflict', 'Automation expected revision is invalid');
  }
  validateAuthority(request.authority);
}

function validateAuthority(authority: AutomationAuthorityCursor): void {
  if (!Number.isInteger(authority.goalRevision) || authority.goalRevision < 0) {
    throw new AutomationStateError('conflict', 'Automation durable goal revision is invalid');
  }
  if (
    !Number.isInteger(authority.userIntentRevision)
    || authority.userIntentRevision < 0
  ) {
    throw new AutomationStateError(
      'conflict',
      'Automation durable user intent revision is invalid',
    );
  }
}
