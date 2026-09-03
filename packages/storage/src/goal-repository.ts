import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  GoalStateError,
  type AcquireGoalRecordRequest,
  type AcquireGoalRecordResult,
  type BeginGoalFencedMutationRequest,
  type GoalFencedMutationAdmission,
  type GoalFencedMutationObservation,
  type CheckpointGoalRecordRequest,
  type CancelGoalRecordRequest,
  type CancelGoalRecordResult,
  type FinishGoalRecordRequest,
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
  type ListGoalRecordsRequest,
  type ClaimScheduledContinuationRecordRequest,
  type ClaimScheduledContinuationRecordResult,
  type ClaimSuccessorDisposition,
  type GetScheduledContinuationRecordRequest,
  type GoalScheduledContinuationFinishResult,
  type ExpediteScheduledContinuationRecordRequest,
  type ExpediteScheduledContinuationRecordResult,
  type PrepareScheduledContinuationRecordRequest,
  type PrepareScheduledContinuationRecordResult,
  type RecordScheduledContinuationReceiptRecordRequest,
  type ScheduledContinuationRecord,
  type ScheduledContinuationRepository,
  type ScheduledContinuationMutationFence,
  type ScheduledContinuationRescheduleReason,
  type ScheduledContinuationStatus,
  type CancelScheduledContinuationRecordRequest,
  type CancelScheduledContinuationRecordResult,
} from '@lnwjud/domain';
import type { SqliteDatabase } from './database.js';

const MAX_TRACKED_TASKS = 50;
const SCHEDULE_RECEIPT_TIME_TOLERANCE_MS = 1_000;

interface GoalRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly goal_key: string;
  readonly owner_client_id: string;
  readonly objective: string;
  readonly plan_json: string;
  readonly status: string;
  readonly revision: number;
  readonly current_phase: string;
  readonly next_action: string;
  readonly blockers_json: string;
  readonly active_task_ids_json: string;
  readonly tracked_tasks_json: string | null;
  readonly lease_owner_client_id: string | null;
  readonly lease_owner_session_id: string | null;
  readonly lease_token_hash: string | null;
  readonly lease_duration_seconds: number | null;
  readonly lease_generation: number;
  readonly lease_activity_seq: number;
  readonly lease_heartbeat_at: string | null;
  readonly lease_expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly terminal_summary: string | null;
  readonly terminal_evidence_json: string | null;
  readonly terminal_at: string | null;
}

interface CheckpointRow {
  readonly id: string;
  readonly goal_id: string;
  readonly revision: number;
  readonly current_phase: string;
  readonly summary: string;
  readonly step_updates_json: string;
  readonly next_action: string;
  readonly blockers_json: string;
  readonly evidence_json: string;
  readonly active_task_ids_json: string;
  readonly tracked_tasks_json: string | null;
  readonly created_at: string;
}

interface ScheduledContinuationRow {
  readonly id: string;
  readonly goal_id: string;
  readonly source_session_id: string;
  readonly generation: number;
  readonly source_goal_revision: number;
  readonly status: string;
  readonly occurrence: string;
  readonly destination: string;
  readonly execution_preference: string;
  readonly confirmed_runs_on: string | null;
  readonly due_at: string;
  readonly native_task_id: string | null;
  readonly request_fingerprint: string;
  readonly version: number;
  readonly last_detail: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly claimed_at: string | null;
  readonly terminal_at: string | null;
  readonly pending_due_at: string | null;
  readonly reschedule_reason: string | null;
  readonly reschedule_count: number;
  readonly last_collision_at: string | null;
  readonly last_rescheduled_at: string | null;
  readonly orphan_probe_started_at: string | null;
  readonly orphan_probe_lease_generation: number | null;
  readonly orphan_probe_activity_seq: number | null;
  readonly orphan_recovery_count: number;
}

const LIVE_CONTINUATION_STATUSES = [
  'prepared',
  'scheduled',
  'create_uncertain',
  'reschedule_required',
  'reschedule_failed',
  'reschedule_uncertain',
  'cancel_required',
  'cancel_failed',
  'cancel_uncertain',
] as const;
const ORPHAN_PROBE_MIN_SECONDS = 120;
const CLAIM_SUCCESSOR_MIN_SECONDS = 120;
const COLLISION_SUCCESSOR_MIN_SECONDS = 240;
const COLLISION_SUCCESSOR_MAX_SECONDS = 25 * 60;
const EXPEDITE_MIN_SECONDS = 120;
const EXPEDITE_MAX_SECONDS = 5 * 60;

