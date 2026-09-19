import {
  AutomationStateError,
  validateAutomationMilestoneGraph,
  type AutomationAttemptRecord,
  type AutomationAttemptStatus,
  type AutomationDispatchReceiptRecord,
  type AutomationDispatchReceiptWrite,
  type AutomationDispatchState,
  type AutomationEventMetadata,
  type AutomationEventRecord,
  type AutomationEventType,
  type AutomationMilestoneRecord,
  type AutomationMilestoneSpec,
  type AutomationMilestoneStatus,
  type AutomationRepository,
  type AutomationRetryPolicy,
  type AutomationRunRecord,
  type AutomationRunSnapshot,
  type AutomationRunStatus,
  type AutomationTaskBindingRecord,
  type AutomationTaskBindingWrite,
  type AutomationTaskObservationUpdate,
  type AutomationTaskObservedState,
  type AutomationTaskProvider,
  type AutomationVerificationRequirement,
  type CommitAutomationTransitionRequest,
  type CreateAutomationRunRecordRequest,
  type GoalEvidence,
  type GoalTrackedTaskRole,
} from '@lnwjud/domain';
import type { SqliteDatabase } from './database.js';
interface AutomationRunRow {
  readonly id: string;
  readonly goal_id: string;
  readonly workspace_id: string;
  readonly policy_profile: string;
  readonly revision: number;
  readonly status: string;
  readonly based_on_goal_revision: number;
  readonly based_on_user_intent_revision: number;
  readonly current_milestone_id: string | null;
  readonly current_attempt_id: string | null;
  readonly last_recovery_decision: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly terminal_at: string | null;
}

interface AutomationMilestoneRow {
  readonly id: string;
  readonly run_id: string;
  readonly ordinal: number;
  readonly title: string;
  readonly depends_on_json: string;
  readonly execution_intent: string;
  readonly verification_requirements_json: string;
  readonly retry_policy_json: string;
  readonly status: string;
  readonly current_attempt_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface AutomationAttemptRow {
  readonly id: string;
  readonly run_id: string;
  readonly milestone_id: string;
  readonly sequence: number;
  readonly based_on_run_revision: number;
  readonly based_on_goal_revision: number;
  readonly based_on_user_intent_revision: number;
  readonly status: string;
  readonly failure_code: string | null;
  readonly failure_detail: string | null;
  readonly verification_evidence_json: string;
  readonly started_at: string;
  readonly updated_at: string;
  readonly finished_at: string | null;
}

interface AutomationTaskBindingRow {
  readonly attempt_id: string;
  readonly provider: string;
  readonly task_id: string;
  readonly role: string;
  readonly cancel_with_goal: number;
  readonly bound_at: string;
  readonly deadline_at: string | null;
  readonly last_observed_at: string | null;
  readonly last_state: string | null;
  readonly last_detail: string | null;
  readonly terminal_at: string | null;
}

interface AutomationDispatchReceiptRow {
  readonly id: string;
  readonly run_id: string;
  readonly milestone_id: string;
  readonly attempt_id: string;
  readonly operation_key: string;
  readonly state: string;
  readonly provider: string | null;
  readonly idempotency_key: string | null;
  readonly external_id: string | null;
  readonly deadline_at: string | null;
  readonly detail: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface AutomationEventRow {
  readonly id: string;
  readonly run_id: string;
  readonly milestone_id: string | null;
  readonly attempt_id: string | null;
  readonly revision_before: number;
  readonly revision_after: number;
  readonly type: string;
  readonly reason: string;
  readonly metadata_json: string;
  readonly created_at: string;
}
interface GoalAuthorityRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly revision: number;
  readonly user_intent_revision: number;
  readonly status: string;
}

const MAX_MILESTONES = 100;
const MAX_ID = 256;
const MAX_TITLE = 512;
const MAX_INTENT = 4_096;
const MAX_POLICY_PROFILE = 128;
const MAX_REASON = 1_024;
const MAX_RECOVERY_DECISION = 2_048;
const MAX_FAILURE_TEXT = 2_048;
const MAX_EVENT_METADATA_KEYS = 50;
const MAX_EVENT_METADATA_STRING = 2_048;
const MAX_VERIFICATION_REQUIREMENTS = 50;
const MAX_DEPENDENCIES = 100;

export class SqliteAutomationRepository implements AutomationRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async createRun(
    request: CreateAutomationRunRecordRequest,
  ): Promise<AutomationRunSnapshot> {
    validateCreateRequest(request);
    validateAutomationMilestoneGraph(request.milestones);
    const db = this.database.connection;
    db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.getRunRowByGoalId(request.goalId);
      if (existing !== undefined) {
        const snapshot = this.snapshotFromRunRow(existing);
        assertCreateReplayMatches(snapshot, request);
        db.exec('COMMIT;');
        return snapshot;
      }

      const goal = db.prepare(
        'SELECT id, workspace_id, revision, user_intent_revision, status FROM goals WHERE id = ?',
      ).get(request.goalId) as GoalAuthorityRow | undefined;
      if (goal === undefined) {
        throw new AutomationStateError('not_found', 'Automation goal was not found');
      }
      if (goal.workspace_id !== request.workspaceId) {
        throw new AutomationStateError('conflict', 'Automation workspace does not match the goal workspace');
      }
      if (goal.status !== 'active') {
        throw new AutomationStateError('conflict', 'Automation can only bind to an active durable goal');
      }
      if (
        goal.revision !== request.basedOnGoalRevision
        || goal.user_intent_revision !== request.basedOnUserIntentRevision
      ) {
        throw new AutomationStateError(
          'conflict',
          'Automation create request is stale relative to the durable goal revision',
        );
      }

      db.prepare(`
        INSERT INTO automation_runs (
          id, goal_id, workspace_id, policy_profile, revision, status,
          based_on_goal_revision, based_on_user_intent_revision,
          current_milestone_id, current_attempt_id, last_recovery_decision,
          created_at, updated_at, terminal_at
        ) VALUES (?, ?, ?, ?, 0, 'planned', ?, ?, NULL, NULL, NULL, ?, ?, NULL)
      `).run(
        request.runId,
        request.goalId,
        request.workspaceId,
        request.policyProfile,
        request.basedOnGoalRevision,
        request.basedOnUserIntentRevision,
        request.createdAt,
        request.createdAt,
      );

      const insertMilestone = db.prepare(`
        INSERT INTO automation_milestones (
          id, run_id, ordinal, title, depends_on_json, execution_intent,
          verification_requirements_json, retry_policy_json, status,
          current_attempt_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
      `);
      request.milestones.forEach((milestone, ordinal) => {
        insertMilestone.run(
          milestone.id,
          request.runId,
          ordinal,
          milestone.title,
          JSON.stringify(milestone.dependsOn),
          milestone.executionIntent,
          JSON.stringify(milestone.verificationRequirements),
          JSON.stringify(milestone.retryPolicy),
          request.createdAt,
          request.createdAt,
        );
      });

      db.prepare(`
        INSERT INTO automation_events (
          id, run_id, milestone_id, attempt_id, revision_before, revision_after,
          type, reason, metadata_json, created_at
        ) VALUES (?, ?, NULL, NULL, 0, 0, 'run_created', 'automation_run_created', ?, ?)
      `).run(
        request.eventId,
        request.runId,
        JSON.stringify({
          milestoneCount: request.milestones.length,
          policyProfile: request.policyProfile,
        }),
        request.createdAt,
      );

      const created = this.snapshotById(request.runId);
      if (created === null) {
        throw new AutomationStateError('corrupt', 'Automation run disappeared after create');
      }
      db.exec('COMMIT;');
      return created;
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }

  public async getRunById(runId: string): Promise<AutomationRunSnapshot | null> {
    assertBoundedString(runId, 'runId', MAX_ID);
    return this.snapshotById(runId);
  }

  public async getRunByGoalId(goalId: string): Promise<AutomationRunSnapshot | null> {
    assertBoundedString(goalId, 'goalId', MAX_ID);
    const row = this.getRunRowByGoalId(goalId);
    return row === undefined ? null : this.snapshotFromRunRow(row);
  }

