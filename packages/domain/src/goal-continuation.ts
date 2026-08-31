export type GoalStatus = 'active' | 'completed' | 'failed' | 'blocked' | 'cancelled';
export type GoalTerminalStatus = 'completed' | 'failed' | 'blocked';
export type GoalStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';
export type GoalEvidenceKind = 'path' | 'hash' | 'task' | 'note';

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
  readonly status: GoalStatus;
  readonly revision: number;
  readonly currentPhase: string;
  readonly nextAction: string;
  readonly blockers: readonly string[];
  readonly activeTaskIds: readonly string[];
  readonly trackedTasks?: readonly GoalTrackedTask[];
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
  | 'lease_invalid'
  | 'terminal'
  | 'corrupt';

export class GoalStateError extends Error {
  public constructor(public readonly reason: GoalStateFailureCode, message: string) {
    super(message);
    this.name = 'GoalStateError';
  }
}

export interface AcquireGoalRecordRequest {
  readonly goalId: string;
  readonly workspaceId: string;
  readonly goalKey: string;
  readonly ownerClientId: string;
  readonly ownerSessionId: string;
  readonly objective?: string;
  readonly plan?: GoalPlan;
  readonly leaseTokenHash: string;
  readonly leaseSeconds: number;
  readonly now: string;
}

export interface AcquireGoalRecordResult {
  readonly goal: GoalRecord;
  readonly acquired: boolean;
  readonly retryAfterSeconds?: number;
}

export interface CheckpointGoalRecordRequest {
  readonly checkpointId: string;
  readonly goalId: string;
  readonly ownerClientId: string;
  readonly ownerSessionId: string;
  readonly leaseTokenHash: string;
  readonly expectedRevision: number;
  readonly plan: GoalPlan;
  readonly currentPhase: string;
  readonly summary: string;
  readonly stepUpdates: readonly GoalStepUpdate[];
  readonly nextAction: string;
  readonly blockers: readonly string[];
  readonly evidence: readonly GoalEvidence[];
  readonly activeTaskIds: readonly string[];
  readonly trackedTasks?: readonly GoalTrackedTask[];
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

export interface ListGoalRecordsRequest {
  readonly ownerClientId: string;
  readonly workspaceId?: string;
  readonly status?: GoalStatus;
  readonly limit: number;
}

export interface ScheduledTaskCancellationInstruction {
  readonly action: 'delete_native_task' | 'none';
  readonly continuationId?: string;
  readonly nativeTaskId?: string;
  readonly provider?: 'chatgpt_scheduled_task';
  readonly expectedContinuationVersion?: number;
  readonly receiptRequired?: true;
  readonly reason: 'live_task_confirmed' | 'no_live_task' | 'already_fired' | 'already_cancelled' | 'native_task_unverified';
}

export interface GoalRepository {
  acquire(request: AcquireGoalRecordRequest): Promise<AcquireGoalRecordResult>;
  getById(goalId: string): Promise<GoalRecord | null>;
  getByKey(workspaceId: string, goalKey: string): Promise<GoalRecord | null>;
  list(request: ListGoalRecordsRequest): Promise<readonly GoalRecord[]>;
  checkpoint(request: CheckpointGoalRecordRequest): Promise<GoalRecord>;
  finish(request: FinishGoalRecordRequest): Promise<GoalRecord>;
  cancel(request: CancelGoalRecordRequest): Promise<CancelGoalRecordResult>;
}
