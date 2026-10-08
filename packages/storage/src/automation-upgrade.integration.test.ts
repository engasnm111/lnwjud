import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPendingSqliteRestoreSync, SqliteBackupService } from './backup-service.js';
import { SqliteAutomationRepository } from './automation-repository.js';
import { SqliteDatabase } from './database.js';
import { SqliteGoalRepository } from './goal-repository.js';

const roots: string[] = [];
const now = '2026-09-20T10:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('019_native_automation migration', () => {
  it('upgrades an 018 database atomically while preserving goal and scheduled-continuation rows', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-automation-upgrade-'));
    roots.push(root);
    const filename = path.join(root, 'lnwjud.sqlite');
    const initial = new SqliteDatabase(filename);
    initial.connection.prepare(`INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at)
      VALUES (?, ?, ?, ?, ?)`).run('workspace-a', 'Workspace A', root, root, now);
    const goals = new SqliteGoalRepository(initial);
    const plan = { steps: [{ id: 'step-a', title: 'Step A', status: 'pending' as const }] };
    await goals.acquire({
      goalId: 'goal-a', workspaceId: 'workspace-a', goalKey: 'goal-a', ownerClientId: 'client-a', ownerSessionId: 'session-a',
      objective: 'Upgrade safely', plan, leaseTokenHash: 'lease-hash', leaseSeconds: 600, now,
    });
    await goals.prepareScheduledContinuation({
      continuationId: 'continuation-a', checkpointId: 'checkpoint-a', goalId: 'goal-a',
      ownerClientId: 'client-a', ownerSessionId: 'session-a', leaseTokenHash: 'lease-hash', expectedRevision: 0,
      plan, currentPhase: 'upgrade', summary: 'preserve schedule', stepUpdates: [], nextAction: 'continue', blockers: [], evidence: [],
      activeTaskIds: [], trackedTasks: [], dueAt: '2026-09-20T11:00:00.000Z', occurrence: 'interval', intervalMinutes: 60,
      executionPreference: 'cloud', requestFingerprint: 'fingerprint-a', now,
    });
    initial.close();

    const raw = new DatabaseSync(filename);
    raw.exec('PRAGMA foreign_keys = OFF;');
    raw.exec('DROP TABLE IF EXISTS automation_events; DROP TABLE IF EXISTS automation_attempts; DROP TABLE IF EXISTS automation_milestones; DROP TABLE IF EXISTS automation_runs;');
    raw.prepare("DELETE FROM schema_migrations WHERE id = '019_native_automation'").run();
    raw.close();

    const backupDirectory = path.join(root, 'backups');
    let snapshotId = '';
    const upgraded = new SqliteDatabase(filename);
    try {
      const tables = upgraded.connection.prepare(`SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'automation_%' ORDER BY name`).all() as { name: string }[];
      expect(tables.map((row) => row.name)).toEqual([
        'automation_attempts',
        'automation_events',
        'automation_milestones',
        'automation_runs',
      ]);
      expect(upgraded.connection.prepare("SELECT COUNT(*) AS count FROM goals WHERE id = 'goal-a'").get()).toEqual({ count: 1 });
      expect(upgraded.connection.prepare("SELECT COUNT(*) AS count FROM goal_scheduled_continuations WHERE id = 'continuation-a'").get()).toEqual({ count: 1 });
      expect(upgraded.connection.prepare("SELECT id FROM schema_migrations WHERE id = '019_native_automation'").get())
        .toEqual({ id: '019_native_automation' });

      const foreignKeys = upgraded.connection.prepare('PRAGMA foreign_key_list(automation_attempts)').all() as { table: string }[];
      expect(foreignKeys.map((row) => row.table)).toContain('automation_milestones');
      const indexes = upgraded.connection.prepare('PRAGMA index_list(automation_runs)').all() as { name: string; unique: number; partial: number }[];
      expect(indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'uq_automation_runs_live_goal', unique: 1, partial: 1 }),
      ]));

      const automation = new SqliteAutomationRepository(upgraded);
      const created = automation.create({
        id: 'run-after-018-upgrade',
        goalId: 'goal-a',
        workspaceId: 'workspace-a',
        ownerClientId: 'client-a',
        createdAt: now,
        plan: {
          milestones: [{
            id: 'build', title: 'Build', goalStepId: 'step-a', dependsOn: [], provider: 'shell',
            role: 'blocking_job', cancelWithGoal: true,
            dispatch: {
              executable: 'node', arguments: ['--version'], cwd: root, timeoutSeconds: 60,
              maxOutputBytes: 1024, includeStdout: false, includeStderr: true,
            },
            verification: [{ id: 'exit', kind: 'command_exit', expectedExitCode: 0 }],
          }],
        },
      });
      expect(created).toMatchObject({ ok: true, value: { run: { revision: 0, status: 'active' } } });
      expect(automation.transitionMilestone({
        runId: 'run-after-018-upgrade', ownerClientId: 'client-a', workspaceId: 'workspace-a', expectedRevision: 0,
        milestoneId: 'build', status: 'ready', updatedAt: now,
        event: { kind: 'milestone_ready', milestoneId: 'build', payload: {} },
      }).ok).toBe(true);
      expect(automation.reserveAttempt({
        runId: 'run-after-018-upgrade', ownerClientId: 'client-a', workspaceId: 'workspace-a', expectedRevision: 1,
        milestoneId: 'build', attemptId: 'attempt-a', ordinal: 1, taskId: 'automation-upgrade-build-1',
        requestDigest: 'a'.repeat(64), updatedAt: now,
        event: { kind: 'attempt_reserved', milestoneId: 'build', attemptId: 'attempt-a', payload: {} },
      }).ok).toBe(true);
      expect(automation.updateAttempt({
        runId: 'run-after-018-upgrade', ownerClientId: 'client-a', workspaceId: 'workspace-a', expectedRevision: 2,
        attemptId: 'attempt-a', dispatchStatus: 'launched', milestoneStatus: 'running', updatedAt: now,
        event: { kind: 'dispatch_observed', milestoneId: 'build', attemptId: 'attempt-a', payload: {} },
      }).ok).toBe(true);

      const backup = new SqliteBackupService(upgraded, {
        backupDirectory,
        databaseFilename: filename,
        platform: 'win32',
        arch: 'x64',
      });
      const snapshot = await backup.create('manual');
      snapshotId = snapshot.id;
      expect(snapshot.dataSchemaVersion).toBe(24);
      expect(upgraded.connection.prepare("SELECT id FROM schema_migrations WHERE id = '024_audit_call_history_paging'").get())
        .toEqual({ id: '024_audit_call_history_paging' });
      await backup.scheduleRestore(snapshot.id);
    } finally {
      upgraded.close();
    }

    expect(applyPendingSqliteRestoreSync(filename, backupDirectory, { platform: 'linux', arch: 'x64' })).toMatchObject({
      applied: true,
      backupId: snapshotId,
      crossHost: true,
      quarantinedItems: expect.arrayContaining(['automation:run-after-018-upgrade']),
    });
    const restored = new SqliteDatabase(filename);
    try {
      expect(restored.connection.prepare('SELECT status, revision FROM automation_runs WHERE id = ?').get('run-after-018-upgrade'))
        .toEqual({ status: 'blocked', revision: 4 });
      expect(restored.connection.prepare('SELECT status FROM automation_milestones WHERE run_id = ?').get('run-after-018-upgrade'))
        .toEqual({ status: 'blocked' });
      expect(restored.connection.prepare('SELECT dispatch_status, terminal_state FROM automation_attempts WHERE run_id = ?').get('run-after-018-upgrade'))
        .toEqual({ dispatch_status: 'dispatched_unresolved', terminal_state: null });
      expect(restored.connection.prepare('SELECT sequence, kind FROM automation_events WHERE run_id = ? ORDER BY sequence').all('run-after-018-upgrade'))
        .toEqual([
          { sequence: 0, kind: 'run_created' },
          { sequence: 1, kind: 'milestone_ready' },
          { sequence: 2, kind: 'attempt_reserved' },
          { sequence: 3, kind: 'dispatch_observed' },
          { sequence: 4, kind: 'cross_host_restore_quarantined' },
        ]);
    } finally {
      restored.close();
    }
  });
});
