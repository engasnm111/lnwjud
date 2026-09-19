import type { GoalEvidence, GoalTrackedTaskRole } from './goal-continuation.js';

export type AutomationRunStatus =
  | 'planned'
  | 'running'
  | 'waiting_task'
  | 'verifying'
  | 'paused'
  | 'blocked'
  | 'completing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AutomationMilestoneStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'waiting_task'
  | 'verifying'
  | 'retry_ready'
  | 'completed'
  | 'blocked'
  | 'failed';

export type AutomationAttemptStatus =
  | 'reserved'
  | 'dispatching'
  | 'waiting_task'
  | 'verifying'
  | 'dispatch_unresolved'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AutomationTaskProvider = 'process' | 'codex' | 'shell';

export type AutomationTaskObservedState =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'termination_unverified'
  | 'not_found'
  | 'unreachable';

export type AutomationRecoveryClass =
  | 'observation_timeout'
  | 'transport_interrupted'
  | 'dispatch_uncertain'
  | 'dispatch_absent'
  | 'task_deadline_exceeded'
  | 'task_failed'
  | 'task_cancelled'
  | 'task_timed_out'
  | 'task_missing'
  | 'termination_unverified';

export type AutomationRecoveryAction =
  | 'continue_observing'
  | 'enter_verification'
  | 'retry_attempt'
  | 'fail_attempt'
  | 'block_reconciliation'
  | 'cancel_and_reobserve';

export interface AutomationRecoveryDecision {
  readonly classification: AutomationRecoveryClass;
  readonly action: AutomationRecoveryAction;
  readonly retryable: boolean;
  readonly reason: string;
}

export type AutomationDispatchState =
  | 'reserved'
  | 'dispatched_unresolved'
  | 'confirmed'
  | 'failed'
  | 'cancelled';

export type AutomationRetryClass =
  | 'safe_read'
  | 'idempotent_local_state'
  | 'durable_task_observation'
  | 'workspace_mutation'
  | 'opaque_external_mutation'
  | 'destructive_operation';

export interface AutomationRetryPolicy {
  readonly classification: AutomationRetryClass;
  readonly maxAttempts: number;
}

export type AutomationVerificationKind = 'command' | 'evidence' | 'custom';
export interface AutomationVerificationRequirement {
  readonly id: string;
  readonly title: string;
  readonly kind: AutomationVerificationKind;
  readonly specification: string;
}

export interface AutomationMilestoneSpec {
  readonly id: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
  readonly executionIntent: string;
  readonly verificationRequirements: readonly AutomationVerificationRequirement[];
  readonly retryPolicy: AutomationRetryPolicy;
}

export type AutomationEventMetadataValue = string | number | boolean | null;
export type AutomationEventMetadata = Readonly<Record<string, AutomationEventMetadataValue>>;

export type AutomationEventType =
  | 'run_created'
  | 'milestone_ready'
  | 'attempt_started'
  | 'task_bound'
  | 'task_observed'
  | 'verification_started'
  | 'verification_passed'
  | 'verification_failed'
  | 'checkpoint_committed'
  | 'milestone_completed'
  | 'recovery_reconciled'
  | 'policy_denied'
  | 'run_paused'
  | 'run_resumed'
  | 'dispatch_recorded'
  | 'attempt_failed'
  | 'milestone_blocked'
  | 'run_completing'
  | 'dispatch_unresolved'
  | 'task_deadline_exceeded'
  | 'task_recovery_decision'
  | 'run_terminal';

export interface AutomationRunRecord {
  readonly id: string;
  readonly goalId: string;
  readonly workspaceId: string;
  readonly policyProfile: string;
  readonly revision: number;
  readonly status: AutomationRunStatus;
  readonly basedOnGoalRevision: number;
  readonly basedOnUserIntentRevision: number;
  readonly currentMilestoneId?: string;
  readonly currentAttemptId?: string;
  readonly lastRecoveryDecision?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt?: string;
}

