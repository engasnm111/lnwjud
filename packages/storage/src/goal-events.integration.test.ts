import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GoalContinuationService } from '@lnwjud/application';
import { canonicalGoalEvent } from '@lnwjud/domain';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabase } from './database.js';
import { SqliteGoalRepository } from './goal-repository.js';
import { SqliteGoalEventStore } from './goal-event-store.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';
import { SqliteBackupService, applyPendingSqliteRestoreSync } from './backup-service.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const actor = { clientId: 'host-client', clientName: 'Host', sessionId: 'session-1' };

async function fixture(): Promise<{ root: string; database: SqliteDatabase; workspaces: SqliteWorkspaceRepository; store: SqliteGoalEventStore; repository: SqliteGoalRepository; service: GoalContinuationService }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-goal-events-'));
  roots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
  const workspaces = new SqliteWorkspaceRepository(database);
  for (const id of ['workspace-a', 'workspace-b']) await workspaces.insert({ id, displayName: id, rootPath: path.join(root, id), realRootPath: path.join(root, id), createdAt: '2026-11-11T00:00:00.000Z' });
  const store = new SqliteGoalEventStore(database);
  const repository = new SqliteGoalRepository(database, () => 'standard');
  const service = new GoalContinuationService(workspaces, repository);
  return { root, database, workspaces, store, repository, service };
}

