import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { SqliteGoalRepository } from './goal-repository.js';
import { GOAL_CONTINUATION_MIGRATION_SQL } from './migrations/goal-continuation-migration.js';
import { SCHEDULED_CONTINUATION_MIGRATION_SQL } from './migrations/scheduled-continuation-migration.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openDatabase(): Promise<SqliteDatabase> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-scheduled-continuation-'));
  temporaryRoots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
  database.connection.prepare(`
    INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('workspace-1', 'Fixture', root, root, '2026-08-27T00:00:00.000Z');
  database.connection.prepare(`
    INSERT INTO goals (
      id, workspace_id, goal_key, owner_client_id, objective, plan_json, status, revision,
      current_phase, next_action, blockers_json, active_task_ids_json,
      lease_owner_client_id, lease_token_hash, lease_duration_seconds, lease_heartbeat_at, lease_expires_at,
      created_at, updated_at, terminal_summary, terminal_evidence_json, terminal_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', 0, 'created', ?, '[]', '[]', NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL)
  `).run(
    'goal-1',
    'workspace-1',
    'scheduled-continuation-fixture',
    'chatgpt-web-client',
    'Exercise the scheduled continuation migration.',
    JSON.stringify({ steps: [] }),
    'Continue safely.',
    '2026-08-27T00:00:00.000Z',
    '2026-08-27T00:00:00.000Z',
  );
  return database;
}

function insertContinuation(
  database: SqliteDatabase,
  input: { id: string; generation: number; sourceRevision: number; status: string; fingerprint: string },
): void {
  database.connection.prepare(`
    INSERT INTO goal_scheduled_continuations (
      id, goal_id, source_session_id, generation, source_goal_revision, status, occurrence, destination,
      execution_preference, confirmed_runs_on, due_at, native_task_id, request_fingerprint,
      version, last_detail, created_at, updated_at, claimed_at, terminal_at
    ) VALUES (?, 'goal-1', 'session-a', ?, ?, ?, 'once', 'current_chat', 'cloud', NULL, ?, NULL, ?, 0, NULL, ?, ?, NULL, NULL)
  `).run(
    input.id,
    input.generation,
    input.sourceRevision,
    input.status,
    `2026-08-27T00:0${input.generation}:00.000Z`,
    input.fingerprint,
    '2026-08-27T00:00:00.000Z',
    '2026-08-27T00:00:00.000Z',
  );
}

async function acquireGoalLease(repository: SqliteGoalRepository, now: string, leaseTokenHash = 'lease-hash-a'): Promise<void> {
  const result = await repository.acquire({
    goalId: 'unused-new-goal-id',
    workspaceId: 'workspace-1',
    goalKey: 'scheduled-continuation-fixture',
    ownerClientId: 'chatgpt-web-client',
    ownerSessionId: 'session-a',
    leaseTokenHash,
    leaseSeconds: 3_600,
    now,
  });
  expect(result.acquired).toBe(true);
}

function prepareRequest(
  now: string,
  dueAt: string,
  expectedRevision: number,
  requestFingerprint: string,
  continuationId: string,
  leaseTokenHash = 'lease-hash-a',
  ownerSessionId = 'session-a',
): Parameters<SqliteGoalRepository['prepareScheduledContinuation']>[0] {
  return {
    continuationId,
    checkpointId: `checkpoint-${continuationId}`,
    goalId: 'goal-1',
    ownerClientId: 'chatgpt-web-client',
    ownerSessionId,
    leaseTokenHash,
    expectedRevision,
    plan: { steps: [] },
    currentPhase: 'continuation-ready',
    summary: 'Prepared one successor near the end of the current full work turn.',
    stepUpdates: [],
    nextAction: 'Continue the durable goal in the successor when it wakes.',
    blockers: [],
    evidence: [],
    activeTaskIds: [],
    dueAt,
    executionPreference: 'cloud' as const,
    requestFingerprint,
    now,
  };
}

describe('scheduled continuation migration', () => {
  it('applies migration 007 and creates the continuation table', async () => {
    const database = await openDatabase();
    try {
      const migrationIds = database.connection.prepare('SELECT id FROM schema_migrations ORDER BY id').all()
        .map((row) => (row as { id: string }).id);
      const tableNames = database.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
        .map((row) => (row as { name: string }).name);

      expect(migrationIds).toContain('007_scheduled_continuations');
      expect(tableNames).toContain('goal_scheduled_continuations');
    } finally {
      database.close();
    }
  });

  it('upgrades a database that already recorded the pre-fence 007 migration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-scheduled-continuation-upgrade-'));
    temporaryRoots.push(root);
    const filename = path.join(root, 'state.sqlite');
    const legacy = new DatabaseSync(filename);
    legacy.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY NOT NULL);');
    legacy.exec(GOAL_CONTINUATION_MIGRATION_SQL);
    legacy.exec(SCHEDULED_CONTINUATION_MIGRATION_SQL);
    for (const id of ['001_initial','002_audit','003_checkpoints','004_audit_scope','005_workspace_archive','006_goal_continuation','007_scheduled_continuations']) {
      legacy.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(id);
    }
    legacy.close();

    const upgraded = new SqliteDatabase(filename);
    try {
      const migrationIds = upgraded.connection.prepare('SELECT id FROM schema_migrations ORDER BY id').all()
        .map((row) => (row as { id: string }).id);
      const goalColumns = upgraded.connection.prepare('PRAGMA table_info(goals)').all()
        .map((row) => (row as { name: string }).name);
      const continuationColumns = upgraded.connection.prepare('PRAGMA table_info(goal_scheduled_continuations)').all()
        .map((row) => (row as { name: string }).name);
      expect(migrationIds).toContain('008_scheduled_continuation_session_fence');
      expect(goalColumns).toContain('lease_owner_session_id');
      expect(continuationColumns).toContain('source_session_id');
    } finally {
      upgraded.close();
    }
  });

  it('repairs an active legacy lease whose session owner was missing after migration 008', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-goal-lease-repair-'));
    temporaryRoots.push(root);
    const filename = path.join(root, 'state.sqlite');
    const first = new SqliteDatabase(filename);
    first.connection.prepare(`
      INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('legacy-workspace', 'Legacy', root, root, '2026-08-27T00:00:00.000Z');
    const firstRepository = new SqliteGoalRepository(first);
    const acquired = await firstRepository.acquire({
      goalId: 'legacy-goal',
      workspaceId: 'legacy-workspace',
      goalKey: 'legacy-goal',
      ownerClientId: 'chatgpt-web-client',
      ownerSessionId: 'session-before-upgrade',
      objective: 'Exercise legacy lease repair.',
      plan: { steps: [] },
      leaseTokenHash: 'legacy-lease-hash',
      leaseSeconds: 600,
      now: '2026-08-27T00:00:00.000Z',
    });
    expect(acquired.acquired).toBe(true);
    first.connection.prepare('UPDATE goals SET lease_owner_session_id = NULL WHERE id = ?').run('legacy-goal');
    first.connection.prepare("DELETE FROM schema_migrations WHERE id = '010_goal_lease_repair'").run();
    first.close();

    const repaired = new SqliteDatabase(filename);
    try {
      const repository = new SqliteGoalRepository(repaired);
      const goal = await repository.getById('legacy-goal');
      expect(goal).toMatchObject({
        status: 'active',
        leaseOwnerClientId: 'chatgpt-web-client',
        leaseOwnerSessionId: 'legacy-pre-session-fence',
        leaseTokenHash: 'legacy-lease-hash',
      });
      await expect(repository.list({ ownerClientId: 'chatgpt-web-client', limit: 20 })).resolves.toHaveLength(1);
      const migrationIds = repaired.connection.prepare('SELECT id FROM schema_migrations ORDER BY id').all()
        .map((row) => (row as { id: string }).id);
      expect(migrationIds).toContain('010_goal_lease_repair');
    } finally {
      repaired.close();
    }
  });

  it('quarantines a malformed partial active lease instead of clearing it for immediate takeover', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-goal-lease-quarantine-'));
    temporaryRoots.push(root);
    const filename = path.join(root, 'state.sqlite');
    const first = new SqliteDatabase(filename);
    first.connection.prepare(`
      INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('quarantine-workspace', 'Quarantine', root, root, '2026-08-27T00:00:00.000Z');
    const firstRepository = new SqliteGoalRepository(first);
    await firstRepository.acquire({
      goalId: 'quarantine-goal',
      workspaceId: 'quarantine-workspace',
      goalKey: 'quarantine-goal',
      ownerClientId: 'chatgpt-web-client',
      ownerSessionId: 'session-before-upgrade',
      objective: 'Exercise malformed lease quarantine.',
      plan: { steps: [] },
      leaseTokenHash: 'legacy-lease-hash',
      leaseSeconds: 600,
      now: '2026-08-27T00:00:00.000Z',
    });
    first.connection.prepare(`
      UPDATE goals
      SET lease_owner_session_id = NULL, lease_token_hash = NULL
      WHERE id = ?
    `).run('quarantine-goal');
    first.connection.prepare("DELETE FROM schema_migrations WHERE id = '010_goal_lease_repair'").run();
    first.close();

    const repaired = new SqliteDatabase(filename);
    try {
      const repository = new SqliteGoalRepository(repaired);
      const goal = await repository.getById('quarantine-goal');
      expect(goal).toMatchObject({
        status: 'active',
        leaseOwnerClientId: 'chatgpt-web-client',
        leaseOwnerSessionId: 'legacy-quarantined-lease',
        leaseTokenHash: '0000000000000000000000000000000000000000000000000000000000000000',
      });
      expect(goal?.leaseExpiresAt).toBe('9999-12-31T23:59:59.999Z');

      const takeover = await repository.acquire({
        goalId: 'unused-goal-id',
        workspaceId: 'quarantine-workspace',
        goalKey: 'quarantine-goal',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'new-session',
        leaseTokenHash: 'new-lease-hash',
        leaseSeconds: 600,
        now: '2026-08-27T00:10:00.000Z',
      });
      expect(takeover.acquired).toBe(false);
    } finally {
      repaired.close();
    }
  });

  it('quarantines a live continuation that an already-applied fail-open repair left without a lease', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-live-continuation-quarantine-'));
    temporaryRoots.push(root);
    const filename = path.join(root, 'state.sqlite');
    const first = new SqliteDatabase(filename);
    first.connection.prepare(`
      INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('live-workspace', 'Live', root, root, '2026-08-27T00:00:00.000Z');
    const repository = new SqliteGoalRepository(first);
    const acquired = await repository.acquire({
      goalId: 'live-goal',
      workspaceId: 'live-workspace',
      goalKey: 'live-goal',
      ownerClientId: 'chatgpt-web-client',
      ownerSessionId: 'session-a',
      objective: 'Repair an old fail-open migration result.',
      plan: { steps: [] },
      leaseTokenHash: 'lease-hash-a',
      leaseSeconds: 600,
      now: '2026-08-27T00:00:00.000Z',
    });
    await repository.prepareScheduledContinuation({
      continuationId: 'live-continuation',
      checkpointId: 'live-continuation-checkpoint',
      goalId: 'live-goal',
      ownerClientId: 'chatgpt-web-client',
      ownerSessionId: 'session-a',
      leaseTokenHash: 'lease-hash-a',
      expectedRevision: acquired.goal.revision,
      plan: { steps: [] },
      currentPhase: 'continuation-ready',
      summary: 'A live continuation exists.',
      stepUpdates: [],
      nextAction: 'Continue safely.',
      blockers: [],
      evidence: [],
      activeTaskIds: [],
      dueAt: '2026-08-27T00:25:00.000Z',
      executionPreference: 'cloud',
      requestFingerprint: 'live-continuation-fingerprint',
      now: '2026-08-27T00:00:01.000Z',
    });
    first.connection.prepare(`
      UPDATE goals
      SET lease_owner_client_id = NULL, lease_owner_session_id = NULL, lease_token_hash = NULL,
          lease_duration_seconds = NULL, lease_heartbeat_at = NULL, lease_expires_at = NULL
      WHERE id = ?
    `).run('live-goal');
    first.connection.prepare("DELETE FROM schema_migrations WHERE id = '011_goal_live_continuation_lease_quarantine'").run();
    first.close();

    const repaired = new SqliteDatabase(filename);
    try {
      const goal = await new SqliteGoalRepository(repaired).getById('live-goal');
      expect(goal).toMatchObject({
        status: 'active',
        leaseOwnerClientId: 'chatgpt-web-client',
        leaseOwnerSessionId: 'legacy-quarantined-live-continuation',
        leaseTokenHash: '0000000000000000000000000000000000000000000000000000000000000000',
      });
      expect(goal?.leaseExpiresAt).toBe('9999-12-31T23:59:59.999Z');
    } finally {
      repaired.close();
    }
  });

  it('enforces at most one live continuation per goal but allows history followed by a new generation', async () => {
    const database = await openDatabase();
    try {
      insertContinuation(database, { id: 'continuation-1', generation: 1, sourceRevision: 0, status: 'prepared', fingerprint: 'fp-1' });
      expect(() => insertContinuation(database, {
        id: 'continuation-2', generation: 2, sourceRevision: 1, status: 'scheduled', fingerprint: 'fp-2',
      })).toThrow();

      database.connection.prepare(`
        UPDATE goal_scheduled_continuations
        SET status = 'claimed', claimed_at = ?, terminal_at = ?, updated_at = ?, version = version + 1
        WHERE id = ?
      `).run(
        '2026-08-27T00:02:00.000Z',
        '2026-08-27T00:02:00.000Z',
        '2026-08-27T00:02:00.000Z',
        'continuation-1',
      );

      expect(() => insertContinuation(database, {
        id: 'continuation-2', generation: 2, sourceRevision: 1, status: 'prepared', fingerprint: 'fp-2',
      })).not.toThrow();
    } finally {
      database.close();
    }
  });
});

