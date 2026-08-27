import type { DatabaseSync } from 'node:sqlite';
import {
  GoalStateError,
  type AcquireGoalRecordRequest,
  type AcquireGoalRecordResult,
  type CheckpointGoalRecordRequest,
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
  type ListGoalRecordsRequest,
} from '@lnwjud/domain';
import type { SqliteDatabase } from './database.js';

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
  readonly lease_owner_client_id: string | null;
  readonly lease_token_hash: string | null;
  readonly lease_duration_seconds: number | null;
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
  readonly created_at: string;
}

export class SqliteGoalRepository implements GoalRepository {
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
            current_phase, next_action, blockers_json, active_task_ids_json,
            lease_owner_client_id, lease_token_hash, lease_duration_seconds, lease_heartbeat_at, lease_expires_at,
            created_at, updated_at, terminal_summary, terminal_evidence_json, terminal_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', 0, 'created', '', '[]', '[]', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
        `).run(
          request.goalId,
          request.workspaceId,
          request.goalKey,
          request.ownerClientId,
          request.objective,
          JSON.stringify(request.plan),
          request.ownerClientId,
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
        SET lease_owner_client_id = ?, lease_token_hash = ?, lease_duration_seconds = ?,
            lease_heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'active' AND revision = ?
      `).run(
        request.ownerClientId,
        request.leaseTokenHash,
        request.leaseSeconds,
        request.now,
        leaseExpiresAt,
        request.now,
        existing.id,
        existing.revision,
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
      this.assertMutableLease(current, request.ownerClientId, request.leaseTokenHash, request.expectedRevision, request.now);
      const leaseDurationSeconds = current.leaseDurationSeconds;
      if (leaseDurationSeconds === undefined) throw corrupt('Active goal lease duration is missing');
      const revision = current.revision + 1;
      const leaseExpiresAt = request.releaseLease ? null : addSeconds(request.now, leaseDurationSeconds);
      const changed = this.database.connection.prepare(`
        UPDATE goals
        SET plan_json = ?, revision = ?, current_phase = ?, next_action = ?, blockers_json = ?, active_task_ids_json = ?,
            lease_owner_client_id = ?, lease_token_hash = ?, lease_duration_seconds = ?, lease_heartbeat_at = ?, lease_expires_at = ?,
            updated_at = ?
        WHERE id = ? AND revision = ? AND lease_token_hash = ? AND status = 'active'
      `).run(
        JSON.stringify(request.plan),
        revision,
        request.currentPhase,
        request.nextAction,
        JSON.stringify(request.blockers),
        JSON.stringify(request.activeTaskIds),
        request.releaseLease ? null : request.ownerClientId,
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
        activeTaskIds: request.activeTaskIds,
        createdAt: request.now,
      });
      return this.requireById(request.goalId);
    });
  }

  public async finish(request: FinishGoalRecordRequest): Promise<GoalRecord> {
    return this.transaction(() => {
      const current = this.requireById(request.goalId);
      this.assertOwner(current, request.ownerClientId);
      this.assertMutableLease(current, request.ownerClientId, request.leaseTokenHash, request.expectedRevision, request.now);
      const revision = current.revision + 1;
      const changed = this.database.connection.prepare(`
        UPDATE goals
        SET status = ?, revision = ?, current_phase = ?, next_action = '', blockers_json = '[]', active_task_ids_json = '[]',
            lease_owner_client_id = NULL, lease_token_hash = NULL, lease_duration_seconds = NULL,
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
        createdAt: request.now,
      });
      return this.requireById(request.goalId);
    });
  }

  private insertCheckpoint(checkpoint: GoalCheckpointRecord): void {
    this.database.connection.prepare(`
      INSERT INTO goal_checkpoints (
        id, goal_id, revision, current_phase, summary, step_updates_json,
        next_action, blockers_json, evidence_json, active_task_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      checkpoint.createdAt,
    );
  }

  private assertMutableLease(goal: GoalRecord, ownerClientId: string, tokenHash: string, revision: number, now: string): void {
    if (goal.status !== 'active') throw new GoalStateError('terminal', 'Goal is already terminal');
    if (goal.revision !== revision) throw new GoalStateError('conflict', 'Goal revision is stale');
    if (goal.leaseOwnerClientId !== ownerClientId || goal.leaseTokenHash !== tokenHash) {
      throw new GoalStateError('lease_invalid', 'Goal lease token is invalid');
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
    const activeTaskIds = parseStringArray(row.active_task_ids_json, 'goal active tasks');
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
      ...(row.lease_owner_client_id === null ? {} : { leaseOwnerClientId: row.lease_owner_client_id }),
      ...(row.lease_token_hash === null ? {} : { leaseTokenHash: row.lease_token_hash }),
      ...(row.lease_duration_seconds === null ? {} : { leaseDurationSeconds: row.lease_duration_seconds }),
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
      activeTaskIds: parseStringArray(row.active_task_ids_json, 'checkpoint active tasks'),
      createdAt: row.created_at,
    };
  }

  private requireGoalRow(value: unknown): GoalRow {
    if (!isRecord(value)) throw corrupt('Goal row is invalid');
    const requiredStrings = ['id','workspace_id','goal_key','owner_client_id','objective','plan_json','status','current_phase','next_action','blockers_json','active_task_ids_json','created_at','updated_at'];
    if (!requiredStrings.every((key) => typeof value[key] === 'string') || typeof value.revision !== 'number') throw corrupt('Goal row fields are invalid');
    const nullableStrings = ['lease_owner_client_id','lease_token_hash','lease_heartbeat_at','lease_expires_at','terminal_summary','terminal_evidence_json','terminal_at'];
    if (!nullableStrings.every((key) => value[key] === null || typeof value[key] === 'string')) throw corrupt('Goal nullable fields are invalid');
    if (value.lease_duration_seconds !== null && typeof value.lease_duration_seconds !== 'number') throw corrupt('Goal lease duration is invalid');
    return value as unknown as GoalRow;
  }

  private requireCheckpointRow(value: unknown): CheckpointRow {
    if (!isRecord(value)) throw corrupt('Goal checkpoint row is invalid');
    const strings = ['id','goal_id','current_phase','summary','step_updates_json','next_action','blockers_json','evidence_json','active_task_ids_json','created_at'];
    if (!strings.every((key) => typeof value[key] === 'string') || typeof value.revision !== 'number') throw corrupt('Goal checkpoint row fields are invalid');
    return value as unknown as CheckpointRow;
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

function validateLeaseState(row: GoalRow, status: GoalStatus): void {
  const fields = [
    row.lease_owner_client_id,
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

function parseGoalStatus(value: string): GoalStatus {
  if (value === 'active' || value === 'completed' || value === 'failed' || value === 'blocked') return value;
  throw corrupt('Goal status is invalid');
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

function validateIso(value: string, label: string): void { parseIso(value, label); }
function parseIso(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw corrupt(`${label} is invalid`);
  return parsed;
}
function corrupt(message: string): GoalStateError { return new GoalStateError('corrupt', message); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
