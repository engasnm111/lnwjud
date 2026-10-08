import type { EngineeringGoalMetadata } from './engineering.js';
import type { StoredWorkflowMetadata } from './workflow.js';

export type GoalStatus = 'active' | 'completed' | 'failed' | 'blocked' | 'cancelled';
export type GoalTerminalStatus = 'completed' | 'failed' | 'blocked';
export type GoalStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';
export type GoalEvidenceKind = 'path' | 'hash' | 'task' | 'note';
export type GoalPonytailMode = 'off' | 'lite' | 'full' | 'ultra';

export type GoalTaskProvider = 'process' | 'codex' | 'shell' | 'legacy_auto';
export type GoalTrackedTaskRole = 'blocking_job' | 'supporting_service';

/**
 * A task binding is goal-relative: the same host task may be a shared service
 * for one goal and a goal-owned cancellation target for another.
 * `legacy_auto` is decode-only for pre-structured activeTaskIds rows.
 */
export type GoalTrackedTask =
  | {
      readonly taskId: string;
      readonly provider: 'process' | 'codex' | 'shell';
      readonly role: GoalTrackedTaskRole;
      readonly cancelWithGoal: boolean;
    }
  | {
      readonly taskId: string;
      readonly provider: 'legacy_auto';
      readonly role: 'blocking_job';
      readonly cancelWithGoal: true;
    };

export type GoalTaskCancellationState = 'cancelled' | 'already_terminal' | 'not_found' | 'termination_unverified';

export interface GoalTaskCancellationObservation {
  readonly matched: boolean;
  readonly state: GoalTaskCancellationState;
  readonly detail?: string;
}

export interface GoalPlanStep {
  readonly id: string;
  readonly title: string;
  readonly status: GoalStepStatus;
  readonly summary?: string;
}

export interface GoalPlan {
  readonly steps: readonly GoalPlanStep[];
}

export interface GoalStepUpdate {
  readonly stepId: string;
  readonly status: GoalStepStatus;
  readonly summary?: string;
}

export interface GoalEvidence {
  readonly kind: GoalEvidenceKind;
  readonly value: string;
}

export type GoalCommandStatus = 'passed' | 'failed' | 'running';

export interface GoalCommandRecord {
  readonly command: string;
  readonly status: GoalCommandStatus;
  readonly exitCode?: number | undefined;
  readonly result?: string | undefined;
}

/**
 * Reconstruction-grade state persisted atomically with a milestone checkpoint.
 * It complements the short summary with the concrete facts a new worker needs
 * to continue without guessing or redoing already-settled work.
 */
export interface GoalCheckpointResumeContext {
  readonly changedFiles: readonly string[];
  readonly commands: readonly GoalCommandRecord[];
  readonly decisions: readonly string[];
  readonly failedAttempts: readonly string[];
  readonly pendingValidation: readonly string[];
  readonly resumePrerequisites: readonly string[];
  readonly stateFacts: readonly GoalEvidence[];
  readonly artifacts: readonly GoalEvidence[];
}

export type GoalAcceptanceStatus = 'pending' | 'completed' | 'blocked';

export interface GoalAcceptanceCriterion {
  readonly id: string;
  readonly title: string;
  readonly status: GoalAcceptanceStatus;
  readonly evidence?: readonly GoalEvidence[];
}

export type GoalIterationMode = 'outcome' | 'iterate';

export interface GoalIterationPolicy {
  readonly mode: GoalIterationMode;
  readonly maxIterations: number;
  readonly currentIteration: number;
  readonly stopOnNoNewEvidence: boolean;
}

export interface GoalContextCapsulePayload {
  readonly objective: string;
  readonly userSteering: readonly string[];
  readonly currentPhase: string;
  readonly plan: GoalPlan;
  readonly acceptanceCriteria: readonly GoalAcceptanceCriterion[];
  readonly completedWork: readonly string[];
  readonly remainingWork: readonly string[];
  readonly decisions: readonly string[];
  readonly validation: readonly GoalEvidence[];
  readonly changedFiles: readonly string[];
  readonly artifacts: readonly GoalEvidence[];
  readonly blockers: readonly string[];
  readonly nextAction: string;
}

export interface GoalContextCapsuleRecord {
  readonly id: string;
  readonly goalId: string;
  readonly sourceGoalRevision: number;
  readonly sourceUserIntentRevision: number;
  readonly previousCapsuleId?: string;
  readonly payload: GoalContextCapsulePayload;
  readonly createdAt: string;
}

export type GoalDeliveryState = 'reserved' | 'attempted_unresolved' | 'dispatched_unresolved' | 'host_confirmed' | 'completed' | 'cancelled' | 'retired';