export class SqliteGoalRepository implements GoalRepository, ScheduledContinuationRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async acquire(request: AcquireGoalRecordRequest): Promise<AcquireGoalRecordResult> {
    return this.transaction(() => {
      const existingRow = this.selectByKey(request.workspaceId, request.goalKey);
      if (existingRow === undefined) {
        if (request.objective === undefined || request.plan === undefined) {
          throw new GoalStateError('not_found', 'Goal does not exist and objective/plan were not supplied');
        }
        const leaseExpiresAt = addSeconds(request.now, request.leaseSeconds);
        this.database.connection.prepare(`
          INSERT INTO goals (
            id, workspace_id, goal_key, owner_client_id, objective, plan_json, status, revision,
            current_phase, next_action, blockers_json, active_task_ids_json, tracked_tasks_json,
            lease_owner_client_id, lease_owner_session_id, lease_token_hash, lease_duration_seconds, lease_generation, lease_activity_seq, lease_heartbeat_at, lease_expires_at,
            created_at, updated_at, terminal_summary, terminal_evidence_json, terminal_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', 0, 'created', '', '[]', '[]', '[]', ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, NULL, NULL, NULL)
        `).run(
          request.goalId,
          request.workspaceId,
          request.goalKey,
          request.ownerClientId,
          request.objective,
          JSON.stringify(request.plan),
          request.ownerClientId,
          request.ownerSessionId,
          request.leaseTokenHash,
          request.leaseSeconds,
          request.now,
          leaseExpiresAt,
          request.now,
          request.now,
        );
        return { goal: this.requireById(request.goalId), acquired: true };
      }

      const existing = this.toGoalRecord(existingRow);
      this.assertOwner(existing, request.ownerClientId);
      if (request.objective !== undefined && request.objective !== existing.objective) {
        throw new GoalStateError('conflict', 'Existing goal objective does not match the requested objective');
      }
      if (request.plan !== undefined && JSON.stringify(request.plan) !== JSON.stringify(existing.plan)) {
        throw new GoalStateError('conflict', 'Existing goal plan does not match the requested plan');
      }
      if (existing.status !== 'active') return { goal: existing, acquired: false };

      const nowMs = parseIso(request.now, 'request time');
      const expiresMs = existing.leaseExpiresAt === undefined ? undefined : parseIso(existing.leaseExpiresAt, 'lease expiry');
      if (expiresMs !== undefined && expiresMs > nowMs) {
        return {
          goal: existing,
          acquired: false,
          retryAfterSeconds: Math.max(1, Math.ceil((expiresMs - nowMs) / 1000)),
        };
      }

      const leaseExpiresAt = addSeconds(request.now, request.leaseSeconds);
      const changed = this.database.connection.prepare(`
        UPDATE goals
        SET lease_owner_client_id = ?, lease_owner_session_id = ?, lease_token_hash = ?, lease_duration_seconds = ?,
            lease_generation = lease_generation + 1, lease_activity_seq = 0,
            lease_heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active' AND revision = ? AND lease_generation = ?
      `).run(
        request.ownerClientId,
        request.ownerSessionId,
        request.leaseTokenHash,
        request.leaseSeconds,
        request.now,
        leaseExpiresAt,
        request.now,
        existing.id,
        existing.revision,
        existing.leaseGeneration,
      );
      if (Number(changed.changes) !== 1) throw new GoalStateError('conflict', 'Goal lease changed concurrently');
      return { goal: this.requireById(existing.id), acquired: true };
    });
  }

  public async getById(goalId: string): Promise<GoalRecord | null> {
    const row = this.selectById(goalId);
    return row === undefined ? null : this.toGoalRecord(row);
  }

  public async getByKey(workspaceId: string, goalKey: string): Promise<GoalRecord | null> {
    const row = this.selectByKey(workspaceId, goalKey);
    return row === undefined ? null : this.toGoalRecord(row);
  }

  public async list(request: ListGoalRecordsRequest): Promise<readonly GoalRecord[]> {
    const conditions = ['owner_client_id = ?'];
    const values: Array<string | number> = [request.ownerClientId];
    if (request.workspaceId !== undefined) {
      conditions.push('workspace_id = ?');
      values.push(request.workspaceId);
    }
    if (request.status !== undefined) {
      conditions.push('status = ?');
      values.push(request.status);
    }
    values.push(request.limit);
    const rows = this.database.connection.prepare(`
      SELECT * FROM goals WHERE ${conditions.join(' AND ')}
      ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(...values);
    return rows.map((row) => this.toGoalRecord(this.requireGoalRow(row)));
  }

  public async checkpoint(request: CheckpointGoalRecordRequest): Promise<GoalRecord> {
    return this.transaction(() => {
      const current = this.requireById(request.goalId);
      this.assertOwner(current, request.ownerClientId);
      this.assertMutableLease(current, request.ownerClientId, request.ownerSessionId, request.leaseTokenHash, request.expectedRevision, request.now);
      const leaseDurationSeconds = current.leaseDurationSeconds;
      if (leaseDurationSeconds === undefined) throw corrupt('Active goal lease duration is missing');
      const revision = current.revision + 1;
      const trackedTasks = normalizeTrackedTasks(request.trackedTasks, request.activeTaskIds);
      const activeTaskIds = blockingTaskIds(trackedTasks);
      const liveContinuation = this.selectLiveScheduledContinuation(request.goalId);
      const normalLeaseExpiresAt = addSeconds(request.now, leaseDurationSeconds);
      const leaseExpiresAt = request.releaseLease
        ? null
        : liveContinuation === undefined
          ? normalLeaseExpiresAt
          : minIso(normalLeaseExpiresAt, liveContinuation.pending_due_at ?? liveContinuation.due_at);
      const changed = this.database.connection.prepare(`
        UPDATE goals
        SET plan_json = ?, revision = ?, current_phase = ?, next_action = ?, blockers_json = ?, active_task_ids_json = ?, tracked_tasks_json = ?,
            lease_owner_client_id = ?, lease_owner_session_id = ?, lease_token_hash = ?, lease_duration_seconds = ?, lease_heartbeat_at = ?, lease_expires_at = ?,
            lease_activity_seq = lease_activity_seq + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND lease_token_hash = ? AND status = 'active'
      `).run(
        JSON.stringify(request.plan),
        revision,
        request.currentPhase,
        request.nextAction,
        JSON.stringify(request.blockers),
        JSON.stringify(activeTaskIds),
        JSON.stringify(trackedTasks),
        request.releaseLease ? null : request.ownerClientId,
        request.releaseLease ? null : request.ownerSessionId,
        request.releaseLease ? null : request.leaseTokenHash,
        request.releaseLease ? null : leaseDurationSeconds,
        request.releaseLease ? null : request.now,
        leaseExpiresAt,
        request.now,
        request.goalId,
        request.expectedRevision,
        request.leaseTokenHash,
      );
      if (Number(changed.changes) !== 1) throw new GoalStateError('conflict', 'Goal checkpoint lost the compare-and-swap race');
      this.insertCheckpoint({
        id: request.checkpointId,
        goalId: request.goalId,
        revision,
        currentPhase: request.currentPhase,
        summary: request.summary,
        stepUpdates: request.stepUpdates,
        nextAction: request.nextAction,
        blockers: request.blockers,
        evidence: request.evidence,
        activeTaskIds,
        trackedTasks,
        createdAt: request.now,
      });
      return this.requireById(request.goalId);
    });
  }

  public async finish(request: FinishGoalRecordRequest): Promise<GoalRecord> {
    return this.transaction(() => {
      const current = this.requireById(request.goalId);
      this.assertOwner(current, request.ownerClientId);
      this.assertMutableLease(current, request.ownerClientId, request.ownerSessionId, request.leaseTokenHash, request.expectedRevision, request.now);
      const revision = current.revision + 1;
      const changed = this.database.connection.prepare(`
        UPDATE goals
        SET status = ?, revision = ?, current_phase = ?, next_action = '', blockers_json = '[]', active_task_ids_json = '[]', tracked_tasks_json = '[]',
            lease_owner_client_id = NULL, lease_owner_session_id = NULL, lease_token_hash = NULL, lease_duration_seconds = NULL,
            lease_heartbeat_at = NULL, lease_expires_at = NULL, updated_at = ?,
            terminal_summary = ?, terminal_evidence_json = ?, terminal_at = ?
        WHERE id = ? AND revision = ? AND lease_token_hash = ? AND status = 'active'
      `).run(
        request.status,
        revision,
        request.status,
        request.now,
        request.summary,
        JSON.stringify(request.evidence),
        request.now,
        request.goalId,
        request.expectedRevision,
        request.leaseTokenHash,
      );
      if (Number(changed.changes) !== 1) throw new GoalStateError('conflict', 'Goal finish lost the compare-and-swap race');
      this.insertCheckpoint({
        id: request.checkpointId,
        goalId: request.goalId,
        revision,
        currentPhase: request.status,
        summary: request.summary,
        stepUpdates: [],
        nextAction: '',
        blockers: [],
        evidence: request.evidence,
        activeTaskIds: [],
        trackedTasks: [],
        createdAt: request.now,
      });
      return this.requireById(request.goalId);
    });
  }

  public async validateFinish(request: FinishGoalRecordRequest): Promise<void> {
    this.transaction(() => {
      const current = this.requireById(request.goalId);
      this.assertOwner(current, request.ownerClientId);
      this.assertMutableLease(current, request.ownerClientId, request.ownerSessionId, request.leaseTokenHash, request.expectedRevision, request.now);
    });
  }

  public async cancel(request: CancelGoalRecordRequest): Promise<CancelGoalRecordResult> {
    return this.transaction(() => {
      const current = this.requireById(request.goalId);
      this.assertOwner(current, request.ownerClientId);
      if (current.revision !== request.expectedRevision) throw new GoalStateError('conflict', 'Goal revision is stale');
      if (current.status === 'cancelled') {
        // Repair any legacy/live fence rows left by an interrupted cancellation
        // so a repeated cancel remains an effective hard stop.
        this.database.connection.prepare(`
          UPDATE goal_fenced_mutation_calls
          SET completed_at = COALESCE(completed_at, ?)
          WHERE goal_id = ? AND completed_at IS NULL
        `).run(request.now, request.goalId);
        const trackedTasks = trackedTasksAtCancellation(current);
        return { goal: current, trackedTaskIds: trackedTasks.map((task) => task.taskId), trackedTasks };
      }
      if (current.status !== 'active') throw new GoalStateError('terminal', 'Goal is already terminal');

      const trackedTasks = trackedTasksAtCancellation(current);
      const trackedTaskIds = trackedTasks.map((task) => task.taskId);
      const revision = current.revision + 1;
      const changed = this.database.connection.prepare(`
        UPDATE goals
        SET status = 'cancelled', revision = ?, current_phase = 'cancelled', next_action = '', blockers_json = '[]', active_task_ids_json = '[]', tracked_tasks_json = '[]',
            lease_owner_client_id = NULL, lease_owner_session_id = NULL, lease_token_hash = NULL, lease_duration_seconds = NULL,
            lease_heartbeat_at = NULL, lease_expires_at = NULL, updated_at = ?,
            terminal_summary = ?, terminal_evidence_json = ?, terminal_at = ?
        WHERE id = ? AND revision = ? AND status = 'active'
      `).run(
        revision,
        request.now,
        request.summary,
        JSON.stringify(request.evidence),
        request.now,
        request.goalId,
        request.expectedRevision,
      );
      if (Number(changed.changes) !== 1) throw new GoalStateError('conflict', 'Goal cancellation lost the compare-and-swap race');
      // A cancellation invalidates every currently admitted fenced mutation
      // immediately. The handler still receives an AbortSignal from the
      // runtime registry, but liveness probes must not keep treating a
      // cancelled goal as if a worker were actively mutating its workspace.
      this.database.connection.prepare(`
        UPDATE goal_fenced_mutation_calls
        SET completed_at = ?
        WHERE goal_id = ? AND completed_at IS NULL
      `).run(request.now, request.goalId);
      this.insertCheckpoint({
        id: request.checkpointId,
        goalId: request.goalId,
        revision,
        currentPhase: 'cancelled',
        summary: request.summary,
        stepUpdates: [],
        nextAction: '',
        blockers: [],
        evidence: request.evidence,
        activeTaskIds: blockingTaskIds(trackedTasks),
        trackedTasks,
        createdAt: request.now,
      });
      return { goal: this.requireById(request.goalId), trackedTaskIds, trackedTasks };
    });
  }

  public async prepareScheduledContinuation(
    request: PrepareScheduledContinuationRecordRequest,
  ): Promise<PrepareScheduledContinuationRecordResult> {
    return this.transaction(() => {
      const current = this.requireById(request.goalId);
      this.assertOwner(current, request.ownerClientId);

      const existingSame = this.selectScheduledContinuationByFingerprint(
        request.goalId,
        request.expectedRevision,
        request.requestFingerprint,
      );
      if (existingSame !== undefined) {
        if (!isLiveScheduledStatus(existingSame.status)) {
          throw new GoalStateError('conflict', 'Scheduled continuation request already became historical');
        }
        if (current.status !== 'active') throw new GoalStateError('terminal', 'Goal is already terminal');
        if (
          current.leaseOwnerClientId !== request.ownerClientId
          || current.leaseOwnerSessionId !== request.ownerSessionId
          || current.leaseTokenHash !== request.leaseTokenHash
        ) {
          throw new GoalStateError('lease_invalid', 'Goal lease token or session is invalid');
        }
        if (current.leaseExpiresAt === undefined || parseIso(current.leaseExpiresAt, 'lease expiry') <= parseIso(request.now, 'request time')) {
          throw new GoalStateError('lease_invalid', 'Goal lease has expired');
        }
        return {
          goal: current,
          continuation: this.toScheduledContinuationRecord(existingSame),
          alreadyPrepared: true,
        };
      }

      const workspaceScheduledGoalId = this.selectActiveScheduledGoalId(current.workspaceId);
      if (workspaceScheduledGoalId !== undefined && workspaceScheduledGoalId !== request.goalId) {
        throw new GoalStateError('conflict', 'Workspace already has another active scheduled-continuation mutation owner');
      }
      if (this.selectLiveScheduledContinuation(request.goalId) !== undefined) {
        throw new GoalStateError('conflict', 'Goal already has a live scheduled continuation');
      }
      this.assertMutableLease(current, request.ownerClientId, request.ownerSessionId, request.leaseTokenHash, request.expectedRevision, request.now);
      if (parseIso(request.dueAt, 'scheduled continuation due_at') <= parseIso(request.now, 'request time')) {
        throw new GoalStateError('conflict', 'Scheduled continuation due time must be in the future');
      }
      const leaseDurationSeconds = current.leaseDurationSeconds;
      if (leaseDurationSeconds === undefined) throw corrupt('Active goal lease duration is missing');

      const revision = current.revision + 1;
      const trackedTasks = normalizeTrackedTasks(request.trackedTasks, request.activeTaskIds);
      const activeTaskIds = blockingTaskIds(trackedTasks);
      const leaseExpiresAt = minIso(addSeconds(request.now, leaseDurationSeconds), request.dueAt);
      const changed = this.database.connection.prepare(`
        UPDATE goals
        SET plan_json = ?, revision = ?, current_phase = ?, next_action = ?, blockers_json = ?, active_task_ids_json = ?, tracked_tasks_json = ?,
            lease_owner_client_id = ?, lease_owner_session_id = ?, lease_token_hash = ?, lease_duration_seconds = ?, lease_heartbeat_at = ?, lease_expires_at = ?,
            updated_at = ?
        WHERE id = ? AND revision = ? AND lease_token_hash = ? AND status = 'active'
      `).run(
        JSON.stringify(request.plan),
        revision,
        request.currentPhase,
        request.nextAction,
        JSON.stringify(request.blockers),
        JSON.stringify(activeTaskIds),
        JSON.stringify(trackedTasks),
        request.ownerClientId,
        request.ownerSessionId,
        request.leaseTokenHash,
        leaseDurationSeconds,
        request.now,
        leaseExpiresAt,
        request.now,
        request.goalId,
        request.expectedRevision,
        request.leaseTokenHash,
      );
      if (Number(changed.changes) !== 1) {
        throw new GoalStateError('conflict', 'Scheduled continuation prepare lost the goal compare-and-swap race');
      }
      this.insertCheckpoint({
        id: request.checkpointId,
        goalId: request.goalId,
        revision,
        currentPhase: request.currentPhase,
        summary: request.summary,
        stepUpdates: request.stepUpdates,
        nextAction: request.nextAction,
        blockers: request.blockers,
        evidence: request.evidence,
        activeTaskIds,
        trackedTasks,
        createdAt: request.now,
      });

      const generation = this.nextScheduledContinuationGeneration(request.goalId);
      this.database.connection.prepare(`
        INSERT INTO goal_scheduled_continuations (
          id, goal_id, source_session_id, generation, source_goal_revision, status, occurrence, destination,
          execution_preference, confirmed_runs_on, due_at, native_task_id, request_fingerprint,
          version, last_detail, created_at, updated_at, claimed_at, terminal_at
        ) VALUES (?, ?, ?, ?, ?, 'prepared', 'once', 'current_chat', ?, NULL, ?, NULL, ?, 0, NULL, ?, ?, NULL, NULL)
      `).run(
        request.continuationId,
        request.goalId,
        request.ownerSessionId,
        generation,
        request.expectedRevision,
        request.executionPreference,
        request.dueAt,
        request.requestFingerprint,
        request.now,
        request.now,
      );
      return {
        goal: this.requireById(request.goalId),
        continuation: this.requireScheduledContinuationById(request.continuationId),
        alreadyPrepared: false,
      };
    });
  }

  public async recordScheduledContinuationReceipt(
    request: RecordScheduledContinuationReceiptRecordRequest,
  ): Promise<ScheduledContinuationRecord> {
    return this.transaction(() => {
      const currentRow = this.selectScheduledContinuationById(request.continuationId);
      if (currentRow === undefined) throw new GoalStateError('not_found', 'Scheduled continuation was not found');
      const goal = this.requireById(currentRow.goal_id);
      this.assertOwner(goal, request.ownerClientId);
      if (currentRow.version !== request.expectedVersion) {
        throw new GoalStateError('conflict', 'Scheduled continuation version is stale');
      }

      let nextStatus = receiptStatus(request.outcome);
      let nativeTaskId = currentRow.native_task_id;
      let dueAt = currentRow.due_at;
      let pendingDueAt = currentRow.pending_due_at;
      let rescheduleReason = currentRow.reschedule_reason;
      let rescheduleCount = currentRow.reschedule_count;
      let lastRescheduledAt = currentRow.last_rescheduled_at;

      if (request.outcome === 'created') {
        if (request.nativeTaskId === undefined || request.nativeTaskId.length === 0 || request.runsOn !== 'cloud') {
          throw new GoalStateError('conflict', 'Created receipt requires a native task ID and confirmed cloud execution');
        }
        if (request.dueAt === undefined || !sameScheduledInstant(request.dueAt, currentRow.due_at)) {
          throw new GoalStateError('conflict', 'Created receipt scheduled time does not match the reserved continuation due time');
        }
        if (currentRow.native_task_id !== null && currentRow.native_task_id !== request.nativeTaskId) {
          throw new GoalStateError('conflict', 'Created receipt cannot replace the stored native task ID');
        }
        if (currentRow.native_task_id === request.nativeTaskId && currentRow.status === 'scheduled' && currentRow.confirmed_runs_on === 'cloud') {
          return this.toScheduledContinuationRecord(currentRow);
        }
        if (!['prepared', 'create_failed', 'create_uncertain'].includes(currentRow.status)) {
          throw new GoalStateError('conflict', `Created receipt cannot be recorded from status ${currentRow.status}`);
        }
        nativeTaskId = request.nativeTaskId;
      } else if (request.outcome === 'rescheduled') {
        const expectedDueAt = currentRow.pending_due_at ?? currentRow.due_at;
        if (
          currentRow.native_task_id === null
          || request.nativeTaskId !== currentRow.native_task_id
          || request.dueAt === undefined
          || !sameScheduledInstant(request.dueAt, expectedDueAt)
        ) {
          throw new GoalStateError('conflict', 'Rescheduled receipt must match the stored native task ID and absolute due time');
        }
        const confirmsPendingUpdate = currentRow.pending_due_at !== null
          && ['reschedule_required', 'reschedule_failed', 'reschedule_uncertain'].includes(currentRow.status);
        const confirmsEarlyFireCorrection = currentRow.pending_due_at === null && currentRow.status === 'scheduled';
        if (!confirmsPendingUpdate && !confirmsEarlyFireCorrection) {
          throw new GoalStateError('conflict', 'Continuation has no same-task reschedule to confirm');
        }
        nextStatus = 'scheduled';
        dueAt = expectedDueAt;
        pendingDueAt = null;
        rescheduleReason = null;
        rescheduleCount += 1;
        lastRescheduledAt = request.now;
      } else if (request.outcome === 'reschedule_failed' || request.outcome === 'reschedule_uncertain') {
        if (currentRow.native_task_id === null || currentRow.pending_due_at === null) {
          throw new GoalStateError('conflict', 'Reschedule failure receipt requires an existing pending same-task update');
        }
        if (request.nativeTaskId !== undefined && request.nativeTaskId !== currentRow.native_task_id) {
          throw new GoalStateError('conflict', 'Reschedule failure receipt cannot replace the native task ID');
        }
        if (request.dueAt !== undefined && request.dueAt !== currentRow.pending_due_at) {
          throw new GoalStateError('conflict', 'Reschedule failure receipt due time does not match the pending update');
        }
      } else if (request.outcome === 'consumed') {
        if (
          currentRow.native_task_id === null
          || request.nativeRunReceipt === undefined
          || request.nativeRunReceipt.provider !== 'chatgpt_scheduled_task'
          || request.nativeRunReceipt.operation !== 'run'
          || request.nativeRunReceipt.nativeTaskId !== currentRow.native_task_id
          || request.nativeRunReceipt.state !== 'consumed'
        ) {
          throw new GoalStateError('conflict', 'Consumed receipt requires matching native host run evidence');
        }
        if (![
          'scheduled', 'create_uncertain',
          'reschedule_required', 'reschedule_failed', 'reschedule_uncertain',
          'cancel_required', 'cancel_failed', 'cancel_uncertain',
        ].includes(currentRow.status)) {
          throw new GoalStateError('conflict', `Consumed receipt cannot be recorded from status ${currentRow.status}`);
        }
        validateIso(request.nativeRunReceipt.observedAt, 'native run observed_at');
        if (Date.parse(request.nativeRunReceipt.observedAt) < Date.parse(currentRow.created_at)) {
          throw new GoalStateError('conflict', 'Native run evidence predates scheduled continuation creation');
        }
        nextStatus = 'superseded';
        pendingDueAt = null;
        rescheduleReason = null;
      } else if (request.outcome === 'cancelled') {
        if (!['cancel_required', 'cancel_failed', 'cancel_uncertain'].includes(currentRow.status)) {
          throw new GoalStateError('conflict', `Cancelled receipt cannot be recorded from status ${currentRow.status}`);
        }
        if (currentRow.native_task_id === null || request.nativeTaskId !== currentRow.native_task_id) {
          throw new GoalStateError('conflict', 'Cancelled receipt must match the stored native task ID');
        }
        if (
          request.nativeCancellationReceipt === undefined
          || request.nativeCancellationReceipt.provider !== 'chatgpt_scheduled_task'
          || request.nativeCancellationReceipt.operation !== 'delete'
          || request.nativeCancellationReceipt.nativeTaskId !== currentRow.native_task_id
          || !['deleted', 'not_found'].includes(request.nativeCancellationReceipt.state)
        ) {
          throw new GoalStateError('conflict', 'Cancelled receipt requires matching native host deletion evidence');
        }
        validateIso(request.nativeCancellationReceipt.observedAt, 'native cancellation observed_at');
        if (
          goal.terminalAt !== undefined
          && Date.parse(request.nativeCancellationReceipt.observedAt) < Date.parse(goal.terminalAt)
        ) {
          throw new GoalStateError('conflict', 'Native cancellation evidence predates durable goal termination');
        }
      } else if (request.outcome === 'cancel_failed' || request.outcome === 'cancel_uncertain') {
        if (!['cancel_required', 'cancel_failed', 'cancel_uncertain'].includes(currentRow.status)) {
          throw new GoalStateError('conflict', `Cancellation receipt cannot be recorded from status ${currentRow.status}`);
        }
        if (request.nativeTaskId !== undefined && currentRow.native_task_id !== request.nativeTaskId) {
          throw new GoalStateError('conflict', 'Cancellation receipt must match the stored native task ID');
        }
      } else if (request.nativeTaskId !== undefined) {
        if (currentRow.native_task_id !== null && currentRow.native_task_id !== request.nativeTaskId) {
          throw new GoalStateError('conflict', 'Native task ID does not match the stored receipt');
        }
        nativeTaskId = request.nativeTaskId;
      }

      const terminalAt = isLiveScheduledStatus(nextStatus) ? null : request.now;
      const changed = this.database.connection.prepare(`
        UPDATE goal_scheduled_continuations
        SET status = ?, confirmed_runs_on = ?, native_task_id = ?, due_at = ?, pending_due_at = ?, reschedule_reason = ?,
            reschedule_count = ?, last_rescheduled_at = ?, version = version + 1,
            last_detail = ?, updated_at = ?, terminal_at = ?
        WHERE id = ? AND version = ?
      `).run(
        nextStatus,
        request.runsOn ?? currentRow.confirmed_runs_on,
        nativeTaskId,
        dueAt,
        pendingDueAt,
        rescheduleReason,
        rescheduleCount,
        lastRescheduledAt,
        request.detail ?? null,
        request.now,
        terminalAt,
        request.continuationId,
        request.expectedVersion,
      );
      if (Number(changed.changes) !== 1) throw new GoalStateError('conflict', 'Scheduled continuation receipt lost the compare-and-swap race');
      return this.requireScheduledContinuationById(request.continuationId);
    });
  }

  public async cancelScheduledContinuation(
    request: CancelScheduledContinuationRecordRequest,
  ): Promise<CancelScheduledContinuationRecordResult> {
    return this.transaction(() => {
      const row = 'continuationId' in request
        ? this.selectScheduledContinuationById(request.continuationId)
        : this.selectLatestScheduledContinuation(request.goalId);
      if (row === undefined) throw new GoalStateError('not_found', 'Scheduled continuation was not found');
      const continuation = this.toScheduledContinuationRecord(row);
      const goal = this.requireById(row.goal_id);
      this.assertOwner(goal, request.ownerClientId);
      if (continuation.version !== request.expectedVersion) throw new GoalStateError('conflict', 'Scheduled continuation version is stale');

      if (continuation.status === 'cancelled' || continuation.status === 'superseded') {
        return { outcome: 'already_cancelled', continuation };
      }
      if (continuation.status === 'claimed' || continuation.status === 'terminal_noop') {
        return { outcome: 'already_fired', continuation };
      }
      if (continuation.status === 'cancel_required' && continuation.nativeTaskId !== undefined) {
        return { outcome: 'delete_required', continuation };
      }
      if (
        (continuation.status === 'cancel_failed' || continuation.status === 'cancel_uncertain')
        && continuation.nativeTaskId !== undefined
      ) {
        const changed = this.database.connection.prepare(`
          UPDATE goal_scheduled_continuations
          SET status = 'cancel_required', version = version + 1, updated_at = ?, terminal_at = NULL
          WHERE id = ? AND version = ?
        `).run(request.now, continuation.continuationId, continuation.version);
        if (Number(changed.changes) !== 1) throw new GoalStateError('conflict', 'Scheduled continuation cancellation retry lost the compare-and-swap race');
        return { outcome: 'delete_required', continuation: this.requireScheduledContinuationById(continuation.continuationId) };
      }

      let nextStatus: ScheduledContinuationStatus;
      let outcome: CancelScheduledContinuationRecordResult['outcome'];
      if (
        continuation.nativeTaskId !== undefined
        && ['scheduled', 'create_uncertain', 'reschedule_required', 'reschedule_failed', 'reschedule_uncertain'].includes(continuation.status)
      ) {
        nextStatus = 'cancel_required';
        outcome = 'delete_required';
      } else if (continuation.nativeTaskId === undefined && (continuation.status === 'prepared' || continuation.status === 'create_failed')) {
        nextStatus = 'superseded';
        outcome = 'cancelled';
      } else {
        nextStatus = 'cancel_uncertain';
        outcome = 'native_task_unverified';
      }

      const terminalAt = isLiveScheduledStatus(nextStatus) ? null : request.now;
      const changed = this.database.connection.prepare(`
        UPDATE goal_scheduled_continuations
        SET status = ?, version = version + 1, updated_at = ?, terminal_at = ?, last_detail = ?
        WHERE id = ? AND version = ?
      `).run(
        nextStatus,
        request.now,
        terminalAt,
        'Cancellation requested by the goal owner',
        continuation.continuationId,
        continuation.version,
      );
      if (Number(changed.changes) !== 1) throw new GoalStateError('conflict', 'Scheduled continuation cancellation lost the compare-and-swap race');
      return { outcome, continuation: this.requireScheduledContinuationById(continuation.continuationId) };
    });
  }

  public async claimScheduledContinuation(
    request: ClaimScheduledContinuationRecordRequest,
  ): Promise<ClaimScheduledContinuationRecordResult> {
    return this.transaction(() => {
      const row = this.selectScheduledContinuationById(request.continuationId);
      if (row === undefined) throw new GoalStateError('not_found', 'Scheduled continuation was not found');
      const continuation = this.toScheduledContinuationRecord(row);
      const goal = this.requireById(row.goal_id);
      this.assertOwner(goal, request.ownerClientId);

      if (continuation.status === 'claimed') {
        if (goal.status !== 'active') return { outcome: 'already_claimed', continuation, goal };
        const liveSuccessor = this.selectLiveScheduledContinuation(goal.id);
        if (liveSuccessor !== undefined) {
          const observedSuccessor = this.toScheduledContinuationRecord(liveSuccessor);
          if (observedSuccessor.generation !== continuation.generation + 1) {
            throw new GoalStateError('conflict', 'Claimed continuation has an unexpected live successor generation');
          }
          if (observedSuccessor.status === 'prepared' || observedSuccessor.status === 'create_failed' || observedSuccessor.status === 'create_uncertain') {
            const prepared = this.prepareFreshClaimSuccessor(request, continuation, goal, false);
            return {
              outcome: 'successor_required',
              continuation,
              successor: prepared.successor,
              successorDisposition: prepared.disposition,
              goal,
              retryAfterSeconds: secondsBetween(request.now, prepared.successor.dueAt),
            };
          }
          return { outcome: 'already_claimed', continuation, goal };
        }
        const prepared = this.prepareFreshClaimSuccessor(request, continuation, goal, false);
        return {
          outcome: 'successor_required',
          continuation,
          successor: prepared.successor,
          successorDisposition: prepared.disposition,
          goal: this.requireById(goal.id),
          retryAfterSeconds: secondsBetween(request.now, prepared.successor.dueAt),
        };
      }
      if (continuation.status === 'superseded') {
        if (goal.status !== 'active') return { outcome: 'already_claimed', continuation, goal };
        // A fired one-time wake may have been reconciled as consumed/superseded before
        // its successor receipt was persisted. Deterministically recover that successor
        // instead of leaving an active goal with no future wake.
        const prepared = this.prepareFreshClaimSuccessor(request, continuation, goal, false);
        return {
          outcome: 'successor_required',
          continuation,
          successor: prepared.successor,
          successorDisposition: prepared.disposition,
          goal: this.requireById(goal.id),
          retryAfterSeconds: secondsBetween(request.now, prepared.successor.dueAt),
        };
      }
      if (continuation.status === 'terminal_noop') return { outcome: 'terminal_noop', continuation, goal };
      if (goal.status !== 'active') {
        const changed = this.database.connection.prepare(`
          UPDATE goal_scheduled_continuations
          SET status = 'terminal_noop', version = version + 1, updated_at = ?, terminal_at = ?
          WHERE id = ? AND version = ? AND status <> 'terminal_noop'
        `).run(request.now, request.now, request.continuationId, continuation.version);
        if (Number(changed.changes) !== 1) throw new GoalStateError('conflict', 'Scheduled terminal no-op lost the compare-and-swap race');
        return {
          outcome: 'terminal_noop',
          continuation: this.requireScheduledContinuationById(request.continuationId),
          goal: this.requireById(goal.id),
        };
      }

      if (
        continuation.status === 'reschedule_required'
        || continuation.status === 'reschedule_failed'
        || continuation.status === 'reschedule_uncertain'
      ) {
        if (continuation.nativeTaskId === undefined) {
          throw corrupt('Legacy collision continuation is missing its native task ID');
        }
        // A one-time host task that reached claim has already fired and is no longer
        // trustworthy future coverage. Recover old v4.52.1 same-task collision rows by
        // retiring the firing task and reserving a fresh deterministic successor.
        return this.prepareFreshCollisionSuccessor(request, continuation, goal, continuation.orphanProbeStartedAt);
      }
      if (!['prepared', 'scheduled', 'create_uncertain'].includes(continuation.status)) {
        throw new GoalStateError('conflict', `Scheduled continuation cannot be claimed from status ${continuation.status}`);
      }

      const nowMs = parseIso(request.now, 'request time');
      const effectiveDueAt = continuation.dueAt;
      const dueMs = parseIso(effectiveDueAt, 'scheduled continuation due_at');
      const earlyToleranceSeconds = request.earlyToleranceSeconds ?? 0;
      if (!Number.isInteger(earlyToleranceSeconds) || earlyToleranceSeconds < 0 || earlyToleranceSeconds > 300) {
        throw new GoalStateError('corrupt', 'Scheduled continuation early tolerance is invalid');
      }
      // prepared is reservation-only regardless of timing. Do not let an early wake hide a
      // missing native host receipt behind not_due.
      if (continuation.nativeTaskId === undefined || continuation.confirmedRunsOn !== 'cloud') {
        return {
          outcome: 'receipt_required',
          reason: 'native_task_unconfirmed',
          continuation,
          goal,
        };
      }
      if (nowMs + earlyToleranceSeconds * 1000 < dueMs) {
        // claim_scheduled_continuation is entered by a host wake. Once a one-time task has
        // fired, its native ID is no longer trustworthy future coverage even when the host
        // fired outside the accepted early-jitter window. Retire the firing ticket and
        // reserve a fresh adaptive successor instead of asking the host to update a task
        // that may already have been consumed.
        return this.prepareFreshCollisionSuccessor(request, continuation, goal, undefined);
      }

      // Pre-4.31 repository callers did not provide a liveness envelope. Keep
      // that shape readable during migration, but still treat any durable
      // blocking task as unknown below (so it cannot be silently bypassed).
      const liveness = request.liveness ?? {
        trustworthy: true,
        observedAt: request.now,
        leaseGeneration: goal.leaseGeneration,
        leaseActivitySeq: goal.leaseActivitySeq,
        liveFencedCallCount: 0,
        blockingTaskStates: [],
      };
      if (liveness.leaseGeneration !== goal.leaseGeneration || liveness.leaseActivitySeq !== goal.leaseActivitySeq) {
        throw new GoalStateError('conflict', 'Worker-liveness observation is stale relative to the goal lease');
      }
      const observedAtMs = parseIso(liveness.observedAt, 'worker liveness observation');
      if (observedAtMs > nowMs) throw new GoalStateError('conflict', 'Worker-liveness observation cannot be from the future');

      const trackedTasks = goal.trackedTasks ?? legacyTrackedTasks(goal.activeTaskIds);
      const blockingTasks = trackedTasks.filter((task) => task.role === 'blocking_job');
      const observedBlockingStates = liveness.blockingTaskStates
        ?? liveness.activeTaskStates?.map((entry) => ({ ...entry, provider: 'legacy_auto' as const }))
        ?? [];
      const stateByBinding = new Map(observedBlockingStates.map((entry) => [`${entry.provider}\0${entry.taskId}`, entry.state]));
      const expectedTaskStates = blockingTasks.map((task) => stateByBinding.get(`${task.provider}\0${task.taskId}`) ?? 'unknown');
      const allExpectedInactive = expectedTaskStates.every((state) => state === 'terminal' || state === 'absent');
      const hasUnknown = !liveness.trustworthy
        || expectedTaskStates.some((state) => state === 'unknown');
      const hasLiveWorker = liveness.liveFencedCallCount > 0
        || expectedTaskStates.some((state) => state === 'running');
      const confirmedInactive = !hasUnknown && !hasLiveWorker && liveness.liveFencedCallCount === 0 && allExpectedInactive;

      const matchingProbe = confirmedInactive
        && continuation.orphanProbeStartedAt !== undefined
        && continuation.orphanProbeLeaseGeneration === goal.leaseGeneration
        && continuation.orphanProbeActivitySeq === goal.leaseActivitySeq;
      if (matchingProbe) {
        const probeAgeSeconds = Math.floor((nowMs - parseIso(continuation.orphanProbeStartedAt!, 'orphan probe start')) / 1000);
        if (probeAgeSeconds >= ORPHAN_PROBE_MIN_SECONDS) {
          // Preserve the stronger two-probe orphan evidence even when the predecessor lease
          // happens to expire between probes. Otherwise timing drift changes the acquisition
          // reason and can skip the exact recovery path the probes were designed to prove.
          return this.claimContinuationLease(request, continuation, goal, 'orphan_recovered');
        }
      }

      const leaseExpiresMs = goal.leaseExpiresAt === undefined ? undefined : parseIso(goal.leaseExpiresAt, 'lease expiry');
      if (leaseExpiresMs === undefined || leaseExpiresMs <= nowMs) {
        if (!confirmedInactive) return this.prepareFreshCollisionSuccessor(request, continuation, goal, undefined);
        return this.claimContinuationLease(
          request,
          continuation,
          goal,
          leaseExpiresMs === undefined ? 'normal' : 'expired_lease',
        );
      }

      const probeStartedAt = confirmedInactive
        ? (matchingProbe ? continuation.orphanProbeStartedAt! : request.now)
        : undefined;
      return this.prepareFreshCollisionSuccessor(request, continuation, goal, probeStartedAt);
    });
  }

  private claimContinuationLease(
    request: ClaimScheduledContinuationRecordRequest,
    continuation: ScheduledContinuationRecord,
    goal: GoalRecord,
    acquisition: 'normal' | 'expired_lease' | 'orphan_recovered',
  ): ClaimScheduledContinuationRecordResult {
    const leaseExpiresAt = addSeconds(request.now, request.leaseSeconds);
    const changedGoal = this.database.connection.prepare(`
      UPDATE goals
      SET lease_owner_client_id = ?, lease_owner_session_id = ?, lease_token_hash = ?, lease_duration_seconds = ?,
          lease_generation = lease_generation + 1, lease_activity_seq = 0,
          lease_heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'active' AND revision = ? AND lease_generation = ? AND lease_activity_seq = ?
    `).run(
      request.ownerClientId,
      request.ownerSessionId,
      request.leaseTokenHash,
      request.leaseSeconds,
      request.now,
      leaseExpiresAt,
      request.now,
      goal.id,
      goal.revision,
      goal.leaseGeneration,
      goal.leaseActivitySeq,
    );
    if (Number(changedGoal.changes) !== 1) throw new GoalStateError('conflict', 'Scheduled continuation claim lost the goal lease CAS race');

    const changedContinuation = this.database.connection.prepare(`
      UPDATE goal_scheduled_continuations
      SET status = 'claimed', version = version + 1, updated_at = ?, claimed_at = ?, terminal_at = ?,
          pending_due_at = NULL, reschedule_reason = NULL,
          orphan_probe_started_at = NULL, orphan_probe_lease_generation = NULL, orphan_probe_activity_seq = NULL,
          orphan_recovery_count = orphan_recovery_count + ?
      WHERE id = ? AND version = ? AND status IN (
        'prepared','scheduled','create_uncertain',
        'reschedule_required','reschedule_failed','reschedule_uncertain'
      )
    `).run(
      request.now,
      request.now,
      request.now,
      acquisition === 'orphan_recovered' ? 1 : 0,
      request.continuationId,
      continuation.version,
    );
    if (Number(changedContinuation.changes) !== 1) {
      throw new GoalStateError('conflict', 'Scheduled continuation claim lost the continuation compare-and-swap race');
    }
    const claimedContinuation = this.requireScheduledContinuationById(request.continuationId);
    const claimedGoal = this.requireById(goal.id);
    const prepared = this.prepareFreshClaimSuccessor(request, claimedContinuation, claimedGoal, true);
    const reservedGoal = this.requireById(goal.id);
    return {
      outcome: 'acquired',
      acquisition,
      continuation: claimedContinuation,
      successor: prepared.successor,
      successorDisposition: 'freshly_reserved',
      goal: reservedGoal,
    };
  }

  private prepareFreshClaimSuccessor(
    request: ClaimScheduledContinuationRecordRequest,
    continuation: ScheduledContinuationRecord,
    goal: GoalRecord,
    requireLeaseCap: boolean,
    validateLeaseAlignedDue = true,
  ): { readonly successor: ScheduledContinuationRecord; readonly disposition: ClaimSuccessorDisposition } {
    if (continuation.nativeTaskId === undefined || continuation.confirmedRunsOn !== 'cloud') {
      throw new GoalStateError('corrupt', 'Claimed continuation is missing its confirmed native cloud task');
    }
    const identity = createHash('sha256')
      .update(`claimed-successor-v1\0${continuation.continuationId}`)
      .digest('hex');
    const successorId = `wake-${identity.slice(0, 48)}`;
    const successorRequestFingerprint = identity;
    if (request.claimSuccessorId !== successorId) {
      throw new GoalStateError('conflict', 'Claimed successor identity is not deterministic for the firing continuation');
    }
    if (request.claimSuccessorRequestFingerprint !== successorRequestFingerprint) {
      throw new GoalStateError('conflict', 'Claimed successor fingerprint is not deterministic for the firing continuation');
    }

    const existingRow = this.selectScheduledContinuationById(successorId);
    if (existingRow !== undefined) {
      const existing = this.toScheduledContinuationRecord(existingRow);
      this.assertClaimSuccessorInvariant(request, continuation, goal, existing, successorRequestFingerprint);
      const refreshed = this.refreshUnconfirmedClaimSuccessorIfStale(request, goal, existing, requireLeaseCap);
      return {
        successor: refreshed.successor,
        disposition: refreshed.disposition,
      };
    }

    const liveSuccessor = this.selectLiveScheduledContinuation(goal.id);
    if (liveSuccessor !== undefined) {
      const existing = this.toScheduledContinuationRecord(liveSuccessor);
      this.assertClaimSuccessorInvariant(request, continuation, goal, existing, successorRequestFingerprint);
      const refreshed = this.refreshUnconfirmedClaimSuccessorIfStale(request, goal, existing, requireLeaseCap);
      return {
        successor: refreshed.successor,
        disposition: refreshed.disposition,
      };
    }

    const generation = this.nextScheduledContinuationGeneration(goal.id);
    if (generation !== continuation.generation + 1) {
      throw new GoalStateError('conflict', 'Claimed successor generation is not contiguous');
    }
    const successorDueAt = request.claimSuccessorDueAt;
    const successorDelaySeconds = Math.ceil((parseIso(successorDueAt, 'claimed successor due_at') - parseIso(request.now, 'request time')) / 1000);
    if (successorDelaySeconds < CLAIM_SUCCESSOR_MIN_SECONDS || successorDelaySeconds > COLLISION_SUCCESSOR_MAX_SECONDS) {
      throw new GoalStateError('conflict', 'Claimed successor due time must be between 2 and 25 minutes after reservation');
    }
    if (validateLeaseAlignedDue) {
      const leaseAlignedMinutes = Math.min(
        COLLISION_SUCCESSOR_MAX_SECONDS / 60,
        Math.max(CLAIM_SUCCESSOR_MIN_SECONDS / 60, Math.ceil(request.leaseSeconds / 60)),
      );
      const expectedDueAt = addSeconds(request.now, leaseAlignedMinutes * 60);
      if (successorDueAt !== expectedDueAt) {
        throw new GoalStateError('conflict', 'Claimed successor due time does not match the lease-aligned adaptive deadline');
      }
    }
    this.database.connection.prepare(`
      INSERT INTO goal_scheduled_continuations (
        id, goal_id, source_session_id, generation, source_goal_revision, status, occurrence, destination,
        execution_preference, confirmed_runs_on, due_at, pending_due_at, native_task_id, request_fingerprint,
        version, reschedule_reason, reschedule_count, last_collision_at, last_rescheduled_at,
        orphan_probe_started_at, orphan_probe_lease_generation, orphan_probe_activity_seq, orphan_recovery_count,
        last_detail, created_at, updated_at, claimed_at, terminal_at
      ) VALUES (
        ?, ?, ?, ?, ?, 'prepared', 'once', 'current_chat',
        'cloud', NULL, ?, NULL, NULL, ?,
        0, NULL, 0, NULL, NULL,
        NULL, NULL, NULL, ?,
        'Successful wake claim atomically reserved the next one-time successor', ?, ?, NULL, NULL
      )
    `).run(
      successorId,
      goal.id,
      request.ownerSessionId,
      generation,
      goal.revision,
      successorDueAt,
      successorRequestFingerprint,
      continuation.orphanRecoveryCount,
      request.now,
      request.now,
    );
    this.capGoalLeaseAtClaimSuccessor(goal, successorDueAt, request.now, requireLeaseCap);
    return {
      successor: this.requireScheduledContinuationById(successorId),
      disposition: 'freshly_reserved',
    };
  }

  private assertClaimSuccessorInvariant(
    request: ClaimScheduledContinuationRecordRequest,
    continuation: ScheduledContinuationRecord,
    goal: GoalRecord,
    successor: ScheduledContinuationRecord,
    expectedFingerprint: string,
  ): void {
    if (
      successor.goalId !== goal.id
      || successor.continuationId !== request.claimSuccessorId
      || successor.generation !== continuation.generation + 1
      || successor.requestFingerprint !== expectedFingerprint
      || successor.sourceGoalRevision < continuation.sourceGoalRevision
      || successor.sourceGoalRevision > goal.revision
      || !['prepared', 'create_failed', 'create_uncertain'].includes(successor.status)
    ) {
      throw new GoalStateError('conflict', 'Claimed continuation has an invalid deterministic successor');
    }
    // Concurrent callers may derive different +2 request instants. Once a
    // successor exists, its transaction-authored dueAt is canonical.
    parseIso(successor.dueAt, 'claimed successor due_at');
  }

  private refreshUnconfirmedClaimSuccessorIfStale(
    request: ClaimScheduledContinuationRecordRequest,
    goal: GoalRecord,
    successor: ScheduledContinuationRecord,
    requireLeaseCap: boolean,
  ): {
    readonly successor: ScheduledContinuationRecord;
    readonly disposition: Extract<ClaimSuccessorDisposition, 'existing_unconfirmed' | 'retryable_failed_create' | 'refreshed_failed_create'>;
  } {
    const safelyRecreatable = successor.nativeTaskId === undefined && successor.status === 'create_failed';
    if (safelyRecreatable) {
      if (parseIso(successor.dueAt, 'claimed successor due_at') > parseIso(request.now, 'request time')) {
        this.capGoalLeaseAtClaimSuccessor(goal, successor.dueAt, request.now, requireLeaseCap);
        return { successor, disposition: 'retryable_failed_create' };
      }
      const refreshedDueAt = request.claimSuccessorDueAt;
      const refreshedDelaySeconds = Math.ceil((parseIso(refreshedDueAt, 'claimed successor retry due_at') - parseIso(request.now, 'request time')) / 1000);
      if (refreshedDelaySeconds < CLAIM_SUCCESSOR_MIN_SECONDS || refreshedDelaySeconds > COLLISION_SUCCESSOR_MAX_SECONDS) {
        throw new GoalStateError('conflict', 'Claimed successor retry due time is outside the supported adaptive range');
      }
      const changed = this.database.connection.prepare(`
        UPDATE goal_scheduled_continuations
        SET status = 'prepared', due_at = ?, version = version + 1, updated_at = ?,
            last_detail = 'Truthfully failed claimed successor creation refreshed to the current adaptive retry deadline'
        WHERE id = ? AND version = ? AND native_task_id IS NULL AND status = 'create_failed'
      `).run(refreshedDueAt, request.now, successor.continuationId, successor.version);
      if (Number(changed.changes) !== 1) {
        throw new GoalStateError('conflict', 'Claimed successor refresh lost the compare-and-swap race');
      }
      this.capGoalLeaseAtClaimSuccessor(goal, refreshedDueAt, request.now, requireLeaseCap);
      return {
        successor: this.requireScheduledContinuationById(successor.continuationId),
        disposition: 'refreshed_failed_create',
      };
    }
    this.capGoalLeaseAtClaimSuccessor(goal, successor.dueAt, request.now, requireLeaseCap);
    return { successor, disposition: 'existing_unconfirmed' };
  }

  private capGoalLeaseAtClaimSuccessor(
    goal: GoalRecord,
    successorDueAt: string,
    now: string,
    required: boolean,
  ): void {
    if (goal.leaseExpiresAt === undefined) {
      if (required) throw corrupt('Active goal lease expiry is missing after scheduled claim');
      return;
    }
    const leaseExpiresAt = minIso(goal.leaseExpiresAt, successorDueAt);
    const cappedGoal = this.database.connection.prepare(`
      UPDATE goals
      SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'active' AND revision = ? AND lease_generation = ?
    `).run(
      leaseExpiresAt,
      now,
      goal.id,
      goal.revision,
      goal.leaseGeneration,
    );
    if (Number(cappedGoal.changes) !== 1) {
      throw new GoalStateError('conflict', 'Claimed successor failed to cap the acquired goal lease');
    }
  }

  private prepareFreshCollisionSuccessor(
    request: ClaimScheduledContinuationRecordRequest,
    continuation: ScheduledContinuationRecord,
    goal: GoalRecord,
    probeStartedAt: string | undefined,
  ): ClaimScheduledContinuationRecordResult {
    if (continuation.nativeTaskId === undefined || continuation.confirmedRunsOn !== 'cloud') {
      throw new GoalStateError('conflict', 'Collision recovery requires a confirmed firing cloud native task ID');
    }

    const delaySeconds = adaptiveCollisionSuccessorSeconds(request, continuation, goal, probeStartedAt !== undefined);
    const successorDueAt = addSeconds(request.now, delaySeconds);
    const changed = this.database.connection.prepare(`
      UPDATE goal_scheduled_continuations
      SET status = 'superseded', pending_due_at = NULL, reschedule_reason = NULL,
          reschedule_count = reschedule_count + 1, last_collision_at = ?,
          orphan_probe_started_at = ?, orphan_probe_lease_generation = ?, orphan_probe_activity_seq = ?,
          version = version + 1, updated_at = ?, terminal_at = ?,
          last_detail = 'Firing one-time wake collided with an active or uncertain worker; retired it and reserved adaptive fresh successor coverage'
      WHERE id = ? AND version = ? AND status IN (
        'prepared','scheduled','create_uncertain',
        'reschedule_required','reschedule_failed','reschedule_uncertain'
      )
    `).run(
      request.now,
      probeStartedAt ?? null,
      probeStartedAt === undefined ? null : goal.leaseGeneration,
      probeStartedAt === undefined ? null : goal.leaseActivitySeq,
      request.now,
      request.now,
      continuation.continuationId,
      continuation.version,
    );
    if (Number(changed.changes) !== 1) {
      throw new GoalStateError('conflict', 'Fresh collision successor lost the firing continuation CAS race');
    }

    const retired = this.requireScheduledContinuationById(continuation.continuationId);
    const prepared = this.prepareFreshClaimSuccessor(
      { ...request, claimSuccessorDueAt: successorDueAt },
      retired,
      goal,
      false,
      false,
    );
    this.database.connection.prepare(`
      UPDATE goal_scheduled_continuations
      SET reschedule_count = ?, last_collision_at = ?,
          orphan_probe_started_at = ?, orphan_probe_lease_generation = ?, orphan_probe_activity_seq = ?,
          last_detail = 'Adaptive collision successor reserved from consumed firing wake'
      WHERE id = ?
    `).run(
      retired.rescheduleCount,
      request.now,
      probeStartedAt ?? null,
      probeStartedAt === undefined ? null : goal.leaseGeneration,
      probeStartedAt === undefined ? null : goal.leaseActivitySeq,
      prepared.successor.continuationId,
    );
    const successor = this.requireScheduledContinuationById(prepared.successor.continuationId);
    return {
      outcome: 'successor_required',
      goal: this.requireById(goal.id),
      continuation: retired,
      successor,
      successorDisposition: prepared.disposition,
      retryAfterSeconds: secondsBetween(request.now, successor.dueAt),
    };
  }

  public async expediteScheduledContinuation(
    request: ExpediteScheduledContinuationRecordRequest,
  ): Promise<ExpediteScheduledContinuationRecordResult> {
    return this.transaction(() => {
      const row = this.selectScheduledContinuationById(request.continuationId);
      if (row === undefined) throw new GoalStateError('not_found', 'Scheduled continuation was not found');
      if (row.goal_id !== request.goalId) throw new GoalStateError('conflict', 'Scheduled continuation belongs to another goal');
      const goal = this.requireById(request.goalId);
      this.assertOwner(goal, request.ownerClientId);
      this.assertMutableLease(
        goal,
        request.ownerClientId,
        request.ownerSessionId,
        request.leaseTokenHash,
        request.expectedGoalRevision,
        request.now,
      );
      if (goal.leaseGeneration !== request.expectedLeaseGeneration) {
        throw new GoalStateError('conflict', 'Goal lease generation is stale');
      }
      if (row.version !== request.expectedContinuationVersion) {
        throw new GoalStateError('conflict', 'Scheduled continuation version is stale');
      }
      const continuation = this.toScheduledContinuationRecord(row);
      if (
        continuation.status === 'reschedule_required'
        || continuation.status === 'reschedule_failed'
        || continuation.status === 'reschedule_uncertain'
      ) {
        if (continuation.pendingDueAt === undefined || continuation.nativeTaskId === undefined) {
          throw corrupt('Pending expedite is missing its task identity or due time');
        }
        return { outcome: 'update_required', goal, continuation };
      }
      if (continuation.status !== 'scheduled') {
        throw new GoalStateError('conflict', `Scheduled continuation cannot be expedited from status ${continuation.status}`);
      }
      if (continuation.nativeTaskId === undefined || continuation.confirmedRunsOn !== 'cloud') {
        throw new GoalStateError('conflict', 'Expedite requires a confirmed cloud native task ID');
      }
      const candidateDueAt = request.dueAt;
      const expediteDelaySeconds = Math.ceil((parseIso(candidateDueAt, 'expedite due_at') - parseIso(request.now, 'expedite request time')) / 1000);
      if (expediteDelaySeconds < EXPEDITE_MIN_SECONDS || expediteDelaySeconds > EXPEDITE_MAX_SECONDS) {
        throw new GoalStateError('conflict', 'Expedite due time is outside the adaptive host handoff window');
      }
      if (parseIso(continuation.dueAt, 'scheduled continuation due_at') <= parseIso(candidateDueAt, 'expedite due_at')) {
        return { outcome: 'unchanged', reason: 'already_due_within_two_minutes', goal, continuation };
      }
      const changed = this.database.connection.prepare(`
        UPDATE goal_scheduled_continuations
        SET status = 'reschedule_required', pending_due_at = ?, reschedule_reason = ?,
            version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'scheduled'
      `).run(
        candidateDueAt,
        `expedite:${request.reason}`,
        request.now,
        continuation.continuationId,
        continuation.version,
      );
      if (Number(changed.changes) !== 1) throw new GoalStateError('conflict', 'Expedite lost the continuation compare-and-swap race');
      return {
        outcome: 'update_required',
        goal: this.requireById(goal.id),
        continuation: this.requireScheduledContinuationById(continuation.continuationId),
      };
    });
  }

  public async getScheduledContinuation(
    request: GetScheduledContinuationRecordRequest,
  ): Promise<ScheduledContinuationRecord | null> {
    const row = 'continuationId' in request
      ? this.selectScheduledContinuationById(request.continuationId)
      : this.selectLatestScheduledContinuation(request.goalId);
    return row === undefined ? null : this.toScheduledContinuationRecord(row);
  }

  public async getLiveScheduledContinuation(goalId: string): Promise<ScheduledContinuationRecord | null> {
    const row = this.selectLiveScheduledContinuation(goalId);
    return row === undefined ? null : this.toScheduledContinuationRecord(row);
  }

  public async getWorkspaceMutationFence(workspaceId: string): Promise<ScheduledContinuationMutationFence | null> {
    const value = this.database.connection.prepare(`
      SELECT g.id AS goal_id, c.id AS continuation_id
      FROM goals g
      JOIN goal_scheduled_continuations c ON c.goal_id = g.id
      WHERE g.workspace_id = ? AND g.status = 'active'
        AND c.status IN (
          'prepared','scheduled','create_uncertain',
          'reschedule_required','reschedule_failed','reschedule_uncertain'
        )
      ORDER BY c.generation DESC
      LIMIT 1
    `).get(workspaceId);
    if (value === undefined) return null;
    if (!isRecord(value) || typeof value.goal_id !== 'string' || typeof value.continuation_id !== 'string') {
      throw corrupt('Scheduled continuation mutation fence query is invalid');
    }
    return {
      goal: this.requireById(value.goal_id),
      continuation: this.requireScheduledContinuationById(value.continuation_id),
    };
  }

  public async beginGoalFencedMutation(
    request: BeginGoalFencedMutationRequest,
  ): Promise<GoalFencedMutationAdmission> {
    return this.transaction(() => {
      const goal = this.requireById(request.goalId);
      if (goal.workspaceId !== request.workspaceId) throw new GoalStateError('conflict', 'Goal fence workspace does not match the request');
      this.assertOwner(goal, request.ownerClientId);
      if (goal.status !== 'active') throw new GoalStateError('terminal', 'Goal is already terminal');
      if (goal.leaseTokenHash !== request.leaseTokenHash || goal.leaseGeneration !== request.leaseGeneration) {
        throw new GoalStateError('lease_invalid', 'Goal lease token or generation is invalid');
      }
      if (goal.leaseExpiresAt === undefined || parseIso(goal.leaseExpiresAt, 'lease expiry') <= parseIso(request.startedAt, 'mutation start')) {
        throw new GoalStateError('lease_invalid', 'Goal lease has expired');
      }
      const fence = this.selectMutationFenceContinuation(goal.id);
      if (fence === undefined) throw new GoalStateError('conflict', 'Goal has no live scheduled-continuation fence');
      const effectiveDueAt = mutationFenceDueAt(fence);
      if (parseIso(effectiveDueAt, 'scheduled continuation handoff') <= parseIso(request.startedAt, 'mutation start')) {
        throw new GoalStateError('lease_invalid', 'Goal handoff deadline has passed');
      }
      const leaseDurationSeconds = goal.leaseDurationSeconds;
      if (leaseDurationSeconds === undefined) throw corrupt('Active goal lease duration is missing');
      const renewedLeaseExpiresAt = minIso(addSeconds(request.startedAt, leaseDurationSeconds), effectiveDueAt);

      const changed = this.database.connection.prepare(`
        UPDATE goals
        SET lease_activity_seq = lease_activity_seq + 1, lease_heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active' AND lease_token_hash = ? AND lease_generation = ? AND lease_activity_seq = ?
      `).run(
        request.startedAt,
        renewedLeaseExpiresAt,
        request.startedAt,
        goal.id,
        request.leaseTokenHash,
        request.leaseGeneration,
        goal.leaseActivitySeq,
      );
      if (Number(changed.changes) !== 1) throw new GoalStateError('conflict', 'Goal mutation admission lost the lease CAS race');

      this.database.connection.prepare(`
        INSERT INTO goal_fenced_mutation_calls (
          call_id, goal_id, lease_generation, started_at, heartbeat_at, expires_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)
      `).run(
        request.callId,
        goal.id,
        request.leaseGeneration,
        request.startedAt,
        request.startedAt,
        request.expiresAt,
      );
      return { goalId: goal.id, leaseGeneration: request.leaseGeneration };
    });
  }

  public async heartbeatGoalFencedMutation(
    callId: string,
    leaseGeneration: number,
    heartbeatAt: string,
    expiresAt: string,
  ): Promise<void> {
    this.transaction(() => {
      const call = this.database.connection.prepare(`
        SELECT goal_id FROM goal_fenced_mutation_calls
        WHERE call_id = ? AND lease_generation = ? AND completed_at IS NULL
      `).get(callId, leaseGeneration);
      if (!isRecord(call) || typeof call.goal_id !== 'string') {
        throw new GoalStateError('conflict', 'Fenced mutation heartbeat no longer owns a live call');
      }
      const goal = this.requireById(call.goal_id);
      if (goal.status !== 'active' || goal.leaseGeneration !== leaseGeneration) {
        throw new GoalStateError('lease_invalid', 'Goal lease generation is no longer active');
      }
      if (goal.leaseExpiresAt === undefined || parseIso(goal.leaseExpiresAt, 'lease expiry') <= parseIso(heartbeatAt, 'mutation heartbeat')) {
        throw new GoalStateError('lease_invalid', 'Goal lease has expired');
      }
      const leaseDurationSeconds = goal.leaseDurationSeconds;
      if (leaseDurationSeconds === undefined) throw corrupt('Active goal lease duration is missing');
      const fence = this.selectMutationFenceContinuation(goal.id);
      if (fence === undefined) throw new GoalStateError('conflict', 'Goal has no live scheduled-continuation fence');
      const effectiveDueAt = mutationFenceDueAt(fence);
      if (parseIso(effectiveDueAt, 'scheduled continuation handoff') <= parseIso(heartbeatAt, 'mutation heartbeat')) {
        throw new GoalStateError('lease_invalid', 'Goal handoff deadline has passed');
      }
      const renewedLeaseExpiresAt = minIso(addSeconds(heartbeatAt, leaseDurationSeconds), effectiveDueAt);

      const changed = this.database.connection.prepare(`
        UPDATE goal_fenced_mutation_calls
        SET heartbeat_at = ?, expires_at = ?
        WHERE call_id = ? AND lease_generation = ? AND completed_at IS NULL
      `).run(heartbeatAt, expiresAt, callId, leaseGeneration);
      if (Number(changed.changes) !== 1) throw new GoalStateError('conflict', 'Fenced mutation heartbeat no longer owns a live call');

      const renewed = this.database.connection.prepare(`
        UPDATE goals
        SET lease_activity_seq = lease_activity_seq + 1, lease_heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active' AND lease_generation = ? AND lease_activity_seq = ?
      `).run(
        heartbeatAt,
        renewedLeaseExpiresAt,
        heartbeatAt,
        goal.id,
        leaseGeneration,
        goal.leaseActivitySeq,
      );
      if (Number(renewed.changes) !== 1) throw new GoalStateError('conflict', 'Goal heartbeat lost the lease CAS race');
    });
  }

  public async endGoalFencedMutation(callId: string, completedAt: string): Promise<void> {
    this.transaction(() => {
      this.database.connection.prepare(`
        UPDATE goal_fenced_mutation_calls
        SET completed_at = ?
        WHERE call_id = ? AND completed_at IS NULL
      `).run(completedAt, callId);
    });
  }

  public async observeGoalFencedMutations(goalId: string, now: string): Promise<GoalFencedMutationObservation> {
    const goal = this.requireById(goalId);
    const value = this.database.connection.prepare(`
      SELECT COUNT(*) AS live_count
      FROM goal_fenced_mutation_calls
      WHERE goal_id = ? AND lease_generation = ? AND completed_at IS NULL AND expires_at > ?
    `).get(goalId, goal.leaseGeneration, now);
    if (!isRecord(value) || typeof value.live_count !== 'number') throw corrupt('Fenced mutation observation is invalid');
    return {
      workspaceId: goal.workspaceId,
      leaseGeneration: goal.leaseGeneration,
      leaseActivitySeq: goal.leaseActivitySeq,
      liveFencedCallCount: value.live_count,
    };
  }

  public async markGoalFinishedForScheduledContinuation(
    goalId: string,
    now: string,
  ): Promise<GoalScheduledContinuationFinishResult> {
    return this.transaction(() => {
      const row = this.selectLiveScheduledContinuation(goalId);
      if (row === undefined) return { continuation: null };
      let nextStatus: ScheduledContinuationStatus;
      if (
        row.native_task_id !== null
        && ['scheduled', 'create_uncertain', 'reschedule_required', 'reschedule_failed', 'reschedule_uncertain'].includes(row.status)
      ) {
        const effectiveDueAt = row.pending_due_at ?? row.due_at;
        nextStatus = new Date(effectiveDueAt).getTime() <= new Date(now).getTime()
          ? 'cancel_uncertain'
          : 'cancel_required';
      }
      else if (row.status === 'cancel_required' || row.status === 'cancel_failed' || row.status === 'cancel_uncertain') {
        return { continuation: this.toScheduledContinuationRecord(row) };
      } else if (row.native_task_id === null && row.status === 'prepared') nextStatus = 'superseded';
      else nextStatus = 'cancel_uncertain';

      const terminalAt = isLiveScheduledStatus(nextStatus) ? null : now;
      const changed = this.database.connection.prepare(`
        UPDATE goal_scheduled_continuations
        SET status = ?, version = version + 1, updated_at = ?, terminal_at = ?
        WHERE id = ? AND version = ?
      `).run(nextStatus, now, terminalAt, row.id, row.version);
      if (Number(changed.changes) !== 1) throw new GoalStateError('conflict', 'Scheduled continuation finish marker lost the compare-and-swap race');
      return { continuation: this.requireScheduledContinuationById(row.id) };
    });
  }

  private insertCheckpoint(checkpoint: GoalCheckpointRecord): void {
    this.database.connection.prepare(`
      INSERT INTO goal_checkpoints (
        id, goal_id, revision, current_phase, summary, step_updates_json,
        next_action, blockers_json, evidence_json, active_task_ids_json, tracked_tasks_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkpoint.id,
      checkpoint.goalId,
      checkpoint.revision,
      checkpoint.currentPhase,
      checkpoint.summary,
      JSON.stringify(checkpoint.stepUpdates),
      checkpoint.nextAction,
      JSON.stringify(checkpoint.blockers),
      JSON.stringify(checkpoint.evidence),
      JSON.stringify(checkpoint.activeTaskIds),
      JSON.stringify(checkpoint.trackedTasks ?? legacyTrackedTasks(checkpoint.activeTaskIds)),
      checkpoint.createdAt,
    );
  }

  private assertMutableLease(goal: GoalRecord, ownerClientId: string, ownerSessionId: string, tokenHash: string, revision: number, now: string): void {
    if (goal.status !== 'active') throw new GoalStateError('terminal', 'Goal is already terminal');
    if (goal.revision !== revision) throw new GoalStateError('conflict', 'Goal revision is stale');
    if (goal.leaseOwnerClientId !== ownerClientId || goal.leaseOwnerSessionId !== ownerSessionId || goal.leaseTokenHash !== tokenHash) {
      throw new GoalStateError('lease_invalid', 'Goal lease token or session is invalid');
    }
    if (goal.leaseExpiresAt === undefined || parseIso(goal.leaseExpiresAt, 'lease expiry') <= parseIso(now, 'request time')) {
      throw new GoalStateError('lease_invalid', 'Goal lease has expired');
    }
  }

  private assertOwner(goal: GoalRecord, ownerClientId: string): void {
    if (goal.ownerClientId !== ownerClientId) throw new GoalStateError('owner_mismatch', 'Goal belongs to another client');
  }

  private requireById(goalId: string): GoalRecord {
    const row = this.selectById(goalId);
    if (row === undefined) throw new GoalStateError('not_found', 'Goal was not found');
    return this.toGoalRecord(row);
  }

  private selectById(goalId: string): GoalRow | undefined {
    const row = this.database.connection.prepare('SELECT * FROM goals WHERE id = ?').get(goalId);
    return row === undefined ? undefined : this.requireGoalRow(row);
  }

  private selectByKey(workspaceId: string, goalKey: string): GoalRow | undefined {
    const row = this.database.connection.prepare('SELECT * FROM goals WHERE workspace_id = ? AND goal_key = ?').get(workspaceId, goalKey);
    return row === undefined ? undefined : this.requireGoalRow(row);
  }

  private toGoalRecord(row: GoalRow): GoalRecord {
    const status = parseGoalStatus(row.status);
    const plan = parsePlan(row.plan_json);
    const blockers = parseStringArray(row.blockers_json, 'goal blockers');
    const trackedTasks = parseTrackedTasks(row.tracked_tasks_json, row.active_task_ids_json, 'goal tracked tasks');
    const activeTaskIds = blockingTaskIds(trackedTasks);
    const terminalEvidence = row.terminal_evidence_json === null ? undefined : parseEvidence(row.terminal_evidence_json, 'terminal evidence');
    const checkpoints = this.database.connection.prepare(
      'SELECT * FROM goal_checkpoints WHERE goal_id = ? ORDER BY revision ASC',
    ).all(row.id).map((value) => this.toCheckpoint(this.requireCheckpointRow(value)));

    if (!Number.isInteger(row.revision) || row.revision < 0) throw corrupt('Goal revision is invalid');
    if (checkpoints.length !== row.revision) throw corrupt('Goal checkpoint history does not match the current revision');
    checkpoints.forEach((checkpoint, index) => {
      if (checkpoint.revision !== index + 1) throw corrupt('Goal checkpoint revisions are not contiguous');
    });
    validateIso(row.created_at, 'goal created_at');
    validateIso(row.updated_at, 'goal updated_at');
    validateLeaseState(row, status);
    validateTerminalState(row, status);

    return {
      id: row.id,
      goalKey: row.goal_key,
      workspaceId: row.workspace_id,
      ownerClientId: row.owner_client_id,
      objective: row.objective,
      plan,
      status,
      revision: row.revision,
      currentPhase: row.current_phase,
      nextAction: row.next_action,
      blockers,
      activeTaskIds,
      trackedTasks,
      ...(row.lease_owner_client_id === null ? {} : { leaseOwnerClientId: row.lease_owner_client_id }),
      ...(row.lease_owner_session_id === null ? {} : { leaseOwnerSessionId: row.lease_owner_session_id }),
      ...(row.lease_token_hash === null ? {} : { leaseTokenHash: row.lease_token_hash }),
      ...(row.lease_duration_seconds === null ? {} : { leaseDurationSeconds: row.lease_duration_seconds }),
      leaseGeneration: row.lease_generation,
      leaseActivitySeq: row.lease_activity_seq,
      ...(row.lease_heartbeat_at === null ? {} : { leaseHeartbeatAt: row.lease_heartbeat_at }),
      ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.terminal_summary === null ? {} : { terminalSummary: row.terminal_summary }),
      ...(terminalEvidence === undefined ? {} : { terminalEvidence }),
      ...(row.terminal_at === null ? {} : { terminalAt: row.terminal_at }),
      checkpoints,
    };
  }

  private toCheckpoint(row: CheckpointRow): GoalCheckpointRecord {
    if (!Number.isInteger(row.revision) || row.revision <= 0) throw corrupt('Checkpoint revision is invalid');
    validateIso(row.created_at, 'checkpoint created_at');
    return {
      id: row.id,
      goalId: row.goal_id,
      revision: row.revision,
      currentPhase: row.current_phase,
      summary: row.summary,
      stepUpdates: parseStepUpdates(row.step_updates_json),
      nextAction: row.next_action,
      blockers: parseStringArray(row.blockers_json, 'checkpoint blockers'),
      evidence: parseEvidence(row.evidence_json, 'checkpoint evidence'),
      activeTaskIds: blockingTaskIds(parseTrackedTasks(row.tracked_tasks_json, row.active_task_ids_json, 'checkpoint tracked tasks')),
      trackedTasks: parseTrackedTasks(row.tracked_tasks_json, row.active_task_ids_json, 'checkpoint tracked tasks'),
      createdAt: row.created_at,
    };
  }

  private requireGoalRow(value: unknown): GoalRow {
    if (!isRecord(value)) throw corrupt('Goal row is invalid');
    const requiredStrings = ['id','workspace_id','goal_key','owner_client_id','objective','plan_json','status','current_phase','next_action','blockers_json','active_task_ids_json','created_at','updated_at'];
    if (!requiredStrings.every((key) => typeof value[key] === 'string') || typeof value.revision !== 'number') throw corrupt('Goal row fields are invalid');
    const nullableStrings = ['tracked_tasks_json','lease_owner_client_id','lease_owner_session_id','lease_token_hash','lease_heartbeat_at','lease_expires_at','terminal_summary','terminal_evidence_json','terminal_at'];
    if (!nullableStrings.every((key) => value[key] === null || typeof value[key] === 'string')) throw corrupt('Goal nullable fields are invalid');
    if (value.lease_duration_seconds !== null && typeof value.lease_duration_seconds !== 'number') throw corrupt('Goal lease duration is invalid');
    if (typeof value.lease_generation !== 'number' || !Number.isInteger(value.lease_generation) || value.lease_generation < 0) throw corrupt('Goal lease generation is invalid');
    if (typeof value.lease_activity_seq !== 'number' || !Number.isInteger(value.lease_activity_seq) || value.lease_activity_seq < 0) throw corrupt('Goal lease activity sequence is invalid');
    return value as unknown as GoalRow;
  }

  private requireCheckpointRow(value: unknown): CheckpointRow {
    if (!isRecord(value)) throw corrupt('Goal checkpoint row is invalid');
    const strings = ['id','goal_id','current_phase','summary','step_updates_json','next_action','blockers_json','evidence_json','active_task_ids_json','created_at'];
    if (value.tracked_tasks_json !== null && typeof value.tracked_tasks_json !== 'string') throw corrupt('Goal checkpoint tracked tasks are invalid');
    if (!strings.every((key) => typeof value[key] === 'string') || typeof value.revision !== 'number') throw corrupt('Goal checkpoint row fields are invalid');
    return value as unknown as CheckpointRow;
  }

  private selectScheduledContinuationById(continuationId: string): ScheduledContinuationRow | undefined {
    const row = this.database.connection.prepare('SELECT * FROM goal_scheduled_continuations WHERE id = ?').get(continuationId);
    return row === undefined ? undefined : this.requireScheduledContinuationRow(row);
  }

  private selectScheduledContinuationByFingerprint(
    goalId: string,
    sourceGoalRevision: number,
    requestFingerprint: string,
  ): ScheduledContinuationRow | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM goal_scheduled_continuations
      WHERE goal_id = ? AND source_goal_revision = ? AND request_fingerprint = ?
    `).get(goalId, sourceGoalRevision, requestFingerprint);
    return row === undefined ? undefined : this.requireScheduledContinuationRow(row);
  }

  private selectLiveScheduledContinuation(goalId: string): ScheduledContinuationRow | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM goal_scheduled_continuations
      WHERE goal_id = ?
        AND status IN (
          'prepared','scheduled','create_uncertain',
          'reschedule_required','reschedule_failed','reschedule_uncertain',
          'cancel_required','cancel_failed','cancel_uncertain'
        )
      ORDER BY generation DESC LIMIT 1
    `).get(goalId);
    return row === undefined ? undefined : this.requireScheduledContinuationRow(row);
  }

  private selectMutationFenceContinuation(goalId: string): ScheduledContinuationRow | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM goal_scheduled_continuations
      WHERE goal_id = ?
        AND status IN (
          'prepared','scheduled','create_uncertain',
          'reschedule_required','reschedule_failed','reschedule_uncertain'
        )
      ORDER BY generation DESC LIMIT 1
    `).get(goalId);
    return row === undefined ? undefined : this.requireScheduledContinuationRow(row);
  }

  private selectLatestScheduledContinuation(goalId: string): ScheduledContinuationRow | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM goal_scheduled_continuations
      WHERE goal_id = ? ORDER BY generation DESC LIMIT 1
    `).get(goalId);
    return row === undefined ? undefined : this.requireScheduledContinuationRow(row);
  }

  private selectActiveScheduledGoalId(workspaceId: string): string | undefined {
    const value = this.database.connection.prepare(`
      SELECT g.id AS goal_id
      FROM goals g
      WHERE g.workspace_id = ? AND g.status = 'active'
        AND EXISTS (
          SELECT 1 FROM goal_scheduled_continuations c
          WHERE c.goal_id = g.id
            AND c.status IN (
              'prepared','scheduled','create_uncertain',
              'reschedule_required','reschedule_failed','reschedule_uncertain',
              'cancel_required','cancel_failed','cancel_uncertain'
            )
        )
      ORDER BY g.updated_at DESC, g.id DESC
      LIMIT 1
    `).get(workspaceId);
    if (value === undefined) return undefined;
    if (!isRecord(value) || typeof value.goal_id !== 'string') throw corrupt('Active scheduled goal query is invalid');
    return value.goal_id;
  }

  private nextScheduledContinuationGeneration(goalId: string): number {
    const row = this.database.connection.prepare(`
      SELECT COALESCE(MAX(generation), 0) AS generation
      FROM goal_scheduled_continuations WHERE goal_id = ?
    `).get(goalId);
    if (!isRecord(row) || typeof row.generation !== 'number' || !Number.isInteger(row.generation) || row.generation < 0) {
      throw corrupt('Scheduled continuation generation query is invalid');
    }
    return row.generation + 1;
  }

  private requireScheduledContinuationById(continuationId: string): ScheduledContinuationRecord {
    const row = this.selectScheduledContinuationById(continuationId);
    if (row === undefined) throw new GoalStateError('not_found', 'Scheduled continuation was not found');
    return this.toScheduledContinuationRecord(row);
  }

  private requireScheduledContinuationRow(value: unknown): ScheduledContinuationRow {
    if (!isRecord(value)) throw corrupt('Scheduled continuation row is invalid');
    const requiredStrings = [
      'id', 'goal_id', 'source_session_id', 'status', 'occurrence', 'destination', 'execution_preference',
      'due_at', 'request_fingerprint', 'created_at', 'updated_at',
    ];
    if (!requiredStrings.every((key) => typeof value[key] === 'string')) {
      throw corrupt('Scheduled continuation string fields are invalid');
    }
    const nullableStrings = [
      'confirmed_runs_on', 'native_task_id', 'last_detail', 'claimed_at', 'terminal_at',
      'pending_due_at', 'reschedule_reason', 'last_collision_at', 'last_rescheduled_at', 'orphan_probe_started_at',
    ];
    if (!nullableStrings.every((key) => value[key] === null || typeof value[key] === 'string')) {
      throw corrupt('Scheduled continuation nullable fields are invalid');
    }
    for (const key of ['generation', 'source_goal_revision', 'version', 'reschedule_count', 'orphan_recovery_count']) {
      if (typeof value[key] !== 'number' || !Number.isInteger(value[key]) || value[key] < 0) {
        throw corrupt(`Scheduled continuation ${key} is invalid`);
      }
    }
    for (const key of ['orphan_probe_lease_generation', 'orphan_probe_activity_seq']) {
      if (value[key] !== null && (typeof value[key] !== 'number' || !Number.isInteger(value[key]) || value[key] < 0)) {
        throw corrupt(`Scheduled continuation ${key} is invalid`);
      }
    }
    return value as unknown as ScheduledContinuationRow;
  }

  private toScheduledContinuationRecord(row: ScheduledContinuationRow): ScheduledContinuationRecord {
    const status = parseScheduledContinuationStatus(row.status);
    if (row.occurrence !== 'once') throw corrupt('Scheduled continuation occurrence is invalid');
    if (row.destination !== 'current_chat') throw corrupt('Scheduled continuation destination is invalid');
    if (row.execution_preference !== 'auto' && row.execution_preference !== 'cloud' && row.execution_preference !== 'local') {
      throw corrupt('Scheduled continuation execution preference is invalid');
    }
    if (row.confirmed_runs_on !== null && row.confirmed_runs_on !== 'cloud' && row.confirmed_runs_on !== 'local' && row.confirmed_runs_on !== 'unverified') {
      throw corrupt('Scheduled continuation confirmed runsOn is invalid');
    }
    if (row.generation <= 0 || row.source_goal_revision < 0 || row.version < 0) throw corrupt('Scheduled continuation numeric state is invalid');
    validateIso(row.due_at, 'scheduled continuation due_at');
    validateIso(row.created_at, 'scheduled continuation created_at');
    validateIso(row.updated_at, 'scheduled continuation updated_at');
    if (row.claimed_at !== null) validateIso(row.claimed_at, 'scheduled continuation claimed_at');
    if (row.terminal_at !== null) validateIso(row.terminal_at, 'scheduled continuation terminal_at');
    if (row.pending_due_at !== null) validateIso(row.pending_due_at, 'scheduled continuation pending_due_at');
    if (row.last_collision_at !== null) validateIso(row.last_collision_at, 'scheduled continuation last_collision_at');
    if (row.last_rescheduled_at !== null) validateIso(row.last_rescheduled_at, 'scheduled continuation last_rescheduled_at');
    if (row.orphan_probe_started_at !== null) validateIso(row.orphan_probe_started_at, 'scheduled continuation orphan_probe_started_at');
    if (row.reschedule_reason !== null && !isScheduledRescheduleReason(row.reschedule_reason)) throw corrupt('Scheduled continuation reschedule reason is invalid');
    return {
      continuationId: row.id,
      goalId: row.goal_id,
      generation: row.generation,
      sourceGoalRevision: row.source_goal_revision,
      status,
      occurrence: 'once',
      destination: 'current_chat',
      executionPreference: row.execution_preference,
      ...(row.confirmed_runs_on === null ? {} : { confirmedRunsOn: row.confirmed_runs_on }),
      dueAt: row.due_at,
      ...(row.native_task_id === null ? {} : { nativeTaskId: row.native_task_id }),
      ...(row.pending_due_at === null ? {} : { pendingDueAt: row.pending_due_at }),
      ...(row.reschedule_reason === null ? {} : { rescheduleReason: row.reschedule_reason }),
      rescheduleCount: row.reschedule_count,
      ...(row.last_collision_at === null ? {} : { lastCollisionAt: row.last_collision_at }),
      ...(row.last_rescheduled_at === null ? {} : { lastRescheduledAt: row.last_rescheduled_at }),
      ...(row.orphan_probe_started_at === null ? {} : { orphanProbeStartedAt: row.orphan_probe_started_at }),
      ...(row.orphan_probe_lease_generation === null ? {} : { orphanProbeLeaseGeneration: row.orphan_probe_lease_generation }),
      ...(row.orphan_probe_activity_seq === null ? {} : { orphanProbeActivitySeq: row.orphan_probe_activity_seq }),
      orphanRecoveryCount: row.orphan_recovery_count,
      sourceSessionId: row.source_session_id,
      requestFingerprint: row.request_fingerprint,
      version: row.version,
      ...(row.last_detail === null ? {} : { lastDetail: row.last_detail }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
      ...(row.terminal_at === null ? {} : { terminalAt: row.terminal_at }),
    };
  }

  private transaction<T>(operation: () => T): T {
    const connection: DatabaseSync = this.database.connection;
    connection.exec('BEGIN IMMEDIATE;');
    try {
      const value = operation();
      connection.exec('COMMIT;');
      return value;
    } catch (error) {
      connection.exec('ROLLBACK;');
      throw error;
    }
  }
}

