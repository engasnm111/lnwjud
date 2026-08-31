import type {
  GoalEvidence,
  GoalPlan,
  GoalRecord,
  GoalTaskProvider,
  GoalTrackedTask,
  GoalStepUpdate,
} from './goal-continuation.js';

export type ScheduledContinuationStatus =
  | 'prepared'
  | 'scheduled'
  | 'create_failed'
  | 'create_uncertain'
  | 'reschedule_required'
  | 'reschedule_failed'
  | 'reschedule_uncertain'
  | 'claimed'
  | 'terminal_noop'
  | 'superseded'
  | 'cancel_required'
  | 'cancelled'
  | 'cancel_failed'
  | 'cancel_uncertain';

export type LiveScheduledContinuationStatus =
  | 'prepared'
  | 'scheduled'
  | 'create_uncertain'
  | 'reschedule_required'
  | 'reschedule_failed'
  | 'reschedule_uncertain'
  | 'cancel_required'
  | 'cancel_failed'
  | 'cancel_uncertain';

/** Historical rows may contain auto/local from pre-v4.27 databases. New preparation is cloud-only. */
export type ScheduledContinuationExecutionPreference = 'auto' | 'cloud' | 'local';
export type ScheduledContinuationRunsOn = 'cloud' | 'local' | 'unverified';
export type ScheduledContinuationExpediteReason =
  | 'host_deadline_warning'
  | 'host_budget_warning'
  | 'tool_access_degradation'
  | 'turn_yield_signal';
export type ScheduledContinuationRescheduleReason =
  | 'collision'
  | `expedite:${ScheduledContinuationExpediteReason}`;

export type ScheduledContinuationReceiptOutcome =
  | 'created'
  | 'create_failed'
  | 'create_uncertain'
  | 'rescheduled'
  | 'reschedule_failed'
  | 'reschedule_uncertain'
  | 'consumed'
  | 'cancelled'
  | 'cancel_failed'
  | 'cancel_uncertain';

export type ScheduledContinuationCancellationOutcome =
  | 'delete_required'
  | 'cancelled'
  | 'already_cancelled'
  | 'already_fired'
  | 'native_task_unverified';

export interface ScheduledContinuationNativeCancellationReceipt {
  readonly provider: 'chatgpt_scheduled_task';
  readonly operation: 'delete';
  readonly nativeTaskId: string;
  readonly state: 'deleted' | 'not_found';
  readonly observedAt: string;
}

export interface ScheduledContinuationNativeRunReceipt {
  readonly provider: 'chatgpt_scheduled_task';
  readonly operation: 'run';
  readonly nativeTaskId: string;
  readonly state: 'consumed';
  readonly observedAt: string;
}