export interface AutomationMilestoneRecord extends AutomationMilestoneSpec {
  readonly runId: string;
  readonly ordinal: number;
  readonly status: AutomationMilestoneStatus;
  readonly currentAttemptId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutomationAttemptRecord {
  readonly id: string;
  readonly runId: string;
  readonly milestoneId: string;
  readonly sequence: number;
  readonly basedOnRunRevision: number;
  readonly basedOnGoalRevision: number;
  readonly basedOnUserIntentRevision: number;
  readonly status: AutomationAttemptStatus;
  readonly failureCode?: string;
  readonly failureDetail?: string;
  readonly verificationEvidence: readonly GoalEvidence[];
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly finishedAt?: string;
}

export interface AutomationTaskBindingRecord {
  readonly attemptId: string;
  readonly provider: AutomationTaskProvider;
  readonly taskId: string;
  readonly role: GoalTrackedTaskRole;
  readonly cancelWithGoal: boolean;
  readonly boundAt: string;
  readonly deadlineAt?: string;
  readonly lastObservedAt?: string;
  readonly lastState?: AutomationTaskObservedState;
  readonly lastDetail?: string;
  readonly terminalAt?: string;
}
export interface AutomationDispatchReceiptRecord {
  readonly id: string;
  readonly runId: string;
  readonly milestoneId: string;
  readonly attemptId: string;
  readonly operationKey: string;
  readonly state: AutomationDispatchState;
  readonly provider?: AutomationTaskProvider;
  readonly idempotencyKey?: string;
  readonly externalId?: string;
  readonly deadlineAt?: string;
  readonly detail?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutomationEventRecord {
  readonly id: string;
  readonly runId: string;
  readonly milestoneId?: string;
  readonly attemptId?: string;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly type: AutomationEventType;
  readonly reason: string;
  readonly metadata: AutomationEventMetadata;
  readonly createdAt: string;
}

export interface AutomationRunSnapshot extends AutomationRunRecord {
  readonly milestones: readonly AutomationMilestoneRecord[];
  readonly attempts: readonly AutomationAttemptRecord[];
  readonly taskBindings: readonly AutomationTaskBindingRecord[];
  readonly dispatchReceipts: readonly AutomationDispatchReceiptRecord[];
}

export interface CreateAutomationRunRecordRequest {
  readonly runId: string;
  readonly goalId: string;
  readonly workspaceId: string;
  readonly policyProfile: string;
  readonly basedOnGoalRevision: number;
  readonly basedOnUserIntentRevision: number;
  readonly milestones: readonly AutomationMilestoneSpec[];
  readonly createdAt: string;
  readonly eventId: string;
}

export interface AutomationRunPatch {
  readonly status?: AutomationRunStatus;
  readonly basedOnGoalRevision?: number;
  readonly basedOnUserIntentRevision?: number;
  readonly currentMilestoneId?: string | null;
  readonly currentAttemptId?: string | null;
  readonly lastRecoveryDecision?: string | null;
  readonly terminalAt?: string | null;
}

export interface AutomationMilestoneUpdate {
  readonly milestoneId: string;
  readonly status: AutomationMilestoneStatus;
  readonly currentAttemptId?: string | null;
}
export interface AutomationAttemptCreate {
  readonly attemptId: string;
  readonly milestoneId: string;
  readonly basedOnGoalRevision: number;
  readonly basedOnUserIntentRevision: number;
  readonly status: AutomationAttemptStatus;
  readonly startedAt: string;
}

export interface AutomationAttemptUpdate {
  readonly attemptId: string;
  readonly status: AutomationAttemptStatus;
  readonly failureCode?: string | null;
  readonly failureDetail?: string | null;
  readonly verificationEvidence?: readonly GoalEvidence[];
  readonly finishedAt?: string | null;
}

export interface AutomationTaskBindingWrite {
  readonly attemptId: string;
  readonly provider: AutomationTaskProvider;
  readonly taskId: string;
  readonly role: GoalTrackedTaskRole;
  readonly cancelWithGoal: boolean;
  readonly boundAt: string;
  readonly deadlineAt?: string | null;
}

export interface AutomationTaskObservationUpdate {
  readonly attemptId: string;
  readonly provider: AutomationTaskProvider;
  readonly taskId: string;
  readonly state: AutomationTaskObservedState;
  readonly observedAt: string;
  readonly detail?: string | null;
  readonly terminalAt?: string | null;
}

export interface AutomationDispatchReceiptWrite {
  readonly id: string;
  readonly milestoneId: string;
  readonly attemptId: string;
  readonly operationKey: string;
  readonly state: AutomationDispatchState;
  readonly provider?: AutomationTaskProvider;
  readonly idempotencyKey?: string | null;
  readonly externalId?: string | null;
  readonly deadlineAt?: string;
  readonly detail?: string | null;
}

export interface AutomationEventWrite {
  readonly id: string;
  readonly milestoneId?: string;
  readonly attemptId?: string;
  readonly type: AutomationEventType;
  readonly reason: string;
  readonly metadata?: AutomationEventMetadata;
}

export interface CommitAutomationTransitionRequest {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly runPatch?: AutomationRunPatch;
  readonly milestoneUpdates?: readonly AutomationMilestoneUpdate[];
  readonly createAttempt?: AutomationAttemptCreate;
  readonly attemptUpdates?: readonly AutomationAttemptUpdate[];
  readonly taskBindings?: readonly AutomationTaskBindingWrite[];
  readonly taskObservationUpdates?: readonly AutomationTaskObservationUpdate[];
  readonly dispatchReceipts?: readonly AutomationDispatchReceiptWrite[];
  readonly event: AutomationEventWrite;
  readonly additionalEvents?: readonly AutomationEventWrite[];
  readonly now: string;
}

export interface AutomationRepository {
  createRun(request: CreateAutomationRunRecordRequest): Promise<AutomationRunSnapshot>;
  getRunById(runId: string): Promise<AutomationRunSnapshot | null>;
  getRunByGoalId(goalId: string): Promise<AutomationRunSnapshot | null>;
  listRuns(limit: number): Promise<readonly AutomationRunSnapshot[]>;
  commitTransition(request: CommitAutomationTransitionRequest): Promise<AutomationRunSnapshot>;
  listEvents(runId: string, limit: number): Promise<readonly AutomationEventRecord[]>;
}

export type AutomationStateFailureCode =
  | 'not_found'
  | 'conflict'
  | 'invalid_graph'
  | 'corrupt';

export class AutomationStateError extends Error {
  public constructor(
    public readonly reason: AutomationStateFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'AutomationStateError';
  }
}

export function validateAutomationMilestoneGraph(
  milestones: readonly AutomationMilestoneSpec[],
): void {
  if (milestones.length === 0) {
    throw new AutomationStateError('invalid_graph', 'Automation requires at least one milestone');
  }
  const byId = new Map<string, AutomationMilestoneSpec>();
  for (const milestone of milestones) {
    if (byId.has(milestone.id)) {
      throw new AutomationStateError('invalid_graph', `Duplicate automation milestone id: ${milestone.id}`);
    }
    byId.set(milestone.id, milestone);
  }

  for (const milestone of milestones) {
    const seenDependencies = new Set<string>();
    for (const dependencyId of milestone.dependsOn) {
      if (dependencyId === milestone.id) {
        throw new AutomationStateError('invalid_graph', `Automation milestone ${milestone.id} cannot depend on itself`);
      }
      if (!byId.has(dependencyId)) {
        throw new AutomationStateError('invalid_graph', `Automation milestone ${milestone.id} depends on missing milestone ${dependencyId}`);
      }
      if (seenDependencies.has(dependencyId)) {
        throw new AutomationStateError('invalid_graph', `Automation milestone ${milestone.id} has duplicate dependency ${dependencyId}`);
      }
      seenDependencies.add(dependencyId);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (milestoneId: string): void => {
    if (visited.has(milestoneId)) return;
    if (visiting.has(milestoneId)) {
      throw new AutomationStateError('invalid_graph', `Automation milestone graph contains a cycle at ${milestoneId}`);
    }
    visiting.add(milestoneId);
    const milestone = byId.get(milestoneId);
    if (milestone === undefined) {
      throw new AutomationStateError('corrupt', `Automation milestone disappeared during graph validation: ${milestoneId}`);
    }
    for (const dependencyId of milestone.dependsOn) visit(dependencyId);
    visiting.delete(milestoneId);
    visited.add(milestoneId);
  };

  for (const milestone of milestones) visit(milestone.id);
}