function mutationFenceDueAt(row: ScheduledContinuationRow): string {
  // A confirmed reschedule failure means the host kept the original schedule;
  // pending_due_at is only the attempted update and must not become a phantom fence.
  if (row.status === 'reschedule_failed') return row.due_at;
  return row.pending_due_at ?? row.due_at;
}

function adaptiveCollisionSuccessorSeconds(
  request: ClaimScheduledContinuationRecordRequest,
  continuation: ScheduledContinuationRecord,
  goal: GoalRecord,
  orphanProbeActive: boolean,
): number {
  const earlyToleranceSeconds = request.earlyToleranceSeconds ?? 0;
  const exponent = Math.min(Math.max(continuation.rescheduleCount, 0), 3);
  const exponentialBackoff = Math.min(
    COLLISION_SUCCESSOR_MAX_SECONDS,
    COLLISION_SUCCESSOR_MIN_SECONDS * (2 ** exponent),
  );
  const orphanProbeFloor = orphanProbeActive
    ? ORPHAN_PROBE_MIN_SECONDS + earlyToleranceSeconds
    : 0;
  const nowMs = parseIso(request.now, 'request time');
  const remainingLeaseSeconds = goal.leaseExpiresAt === undefined
    ? 0
    : Math.max(0, Math.ceil((parseIso(goal.leaseExpiresAt, 'lease expiry') - nowMs) / 1000));
  const leaseAlignedDelay = remainingLeaseSeconds > 0
    ? remainingLeaseSeconds + earlyToleranceSeconds
    : 0;
  const adaptiveFloor = orphanProbeActive
    ? Math.max(COLLISION_SUCCESSOR_MIN_SECONDS, exponentialBackoff, orphanProbeFloor)
    : Math.max(COLLISION_SUCCESSOR_MIN_SECONDS, exponentialBackoff, leaseAlignedDelay);
  return Math.min(COLLISION_SUCCESSOR_MAX_SECONDS, adaptiveFloor);
}