export interface ScheduledContinuationSnapshot {
  readonly continuationId: string;
  readonly goalId: string;
  readonly generation: number;
  readonly sourceGoalRevision: number;
  readonly status: ScheduledContinuationStatus;
  readonly occurrence: 'once';
  readonly destination: 'current_chat';
  readonly executionPreference: ScheduledContinuationExecutionPreference;
  readonly confirmedRunsOn?: ScheduledContinuationRunsOn;
  readonly dueAt: string;
  readonly pendingDueAt?: string;
  readonly nativeTaskId?: string;
  readonly rescheduleReason?: ScheduledContinuationRescheduleReason;
  readonly rescheduleCount: number;
  readonly lastCollisionAt?: string;
  readonly lastRescheduledAt?: string;
  readonly orphanProbeStartedAt?: string;
  readonly orphanProbeLeaseGeneration?: number;
  readonly orphanProbeActivitySeq?: number;
  readonly orphanRecoveryCount: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScheduledContinuationRecord extends ScheduledContinuationSnapshot {
  /** Audit-only predecessor transport identity. It is never mutation authority. */
  readonly sourceSessionId: string;
  readonly requestFingerprint: string;
  readonly lastDetail?: string;
  readonly claimedAt?: string;
  readonly terminalAt?: string;
}

export interface PrepareScheduledContinuationRecordRequest {
  readonly continuationId: string;
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
  /** Structured goal-relative task bindings. Omitted only by legacy callers. */
  readonly trackedTasks?: readonly GoalTrackedTask[];
  readonly dueAt: string;
  readonly executionPreference: 'cloud';
  readonly requestFingerprint: string;
  readonly now: string;
}

export interface PrepareScheduledContinuationRecordResult {
  readonly goal: GoalRecord;
  readonly continuation: ScheduledContinuationRecord;
  readonly alreadyPrepared: boolean;
}

export interface RecordScheduledContinuationReceiptRecordRequest {
  readonly continuationId: string;
  readonly ownerClientId: string;
  readonly expectedVersion: number;
  readonly outcome: ScheduledContinuationReceiptOutcome;
  readonly nativeTaskId?: string;
  readonly dueAt?: string;
  readonly runsOn?: ScheduledContinuationRunsOn;
  readonly nativeRunReceipt?: ScheduledContinuationNativeRunReceipt;
  readonly nativeCancellationReceipt?: ScheduledContinuationNativeCancellationReceipt;
  readonly detail?: string;
  readonly now: string;
}

export type CancelScheduledContinuationRecordRequest =
  | {
      readonly continuationId: string;
      readonly ownerClientId: string;
      readonly expectedVersion: number;
      readonly now: string;
    }
  | {
      readonly goalId: string;
      readonly latest: true;
      readonly ownerClientId: string;
      readonly expectedVersion: number;
      readonly now: string;
    };

export interface CancelScheduledContinuationRecordResult {
  readonly outcome: ScheduledContinuationCancellationOutcome;
  readonly continuation: ScheduledContinuationRecord;
}

export interface ScheduledContinuationWorkerLiveness {
  readonly trustworthy: boolean;
  readonly observedAt: string;
  readonly leaseGeneration: number;
  readonly leaseActivitySeq: number;
  readonly liveFencedCallCount: number;
  readonly blockingTaskStates?: readonly {
    readonly taskId: string;
    readonly provider: GoalTaskProvider;
    readonly state: 'running' | 'terminal' | 'absent' | 'unknown';
  }[];
  /** @deprecated Pre-4.31 liveness shape; accepted only for migration compatibility. */
  readonly activeTaskStates?: readonly {
    readonly taskId: string;
    readonly state: 'running' | 'terminal' | 'absent' | 'unknown';
  }[];
}

export interface ScheduledContinuationWorkerLivenessPort {
  observe(goalId: string, trackedTasks: readonly GoalTrackedTask[]): Promise<ScheduledContinuationWorkerLiveness>;
}

export interface ClaimScheduledContinuationRecordRequest {
  readonly continuationId: string;
  readonly ownerClientId: string;
  readonly ownerSessionId: string;
  readonly leaseTokenHash: string;
  readonly leaseSeconds: number;
  readonly earlyToleranceSeconds?: number;
  readonly liveness: ScheduledContinuationWorkerLiveness;
  /** Deterministic identity used to atomically reserve a fresh one-time ticket when this wake fires into a live worker. */
  readonly collisionSuccessorId?: string;
  readonly collisionSuccessorDueAt?: string;
  readonly collisionSuccessorRequestFingerprint?: string;
  readonly now: string;
}

export type ScheduledContinuationAcquisition = 'normal' | 'expired_lease' | 'orphan_recovered';

export type ClaimScheduledContinuationRecordResult =
  | {
      readonly outcome: 'acquired';
      readonly acquisition: ScheduledContinuationAcquisition;
      readonly goal: GoalRecord;
      readonly continuation: ScheduledContinuationRecord;
    }
  | {
      readonly outcome: 'successor_required';
      readonly goal: GoalRecord;
      /** The one-time native task that is firing now and must be allowed to complete naturally. */
      readonly continuation: ScheduledContinuationRecord;
      /** Fresh future ticket reserved atomically after consuming the current wake. */
      readonly successor: ScheduledContinuationRecord;
      readonly retryAfterSeconds: 120;
    }
  | {
      readonly outcome: 'receipt_required';
      readonly reason: 'native_task_unconfirmed';
      readonly goal: GoalRecord;
      readonly continuation: ScheduledContinuationRecord;
    }
  | {
      readonly outcome: 'already_claimed' | 'terminal_noop';
      readonly goal: GoalRecord;
      readonly continuation: ScheduledContinuationRecord;
    }
  | {
      readonly outcome: 'not_due';
      readonly goal: GoalRecord;
      readonly continuation: ScheduledContinuationRecord;
      readonly retryAfterSeconds: number;
    };

export interface ExpediteScheduledContinuationRecordRequest {
  readonly goalId: string;
  readonly continuationId: string;
  readonly ownerClientId: string;
  readonly ownerSessionId: string;
  readonly leaseTokenHash: string;
  readonly expectedLeaseGeneration: number;
  readonly expectedGoalRevision: number;
  readonly expectedContinuationVersion: number;
  readonly reason: ScheduledContinuationExpediteReason;
  readonly dueAt: string;
  readonly now: string;
}

export type ExpediteScheduledContinuationRecordResult =
  | {
      readonly outcome: 'update_required';
      readonly goal: GoalRecord;
      readonly continuation: ScheduledContinuationRecord;
    }
  | {
      readonly outcome: 'unchanged';
      readonly reason: 'already_due_within_two_minutes';
      readonly goal: GoalRecord;
      readonly continuation: ScheduledContinuationRecord;
    };

export type GetScheduledContinuationRecordRequest =
  | { readonly continuationId: string }
  | { readonly goalId: string; readonly latest: true };

export interface GoalScheduledContinuationFinishResult {
  readonly continuation: ScheduledContinuationRecord | null;
}

export interface ScheduledContinuationMutationFence {
  readonly goal: GoalRecord;
  readonly continuation: ScheduledContinuationRecord;
}

export interface BeginGoalFencedMutationRequest {
  readonly callId: string;
  readonly goalId: string;
  readonly workspaceId: string;
  readonly ownerClientId: string;
  readonly leaseTokenHash: string;
  readonly leaseGeneration: number;
  readonly startedAt: string;
  readonly expiresAt: string;
}

export interface GoalFencedMutationAdmission {
  readonly goalId: string;
  readonly leaseGeneration: number;
}

export interface GoalFencedMutationObservation {
  readonly workspaceId: string;
  readonly leaseGeneration: number;
  readonly leaseActivitySeq: number;
  readonly liveFencedCallCount: number;
}

export interface ScheduledContinuationRepository {
  prepareScheduledContinuation(request: PrepareScheduledContinuationRecordRequest): Promise<PrepareScheduledContinuationRecordResult>;
  recordScheduledContinuationReceipt(request: RecordScheduledContinuationReceiptRecordRequest): Promise<ScheduledContinuationRecord>;
  cancelScheduledContinuation(request: CancelScheduledContinuationRecordRequest): Promise<CancelScheduledContinuationRecordResult>;
  claimScheduledContinuation(request: ClaimScheduledContinuationRecordRequest): Promise<ClaimScheduledContinuationRecordResult>;
  expediteScheduledContinuation(request: ExpediteScheduledContinuationRecordRequest): Promise<ExpediteScheduledContinuationRecordResult>;
  getScheduledContinuation(request: GetScheduledContinuationRecordRequest): Promise<ScheduledContinuationRecord | null>;
  getLiveScheduledContinuation(goalId: string): Promise<ScheduledContinuationRecord | null>;
  getWorkspaceMutationFence(workspaceId: string): Promise<ScheduledContinuationMutationFence | null>;
  beginGoalFencedMutation(request: BeginGoalFencedMutationRequest): Promise<GoalFencedMutationAdmission>;
  heartbeatGoalFencedMutation(callId: string, leaseGeneration: number, heartbeatAt: string, expiresAt: string): Promise<void>;
  endGoalFencedMutation(callId: string, completedAt: string): Promise<void>;
  observeGoalFencedMutations(goalId: string, now: string): Promise<GoalFencedMutationObservation>;
  markGoalFinishedForScheduledContinuation(goalId: string, now: string): Promise<GoalScheduledContinuationFinishResult>;
}