  public async listRuns(limit: number): Promise<readonly AutomationRunSnapshot[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new AutomationStateError('conflict', 'Automation run limit must be between 1 and 100');
    }
    const rows = this.database.connection.prepare(
      'SELECT * FROM automation_runs ORDER BY updated_at DESC, id DESC LIMIT ?',
    ).all(limit) as unknown as AutomationRunRow[];
    return rows.map((row) => this.snapshotFromRunRow(row));
  }

  public async listEvents(
    runId: string,
    limit: number,
  ): Promise<readonly AutomationEventRecord[]> {
    assertBoundedString(runId, 'runId', MAX_ID);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new AutomationStateError('conflict', 'Automation event limit must be between 1 and 500');
    }
    const rows = this.database.connection.prepare(`
      SELECT * FROM automation_events
      WHERE run_id = ?
      ORDER BY revision_after DESC, created_at DESC, id DESC
      LIMIT ?
    `).all(runId, limit) as unknown as AutomationEventRow[];
    return rows.map((row) => this.eventFromRow(row));
  }

  public async commitTransition(
    request: CommitAutomationTransitionRequest,
  ): Promise<AutomationRunSnapshot> {
    validateTransitionRequest(request);
    const db = this.database.connection;
    db.exec('BEGIN IMMEDIATE;');
    try {
      const runRow = this.getRunRowById(request.runId);
      if (runRow === undefined) {
        throw new AutomationStateError('not_found', 'Automation run was not found');
      }
      if (runRow.revision !== request.expectedRevision) {
        throw new AutomationStateError('conflict', 'Automation run revision changed concurrently');
      }
      this.assertGoalAuthorityForTransition(runRow, request);
      const nextRevision = request.expectedRevision + 1;
      if (request.createAttempt !== undefined) {
        this.insertAttempt(request);
      }
      for (const update of request.attemptUpdates ?? []) {
        this.updateAttempt(request.runId, update, request.now);
      }
      for (const binding of request.taskBindings ?? []) {
        this.insertTaskBinding(request.runId, binding);
      }
      for (const observation of request.taskObservationUpdates ?? []) {
        this.updateTaskObservation(request.runId, observation);
      }
      for (const receipt of request.dispatchReceipts ?? []) {
        this.upsertDispatchReceipt(request.runId, receipt, request.now);
      }
      for (const update of request.milestoneUpdates ?? []) {
        this.updateMilestone(request.runId, update, request.now);
      }

      const current = this.requireRunRecord(runRow);
      const patch = request.runPatch;
      const nextCurrentMilestoneId = patch?.currentMilestoneId === undefined
        ? current.currentMilestoneId ?? null
        : patch.currentMilestoneId;
      const nextCurrentAttemptId = patch?.currentAttemptId === undefined
        ? current.currentAttemptId ?? null
        : patch.currentAttemptId;

      this.assertCurrentReferences(
        request.runId,
        nextCurrentMilestoneId,
        nextCurrentAttemptId,
      );

      db.prepare(`
        UPDATE automation_runs
        SET revision = ?, status = ?, based_on_goal_revision = ?,
            based_on_user_intent_revision = ?, current_milestone_id = ?,
            current_attempt_id = ?, last_recovery_decision = ?,
            updated_at = ?, terminal_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        nextRevision,
        patch?.status ?? current.status,
        patch?.basedOnGoalRevision ?? current.basedOnGoalRevision,
        patch?.basedOnUserIntentRevision ?? current.basedOnUserIntentRevision,
        nextCurrentMilestoneId,
        nextCurrentAttemptId,
        patch?.lastRecoveryDecision === undefined
          ? current.lastRecoveryDecision ?? null
          : patch.lastRecoveryDecision,
        request.now,
        patch?.terminalAt === undefined ? current.terminalAt ?? null : patch.terminalAt,
        request.runId,
        request.expectedRevision,
      );

      this.insertTransitionEvents(request, nextRevision);
      const snapshot = this.snapshotById(request.runId);
      if (snapshot === null) {
        throw new AutomationStateError('corrupt', 'Automation run disappeared after transition');
      }
      db.exec('COMMIT;');
      return snapshot;
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }

  private assertGoalAuthorityForTransition(
    runRow: AutomationRunRow,
    request: CommitAutomationTransitionRequest,
  ): void {
    const goal = this.database.connection.prepare(
      'SELECT id, workspace_id, revision, user_intent_revision, status FROM goals WHERE id = ?',
    ).get(runRow.goal_id) as GoalAuthorityRow | undefined;
    if (goal === undefined) {
      throw new AutomationStateError('not_found', 'Automation durable goal was not found');
    }
    if (goal.workspace_id !== runRow.workspace_id) {
      throw new AutomationStateError('corrupt', 'Automation run workspace no longer matches its durable goal');
    }

    const targetGoalRevision = request.runPatch?.basedOnGoalRevision ?? runRow.based_on_goal_revision;
    const targetIntentRevision = request.runPatch?.basedOnUserIntentRevision
      ?? runRow.based_on_user_intent_revision;
    if (
      goal.revision !== targetGoalRevision
      || goal.user_intent_revision !== targetIntentRevision
    ) {
      throw new AutomationStateError(
        'conflict',
        'Automation transition is stale relative to the durable goal authority',
      );
    }

    const targetRunStatus = request.runPatch?.status ?? runRow.status;
    const terminalStatusMatches =
      (goal.status === 'completed' && targetRunStatus === 'completed')
      || (goal.status === 'failed' && targetRunStatus === 'failed')
      || (goal.status === 'blocked' && targetRunStatus === 'blocked')
      || (goal.status === 'cancelled' && targetRunStatus === 'cancelled');
    if (goal.status !== 'active' && !terminalStatusMatches) {
      throw new AutomationStateError(
        'conflict',
        'Automation terminal state does not match the durable goal terminal state',
      );
    }
  }

  private snapshotById(runId: string): AutomationRunSnapshot | null {
    const row = this.getRunRowById(runId);
    return row === undefined ? null : this.snapshotFromRunRow(row);
  }

  private getRunRowById(runId: string): AutomationRunRow | undefined {
    return this.database.connection.prepare(
      'SELECT * FROM automation_runs WHERE id = ?',
    ).get(runId) as AutomationRunRow | undefined;
  }

  private getRunRowByGoalId(goalId: string): AutomationRunRow | undefined {
    return this.database.connection.prepare(
      'SELECT * FROM automation_runs WHERE goal_id = ?',
    ).get(goalId) as AutomationRunRow | undefined;
  }

  private snapshotFromRunRow(row: AutomationRunRow): AutomationRunSnapshot {
    const run = this.requireRunRecord(row);
    const milestones = this.database.connection.prepare(
      'SELECT * FROM automation_milestones WHERE run_id = ? ORDER BY ordinal ASC',
    ).all(row.id) as unknown as AutomationMilestoneRow[];
    const attempts = this.database.connection.prepare(
      'SELECT * FROM automation_attempts WHERE run_id = ? ORDER BY started_at ASC, sequence ASC, id ASC',
    ).all(row.id) as unknown as AutomationAttemptRow[];
    const taskBindings = this.database.connection.prepare(`
      SELECT binding.*
      FROM automation_task_bindings binding
      INNER JOIN automation_attempts attempt ON attempt.id = binding.attempt_id
      WHERE attempt.run_id = ?
      ORDER BY binding.bound_at ASC, binding.task_id ASC
    `).all(row.id) as unknown as AutomationTaskBindingRow[];
    const receipts = this.database.connection.prepare(
      'SELECT * FROM automation_dispatch_receipts WHERE run_id = ? ORDER BY created_at ASC, id ASC',
    ).all(row.id) as unknown as AutomationDispatchReceiptRow[];

    const parsedMilestones = milestones.map((milestone) => this.milestoneFromRow(milestone));
    const parsedAttempts = attempts.map((attempt) => this.attemptFromRow(attempt));
    const parsedTaskBindings = taskBindings.map((binding) => this.taskBindingFromRow(binding));
    const parsedReceipts = receipts.map((receipt) => this.dispatchReceiptFromRow(receipt));
    validateSnapshotReferences(run, parsedMilestones, parsedAttempts, parsedTaskBindings, parsedReceipts);
    return {
      ...run,
      milestones: parsedMilestones,
      attempts: parsedAttempts,
      taskBindings: parsedTaskBindings,
      dispatchReceipts: parsedReceipts,
    };
  }

  private insertAttempt(
    request: CommitAutomationTransitionRequest,
  ): void {
    const input = request.createAttempt;
    if (input === undefined) return;
    assertBoundedString(input.attemptId, 'attemptId', MAX_ID);
    assertBoundedString(input.milestoneId, 'milestoneId', MAX_ID);
    assertNonNegativeInteger(input.basedOnGoalRevision, 'attempt basedOnGoalRevision');
    assertNonNegativeInteger(input.basedOnUserIntentRevision, 'attempt basedOnUserIntentRevision');
    assertAttemptStatus(input.status);
    assertIso(input.startedAt, 'attempt startedAt');

    const milestone = this.requireMilestoneRow(request.runId, input.milestoneId);
    const sequenceRow = this.database.connection.prepare(
      'SELECT COALESCE(MAX(sequence), 0) AS value FROM automation_attempts WHERE run_id = ? AND milestone_id = ?',
    ).get(request.runId, input.milestoneId) as { value: number };
    const sequence = Number(sequenceRow.value) + 1;

    this.database.connection.prepare(`
      INSERT INTO automation_attempts (
        id, run_id, milestone_id, sequence, based_on_run_revision,
        based_on_goal_revision, based_on_user_intent_revision, status,
        failure_code, failure_detail, verification_evidence_json,
        started_at, updated_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '[]', ?, ?, NULL)
    `).run(
      input.attemptId,
      request.runId,
      milestone.id,
      sequence,
      request.expectedRevision,
      input.basedOnGoalRevision,
      input.basedOnUserIntentRevision,
      input.status,
      input.startedAt,
      input.startedAt,
    );
  }

  private updateAttempt(
    runId: string,
    update: NonNullable<CommitAutomationTransitionRequest['attemptUpdates']>[number],
    now: string,
  ): void {
    assertBoundedString(update.attemptId, 'attemptId', MAX_ID);
    assertAttemptStatus(update.status);
    if (update.failureCode !== undefined && update.failureCode !== null) {
      assertBoundedString(update.failureCode, 'failureCode', MAX_FAILURE_TEXT);
    }
    if (update.failureDetail !== undefined && update.failureDetail !== null) {
      assertBoundedString(update.failureDetail, 'failureDetail', MAX_FAILURE_TEXT);
    }
    if (update.finishedAt !== undefined && update.finishedAt !== null) {
      assertIso(update.finishedAt, 'attempt finishedAt');
    }
    if (update.verificationEvidence !== undefined) validateEvidence(update.verificationEvidence);

    const existing = this.requireAttemptRow(runId, update.attemptId);
    this.database.connection.prepare(`
      UPDATE automation_attempts
      SET status = ?, failure_code = ?, failure_detail = ?,
          verification_evidence_json = ?, updated_at = ?, finished_at = ?
      WHERE id = ? AND run_id = ?
    `).run(
      update.status,
      update.failureCode === undefined ? existing.failure_code : update.failureCode,
      update.failureDetail === undefined ? existing.failure_detail : update.failureDetail,
      update.verificationEvidence === undefined
        ? existing.verification_evidence_json
        : JSON.stringify(update.verificationEvidence),
      now,
      update.finishedAt === undefined ? existing.finished_at : update.finishedAt,
      update.attemptId,
      runId,
    );
  }

  private insertTaskBinding(
    runId: string,
    binding: AutomationTaskBindingWrite,
  ): void {
    validateTaskBinding(binding);
    this.requireAttemptRow(runId, binding.attemptId);
    const existing = this.database.connection.prepare(`
      SELECT * FROM automation_task_bindings
      WHERE attempt_id = ? AND provider = ? AND task_id = ?
    `).get(binding.attemptId, binding.provider, binding.taskId) as AutomationTaskBindingRow | undefined;
    if (existing !== undefined) {
      if (
        existing.role !== binding.role
        || existing.cancel_with_goal !== (binding.cancelWithGoal ? 1 : 0)
        || existing.deadline_at !== (binding.deadlineAt ?? null)
      ) {
        throw new AutomationStateError('conflict', 'Automation task binding identity was reused with different ownership');
      }
      return;
    }

    this.database.connection.prepare(`
      INSERT INTO automation_task_bindings (
        attempt_id, provider, task_id, role, cancel_with_goal, bound_at,
        deadline_at, last_observed_at, last_state, last_detail, terminal_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
    `).run(
      binding.attemptId,
      binding.provider,
      binding.taskId,
      binding.role,
      binding.cancelWithGoal ? 1 : 0,
      binding.boundAt,
      binding.deadlineAt ?? null,
    );
  }

  private updateTaskObservation(
    runId: string,
    observation: AutomationTaskObservationUpdate,
  ): void {
    validateTaskObservationUpdate(observation);
    const attempt = this.requireAttemptRow(runId, observation.attemptId);
    const binding = this.database.connection.prepare(`
      SELECT binding.*
      FROM automation_task_bindings binding
      INNER JOIN automation_attempts attempt_row ON attempt_row.id = binding.attempt_id
      WHERE binding.attempt_id = ?
        AND binding.provider = ?
        AND binding.task_id = ?
        AND attempt_row.run_id = ?
    `).get(
      observation.attemptId,
      observation.provider,
      observation.taskId,
      runId,
    ) as AutomationTaskBindingRow | undefined;
    if (binding === undefined || attempt.id !== observation.attemptId) {
      throw new AutomationStateError('not_found', 'Automation task binding was not found in this run');
    }
    const observedMs = Date.parse(observation.observedAt);
    if (observedMs < Date.parse(binding.bound_at)) {
      throw new AutomationStateError('conflict', 'Automation task observation predates the durable task binding');
    }
    if (binding.last_observed_at !== null && observedMs < Date.parse(binding.last_observed_at)) {
      throw new AutomationStateError('conflict', 'Automation task observations must be monotonic');
    }
    const nextTerminalAt = observation.terminalAt === undefined
      ? binding.terminal_at
      : observation.terminalAt;
    if (nextTerminalAt !== null && Date.parse(nextTerminalAt) < Date.parse(binding.bound_at)) {
      throw new AutomationStateError('conflict', 'Automation task terminal time predates the durable task binding');
    }
    if (binding.terminal_at !== null) {
      if (!isTerminalTaskObservedState(observation.state)) {
        throw new AutomationStateError('conflict', 'A terminal automation task observation cannot become non-terminal');
      }
      if (
        binding.last_state !== null
        && isTerminalTaskObservedState(binding.last_state as AutomationTaskObservedState)
        && binding.last_state !== observation.state
      ) {
        throw new AutomationStateError('conflict', 'Automation task terminal state is immutable');
      }
      if (
        observation.terminalAt !== undefined
        && observation.terminalAt !== null
        && binding.terminal_at !== observation.terminalAt
      ) {
        throw new AutomationStateError('conflict', 'Automation task terminal time is immutable');
      }
    }

    this.database.connection.prepare(`
      UPDATE automation_task_bindings
      SET last_observed_at = ?, last_state = ?, last_detail = ?, terminal_at = ?
      WHERE attempt_id = ? AND provider = ? AND task_id = ?
    `).run(
      observation.observedAt,
      observation.state,
      observation.detail === undefined ? binding.last_detail : observation.detail,
      observation.terminalAt === undefined ? binding.terminal_at : observation.terminalAt,
      observation.attemptId,
      observation.provider,
      observation.taskId,
    );
  }

  private upsertDispatchReceipt(
    runId: string,
    receipt: AutomationDispatchReceiptWrite,
    now: string,
  ): void {
    validateDispatchReceiptWrite(receipt);
    const attempt = this.requireAttemptRow(runId, receipt.attemptId);
    const milestone = this.requireMilestoneRow(runId, receipt.milestoneId);
    if (attempt.milestone_id !== milestone.id) {
      throw new AutomationStateError('conflict', 'Automation dispatch receipt milestone does not match its attempt');
    }

    const byId = this.database.connection.prepare(
      'SELECT * FROM automation_dispatch_receipts WHERE id = ?',
    ).get(receipt.id) as AutomationDispatchReceiptRow | undefined;
    const byOperation = this.database.connection.prepare(`
      SELECT * FROM automation_dispatch_receipts
      WHERE attempt_id = ? AND operation_key = ?
    `).get(receipt.attemptId, receipt.operationKey) as AutomationDispatchReceiptRow | undefined;
    if (byOperation !== undefined && byOperation.id !== receipt.id) {
      throw new AutomationStateError('conflict', 'Automation dispatch operation already uses another receipt id');
    }
    if (byId === undefined) {
      this.database.connection.prepare(`
        INSERT INTO automation_dispatch_receipts (
          id, run_id, milestone_id, attempt_id, operation_key, state,
          provider, idempotency_key, external_id, deadline_at, detail,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receipt.id,
        runId,
        receipt.milestoneId,
        receipt.attemptId,
        receipt.operationKey,
        receipt.state,
        receipt.provider ?? null,
        receipt.idempotencyKey ?? null,
        receipt.externalId ?? null,
        receipt.deadlineAt ?? null,
        receipt.detail ?? null,
        now,
        now,
      );
      return;
    }
    if (
      byId.run_id !== runId
      || byId.milestone_id !== receipt.milestoneId
      || byId.attempt_id !== receipt.attemptId
      || byId.operation_key !== receipt.operationKey
      || (byId.provider !== null && receipt.provider !== undefined && byId.provider !== receipt.provider)
      || (byId.idempotency_key !== null && receipt.idempotencyKey !== undefined && byId.idempotency_key !== receipt.idempotencyKey)
      || (byId.external_id !== null && receipt.externalId !== undefined && byId.external_id !== receipt.externalId)
      || (byId.deadline_at !== null && receipt.deadlineAt !== undefined && byId.deadline_at !== receipt.deadlineAt)
    ) {
      throw new AutomationStateError('conflict', 'Automation dispatch receipt identity is immutable');
    }
    assertDispatchStateTransition(byId.state, receipt.state);

    this.database.connection.prepare(`
      UPDATE automation_dispatch_receipts
      SET state = ?, provider = ?, idempotency_key = ?, external_id = ?,
          deadline_at = ?, detail = ?, updated_at = ?
      WHERE id = ?
    `).run(
      receipt.state,
      receipt.provider === undefined ? byId.provider : receipt.provider,
      receipt.idempotencyKey === undefined ? byId.idempotency_key : receipt.idempotencyKey,
      receipt.externalId === undefined ? byId.external_id : receipt.externalId,
      receipt.deadlineAt === undefined ? byId.deadline_at : receipt.deadlineAt,
      receipt.detail === undefined ? byId.detail : receipt.detail,
      now,
      receipt.id,
    );
  }

  private updateMilestone(
    runId: string,
    update: NonNullable<CommitAutomationTransitionRequest['milestoneUpdates']>[number],
    now: string,
  ): void {
    assertBoundedString(update.milestoneId, 'milestoneId', MAX_ID);
    assertMilestoneStatus(update.status);
    this.requireMilestoneRow(runId, update.milestoneId);
    const attemptId = update.currentAttemptId;
    if (attemptId !== undefined && attemptId !== null) {
      const attempt = this.requireAttemptRow(runId, attemptId);
      if (attempt.milestone_id !== update.milestoneId) {
        throw new AutomationStateError('conflict', 'Automation milestone current attempt belongs to another milestone');
      }
    }
    const existing = this.requireMilestoneRow(runId, update.milestoneId);
    this.database.connection.prepare(`
      UPDATE automation_milestones
      SET status = ?, current_attempt_id = ?, updated_at = ?
      WHERE id = ? AND run_id = ?
    `).run(
      update.status,
      attemptId === undefined ? existing.current_attempt_id : attemptId,
      now,
      update.milestoneId,
      runId,
    );
  }

  private assertCurrentReferences(
    runId: string,
    milestoneId: string | null,
    attemptId: string | null,
  ): void {
    const milestone = milestoneId === null ? undefined : this.requireMilestoneRow(runId, milestoneId);
    const attempt = attemptId === null ? undefined : this.requireAttemptRow(runId, attemptId);
    if (milestone !== undefined && attempt !== undefined && attempt.milestone_id !== milestone.id) {
      throw new AutomationStateError('conflict', 'Automation current attempt does not belong to current milestone');
    }
  }

  private insertTransitionEvents(
    request: CommitAutomationTransitionRequest,
    nextRevision: number,
  ): void {
    const events = [request.event, ...(request.additionalEvents ?? [])];
    const seenIds = new Set<string>();
    const insert = this.database.connection.prepare(`
      INSERT INTO automation_events (
        id, run_id, milestone_id, attempt_id, revision_before, revision_after,
        type, reason, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const event of events) {
      validateEventWrite(event);
      if (seenIds.has(event.id)) {
        throw new AutomationStateError('conflict', 'Automation transition event ids must be unique');
      }
      seenIds.add(event.id);
      if (event.milestoneId !== undefined) {
        this.requireMilestoneRow(request.runId, event.milestoneId);
      }
      if (event.attemptId !== undefined) {
        this.requireAttemptRow(request.runId, event.attemptId);
      }
      insert.run(
        event.id,
        request.runId,
        event.milestoneId ?? null,
        event.attemptId ?? null,
        request.expectedRevision,
        nextRevision,
        event.type,
        event.reason,
        JSON.stringify(event.metadata ?? {}),
        request.now,
      );
    }
  }
  private requireMilestoneRow(runId: string, milestoneId: string): AutomationMilestoneRow {
    const row = this.database.connection.prepare(
      'SELECT * FROM automation_milestones WHERE id = ? AND run_id = ?',
    ).get(milestoneId, runId) as AutomationMilestoneRow | undefined;
    if (row === undefined) {
      throw new AutomationStateError('not_found', 'Automation milestone was not found in this run');
    }
    return row;
  }

  private requireAttemptRow(runId: string, attemptId: string): AutomationAttemptRow {
    const row = this.database.connection.prepare(
      'SELECT * FROM automation_attempts WHERE id = ? AND run_id = ?',
    ).get(attemptId, runId) as AutomationAttemptRow | undefined;
    if (row === undefined) {
      throw new AutomationStateError('not_found', 'Automation attempt was not found in this run');
    }
    return row;
  }

  private requireRunRecord(row: AutomationRunRow): AutomationRunRecord {
    assertBoundedString(row.id, 'automation run id', MAX_ID, 'corrupt');
    assertBoundedString(row.goal_id, 'automation goal id', MAX_ID, 'corrupt');
    assertBoundedString(row.workspace_id, 'automation workspace id', MAX_ID, 'corrupt');
    assertBoundedString(row.policy_profile, 'automation policy profile', MAX_POLICY_PROFILE, 'corrupt');
    assertNonNegativeInteger(row.revision, 'automation revision', 'corrupt');
    assertRunStatus(row.status, 'corrupt');
    assertNonNegativeInteger(row.based_on_goal_revision, 'automation goal revision', 'corrupt');
    assertNonNegativeInteger(row.based_on_user_intent_revision, 'automation user intent revision', 'corrupt');
    assertIso(row.created_at, 'automation createdAt', 'corrupt');
    assertIso(row.updated_at, 'automation updatedAt', 'corrupt');
    if (row.terminal_at !== null) assertIso(row.terminal_at, 'automation terminalAt', 'corrupt');
    if (row.current_milestone_id !== null) assertBoundedString(row.current_milestone_id, 'current milestone id', MAX_ID, 'corrupt');
    if (row.current_attempt_id !== null) assertBoundedString(row.current_attempt_id, 'current attempt id', MAX_ID, 'corrupt');
    if (row.last_recovery_decision !== null) assertBoundedString(row.last_recovery_decision, 'recovery decision', MAX_RECOVERY_DECISION, 'corrupt');
    return {
      id: row.id,
      goalId: row.goal_id,
      workspaceId: row.workspace_id,
      policyProfile: row.policy_profile,
      revision: row.revision,
      status: row.status as AutomationRunStatus,
      basedOnGoalRevision: row.based_on_goal_revision,
      basedOnUserIntentRevision: row.based_on_user_intent_revision,
      ...(row.current_milestone_id === null ? {} : { currentMilestoneId: row.current_milestone_id }),
      ...(row.current_attempt_id === null ? {} : { currentAttemptId: row.current_attempt_id }),
      ...(row.last_recovery_decision === null ? {} : { lastRecoveryDecision: row.last_recovery_decision }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.terminal_at === null ? {} : { terminalAt: row.terminal_at }),
    };
  }
  private milestoneFromRow(row: AutomationMilestoneRow): AutomationMilestoneRecord {
    assertBoundedString(row.id, 'automation milestone id', MAX_ID, 'corrupt');
    assertBoundedString(row.run_id, 'automation milestone run id', MAX_ID, 'corrupt');
    if (!Number.isInteger(row.ordinal) || row.ordinal < 0) {
      throw corrupt('Automation milestone ordinal is invalid');
    }
    assertBoundedString(row.title, 'automation milestone title', MAX_TITLE, 'corrupt');
    assertBoundedString(row.execution_intent, 'automation execution intent', MAX_INTENT, 'corrupt');
    assertMilestoneStatus(row.status, 'corrupt');
    assertIso(row.created_at, 'automation milestone createdAt', 'corrupt');
    assertIso(row.updated_at, 'automation milestone updatedAt', 'corrupt');

    const dependsOn = parseStringArray(row.depends_on_json, 'automation milestone dependencies');
    if (dependsOn.length > MAX_DEPENDENCIES) throw corrupt('Automation milestone has too many dependencies');
    for (const dependencyId of dependsOn) {
      assertBoundedString(dependencyId, 'automation milestone dependency id', MAX_ID, 'corrupt');
    }
    const verificationRequirements = parseVerificationRequirements(row.verification_requirements_json);
    const retryPolicy = parseRetryPolicy(row.retry_policy_json);

    return {
      id: row.id,
      runId: row.run_id,
      ordinal: row.ordinal,
      title: row.title,
      dependsOn,
      executionIntent: row.execution_intent,
      verificationRequirements,
      retryPolicy,
      status: row.status as AutomationMilestoneStatus,
      ...(row.current_attempt_id === null ? {} : { currentAttemptId: row.current_attempt_id }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private attemptFromRow(row: AutomationAttemptRow): AutomationAttemptRecord {
    assertBoundedString(row.id, 'automation attempt id', MAX_ID, 'corrupt');
    assertBoundedString(row.run_id, 'automation attempt run id', MAX_ID, 'corrupt');
    assertBoundedString(row.milestone_id, 'automation attempt milestone id', MAX_ID, 'corrupt');
    if (!Number.isInteger(row.sequence) || row.sequence < 1) throw corrupt('Automation attempt sequence is invalid');
    assertNonNegativeInteger(row.based_on_run_revision, 'automation attempt run revision', 'corrupt');
    assertNonNegativeInteger(row.based_on_goal_revision, 'automation attempt goal revision', 'corrupt');
    assertNonNegativeInteger(row.based_on_user_intent_revision, 'automation attempt intent revision', 'corrupt');
    assertAttemptStatus(row.status, 'corrupt');
    assertIso(row.started_at, 'automation attempt startedAt', 'corrupt');
    assertIso(row.updated_at, 'automation attempt updatedAt', 'corrupt');
    if (row.finished_at !== null) assertIso(row.finished_at, 'automation attempt finishedAt', 'corrupt');
    if (row.failure_code !== null) assertBoundedString(row.failure_code, 'automation failure code', MAX_FAILURE_TEXT, 'corrupt');
    if (row.failure_detail !== null) assertBoundedString(row.failure_detail, 'automation failure detail', MAX_FAILURE_TEXT, 'corrupt');
    return {
      id: row.id,
      runId: row.run_id,
      milestoneId: row.milestone_id,
      sequence: row.sequence,
      basedOnRunRevision: row.based_on_run_revision,
      basedOnGoalRevision: row.based_on_goal_revision,
      basedOnUserIntentRevision: row.based_on_user_intent_revision,
      status: row.status as AutomationAttemptStatus,
      ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
      ...(row.failure_detail === null ? {} : { failureDetail: row.failure_detail }),
      verificationEvidence: parseEvidence(row.verification_evidence_json),
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    };
  }

  private taskBindingFromRow(row: AutomationTaskBindingRow): AutomationTaskBindingRecord {
    assertBoundedString(row.attempt_id, 'automation task attempt id', MAX_ID, 'corrupt');
    assertTaskProvider(row.provider, 'corrupt');
    assertBoundedString(row.task_id, 'automation task id', MAX_ID, 'corrupt');
    assertTaskRole(row.role, 'corrupt');
    if (row.cancel_with_goal !== 0 && row.cancel_with_goal !== 1) throw corrupt('Automation task cancellation flag is invalid');
    assertIso(row.bound_at, 'automation task boundAt', 'corrupt');
    if (row.deadline_at !== null) {
      assertIso(row.deadline_at, 'automation task deadlineAt', 'corrupt');
      if (Date.parse(row.deadline_at) < Date.parse(row.bound_at)) throw corrupt('Automation task deadline precedes binding time');
    }
    if (row.last_observed_at !== null) assertIso(row.last_observed_at, 'automation task lastObservedAt', 'corrupt');
    if (row.last_state !== null) assertTaskObservedState(row.last_state, 'corrupt');
    if (row.last_detail !== null) assertBoundedString(row.last_detail, 'automation task last detail', MAX_FAILURE_TEXT, 'corrupt');
    if (row.terminal_at !== null) assertIso(row.terminal_at, 'automation task terminalAt', 'corrupt');
    return {
      attemptId: row.attempt_id,
      provider: row.provider as AutomationTaskProvider,
      taskId: row.task_id,
      role: row.role as GoalTrackedTaskRole,
      cancelWithGoal: row.cancel_with_goal === 1,
      boundAt: row.bound_at,
      ...(row.deadline_at === null ? {} : { deadlineAt: row.deadline_at }),
      ...(row.last_observed_at === null ? {} : { lastObservedAt: row.last_observed_at }),
      ...(row.last_state === null ? {} : { lastState: row.last_state as AutomationTaskObservedState }),
      ...(row.last_detail === null ? {} : { lastDetail: row.last_detail }),
      ...(row.terminal_at === null ? {} : { terminalAt: row.terminal_at }),
    };
  }
  private dispatchReceiptFromRow(row: AutomationDispatchReceiptRow): AutomationDispatchReceiptRecord {
    assertBoundedString(row.id, 'automation receipt id', MAX_ID, 'corrupt');
    assertBoundedString(row.run_id, 'automation receipt run id', MAX_ID, 'corrupt');
    assertBoundedString(row.milestone_id, 'automation receipt milestone id', MAX_ID, 'corrupt');
    assertBoundedString(row.attempt_id, 'automation receipt attempt id', MAX_ID, 'corrupt');
    assertBoundedString(row.operation_key, 'automation operation key', MAX_ID, 'corrupt');
    assertDispatchState(row.state, 'corrupt');
    if (row.provider !== null) assertTaskProvider(row.provider, 'corrupt');
    if (row.idempotency_key !== null) assertBoundedString(row.idempotency_key, 'automation receipt idempotency key', MAX_FAILURE_TEXT, 'corrupt');
    if (row.external_id !== null) assertBoundedString(row.external_id, 'automation receipt external id', MAX_FAILURE_TEXT, 'corrupt');
    if (row.deadline_at !== null) assertIso(row.deadline_at, 'automation receipt deadlineAt', 'corrupt');
    if (row.detail !== null) assertBoundedString(row.detail, 'automation receipt detail', MAX_FAILURE_TEXT, 'corrupt');
    assertIso(row.created_at, 'automation receipt createdAt', 'corrupt');
    assertIso(row.updated_at, 'automation receipt updatedAt', 'corrupt');
    return {
      id: row.id,
      runId: row.run_id,
      milestoneId: row.milestone_id,
      attemptId: row.attempt_id,
      operationKey: row.operation_key,
      state: row.state as AutomationDispatchState,
      ...(row.provider === null ? {} : { provider: row.provider as AutomationTaskProvider }),
      ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
      ...(row.external_id === null ? {} : { externalId: row.external_id }),
      ...(row.deadline_at === null ? {} : { deadlineAt: row.deadline_at }),
      ...(row.detail === null ? {} : { detail: row.detail }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private eventFromRow(row: AutomationEventRow): AutomationEventRecord {
    assertBoundedString(row.id, 'automation event id', MAX_ID, 'corrupt');
    assertBoundedString(row.run_id, 'automation event run id', MAX_ID, 'corrupt');
    assertNonNegativeInteger(row.revision_before, 'automation event revision before', 'corrupt');
    assertNonNegativeInteger(row.revision_after, 'automation event revision after', 'corrupt');
    if (row.revision_after < row.revision_before) throw corrupt('Automation event revision order is invalid');
    assertEventType(row.type, 'corrupt');
    assertBoundedString(row.reason, 'automation event reason', MAX_REASON, 'corrupt');
    if (row.milestone_id !== null) assertBoundedString(row.milestone_id, 'automation event milestone id', MAX_ID, 'corrupt');
    if (row.attempt_id !== null) assertBoundedString(row.attempt_id, 'automation event attempt id', MAX_ID, 'corrupt');
    assertIso(row.created_at, 'automation event createdAt', 'corrupt');
    const metadata = parseEventMetadata(row.metadata_json);
    return {
      id: row.id,
      runId: row.run_id,
      ...(row.milestone_id === null ? {} : { milestoneId: row.milestone_id }),
      ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
      revisionBefore: row.revision_before,
      revisionAfter: row.revision_after,
      type: row.type as AutomationEventType,
      reason: row.reason,
      metadata,
      createdAt: row.created_at,
    };
  }
}

function validateCreateRequest(request: CreateAutomationRunRecordRequest): void {
  assertBoundedString(request.runId, 'runId', MAX_ID);
  assertBoundedString(request.goalId, 'goalId', MAX_ID);
  assertBoundedString(request.workspaceId, 'workspaceId', MAX_ID);
  assertBoundedString(request.policyProfile, 'policyProfile', MAX_POLICY_PROFILE);
  assertNonNegativeInteger(request.basedOnGoalRevision, 'basedOnGoalRevision');
  assertNonNegativeInteger(request.basedOnUserIntentRevision, 'basedOnUserIntentRevision');
  assertIso(request.createdAt, 'createdAt');
  assertBoundedString(request.eventId, 'eventId', MAX_ID);
  if (request.milestones.length > MAX_MILESTONES) {
    throw conflict('Automation milestone count exceeds the maximum');
  }
  request.milestones.forEach(validateMilestoneSpec);
}

function validateMilestoneSpec(milestone: AutomationMilestoneSpec): void {
  assertBoundedString(milestone.id, 'milestone id', MAX_ID);
  assertBoundedString(milestone.title, 'milestone title', MAX_TITLE);
  assertBoundedString(milestone.executionIntent, 'execution intent', MAX_INTENT);
  if (milestone.dependsOn.length > MAX_DEPENDENCIES) throw conflict('Automation milestone has too many dependencies');
  for (const dependency of milestone.dependsOn) assertBoundedString(dependency, 'dependency id', MAX_ID);
  if (milestone.verificationRequirements.length > MAX_VERIFICATION_REQUIREMENTS) {
    throw conflict('Automation milestone has too many verification requirements');
  }
  milestone.verificationRequirements.forEach(validateVerificationRequirement);
  validateRetryPolicy(milestone.retryPolicy);
}

function validateVerificationRequirement(value: AutomationVerificationRequirement): void {
  assertBoundedString(value.id, 'verification id', MAX_ID);
  assertBoundedString(value.title, 'verification title', MAX_TITLE);
  if (value.kind !== 'command' && value.kind !== 'evidence' && value.kind !== 'custom') {
    throw conflict('Automation verification kind is invalid');
  }
  assertBoundedString(value.specification, 'verification specification', MAX_INTENT);
}

function validateRetryPolicy(value: AutomationRetryPolicy): void {
  if (!isRetryClass(value.classification)) throw conflict('Automation retry classification is invalid');
  if (!Number.isInteger(value.maxAttempts) || value.maxAttempts < 1 || value.maxAttempts > 100) {
    throw conflict('Automation maxAttempts must be between 1 and 100');
  }
}

function validateTransitionRequest(request: CommitAutomationTransitionRequest): void {
  assertBoundedString(request.runId, 'runId', MAX_ID);
  assertNonNegativeInteger(request.expectedRevision, 'expectedRevision');
  assertIso(request.now, 'transition now');
  validateEventWrite(request.event);
  if ((request.additionalEvents?.length ?? 0) > MAX_MILESTONES * 2) throw conflict('Too many automation transition events');
  for (const event of request.additionalEvents ?? []) validateEventWrite(event);
  if (request.runPatch?.status !== undefined) assertRunStatus(request.runPatch.status);
  if (request.runPatch?.basedOnGoalRevision !== undefined) {
    assertNonNegativeInteger(request.runPatch.basedOnGoalRevision, 'run basedOnGoalRevision');
  }
  if (request.runPatch?.basedOnUserIntentRevision !== undefined) {
    assertNonNegativeInteger(request.runPatch.basedOnUserIntentRevision, 'run basedOnUserIntentRevision');
  }
  if (request.runPatch?.currentMilestoneId !== undefined && request.runPatch.currentMilestoneId !== null) {
    assertBoundedString(request.runPatch.currentMilestoneId, 'currentMilestoneId', MAX_ID);
  }
  if (request.runPatch?.currentAttemptId !== undefined && request.runPatch.currentAttemptId !== null) {
    assertBoundedString(request.runPatch.currentAttemptId, 'currentAttemptId', MAX_ID);
  }
  if (request.runPatch?.lastRecoveryDecision !== undefined && request.runPatch.lastRecoveryDecision !== null) {
    assertBoundedString(request.runPatch.lastRecoveryDecision, 'lastRecoveryDecision', MAX_RECOVERY_DECISION);
  }
  if (request.runPatch?.terminalAt !== undefined && request.runPatch.terminalAt !== null) {
    assertIso(request.runPatch.terminalAt, 'terminalAt');
  }
  if ((request.milestoneUpdates?.length ?? 0) > MAX_MILESTONES) throw conflict('Too many automation milestone updates');
  if ((request.attemptUpdates?.length ?? 0) > MAX_MILESTONES) throw conflict('Too many automation attempt updates');
  if ((request.taskBindings?.length ?? 0) > MAX_MILESTONES) throw conflict('Too many automation task bindings');
  if ((request.taskObservationUpdates?.length ?? 0) > MAX_MILESTONES * 2) throw conflict('Too many automation task observations');
  if ((request.dispatchReceipts?.length ?? 0) > MAX_MILESTONES) throw conflict('Too many automation dispatch receipts');
}

function validateTaskBinding(binding: AutomationTaskBindingWrite): void {
  assertBoundedString(binding.attemptId, 'task binding attemptId', MAX_ID);
  assertTaskProvider(binding.provider);
  assertBoundedString(binding.taskId, 'task binding taskId', MAX_ID);
  assertTaskRole(binding.role);
  assertIso(binding.boundAt, 'task binding boundAt');
  if (binding.deadlineAt !== undefined && binding.deadlineAt !== null) {
    assertIso(binding.deadlineAt, 'task binding deadlineAt');
    if (Date.parse(binding.deadlineAt) < Date.parse(binding.boundAt)) {
      throw conflict('Automation task deadline cannot precede binding time');
    }
  }
}

function validateTaskObservationUpdate(observation: AutomationTaskObservationUpdate): void {
  assertBoundedString(observation.attemptId, 'task observation attemptId', MAX_ID);
  assertTaskProvider(observation.provider);
  assertBoundedString(observation.taskId, 'task observation taskId', MAX_ID);
  assertTaskObservedState(observation.state);
  assertIso(observation.observedAt, 'task observation observedAt');
  if (observation.detail !== undefined && observation.detail !== null) {
    assertBoundedString(observation.detail, 'task observation detail', MAX_FAILURE_TEXT);
  }
  const terminal = isTerminalTaskObservedState(observation.state);
  if (terminal && (observation.terminalAt === undefined || observation.terminalAt === null)) {
    throw conflict('Terminal automation task observations require terminalAt');
  }
  if (!terminal && observation.terminalAt !== undefined && observation.terminalAt !== null) {
    throw conflict('Non-terminal automation task observations cannot set terminalAt');
  }
  if (observation.terminalAt !== undefined && observation.terminalAt !== null) {
    assertIso(observation.terminalAt, 'task observation terminalAt');
    if (Date.parse(observation.terminalAt) > Date.parse(observation.observedAt)) {
      throw conflict('Automation task terminalAt cannot be after observedAt');
    }
  }
}

function validateDispatchReceiptWrite(receipt: AutomationDispatchReceiptWrite): void {
  assertBoundedString(receipt.id, 'receipt id', MAX_ID);
  assertBoundedString(receipt.milestoneId, 'receipt milestone id', MAX_ID);
  assertBoundedString(receipt.attemptId, 'receipt attempt id', MAX_ID);
  assertBoundedString(receipt.operationKey, 'receipt operation key', MAX_ID);
  assertDispatchState(receipt.state);
  if (receipt.provider !== undefined) assertTaskProvider(receipt.provider);
  if (receipt.deadlineAt !== undefined) assertIso(receipt.deadlineAt, 'receipt deadlineAt');
  for (const [label, value] of [
    ['idempotencyKey', receipt.idempotencyKey],
    ['externalId', receipt.externalId],
    ['detail', receipt.detail],
  ] as const) {
    if (value !== undefined && value !== null) assertBoundedString(value, label, MAX_FAILURE_TEXT);
  }
}

function validateEventWrite(event: CommitAutomationTransitionRequest['event']): void {
  assertBoundedString(event.id, 'event id', MAX_ID);
  if (event.milestoneId !== undefined) assertBoundedString(event.milestoneId, 'event milestone id', MAX_ID);
  if (event.attemptId !== undefined) assertBoundedString(event.attemptId, 'event attempt id', MAX_ID);
  assertEventType(event.type);
  assertBoundedString(event.reason, 'event reason', MAX_REASON);
  validateEventMetadata(event.metadata ?? {});
}

function validateEventMetadata(metadata: AutomationEventMetadata): void {
  const entries = Object.entries(metadata);
  if (entries.length > MAX_EVENT_METADATA_KEYS) throw conflict('Automation event metadata has too many keys');
  for (const [key, value] of entries) {
    assertBoundedString(key, 'automation event metadata key', 128);
    if (typeof value === 'string' && value.length > MAX_EVENT_METADATA_STRING) {
      throw conflict('Automation event metadata string is too long');
    }
    if (
      value !== null
      && typeof value !== 'string'
      && typeof value !== 'number'
      && typeof value !== 'boolean'
    ) {
      throw conflict('Automation event metadata value is invalid');
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw conflict('Automation event metadata number must be finite');
    }
  }
}

function validateSnapshotReferences(
  run: AutomationRunRecord,
  milestones: readonly AutomationMilestoneRecord[],
  attempts: readonly AutomationAttemptRecord[],
  taskBindings: readonly AutomationTaskBindingRecord[],
  receipts: readonly AutomationDispatchReceiptRecord[],
): void {
  try {
    validateAutomationMilestoneGraph(milestones);
  } catch {
    throw corrupt('Stored automation milestone graph is invalid');
  }

  const milestoneById = new Map(milestones.map((milestone) => [milestone.id, milestone]));
  const attemptById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  if (run.currentMilestoneId !== undefined && !milestoneById.has(run.currentMilestoneId)) {
    throw corrupt('Automation current milestone does not belong to the run');
  }
  if (run.currentAttemptId !== undefined && !attemptById.has(run.currentAttemptId)) {
    throw corrupt('Automation current attempt does not belong to the run');
  }
  for (const attempt of attempts) {
    if (!milestoneById.has(attempt.milestoneId)) throw corrupt('Automation attempt references a missing milestone');
  }
  for (const milestone of milestones) {
    if (milestone.currentAttemptId === undefined) continue;
    const attempt = attemptById.get(milestone.currentAttemptId);
    if (attempt === undefined || attempt.milestoneId !== milestone.id) {
      throw corrupt('Automation milestone current attempt is inconsistent');
    }
  }
  for (const binding of taskBindings) {
    if (!attemptById.has(binding.attemptId)) throw corrupt('Automation task binding references a missing attempt');
  }
  for (const receipt of receipts) {
    const attempt = attemptById.get(receipt.attemptId);
    if (
      receipt.runId !== run.id
      || attempt === undefined
      || attempt.milestoneId !== receipt.milestoneId
    ) {
      throw corrupt('Automation dispatch receipt references inconsistent run state');
    }
  }
}

function assertCreateReplayMatches(
  snapshot: AutomationRunSnapshot,
  request: CreateAutomationRunRecordRequest,
): void {
  const same =
    snapshot.id === request.runId
    && snapshot.workspaceId === request.workspaceId
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
  if (!same) {
    throw new AutomationStateError(
      'conflict',
      'Existing automation run for this goal does not match the requested definition',
    );
  }
}

function parseVerificationRequirements(serialized: string): readonly AutomationVerificationRequirement[] {
  const value = parseJson(serialized, 'automation verification requirements');
  if (!Array.isArray(value) || value.length > MAX_VERIFICATION_REQUIREMENTS) {
    throw corrupt('Automation verification requirements are invalid');
  }
  return value.map((entry) => {
    if (!isRecord(entry)) throw corrupt('Automation verification requirement is invalid');
    const requirement = {
      id: entry.id,
      title: entry.title,
      kind: entry.kind,
      specification: entry.specification,
    };
    if (
      typeof requirement.id !== 'string'
      || typeof requirement.title !== 'string'
      || typeof requirement.specification !== 'string'
      || (requirement.kind !== 'command' && requirement.kind !== 'evidence' && requirement.kind !== 'custom')
    ) {
      throw corrupt('Automation verification requirement fields are invalid');
    }
    const typed: AutomationVerificationRequirement = {
      id: requirement.id,
      title: requirement.title,
      kind: requirement.kind,
      specification: requirement.specification,
    };
    try {
      validateVerificationRequirement(typed);
    } catch {
      throw corrupt('Automation verification requirement violates bounds');
    }
    return typed;
  });
}

function parseRetryPolicy(serialized: string): AutomationRetryPolicy {
  const value = parseJson(serialized, 'automation retry policy');
  if (!isRecord(value) || !isRetryClass(value.classification)) throw corrupt('Automation retry policy is invalid');
  const maxAttempts = value.maxAttempts;
  if (!Number.isInteger(maxAttempts) || Number(maxAttempts) < 1 || Number(maxAttempts) > 100) {
    throw corrupt('Automation retry maxAttempts is invalid');
  }
  return { classification: value.classification, maxAttempts: Number(maxAttempts) };
}

function parseEvidence(serialized: string): readonly GoalEvidence[] {
  const value = parseJson(serialized, 'automation verification evidence');
  if (!Array.isArray(value)) throw corrupt('Automation verification evidence is invalid');
  const evidence = value.map((entry) => {
    if (!isRecord(entry) || typeof entry.value !== 'string') throw corrupt('Automation evidence entry is invalid');
    if (entry.kind !== 'path' && entry.kind !== 'hash' && entry.kind !== 'task' && entry.kind !== 'note') {
      throw corrupt('Automation evidence kind is invalid');
    }
    return { kind: entry.kind, value: entry.value } satisfies GoalEvidence;
  });
  validateEvidence(evidence, 'corrupt');
  return evidence;
}

function validateEvidence(
  evidence: readonly GoalEvidence[],
  reason: 'conflict' | 'corrupt' = 'conflict',
): void {
  if (evidence.length > 100) throw stateError(reason, 'Automation evidence exceeds the maximum count');
  for (const entry of evidence) {
    if (entry.kind !== 'path' && entry.kind !== 'hash' && entry.kind !== 'task' && entry.kind !== 'note') {
      throw stateError(reason, 'Automation evidence kind is invalid');
    }
    assertBoundedString(entry.value, 'automation evidence value', 2_048, reason);
  }
}

function parseEventMetadata(serialized: string): AutomationEventMetadata {
  const value = parseJson(serialized, 'automation event metadata');
  if (!isRecord(value)) throw corrupt('Automation event metadata is invalid');
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      entry !== null
      && typeof entry !== 'string'
      && typeof entry !== 'number'
      && typeof entry !== 'boolean'
    ) {
      throw corrupt('Automation event metadata value is invalid');
    }
    metadata[key] = entry;
  }
  try {
    validateEventMetadata(metadata);
  } catch {
    throw corrupt('Automation event metadata violates bounds');
  }
  return metadata;
}

function parseStringArray(serialized: string, label: string): readonly string[] {
  const value = parseJson(serialized, label);
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw corrupt(`${label} is invalid`);
  }
  return value;
}

function parseJson(serialized: string, label: string): unknown {
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw corrupt(`${label} contains invalid JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRetryClass(value: unknown): value is AutomationRetryPolicy['classification'] {
  return value === 'safe_read'
    || value === 'idempotent_local_state'
    || value === 'durable_task_observation'
    || value === 'workspace_mutation'
    || value === 'opaque_external_mutation'
    || value === 'destructive_operation';
}

function assertRunStatus(value: unknown, reason: 'conflict' | 'corrupt' = 'conflict'): void {
  if (
    value !== 'planned'
    && value !== 'running'
    && value !== 'waiting_task'
    && value !== 'verifying'
    && value !== 'paused'
    && value !== 'blocked'
    && value !== 'completing'
    && value !== 'completed'
    && value !== 'failed'
    && value !== 'cancelled'
  ) throw stateError(reason, 'Automation run status is invalid');
}

function assertMilestoneStatus(value: unknown, reason: 'conflict' | 'corrupt' = 'conflict'): void {
  if (
    value !== 'pending'
    && value !== 'ready'
    && value !== 'running'
    && value !== 'waiting_task'
    && value !== 'verifying'
    && value !== 'retry_ready'
    && value !== 'completed'
    && value !== 'blocked'
    && value !== 'failed'
  ) throw stateError(reason, 'Automation milestone status is invalid');
}

function assertAttemptStatus(value: unknown, reason: 'conflict' | 'corrupt' = 'conflict'): void {
  if (
    value !== 'reserved'
    && value !== 'dispatching'
    && value !== 'waiting_task'
    && value !== 'verifying'
    && value !== 'dispatch_unresolved'
    && value !== 'completed'
    && value !== 'failed'
    && value !== 'cancelled'
  ) throw stateError(reason, 'Automation attempt status is invalid');
}

function assertDispatchState(value: unknown, reason: 'conflict' | 'corrupt' = 'conflict'): void {
  if (
    value !== 'reserved'
    && value !== 'dispatched_unresolved'
    && value !== 'confirmed'
    && value !== 'failed'
    && value !== 'cancelled'
  ) throw stateError(reason, 'Automation dispatch state is invalid');
}

function assertDispatchStateTransition(
  current: AutomationDispatchState | string,
  next: AutomationDispatchState,
): void {
  const allowed: Readonly<Record<AutomationDispatchState, readonly AutomationDispatchState[]>> = {
    reserved: ['reserved', 'dispatched_unresolved', 'confirmed', 'failed', 'cancelled'],
    dispatched_unresolved: ['dispatched_unresolved', 'confirmed', 'failed', 'cancelled'],
    confirmed: ['confirmed'],
    failed: ['failed'],
    cancelled: ['cancelled'],
  };
  if (!isDispatchStateValue(current) || !allowed[current].includes(next)) {
    throw conflict(`Automation dispatch state cannot transition from ${String(current)} to ${next}`);
  }
}

function isDispatchStateValue(value: unknown): value is AutomationDispatchState {
  return value === 'reserved'
    || value === 'dispatched_unresolved'
    || value === 'confirmed'
    || value === 'failed'
    || value === 'cancelled';
}

function assertTaskProvider(value: unknown, reason: 'conflict' | 'corrupt' = 'conflict'): void {
  if (value !== 'process' && value !== 'codex' && value !== 'shell') {
    throw stateError(reason, 'Automation task provider is invalid');
  }
}

function isTerminalTaskObservedState(value: AutomationTaskObservedState): boolean {
  return value === 'completed'
    || value === 'failed'
    || value === 'cancelled'
    || value === 'timed_out';
}

function assertTaskObservedState(value: unknown, reason: 'conflict' | 'corrupt' = 'conflict'): void {
  if (
    value !== 'starting'
    && value !== 'running'
    && value !== 'completed'
    && value !== 'failed'
    && value !== 'cancelled'
    && value !== 'timed_out'
    && value !== 'termination_unverified'
    && value !== 'not_found'
    && value !== 'unreachable'
  ) {
    throw stateError(reason, 'Automation task observed state is invalid');
  }
}

function assertTaskRole(value: unknown, reason: 'conflict' | 'corrupt' = 'conflict'): void {
  if (value !== 'blocking_job' && value !== 'supporting_service') {
    throw stateError(reason, 'Automation task role is invalid');
  }
}

function assertEventType(value: unknown, reason: 'conflict' | 'corrupt' = 'conflict'): void {
  if (!EVENT_TYPES.has(value as AutomationEventType)) {
    throw stateError(reason, 'Automation event type is invalid');
  }
}

const EVENT_TYPES = new Set<AutomationEventType>([
  'run_created',
  'milestone_ready',
  'attempt_started',
  'task_bound',
  'task_observed',
  'verification_started',
  'verification_passed',
  'verification_failed',
  'checkpoint_committed',
  'milestone_completed',
  'recovery_reconciled',
  'policy_denied',
  'run_paused',
  'run_resumed',
  'dispatch_recorded',
  'attempt_failed',
  'milestone_blocked',
  'run_completing',
  'dispatch_unresolved',
  'task_deadline_exceeded',
  'task_recovery_decision',
  'run_terminal',
]);

function assertBoundedString(
  value: unknown,
  label: string,
  maxLength: number,
  reason: 'conflict' | 'corrupt' = 'conflict',
): asserts value is string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > maxLength
    || containsAsciiControlCharacter(value)
  ) {
    throw stateError(reason, `${label} is invalid`);
  }
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function assertNonNegativeInteger(
  value: unknown,
  label: string,
  reason: 'conflict' | 'corrupt' = 'conflict',
): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw stateError(reason, `${label} must be a non-negative integer`);
  }
}

function assertIso(
  value: unknown,
  label: string,
  reason: 'conflict' | 'corrupt' = 'conflict',
): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw stateError(reason, `${label} must be an ISO timestamp`);
  }
}

function stateError(reason: 'conflict' | 'corrupt', message: string): AutomationStateError {
  return new AutomationStateError(reason, message);
}

function conflict(message: string): AutomationStateError {
  return new AutomationStateError('conflict', message);
}

function corrupt(message: string): AutomationStateError {
  return new AutomationStateError('corrupt', message);
}