function secondsBetween(from: string, to: string): number {
  return Math.max(1, Math.ceil((parseIso(to, 'future due_at') - parseIso(from, 'request time')) / 1000));
}

function validateLeaseState(row: GoalRow, status: GoalStatus): void {
  const fields = [
    row.lease_owner_client_id,
    row.lease_owner_session_id,
    row.lease_token_hash,
    row.lease_duration_seconds,
    row.lease_heartbeat_at,
    row.lease_expires_at,
  ];
  const present = fields.filter((value) => value !== null).length;
  if (present !== 0 && present !== fields.length) throw corrupt('Goal lease state is partial');
  if (status !== 'active' && present !== 0) throw corrupt('Terminal goal still holds a lease');
  if (present === 0) return;
  if (!Number.isInteger(row.lease_duration_seconds) || (row.lease_duration_seconds ?? 0) <= 0) throw corrupt('Goal lease duration is invalid');
  validateIso(row.lease_heartbeat_at!, 'goal lease_heartbeat_at');
  validateIso(row.lease_expires_at!, 'goal lease_expires_at');
}

function validateTerminalState(row: GoalRow, status: GoalStatus): void {
  const fields = [row.terminal_summary, row.terminal_evidence_json, row.terminal_at];
  const present = fields.filter((value) => value !== null).length;
  if (status === 'active') {
    if (present !== 0) throw corrupt('Active goal has terminal outcome data');
    return;
  }
  if (present !== fields.length) throw corrupt('Terminal goal outcome is incomplete');
  validateIso(row.terminal_at!, 'goal terminal_at');
}