describe('authoritative Goal event outbox', () => {
  it('fences an already open reader-v2 writer when the event migration commits', async () => {
    const runtime = await fixture();
    const created = await runtime.service.runGoal(actor, { workspaceId: 'workspace-a', goalKey: 'old-writer', objective: 'test' });
    if (!created.ok) throw new Error('fixture goal failed');
    runtime.database.connection.exec(`DROP TABLE goal_commit_events; DROP TABLE goal_event_subscribers; DROP TABLE goal_event_signing_keys;
      DELETE FROM schema_migrations WHERE id = '026_goal_events'; UPDATE runtime_compatibility SET minimum_reader = 2 WHERE scope = 'goal_contract';`);
    runtime.database.close();
    const filename = path.join(runtime.root, 'state.sqlite');
    const old = new DatabaseSync(filename);
    old.function('lnwjud_goal_contract_schema', { deterministic: true }, (): number => 2);
    const statement = old.prepare('UPDATE goals SET current_phase = ? WHERE id = ?');
    statement.run('old compatible writer', created.value.goalId);
    const upgraded = new SqliteDatabase(filename);
    try {
      expect(() => statement.run('untracked old write', created.value.goalId)).toThrow('requires a newer lnwjud');
      expect(upgraded.connection.prepare('SELECT current_phase FROM goals WHERE id = ?').get(created.value.goalId)?.current_phase).toBe('old compatible writer');
      expect(upgraded.connection.prepare("SELECT minimum_reader FROM runtime_compatibility WHERE scope = 'goal_contract'").get()?.minimum_reader).toBe(3);
    } finally { old.close(); upgraded.close(); }
  });

  it('removes only deleted workspace subscription and outbox metadata while preserving another workspace', async () => {
    const runtime = await fixture();
    try {
      const a = runtime.store.enroll('workspace-a', 'Companion A', 'test-key', new Date().toISOString());
      const b = runtime.store.enroll('workspace-b', 'Companion B', 'test-key', new Date().toISOString());
      await runtime.service.runGoal(actor, { workspaceId: 'workspace-a', goalKey: 'a', objective: 'test' });
      await runtime.service.runGoal(actor, { workspaceId: 'workspace-b', goalKey: 'b', objective: 'test' });
      runtime.store.revoke(a.subscriber, new Date().toISOString());
      await runtime.workspaces.delete('workspace-a');
      expect(runtime.store.authenticate(a.token)).toBeNull();
      expect(runtime.database.connection.prepare("SELECT COUNT(*) AS count FROM goal_commit_events WHERE workspace_id = 'workspace-a'").get()?.count).toBe(0);
      expect(runtime.store.authenticate(b.token)).not.toBeNull();
      expect(runtime.store.read(b.subscriber)).toHaveLength(1);
    } finally { runtime.database.close(); }
  });
  it('requires fresh native pairing after any database restore instead of resurrecting old subscriber authority', async () => {
    const runtime = await fixture();
    const filename = path.join(runtime.root, 'state.sqlite');
    const backupDirectory = path.join(runtime.root, 'backups');
    const enrolled = runtime.store.enroll('workspace-a', 'Test companion', 'test-key', new Date().toISOString());
    const backup = new SqliteBackupService(runtime.database, { databaseFilename: filename, backupDirectory });
    const snapshot = await backup.create('manual');
    runtime.store.revoke(enrolled.subscriber, new Date().toISOString());
    await backup.scheduleRestore(snapshot.id);
    runtime.database.close();
    expect(applyPendingSqliteRestoreSync(filename, backupDirectory)).toMatchObject({ applied: true, quarantinedItems: [`goal-event-subscription:${enrolled.subscriber.id}`] });
    const restored = new SqliteDatabase(filename);
    try { expect(new SqliteGoalEventStore(restored).authenticate(enrolled.token)).toBeNull(); }
    finally { restored.close(); }
  });
  it('stages only approved metadata from genuine committed lifecycle transitions, scoped to the workspace', async () => {
    const runtime = await fixture();
    try {
      const enrolled = runtime.store.enroll('workspace-a', 'Test companion', 'test-key', new Date().toISOString());
      const created = await runtime.service.runGoal(actor, { workspaceId: 'workspace-a', goalKey: 'approved', objective: 'secret objective /private/path', plan: { steps: [] } });
      expect(created.ok).toBe(true);
      if (!created.ok || created.value.leaseToken === undefined) throw new Error('fixture goal failed');
      const first = runtime.store.read(enrolled.subscriber);
      expect(first).toHaveLength(1);
      const event = first[0]!.event;
      expect(event).toMatchObject({ contract: 'lnwjud.goal-event.v1', workspaceId: 'workspace-a', goalId: created.value.goalId, revision: 0, fromStatus: null, toStatus: 'active', origin: 'host-goal-repository', authorizationMode: 'standard' });
      const persisted = await runtime.repository.getById(created.value.goalId);
      expect(event.committedAt).toBe(persisted!.updatedAt);
      expect(Object.keys(event)).toHaveLength(10);
      expect(JSON.stringify(event)).not.toContain('secret objective');
      expect(JSON.stringify(event)).not.toContain('/private/path');
      await runtime.service.runGoal(actor, { workspaceId: 'workspace-b', goalKey: 'other', objective: 'private project', plan: { steps: [] } });
      const checkpoint = await runtime.service.checkpointGoal(actor, { goalId: created.value.goalId, leaseToken: created.value.leaseToken, expectedRevision: 0, currentPhase: 'work', summary: 'private checkpoint', stepUpdates: [], nextAction: '', blockers: [], evidence: [], trackedTasks: [] });
      expect(checkpoint.ok).toBe(true);
      expect(runtime.store.read(enrolled.subscriber)).toEqual(first);
      const finished = await runtime.service.finishGoal(actor, { goalId: created.value.goalId, leaseToken: created.value.leaseToken, expectedRevision: 1, status: 'completed', summary: 'private final output', evidence: [] });
      expect(finished.ok).toBe(true);
      const events = runtime.store.read(enrolled.subscriber);
      expect(events).toHaveLength(2);
      expect(events[1]!.event).toMatchObject({ fromStatus: 'active', toStatus: 'completed', revision: 2 });
      expect(events.every((entry) => entry.event.workspaceId === 'workspace-a')).toBe(true);
    } finally { runtime.database.close(); }
  });

  it('rolls the Goal and its checkpoint back when required outbox persistence fails', async () => {
    const runtime = await fixture();
    try {
      runtime.store.enroll('workspace-a', 'Test companion', 'test-key', new Date().toISOString());
      runtime.database.connection.exec(`CREATE TRIGGER reject_goal_events BEFORE INSERT ON goal_commit_events BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END;`);
      const rejected = await runtime.service.runGoal(actor, { workspaceId: 'workspace-a', goalKey: 'fail-create', objective: 'test' });
      expect(rejected.ok).toBe(false);
      expect(await runtime.repository.getByKey('workspace-a', 'fail-create')).toBeNull();
      runtime.database.connection.exec('DROP TRIGGER reject_goal_events');
      const created = await runtime.service.runGoal(actor, { workspaceId: 'workspace-a', goalKey: 'fail-finish', objective: 'test' });
      if (!created.ok || created.value.leaseToken === undefined) throw new Error('fixture goal failed');
      runtime.database.connection.exec(`CREATE TRIGGER reject_goal_events BEFORE INSERT ON goal_commit_events BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END;`);
      const finish = await runtime.service.finishGoal(actor, { goalId: created.value.goalId, leaseToken: created.value.leaseToken, expectedRevision: 0, status: 'blocked', summary: 'test', evidence: [] });
      expect(finish.ok).toBe(false);
      const goal = await runtime.repository.getById(created.value.goalId);
      expect(goal).toMatchObject({ status: 'active', revision: 0, checkpoints: [] });
      expect(runtime.database.connection.prepare('SELECT COUNT(*) AS count FROM goal_commit_events').get()?.count).toBe(1);
    } finally { runtime.database.close(); }
  });

  it('publishes nothing without consent or with Full Bypass or unknown host provenance', async () => {
    const runtime = await fixture();
    try {
      await runtime.service.runGoal(actor, { workspaceId: 'workspace-a', goalKey: 'no-consent', objective: 'test' });
      const enrolled = runtime.store.enroll('workspace-a', 'Test companion', 'test-key', new Date().toISOString());
      for (const mode of ['full_bypass', 'unknown'] as const) {
        const service = new GoalContinuationService(runtime.workspaces, new SqliteGoalRepository(runtime.database, () => mode));
        expect((await service.runGoal(actor, { workspaceId: 'workspace-a', goalKey: mode, objective: 'test' })).ok).toBe(true);
      }
      const unknownService = new GoalContinuationService(runtime.workspaces, new SqliteGoalRepository(runtime.database));
      expect((await unknownService.runGoal(actor, { workspaceId: 'workspace-a', goalKey: 'unwrapped-host-call', objective: 'test' })).ok).toBe(true);
      expect(runtime.store.read(enrolled.subscriber)).toEqual([]);
      expect(() => canonicalGoalEvent({ contract: 'lnwjud.goal-event.v1', objective: 'fake caller event' })).toThrow('GOAL_EVENT_INVALID');
    } finally { runtime.database.close(); }
  });

  it('never exposes an outbox stage to another connection before commit and replays durable data after restart', async () => {
    const runtime = await fixture();
    const observer = new SqliteDatabase(path.join(runtime.root, 'state.sqlite'));
    const enrolled = runtime.store.enroll('workspace-a', 'Test companion', 'test-key', new Date().toISOString());
    try {
      runtime.database.connection.exec('BEGIN IMMEDIATE');
      runtime.database.connection.prepare(`INSERT INTO goals (id,workspace_id,goal_key,owner_client_id,objective,plan_json,status,revision,current_phase,next_action,blockers_json,active_task_ids_json,created_at,updated_at) VALUES ('uncommitted','workspace-a','uncommitted','host','secret','{"steps":[]}','active',0,'','','[]','[]','2026-11-11T00:00:00.000Z','2026-11-11T00:00:00.000Z')`).run();
      runtime.database.connection.prepare(`INSERT INTO goal_commit_events (event_id,workspace_id,goal_id,revision,payload_json) VALUES ('uncommitted','workspace-a','uncommitted',0,'{}')`).run();
      expect(observer.connection.prepare('SELECT COUNT(*) AS count FROM goal_commit_events').get()?.count).toBe(0);
      runtime.database.connection.exec('ROLLBACK');
      expect((await runtime.service.runGoal(actor, { workspaceId: 'workspace-a', goalKey: 'persisted', objective: 'test' })).ok).toBe(true);
      const first = runtime.store.read(enrolled.subscriber);
      runtime.database.close();
      expect(new SqliteGoalEventStore(observer).read(enrolled.subscriber)).toEqual(first);
    } finally { observer.close(); runtime.database.close(); }
  });
});