export interface GoalDeliveryReceipt {
  readonly id: string;
  readonly goalId: string;
  readonly channel: string;
  readonly state: GoalDeliveryState;
  readonly basedOnUserIntentRevision: number;
  readonly externalId?: string;
  readonly detail?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GoalLeaseProof {
  readonly goalId: string;
  readonly leaseToken: string;
  readonly leaseGeneration: number;
}

export interface GoalCheckpointRecord {
  readonly id: string;
  readonly goalId: string;
  readonly revision: number;
  readonly currentPhase: string;
  readonly summary: string;
  readonly stepUpdates: readonly GoalStepUpdate[];
  readonly nextAction: string;
  readonly blockers: readonly string[];
  readonly evidence: readonly GoalEvidence[];
  readonly activeTaskIds: readonly string[];
  readonly trackedTasks?: readonly GoalTrackedTask[];
  readonly resumeContext?: GoalCheckpointResumeContext;
  readonly createdAt: string;
}

/** Authoritative durable aggregate. Raw lease tokens are never stored here. */
export interface GoalRecord {
  readonly id: string;
  readonly goalKey: string;
  readonly workspaceId: string;
  readonly ownerClientId: string;
  readonly objective: string;
  readonly plan: GoalPlan;
  readonly acceptanceCriteria: readonly GoalAcceptanceCriterion[];
  readonly userIntentRevision: number;
  readonly iterationPolicy: GoalIterationPolicy;
  readonly engineering?: EngineeringGoalMetadata;
  readonly workflow?: StoredWorkflowMetadata;
  readonly currentContextCapsuleId?: string;
  readonly status: GoalStatus;
  readonly revision: number;
  readonly currentPhase: string;
  readonly nextAction: string;
  readonly blockers: readonly string[];
  readonly activeTaskIds: readonly string[];
  readonly trackedTasks?: readonly GoalTrackedTask[];
  readonly ponytailMode?: GoalPonytailMode;
  readonly leaseOwnerClientId?: string;
  readonly leaseOwnerSessionId?: string;
  readonly leaseTokenHash?: string;
  readonly leaseDurationSeconds?: number;
  readonly leaseGeneration: number;
  readonly leaseActivitySeq: number;
  readonly leaseHeartbeatAt?: string;
  readonly leaseExpiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalSummary?: string;
  readonly terminalEvidence?: readonly GoalEvidence[];
  readonly terminalAt?: string;
  readonly checkpoints: readonly GoalCheckpointRecord[];
}

export type GoalStateFailureCode =
  | 'not_found'
  | 'owner_mismatch'
  | 'conflict'
  | 'precondition'
  | 'lease_invalid'
  | 'terminal'
  | 'corrupt';

export class GoalStateError extends Error {
  public constructor(public readonly reason: GoalStateFailureCode, message: string) {
    super(message);
    this.name = 'GoalStateError';
  }
}

export interface GoalLeaseRecoveryEvidence {
  readonly trustworthy: boolean;
  readonly observedAt: string;
  readonly leaseGeneration: number;
  readonly leaseActivitySeq: number;
  readonly liveFencedCallCount: number;
  readonly blockingTaskStates: readonly {
    readonly taskId: string;
    readonly provider: GoalTaskProvider;
    readonly state: 'running' | 'terminal' | 'absent' | 'unknown';
  }[];
}

export interface AcquireGoalRecordRequest {
  readonly goalId: string;
  readonly workspaceId: string;
  readonly goalKey: string;
  readonly ownerClientId: string;
  readonly ownerSessionId: string;
  readonly objective?: string;
  readonly plan?: GoalPlan;
  readonly acceptanceCriteria?: readonly GoalAcceptanceCriterion[];
  readonly iterationPolicy?: GoalIterationPolicy;
  readonly engineering?: EngineeringGoalMetadata;
  readonly workflow?: StoredWorkflowMetadata;
  readonly ponytailMode?: GoalPonytailMode;
  readonly leaseTokenHash: string;
  readonly leaseSeconds: number;
  readonly recoveryEvidence?: GoalLeaseRecoveryEvidence;
  readonly now: string;
}

export interface AcquireGoalRecordResult {
  readonly goal: GoalRecord;
  readonly acquired: boolean;
  readonly retryAfterSeconds?: number;
  readonly leaseRecovery?: 'stale_worker_recovered';
}

export interface CheckpointGoalRecordRequest {
  readonly checkpointId: string;
  readonly goalId: string;
  readonly ownerClientId: string;
  readonly ownerSessionId: string;
  readonly leaseTokenHash: string;
  readonly expectedRevision: number;
  readonly expectedUserIntentRevision?: number;
  readonly plan: GoalPlan;
  readonly acceptanceCriteria?: readonly GoalAcceptanceCriterion[];
  readonly userIntentRevision?: number;
  readonly iterationPolicy?: GoalIterationPolicy;
  readonly engineering?: EngineeringGoalMetadata;
  readonly currentContextCapsuleId?: string | null;
  readonly currentPhase: string;
  readonly summary: string;
  readonly stepUpdates: readonly GoalStepUpdate[];
  readonly nextAction: string;
  readonly blockers: readonly string[];
  readonly evidence: readonly GoalEvidence[];
  readonly activeTaskIds: readonly string[];
  readonly trackedTasks?: readonly GoalTrackedTask[];
  readonly resumeContext?: GoalCheckpointResumeContext;
  readonly ponytailMode: GoalPonytailMode | null;
  readonly releaseLease: boolean;
  readonly now: string;
}

export interface FinishGoalRecordRequest {
  readonly checkpointId: string;
  readonly goalId: string;
  readonly ownerClientId: string;
  readonly ownerSessionId: string;
  readonly leaseTokenHash: string;
  readonly expectedRevision: number;
  readonly status: GoalTerminalStatus;
  readonly summary: string;
  readonly evidence: readonly GoalEvidence[];
  readonly now: string;
}

export interface CancelGoalRecordRequest {
  readonly checkpointId: string;
  readonly goalId: string;
  readonly ownerClientId: string;
  readonly expectedRevision: number;
  readonly summary: string;
  readonly evidence: readonly GoalEvidence[];
  readonly now: string;
}

export interface CancelGoalRecordResult {
  readonly goal: GoalRecord;
  readonly trackedTaskIds: readonly string[];
  readonly trackedTasks?: readonly GoalTrackedTask[];
}

export type GoalReconciliationReason = 'abandoned' | 'superseded';

export interface ReconcileGoalRecordRequest {
  readonly checkpointId: string;
  readonly goalId: string;
  readonly ownerClientId: string;
  readonly expectedRevision: number;
  readonly expectedLeaseGeneration: number;
  readonly expectedLeaseActivitySeq: number;
  readonly reason: GoalReconciliationReason;
  readonly summary: string;
  readonly evidence: readonly GoalEvidence[];
  readonly now: string;
}

export interface ListGoalRecordsRequest {
  readonly ownerClientId: string;
  readonly workspaceId?: string;
  readonly status?: GoalStatus;
  readonly limit: number;
}

export interface ScheduledTaskCancellationInstruction {
  /** Host-owned cleanup intent. The caller must resolve the strongest currently exposed native operation. */
  readonly action: 'make_native_task_non_runnable' | 'none';
  readonly continuationId?: string;
  readonly nativeTaskId?: string;
  readonly provider?: 'chatgpt_scheduled_task';
  readonly expectedContinuationVersion?: number;
  readonly receiptRequired?: true;
  readonly requiredEffect?: 'non_runnable';
  readonly reason: 'live_task_confirmed' | 'no_live_task' | 'already_fired' | 'already_cancelled' | 'native_task_unverified';
}

export interface CreateGoalContextCapsuleRecordRequest {
  readonly id: string;
  readonly goalId: string;
  readonly sourceGoalRevision: number;
  readonly sourceUserIntentRevision: number;
  readonly previousCapsuleId?: string;
  readonly payload: GoalContextCapsulePayload;
  readonly createdAt: string;
}

export interface RecordGoalDeliveryReceiptRequest {
  readonly id: string;
  readonly goalId: string;
  readonly channel: string;
  readonly state: GoalDeliveryState;
  readonly basedOnUserIntentRevision: number;
  readonly externalId?: string;
  readonly detail?: string;
  readonly now: string;
}

export interface GoalRepository {
  acquire(request: AcquireGoalRecordRequest): Promise<AcquireGoalRecordResult>;
  getById(goalId: string): Promise<GoalRecord | null>;
  getByKey(workspaceId: string, goalKey: string): Promise<GoalRecord | null>;
  list(request: ListGoalRecordsRequest): Promise<readonly GoalRecord[]>;
  validateFinish(request: FinishGoalRecordRequest): Promise<void>;
  checkpoint(request: CheckpointGoalRecordRequest): Promise<GoalRecord>;
  finish(request: FinishGoalRecordRequest): Promise<GoalRecord>;
  cancel(request: CancelGoalRecordRequest): Promise<CancelGoalRecordResult>;
  reconcile(request: ReconcileGoalRecordRequest): Promise<GoalRecord>;
  createContextCapsule?(request: CreateGoalContextCapsuleRecordRequest): Promise<GoalContextCapsuleRecord>;
  getContextCapsule?(capsuleId: string): Promise<GoalContextCapsuleRecord | null>;
  listContextCapsules?(goalId: string, limit: number): Promise<readonly GoalContextCapsuleRecord[]>;
  recordDeliveryReceipt?(request: RecordGoalDeliveryReceiptRequest): Promise<GoalDeliveryReceipt>;
  getDeliveryReceipt?(receiptId: string): Promise<GoalDeliveryReceipt | null>;
  listDeliveryReceipts?(goalId: string, limit: number): Promise<readonly GoalDeliveryReceipt[]>;
}