function parseScheduledContinuationStatus(value: string): ScheduledContinuationStatus {
  switch (value) {
    case 'prepared':
    case 'scheduled':
    case 'create_failed':
    case 'create_uncertain':
    case 'reschedule_required':
    case 'reschedule_failed':
    case 'reschedule_uncertain':
    case 'claimed':
    case 'terminal_noop':
    case 'superseded':
    case 'cancel_required':
    case 'cancelled':
    case 'cancel_failed':
    case 'cancel_uncertain':
      return value;
    default:
      throw corrupt('Scheduled continuation status is invalid');
  }
}

function isLiveScheduledStatus(value: string): boolean {
  return (LIVE_CONTINUATION_STATUSES as readonly string[]).includes(value);
}

function receiptStatus(outcome: RecordScheduledContinuationReceiptRecordRequest['outcome']): ScheduledContinuationStatus {
  if (outcome === 'created' || outcome === 'rescheduled') return 'scheduled';
  if (outcome === 'consumed') return 'superseded';
  return outcome;
}

function isScheduledRescheduleReason(value: string): value is ScheduledContinuationRescheduleReason {
  return value === 'collision'
    || value === 'expedite:host_deadline_warning'
    || value === 'expedite:host_budget_warning'
    || value === 'expedite:tool_access_degradation'
    || value === 'expedite:turn_yield_signal';
}

