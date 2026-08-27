export type GoalStatus = 'active' | 'completed' | 'failed' | 'blocked';
export type GoalTerminalStatus = Exclude<GoalStatus, 'active'>;
export type GoalStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';
export type GoalEvidenceKind = 'path' | 'hash' | 'task' | 'note';

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
  readonly leaseOwnerClientId?: string;
  readonly leaseTokenHash?: string;
  readonly leaseDurationSeconds?: number;
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
  readonly releaseLease: boolean;
  readonly now: string;
}

export interface FinishGoalRecordRequest {
  readonly checkpointId: string;
  readonly goalId: string;
  readonly ownerClientId: string;
  readonly leaseTokenHash: string;
  readonly expectedRevision: number;
  readonly status: GoalTerminalStatus;
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

export interface GoalRepository {
  acquire(request: AcquireGoalRecordRequest): Promise<AcquireGoalRecordResult>;
  getById(goalId: string): Promise<GoalRecord | null>;
  getByKey(workspaceId: string, goalKey: string): Promise<GoalRecord | null>;
  list(request: ListGoalRecordsRequest): Promise<readonly GoalRecord[]>;
  checkpoint(request: CheckpointGoalRecordRequest): Promise<GoalRecord>;
  finish(request: FinishGoalRecordRequest): Promise<GoalRecord>;
}