describe('scheduled continuation repository state machine', () => {
  it('never replaces a previously recorded native task ID with a later created receipt', async () => {
    const database = await openDatabase();
    const repository = new SqliteGoalRepository(database);
    try {
      await acquireGoalLease(repository, '2026-08-27T00:00:00.000Z');
      const prepared = await repository.prepareScheduledContinuation(prepareRequest(
        '2026-08-27T00:20:00.000Z',
        '2026-08-27T00:25:00.000Z',
        0,
        'native-task-identity-fp',
        'continuation-native-task-identity',
      ));
      const scheduled = await repository.recordScheduledContinuationReceipt({
        continuationId: prepared.continuation.continuationId,
        ownerClientId: 'chatgpt-web-client',
        expectedVersion: prepared.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-original',
        runsOn: 'cloud',
        now: '2026-08-27T00:20:05.000Z',
      });

      await expect(repository.recordScheduledContinuationReceipt({
        continuationId: prepared.continuation.continuationId,
        ownerClientId: 'chatgpt-web-client',
        expectedVersion: scheduled.version,
        outcome: 'created',
        nativeTaskId: 'native-task-replacement',
        runsOn: 'cloud',
        now: '2026-08-27T00:20:06.000Z',
      })).rejects.toMatchObject({ reason: 'conflict' });
      await expect(repository.getScheduledContinuation({
        continuationId: prepared.continuation.continuationId,
      })).resolves.toMatchObject({ nativeTaskId: 'native-task-original' });
    } finally {
      database.close();
    }
  });

  it('does not let historical continuation rows keep fencing a workspace or block a different active scheduled goal', async () => {
    const database = await openDatabase();
    const repository = new SqliteGoalRepository(database);
    try {
      await acquireGoalLease(repository, '2026-08-27T00:00:00.000Z');
      const prepared = await repository.prepareScheduledContinuation(prepareRequest(
        '2026-08-27T00:00:10.000Z',
        '2026-08-27T00:25:10.000Z',
        0,
        'historical-fp',
        'continuation-historical',
      ));
      await repository.recordScheduledContinuationReceipt({
        continuationId: prepared.continuation.continuationId,
        ownerClientId: 'chatgpt-web-client',
        expectedVersion: prepared.continuation.version,
        outcome: 'create_failed',
        detail: 'User opted out before a native task was created.',
        now: '2026-08-27T00:00:11.000Z',
      });
      await expect(repository.getWorkspaceMutationFence('workspace-1')).resolves.toBeNull();
      await expect(repository.getLiveScheduledContinuation('goal-1')).resolves.toBeNull();

      const second = await repository.acquire({
        goalId: 'goal-2',
        workspaceId: 'workspace-1',
        goalKey: 'scheduled-continuation-second-goal',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-b',
        objective: 'Verify historical rows do not own the workspace fence.',
        plan: { steps: [] },
        leaseTokenHash: 'lease-hash-2',
        leaseSeconds: 600,
        now: '2026-08-27T00:01:00.000Z',
      });
      expect(second.acquired).toBe(true);
      await expect(repository.prepareScheduledContinuation({
        continuationId: 'continuation-goal-2',
        checkpointId: 'checkpoint-goal-2',
        goalId: 'goal-2',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-b',
        leaseTokenHash: 'lease-hash-2',
        expectedRevision: 0,
        plan: { steps: [] },
        currentPhase: 'ready',
        summary: 'Second goal may arm after first history is terminal.',
        stepUpdates: [],
        nextAction: 'continue',
        blockers: [],
        evidence: [],
        activeTaskIds: [],
        dueAt: '2026-08-27T00:26:00.000Z',
        executionPreference: 'cloud',
        requestFingerprint: 'goal-2-fp',
        now: '2026-08-27T00:01:00.000Z',
      })).resolves.toMatchObject({ continuation: { continuationId: 'continuation-goal-2', status: 'prepared' } });
    } finally {
      database.close();
    }
  });

  it('keeps useful predecessor work alive until the configured handoff and cancels the exact cloud successor on finish', async () => {
    const database = await openDatabase();
    const repository = new SqliteGoalRepository(database);
    try {
      await acquireGoalLease(repository, '2026-08-27T00:00:00.000Z');
      expect(await repository.getLiveScheduledContinuation('goal-1')).toBeNull();

      const preparedB = await repository.prepareScheduledContinuation(prepareRequest(
        '2026-08-27T00:20:00.000Z',
        '2026-08-27T00:22:00.000Z',
        0,
        'fp-b',
        'continuation-b',
      ));
      expect(preparedB.alreadyPrepared).toBe(false);
      expect(preparedB.continuation.dueAt).toBe('2026-08-27T00:22:00.000Z');
      expect(preparedB.goal.leaseExpiresAt).toBe('2026-08-27T00:22:00.000Z');
      expect(preparedB.goal.revision).toBe(1);
      await repository.recordScheduledContinuationReceipt({
        continuationId: preparedB.continuation.continuationId,
        ownerClientId: 'chatgpt-web-client',
        expectedVersion: preparedB.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-b',
        runsOn: 'cloud',
        now: '2026-08-27T00:20:05.000Z',
      });

      const continuedA = await repository.checkpoint({
        checkpointId: 'checkpoint-a-continued',
        goalId: 'goal-1',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-a',
        leaseTokenHash: 'lease-hash-a',
        expectedRevision: 1,
        plan: { steps: [] },
        currentPhase: 'still-working',
        summary: 'The current run keeps doing useful work after arming its successor.',
        stepUpdates: [],
        nextAction: 'Finish this work slice before the successor due time.',
        blockers: [],
        evidence: [],
        activeTaskIds: [],
        releaseLease: false,
        now: '2026-08-27T00:21:00.000Z',
      });
      expect(continuedA.leaseExpiresAt).toBe('2026-08-27T00:22:00.000Z');
      expect(continuedA.revision).toBe(2);

      const runB = await repository.claimScheduledContinuation({
        continuationId: 'continuation-b',
        recoveryContinuationId: 'continuation-b-recovery-unused',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-b',
        leaseTokenHash: 'lease-hash-b',
        leaseSeconds: 3_600,
        now: '2026-08-27T00:22:00.000Z',
      });
      expect(runB.outcome).toBe('acquired');
      expect(runB.goal.leaseTokenHash).toBe('lease-hash-b');

      const preparedC = await repository.prepareScheduledContinuation(prepareRequest(
        '2026-08-27T00:42:00.000Z',
        '2026-08-27T00:44:00.000Z',
        2,
        'fp-c',
        'continuation-c',
        'lease-hash-b',
        'session-b',
      ));
      expect(preparedC.continuation.generation).toBe(2);
      expect(preparedC.continuation.dueAt).toBe('2026-08-27T00:44:00.000Z');
      expect(preparedC.goal.leaseExpiresAt).toBe('2026-08-27T00:44:00.000Z');

      const scheduledC = await repository.recordScheduledContinuationReceipt({
        continuationId: preparedC.continuation.continuationId,
        ownerClientId: 'chatgpt-web-client',
        expectedVersion: preparedC.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-c',
        runsOn: 'cloud',
        now: '2026-08-27T00:42:05.000Z',
      });
      expect(scheduledC.status).toBe('scheduled');

      await repository.finish({
        checkpointId: 'finish-run-b',
        goalId: 'goal-1',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-b',
        leaseTokenHash: 'lease-hash-b',
        expectedRevision: preparedC.goal.revision,
        status: 'completed',
        summary: 'Run B completed before successor C fired.',
        evidence: [],
        now: '2026-08-27T00:43:00.000Z',
      });
      const cancellation = await repository.markGoalFinishedForScheduledContinuation('goal-1', '2026-08-27T00:43:00.000Z');
      expect(cancellation.continuation).toMatchObject({ status: 'cancel_required', nativeTaskId: 'native-task-c' });
      if (cancellation.continuation === null) throw new Error('missing cancellation continuation');

      await expect(repository.recordScheduledContinuationReceipt({
        continuationId: cancellation.continuation.continuationId,
        ownerClientId: 'chatgpt-web-client',
        expectedVersion: cancellation.continuation.version,
        outcome: 'cancelled',
        nativeTaskId: 'native-task-c',
        runsOn: 'cloud',
        now: '2026-08-27T00:43:04.000Z',
      })).rejects.toThrow('Cancelled receipt requires matching native host deletion evidence');

      const cancelledC = await repository.recordScheduledContinuationReceipt({
        continuationId: cancellation.continuation.continuationId,
        ownerClientId: 'chatgpt-web-client',
        expectedVersion: cancellation.continuation.version,
        outcome: 'cancelled',
        nativeTaskId: 'native-task-c',
        runsOn: 'cloud',
        nativeCancellationReceipt: {
          provider: 'chatgpt_scheduled_task',
          operation: 'delete',
          nativeTaskId: 'native-task-c',
          state: 'deleted',
          observedAt: '2026-08-27T00:43:05.000Z',
        },
        now: '2026-08-27T00:43:05.000Z',
      });
      expect(cancelledC.status).toBe('cancelled');
      expect(await repository.getLiveScheduledContinuation('goal-1')).toBeNull();

      const lateWake = await repository.claimScheduledContinuation({
        continuationId: preparedC.continuation.continuationId,
        recoveryContinuationId: 'continuation-c-late-recovery-unused',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-c',
        leaseTokenHash: 'lease-hash-c',
        leaseSeconds: 600,
        now: '2026-08-27T00:44:00.000Z',
      });
      expect(lateWake.outcome).toBe('terminal_noop');
    } finally {
      database.close();
    }
  });

  it('is idempotent for the same prepare fingerprint and rejects a distinct live prepare', async () => {
    const database = await openDatabase();
    const repository = new SqliteGoalRepository(database);
    try {
      await acquireGoalLease(repository, '2026-08-27T00:00:00.000Z');
      const request = prepareRequest(
        '2026-08-27T00:20:00.000Z',
        '2026-08-27T00:22:00.000Z',
        0,
        'same-fingerprint',
        'continuation-1',
      );
      const first = await repository.prepareScheduledContinuation(request);
      const retry = await repository.prepareScheduledContinuation(request);
      expect(first.alreadyPrepared).toBe(false);
      expect(retry.alreadyPrepared).toBe(true);
      expect(retry.continuation.continuationId).toBe(first.continuation.continuationId);
      expect(retry.goal.revision).toBe(1);

      await expect(repository.prepareScheduledContinuation(prepareRequest(
        '2026-08-27T00:20:30.000Z',
        '2026-08-27T00:22:30.000Z',
        1,
        'different-fingerprint',
        'continuation-2',
      ))).rejects.toMatchObject({ reason: 'conflict' });
    } finally {
      database.close();
    }
  });

  it('rejects stale revisions and wrong lease tokens', async () => {
    const database = await openDatabase();
    const repository = new SqliteGoalRepository(database);
    try {
      await acquireGoalLease(repository, '2026-08-27T00:00:00.000Z');
      await expect(repository.prepareScheduledContinuation(prepareRequest(
        '2026-08-27T00:20:00.000Z',
        '2026-08-27T00:22:00.000Z',
        1,
        'stale',
        'continuation-stale',
      ))).rejects.toMatchObject({ reason: 'conflict' });
      await expect(repository.prepareScheduledContinuation(prepareRequest(
        '2026-08-27T00:20:00.000Z',
        '2026-08-27T00:22:00.000Z',
        0,
        'wrong-token',
        'continuation-wrong-token',
        'wrong-hash',
      ))).rejects.toMatchObject({ reason: 'lease_invalid' });
    } finally {
      database.close();
    }
  });

  it('lets a released predecessor or natural due-time expiry hand the lease to exactly one claimer', async () => {
    const database = await openDatabase();
    const repository = new SqliteGoalRepository(database);
    try {
      await acquireGoalLease(repository, '2026-08-27T00:00:00.000Z');
      const prepared = await repository.prepareScheduledContinuation(prepareRequest(
        '2026-08-27T00:20:00.000Z',
        '2026-08-27T00:22:00.000Z',
        0,
        'claim-fp',
        'continuation-claim',
      ));
      await repository.recordScheduledContinuationReceipt({
        continuationId: prepared.continuation.continuationId,
        ownerClientId: 'chatgpt-web-client',
        expectedVersion: prepared.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-claim',
        runsOn: 'cloud',
        now: '2026-08-27T00:20:05.000Z',
      });
      await repository.checkpoint({
        checkpointId: 'release-before-due',
        goalId: 'goal-1',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-a',
        leaseTokenHash: 'lease-hash-a',
        expectedRevision: 1,
        plan: { steps: [] },
        currentPhase: 'handoff',
        summary: 'Release the lease before the successor wakes.',
        stepUpdates: [],
        nextAction: 'Successor claims at due time.',
        blockers: [],
        evidence: [],
        activeTaskIds: [],
        releaseLease: true,
        now: '2026-08-27T00:21:50.000Z',
      });

      const winner = await repository.claimScheduledContinuation({
        continuationId: 'continuation-claim',
        recoveryContinuationId: 'continuation-claim-recovery-winner',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-b',
        leaseTokenHash: 'lease-hash-b',
        leaseSeconds: 600,
        now: '2026-08-27T00:22:00.000Z',
      });
      expect(winner.outcome).toBe('acquired');

      const loser = await repository.claimScheduledContinuation({
        continuationId: 'continuation-claim',
        recoveryContinuationId: 'continuation-claim-recovery-loser',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-c',
        leaseTokenHash: 'lease-hash-c',
        leaseSeconds: 600,
        now: '2026-08-27T00:22:00.000Z',
      });
      expect(loser.outcome).toBe('already_claimed');
      expect(loser.goal.leaseTokenHash).toBe('lease-hash-b');
    } finally {
      database.close();
    }
  });

  it('returns receipt_required instead of throwing when a prepared continuation has no confirmed native task', async () => {
    const database = await openDatabase();
    const repository = new SqliteGoalRepository(database);
    try {
      await acquireGoalLease(repository, '2026-08-27T00:00:00.000Z');
      const prepared = await repository.prepareScheduledContinuation(prepareRequest(
        '2026-08-27T00:20:00.000Z',
        '2026-08-27T00:22:00.000Z',
        0,
        'receipt-required-fp',
        'continuation-receipt-required',
      ));
      const goal = await repository.getById('goal-1');
      if (goal === null) throw new Error('goal missing');
      const result = await repository.claimScheduledContinuation({
        continuationId: prepared.continuation.continuationId,
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-b',
        leaseTokenHash: 'lease-hash-b',
        leaseSeconds: 600,
        liveness: {
          trustworthy: false,
          observedAt: '2026-08-27T00:22:00.000Z',
          leaseGeneration: goal.leaseGeneration,
          leaseActivitySeq: goal.leaseActivitySeq,
          liveFencedCallCount: 0,
          activeTaskStates: [],
        },
        now: '2026-08-27T00:22:00.000Z',
      });
      expect(result).toMatchObject({
        outcome: 'receipt_required',
        reason: 'native_task_unconfirmed',
        continuation: { continuationId: 'continuation-receipt-required', status: 'prepared' },
      });
      const unchanged = await repository.getScheduledContinuation({ continuationId: 'continuation-receipt-required' });
      expect(unchanged).toMatchObject({ status: 'prepared' });
      expect(unchanged).not.toHaveProperty('nativeTaskId');
    } finally {
      database.close();
    }
  });

  it('consumes the firing native task and reserves exactly one fresh +2 successor on a trusted worker collision', async () => {
    const database = await openDatabase();
    const repository = new SqliteGoalRepository(database);
    try {
      await acquireGoalLease(repository, '2026-08-27T00:00:00.000Z');
      const prepared = await repository.prepareScheduledContinuation(prepareRequest(
        '2026-08-27T00:20:00.000Z',
        '2026-08-27T00:22:00.000Z',
        0,
        'busy-recovery-fp',
        'continuation-busy-original',
      ));
      await repository.recordScheduledContinuationReceipt({
        continuationId: prepared.continuation.continuationId,
        ownerClientId: 'chatgpt-web-client',
        expectedVersion: prepared.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-busy',
        runsOn: 'cloud',
        now: '2026-08-27T00:20:05.000Z',
      });
      database.connection.prepare('UPDATE goals SET lease_expires_at = ? WHERE id = ?')
        .run('2026-08-27T00:25:00.000Z', 'goal-1');
      const goal = await repository.getById('goal-1');
      if (goal === null) throw new Error('goal missing');
      const liveness = {
        trustworthy: true,
        observedAt: '2026-08-27T00:22:00.000Z',
        leaseGeneration: goal.leaseGeneration,
        leaseActivitySeq: goal.leaseActivitySeq,
        liveFencedCallCount: 1,
        activeTaskStates: [],
      } as const;

      const collision = await repository.claimScheduledContinuation({
        continuationId: 'continuation-busy-original',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-b',
        leaseTokenHash: 'lease-hash-b',
        leaseSeconds: 600,
        liveness,
        now: '2026-08-27T00:22:00.000Z',
      });
      expect(collision).toMatchObject({
        outcome: 'successor_required',
        retryAfterSeconds: 120,
        continuation: {
          continuationId: 'continuation-busy-original',
          nativeTaskId: 'native-task-busy',
          status: 'superseded',
        },
        successor: {
          generation: 2,
          status: 'prepared',
          dueAt: '2026-08-27T00:24:00.000Z',
        },
      });
      if (collision.outcome !== 'successor_required') throw new Error('fresh collision successor missing');
      expect(collision.successor.nativeTaskId).toBeUndefined();
      await expect(repository.getLiveScheduledContinuation('goal-1')).resolves.toMatchObject({
        continuationId: collision.successor.continuationId,
        status: 'prepared',
      });
      await expect(repository.getWorkspaceMutationFence('workspace-1')).resolves.toMatchObject({
        continuation: { continuationId: collision.successor.continuationId, status: 'prepared' },
      });

      const repeated = await repository.claimScheduledContinuation({
        continuationId: 'continuation-busy-original',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-c',
        leaseTokenHash: 'lease-hash-c',
        leaseSeconds: 600,
        liveness: { ...liveness, observedAt: '2026-08-27T00:22:30.000Z' },
        now: '2026-08-27T00:22:30.000Z',
      });
      expect(repeated).toMatchObject({
        outcome: 'successor_required',
        successor: { continuationId: collision.successor.continuationId, generation: 2 },
      });
      expect((await repository.getScheduledContinuation({ goalId: 'goal-1', latest: true }))?.continuationId)
        .toBe(collision.successor.continuationId);
    } finally {
      database.close();
    }
  });

  it('fails closed into a fresh disposable +2 successor when worker evidence is uncertain', async () => {
    const database = await openDatabase();
    const repository = new SqliteGoalRepository(database);
    try {
      await acquireGoalLease(repository, '2026-08-27T00:00:00.000Z');
      const prepared = await repository.prepareScheduledContinuation(prepareRequest(
        '2026-08-27T00:20:00.000Z',
        '2026-08-27T00:22:00.000Z',
        0,
        'busy-uncertain-fp',
        'continuation-busy-uncertain',
      ));
      await repository.recordScheduledContinuationReceipt({
        continuationId: prepared.continuation.continuationId,
        ownerClientId: 'chatgpt-web-client',
        expectedVersion: prepared.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-uncertain',
        runsOn: 'cloud',
        now: '2026-08-27T00:20:05.000Z',
      });
      database.connection.prepare('UPDATE goals SET lease_expires_at = ? WHERE id = ?')
        .run('2026-08-27T00:28:01.000Z', 'goal-1');
      const goal = await repository.getById('goal-1');
      if (goal === null) throw new Error('goal missing');

      const blocked = await repository.claimScheduledContinuation({
        continuationId: 'continuation-busy-uncertain',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-b',
        leaseTokenHash: 'lease-hash-b',
        leaseSeconds: 600,
        liveness: {
          trustworthy: false,
          observedAt: '2026-08-27T00:22:00.000Z',
          leaseGeneration: goal.leaseGeneration,
          leaseActivitySeq: goal.leaseActivitySeq,
          liveFencedCallCount: 0,
          activeTaskStates: [],
        },
        now: '2026-08-27T00:22:00.000Z',
      });
      expect(blocked).toMatchObject({
        outcome: 'successor_required',
        retryAfterSeconds: 120,
        continuation: {
          continuationId: 'continuation-busy-uncertain',
          nativeTaskId: 'native-task-uncertain',
          status: 'superseded',
        },
        successor: {
          status: 'prepared',
          dueAt: '2026-08-27T00:24:00.000Z',
        },
      });
      if (blocked.outcome !== 'successor_required') throw new Error('fresh uncertain successor missing');
      expect(blocked.successor.orphanProbeStartedAt).toBeUndefined();
      expect(blocked.successor.orphanProbeLeaseGeneration).toBeUndefined();
      expect(blocked.successor.orphanProbeActivitySeq).toBeUndefined();
      expect(blocked.outcome).not.toBe('acquired');
    } finally {
      database.close();
    }
  });

  it('does not take over an expired lease while a blocking task is still running', async () => {
    const database = await openDatabase();
    const repository = new SqliteGoalRepository(database);
    try {
      await acquireGoalLease(repository, '2026-08-27T00:00:00.000Z');
      const prepared = await repository.prepareScheduledContinuation({
        ...prepareRequest(
          '2026-08-27T00:20:00.000Z',
          '2026-08-27T00:22:00.000Z',
          0,
          'expired-live-job-fp',
          'continuation-expired-live-job',
        ),
        trackedTasks: [{ taskId: 'job-1', provider: 'shell', role: 'blocking_job', cancelWithGoal: true }],
      });
      await repository.recordScheduledContinuationReceipt({
        continuationId: prepared.continuation.continuationId,
        ownerClientId: 'chatgpt-web-client',
        expectedVersion: prepared.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-expired-live-job',
        runsOn: 'cloud',
        now: '2026-08-27T00:20:05.000Z',
      });
      database.connection.prepare('UPDATE goals SET lease_expires_at = ? WHERE id = ?')
        .run('2026-08-27T00:21:00.000Z', 'goal-1');
      const goal = await repository.getById('goal-1');
      if (goal === null) throw new Error('goal missing');
      const result = await repository.claimScheduledContinuation({
        continuationId: prepared.continuation.continuationId,
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-b',
        leaseTokenHash: 'lease-hash-b',
        leaseSeconds: 600,
        liveness: {
          trustworthy: true,
          observedAt: '2026-08-27T00:22:00.000Z',
          leaseGeneration: goal.leaseGeneration,
          leaseActivitySeq: goal.leaseActivitySeq,
          liveFencedCallCount: 0,
          blockingTaskStates: [{ taskId: 'job-1', provider: 'shell', state: 'running' }],
        },
        collisionSuccessorId: 'wake-expired-live-job',
        collisionSuccessorDueAt: '2026-08-27T00:24:00.000Z',
        collisionSuccessorRequestFingerprint: 'expired-live-job-successor-fp',
        now: '2026-08-27T00:22:00.000Z',
      });
      expect(result).toMatchObject({ outcome: 'successor_required', continuation: { status: 'superseded' }, successor: { continuationId: 'wake-expired-live-job' } });
    } finally {
      database.close();
    }
  });

  it('recovers an orphan only after two unchanged trustworthy probes and rejects the predecessor generation even on the same session', async () => {
    const database = await openDatabase();
    const repository = new SqliteGoalRepository(database);
    try {
      await acquireGoalLease(repository, '2026-08-27T00:00:00.000Z');
      const prepared = await repository.prepareScheduledContinuation(prepareRequest(
        '2026-08-27T00:20:00.000Z',
        '2026-08-27T00:22:00.000Z',
        0,
        'orphan-fp',
        'continuation-orphan',
      ));
      await repository.recordScheduledContinuationReceipt({
        continuationId: prepared.continuation.continuationId,
        ownerClientId: 'chatgpt-web-client',
        expectedVersion: prepared.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-orphan',
        runsOn: 'cloud',
        now: '2026-08-27T00:20:05.000Z',
      });
      database.connection.prepare('UPDATE goals SET lease_expires_at = ? WHERE id = ?')
        .run('2026-08-27T00:30:00.000Z', 'goal-1');
      const predecessor = await repository.getById('goal-1');
      if (predecessor === null) throw new Error('goal missing');
      const inactive = {
        trustworthy: true,
        observedAt: '2026-08-27T00:22:00.000Z',
        leaseGeneration: predecessor.leaseGeneration,
        leaseActivitySeq: predecessor.leaseActivitySeq,
        liveFencedCallCount: 0,
        activeTaskStates: [],
      } as const;

      const firstProbe = await repository.claimScheduledContinuation({
        continuationId: prepared.continuation.continuationId,
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-a',
        leaseTokenHash: 'lease-hash-b',
        leaseSeconds: 600,
        liveness: inactive,
        now: '2026-08-27T00:22:00.000Z',
      });
      expect(firstProbe).toMatchObject({
        outcome: 'successor_required',
        continuation: {
          continuationId: 'continuation-orphan',
          status: 'superseded',
        },
        successor: {
          generation: 2,
          dueAt: '2026-08-27T00:24:00.000Z',
          orphanProbeStartedAt: '2026-08-27T00:22:00.000Z',
          orphanProbeLeaseGeneration: predecessor.leaseGeneration,
          orphanProbeActivitySeq: predecessor.leaseActivitySeq,
        },
      });
      if (firstProbe.outcome !== 'successor_required') throw new Error('first orphan probe did not reserve a successor');

      const scheduledSuccessor = await repository.recordScheduledContinuationReceipt({
        continuationId: firstProbe.successor.continuationId,
        ownerClientId: 'chatgpt-web-client',
        expectedVersion: firstProbe.successor.version,
        outcome: 'created',
        nativeTaskId: 'native-task-orphan-b',
        runsOn: 'cloud',
        now: '2026-08-27T00:22:05.000Z',
      });
      expect(scheduledSuccessor).toMatchObject({ status: 'scheduled', dueAt: '2026-08-27T00:24:00.000Z', generation: 2 });

      const recovered = await repository.claimScheduledContinuation({
        continuationId: firstProbe.successor.continuationId,
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-a',
        leaseTokenHash: 'lease-hash-b',
        leaseSeconds: 600,
        liveness: { ...inactive, observedAt: '2026-08-27T00:24:00.000Z' },
        now: '2026-08-27T00:24:00.000Z',
      });
      expect(recovered).toMatchObject({ outcome: 'acquired', acquisition: 'orphan_recovered' });
      expect(recovered.goal.leaseGeneration).toBe(predecessor.leaseGeneration + 1);
      expect(recovered.goal.leaseTokenHash).toBe('lease-hash-b');

      const successor = await repository.prepareScheduledContinuation(prepareRequest(
        '2026-08-27T00:24:01.000Z',
        '2026-08-27T00:49:01.000Z',
        recovered.goal.revision,
        'orphan-successor-fp',
        'continuation-after-orphan',
        'lease-hash-b',
        'session-a',
      ));
      expect(successor.continuation.generation).toBe(3);

      await expect(repository.beginGoalFencedMutation({
        callId: 'old-generation-call',
        goalId: 'goal-1',
        workspaceId: 'workspace-1',
        ownerClientId: 'chatgpt-web-client',
        leaseTokenHash: 'lease-hash-a',
        leaseGeneration: predecessor.leaseGeneration,
        startedAt: '2026-08-27T00:24:02.000Z',
        expiresAt: '2026-08-27T00:24:32.000Z',
      })).rejects.toMatchObject({ reason: 'lease_invalid' });

      const admitted = await repository.beginGoalFencedMutation({
        callId: 'new-generation-call',
        goalId: 'goal-1',
        workspaceId: 'workspace-1',
        ownerClientId: 'chatgpt-web-client',
        leaseTokenHash: 'lease-hash-b',
        leaseGeneration: recovered.goal.leaseGeneration,
        startedAt: '2026-08-27T00:24:02.000Z',
        expiresAt: '2026-08-27T00:24:32.000Z',
      });
      expect(admitted.leaseGeneration).toBe(recovered.goal.leaseGeneration);
      await repository.endGoalFencedMutation('new-generation-call', '2026-08-27T00:24:03.000Z');
    } finally {
      database.close();
    }
  });

  it('restarts orphan recovery when the predecessor checkpoints between trustworthy probes', async () => {
    const database = await openDatabase();
    const repository = new SqliteGoalRepository(database);
    try {
      await acquireGoalLease(repository, '2026-08-27T00:00:00.000Z');
      const prepared = await repository.prepareScheduledContinuation(prepareRequest(
        '2026-08-27T00:20:00.000Z',
        '2026-08-27T00:22:00.000Z',
        0,
        'orphan-checkpoint-fp',
        'continuation-orphan-checkpoint',
      ));
      await repository.recordScheduledContinuationReceipt({
        continuationId: prepared.continuation.continuationId,
        ownerClientId: 'chatgpt-web-client',
        expectedVersion: prepared.continuation.version,
        outcome: 'created',
        nativeTaskId: 'native-task-orphan-checkpoint',
        runsOn: 'cloud',
        now: '2026-08-27T00:20:05.000Z',
      });
      database.connection.prepare('UPDATE goals SET lease_expires_at = ? WHERE id = ?')
        .run('2026-08-27T00:30:00.000Z', 'goal-1');
      const predecessor = await repository.getById('goal-1');
      if (predecessor === null) throw new Error('goal missing');

      const firstProbe = await repository.claimScheduledContinuation({
        continuationId: prepared.continuation.continuationId,
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-b',
        leaseTokenHash: 'lease-hash-b',
        leaseSeconds: 600,
        liveness: {
          trustworthy: true,
          observedAt: '2026-08-27T00:22:00.000Z',
          leaseGeneration: predecessor.leaseGeneration,
          leaseActivitySeq: predecessor.leaseActivitySeq,
          liveFencedCallCount: 0,
          activeTaskStates: [],
        },
        now: '2026-08-27T00:22:00.000Z',
      });
      expect(firstProbe).toMatchObject({
        outcome: 'successor_required',
        continuation: { status: 'superseded' },
        successor: { orphanProbeStartedAt: '2026-08-27T00:22:00.000Z', dueAt: '2026-08-27T00:24:00.000Z' },
      });
      if (firstProbe.outcome !== 'successor_required') throw new Error('first orphan probe did not reserve a successor');
      await repository.recordScheduledContinuationReceipt({
        continuationId: firstProbe.successor.continuationId,
        ownerClientId: 'chatgpt-web-client',
        expectedVersion: firstProbe.successor.version,
        outcome: 'created',
        nativeTaskId: 'native-task-orphan-checkpoint-b',
        runsOn: 'cloud',
        now: '2026-08-27T00:22:05.000Z',
      });

      const checkpointed = await repository.checkpoint({
        checkpointId: 'predecessor-checkpoint-between-probes',
        goalId: 'goal-1',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-a',
        leaseTokenHash: 'lease-hash-a',
        expectedRevision: prepared.goal.revision,
        plan: { steps: [] },
        currentPhase: 'still-working',
        summary: 'The predecessor is still alive between orphan probes.',
        stepUpdates: [],
        nextAction: 'Continue working.',
        blockers: [],
        evidence: [],
        activeTaskIds: [],
        releaseLease: false,
        now: '2026-08-27T00:23:00.000Z',
      });
      expect(checkpointed.leaseActivitySeq).toBe(predecessor.leaseActivitySeq + 1);
      database.connection.prepare('UPDATE goals SET lease_expires_at = ? WHERE id = ?')
        .run('2026-08-27T00:30:00.000Z', 'goal-1');

      const secondProbe = await repository.claimScheduledContinuation({
        continuationId: firstProbe.successor.continuationId,
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-b',
        leaseTokenHash: 'lease-hash-b',
        leaseSeconds: 600,
        liveness: {
          trustworthy: true,
          observedAt: '2026-08-27T00:24:00.000Z',
          leaseGeneration: checkpointed.leaseGeneration,
          leaseActivitySeq: checkpointed.leaseActivitySeq,
          liveFencedCallCount: 0,
          activeTaskStates: [],
        },
        now: '2026-08-27T00:24:00.000Z',
      });
      expect(secondProbe).toMatchObject({
        outcome: 'successor_required',
        continuation: { status: 'superseded' },
        successor: {
          dueAt: '2026-08-27T00:26:00.000Z',
          orphanProbeStartedAt: '2026-08-27T00:24:00.000Z',
          orphanProbeActivitySeq: checkpointed.leaseActivitySeq,
        },
      });
      expect(secondProbe.outcome).not.toBe('acquired');
    } finally {
      database.close();
    }
  });

  it('slides a 10-minute goal lease only on real fenced activity and never beyond the handoff deadline', async () => {
    const database = await openDatabase();
    const repository = new SqliteGoalRepository(database);
    try {
      const acquired = await repository.acquire({
        goalId: 'unused-new-goal-id',
        workspaceId: 'workspace-1',
        goalKey: 'scheduled-continuation-fixture',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-a',
        leaseTokenHash: 'lease-hash-a',
        leaseSeconds: 600,
        now: '2026-08-27T00:00:00.000Z',
      });
      expect(acquired.acquired).toBe(true);
      const prepared = await repository.prepareScheduledContinuation(prepareRequest(
        '2026-08-27T00:00:00.000Z',
        '2026-08-27T00:25:00.000Z',
        0,
        'sliding-lease-fp',
        'continuation-sliding-lease',
      ));
      expect(prepared.goal.leaseExpiresAt).toBe('2026-08-27T00:10:00.000Z');

      await repository.beginGoalFencedMutation({
        callId: 'sliding-call',
        goalId: 'goal-1',
        workspaceId: 'workspace-1',
        ownerClientId: 'chatgpt-web-client',
        leaseTokenHash: 'lease-hash-a',
        leaseGeneration: prepared.goal.leaseGeneration,
        startedAt: '2026-08-27T00:05:00.000Z',
        expiresAt: '2026-08-27T00:06:00.000Z',
      });
      expect((await repository.getById('goal-1'))?.leaseExpiresAt).toBe('2026-08-27T00:15:00.000Z');

      await repository.heartbeatGoalFencedMutation(
        'sliding-call',
        prepared.goal.leaseGeneration,
        '2026-08-27T00:09:00.000Z',
        '2026-08-27T00:10:00.000Z',
      );
      expect((await repository.getById('goal-1'))?.leaseExpiresAt).toBe('2026-08-27T00:19:00.000Z');

      await repository.heartbeatGoalFencedMutation(
        'sliding-call',
        prepared.goal.leaseGeneration,
        '2026-08-27T00:16:00.000Z',
        '2026-08-27T00:17:00.000Z',
      );
      expect((await repository.getById('goal-1'))?.leaseExpiresAt).toBe('2026-08-27T00:25:00.000Z');
    } finally {
      database.close();
    }
  });

  it('turns a scheduled wake into terminal_noop after the goal finishes', async () => {
    const database = await openDatabase();
    const repository = new SqliteGoalRepository(database);
    try {
      await acquireGoalLease(repository, '2026-08-27T00:00:00.000Z');
      await repository.prepareScheduledContinuation(prepareRequest(
        '2026-08-27T00:20:00.000Z',
        '2026-08-27T00:22:00.000Z',
        0,
        'terminal-fp',
        'continuation-terminal',
      ));
      await repository.finish({
        checkpointId: 'finish-before-due',
        goalId: 'goal-1',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-a',
        leaseTokenHash: 'lease-hash-a',
        expectedRevision: 1,
        status: 'completed',
        summary: 'Completed before the pending successor fired.',
        evidence: [],
        now: '2026-08-27T00:21:00.000Z',
      });

      const claim = await repository.claimScheduledContinuation({
        continuationId: 'continuation-terminal',
        recoveryContinuationId: 'continuation-terminal-recovery-unused',
        ownerClientId: 'chatgpt-web-client',
        ownerSessionId: 'session-b',
        leaseTokenHash: 'lease-hash-b',
        leaseSeconds: 600,
        now: '2026-08-27T00:22:00.000Z',
      });
      expect(claim.outcome).toBe('terminal_noop');
      expect(claim.goal.status).toBe('completed');
      expect(claim.continuation.status).toBe('terminal_noop');
    } finally {
      database.close();
    }
  });
});