function parseGoalStatus(value: string): GoalStatus {
  if (value === 'active' || value === 'completed' || value === 'failed' || value === 'blocked' || value === 'cancelled') return value;
  throw corrupt('Goal status is invalid');
}

function trackedTasksAtCancellation(goal: GoalRecord): readonly GoalTrackedTask[] {
  const latest = goal.checkpoints.at(-1);
  const tracked = latest?.trackedTasks ?? latest?.activeTaskIds.map((taskId) => legacyTrackedTask(taskId)) ?? [];
  return tracked;
}

function normalizeTrackedTasks(
  trackedTasks: readonly GoalTrackedTask[] | undefined,
  activeTaskIds: readonly string[],
): readonly GoalTrackedTask[] {
  if (trackedTasks !== undefined) {
    const seen = new Set<string>();
    return trackedTasks.map((task) => {
      const validated = validateTrackedTask(task);
      const key = `${validated.provider}\0${validated.taskId}`;
      if (seen.has(key)) throw corrupt('Tracked task bindings are duplicated');
      seen.add(key);
      return validated;
    });
  }
  return activeTaskIds.map((taskId) => legacyTrackedTask(taskId));
}

function parseTrackedTasks(
  serialized: string | null,
  legacyActiveTaskIds: string,
  label: string,
): readonly GoalTrackedTask[] {
  if (serialized === null) {
    const legacy = parseStringArray(legacyActiveTaskIds, `${label} legacy active tasks`);
    if (legacy.length > MAX_TRACKED_TASKS) throw corrupt(`${label} exceeds the maximum task count`);
    return legacy.map((taskId) => legacyTrackedTask(taskId));
  }
  const value = parseJson(serialized, label);
  if (!Array.isArray(value)) throw corrupt(`${label} is invalid`);
  if (value.length > MAX_TRACKED_TASKS) throw corrupt(`${label} exceeds the maximum task count`);
  const seen = new Set<string>();
  return value.map((entry) => {
    const task = validateTrackedTask(entry, label);
    const key = `${task.provider}\0${task.taskId}`;
    if (seen.has(key)) throw corrupt(`${label} bindings are duplicated`);
    seen.add(key);
    return task;
  });
}

function validateTrackedTask(value: unknown, label = 'tracked task'): GoalTrackedTask {
  if (!isRecord(value) || typeof value.taskId !== 'string' || value.taskId.trim().length === 0 || value.taskId.length > 256) throw corrupt(`${label} task ID is invalid`);
  if (value.provider === 'legacy_auto') {
    if (value.role !== 'blocking_job' || value.cancelWithGoal !== true) throw corrupt(`${label} legacy binding is invalid`);
    return { taskId: value.taskId.trim(), provider: 'legacy_auto', role: 'blocking_job', cancelWithGoal: true };
  }
  if (value.provider !== 'process' && value.provider !== 'codex' && value.provider !== 'shell') throw corrupt(`${label} provider is invalid`);
  if (value.role !== 'blocking_job' && value.role !== 'supporting_service') throw corrupt(`${label} role is invalid`);
  if (typeof value.cancelWithGoal !== 'boolean') throw corrupt(`${label} cancellation policy is invalid`);
  return {
    taskId: value.taskId.trim(),
    provider: value.provider,
    role: value.role,
    cancelWithGoal: value.cancelWithGoal,
  };
}

function legacyTrackedTask(taskId: string): GoalTrackedTask {
  return { taskId, provider: 'legacy_auto', role: 'blocking_job', cancelWithGoal: true };
}

function blockingTaskIds(tasks: readonly GoalTrackedTask[]): readonly string[] {
  return tasks.filter((task) => task.role === 'blocking_job').map((task) => task.taskId);
}

function legacyTrackedTasks(activeTaskIds: readonly string[]): readonly GoalTrackedTask[] {
  return activeTaskIds.map((taskId) => legacyTrackedTask(taskId));
}

function parsePlan(serialized: string): GoalPlan {
  const value = parseJson(serialized, 'goal plan');
  if (!isRecord(value) || !Array.isArray(value.steps)) throw corrupt('Goal plan is invalid');
  return { steps: value.steps.map(parsePlanStep) };
}

function parsePlanStep(value: unknown): GoalPlanStep {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string' || !isStepStatus(value.status)) throw corrupt('Goal plan step is invalid');
  if (value.summary !== undefined && typeof value.summary !== 'string') throw corrupt('Goal plan step summary is invalid');
  return { id: value.id, title: value.title, status: value.status, ...(value.summary === undefined ? {} : { summary: value.summary }) };
}

function parseStepUpdates(serialized: string): readonly GoalStepUpdate[] {
  const value = parseJson(serialized, 'goal step updates');
  if (!Array.isArray(value)) throw corrupt('Goal step updates are invalid');
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.stepId !== 'string' || !isStepStatus(entry.status)) throw corrupt('Goal step update is invalid');
    if (entry.summary !== undefined && typeof entry.summary !== 'string') throw corrupt('Goal step update summary is invalid');
    return { stepId: entry.stepId, status: entry.status, ...(entry.summary === undefined ? {} : { summary: entry.summary }) };
  });
}

function parseEvidence(serialized: string, label: string): readonly GoalEvidence[] {
  const value = parseJson(serialized, label);
  if (!Array.isArray(value)) throw corrupt(`${label} is invalid`);
  return value.map((entry) => {
    if (!isRecord(entry) || !isEvidenceKind(entry.kind) || typeof entry.value !== 'string') throw corrupt(`${label} entry is invalid`);
    return { kind: entry.kind, value: entry.value };
  });
}

function parseStringArray(serialized: string, label: string): readonly string[] {
  const value = parseJson(serialized, label);
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) throw corrupt(`${label} is invalid`);
  return value;
}

function parseJson(serialized: string, label: string): unknown {
  try { return JSON.parse(serialized) as unknown; }
  catch { throw corrupt(`${label} JSON is corrupt`); }
}

function isStepStatus(value: unknown): value is GoalStepStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'blocked';
}

function isEvidenceKind(value: unknown): value is GoalEvidence['kind'] {
  return value === 'path' || value === 'hash' || value === 'task' || value === 'note';
}

function addSeconds(now: string, seconds: number): string {
  return new Date(parseIso(now, 'request time') + seconds * 1000).toISOString();
}

function minIso(left: string, right: string): string {
  return parseIso(left, 'left time') <= parseIso(right, 'right time') ? left : right;
}

function sameScheduledInstant(left: string, right: string): boolean {
  return Math.abs(parseIso(left, 'host scheduled time') - parseIso(right, 'reserved scheduled time')) <= SCHEDULE_RECEIPT_TIME_TOLERANCE_MS;
}

function validateIso(value: string, label: string): void { parseIso(value, label); }
function parseIso(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw corrupt(`${label} is invalid`);
  return parsed;
}
function corrupt(message: string): GoalStateError { return new GoalStateError('corrupt', message); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
