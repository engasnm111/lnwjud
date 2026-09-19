import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAutomationRepository } from './automation-repository.js';
import { SqliteDatabase } from './database.js';
import { SqliteGoalRepository } from './goal-repository.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('M8 native automation migration and upgrade verification', () => {
  it('upgrades an existing v018-style database additively and preserves a pre-migration recovery snapshot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-m8-upgrade-'));
    roots.push(root);
    const databaseFile = path.join(root, 'state.sqlite');
    const backupDirectory = path.join(root, 'backups');

    const seed = new SqliteDatabase(databaseFile);
    seed.connection.prepare(`
      INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('workspace-1', 'Legacy Workspace', root, root, '2026-09-19T00:00:00.000Z');
    seed.connection.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?)',
    ).run('m8-legacy-marker', 'preserve-me');
    const goals = new SqliteGoalRepository(seed);
    const acquired = await goals.acquire({
      goalId: 'goal-legacy',
      workspaceId: 'workspace-1',
      goalKey: 'legacy-goal-without-automation',
      ownerClientId: 'm8-upgrade',
      ownerSessionId: 'session-a',
      objective: 'Preserve existing goal through additive automation migrations.',
      plan: { steps: [{ id: 'legacy-step', title: 'Legacy step', status: 'pending' }] },
      acceptanceCriteria: [],
      leaseTokenHash: 'legacy-lease-hash',
      leaseSeconds: 600,
      now: '2026-09-19T00:00:00.000Z',
    });
    expect(acquired.acquired).toBe(true);
    seed.close();

    const legacy = new DatabaseSync(databaseFile);
    legacy.exec('PRAGMA foreign_keys = OFF;');
    legacy.exec(`
      DROP TABLE automation_events;
      DROP TABLE automation_dispatch_receipts;
      DROP TABLE automation_task_bindings;
      DROP TABLE automation_attempts;
      DROP TABLE automation_milestones;
      DROP TABLE automation_runs;
      DELETE FROM schema_migrations
      WHERE id IN ('019_native_automation_engine', '020_automation_task_supervisor');
    `);
    legacy.close();

    const upgraded = new SqliteDatabase(databaseFile, {
      backupDirectory,
      platform: 'win32',
      arch: 'x64',
    });
    try {
      const migrationIds = upgraded.connection.prepare(
        'SELECT id FROM schema_migrations ORDER BY id',
      ).all().map((row) => (row as { id: string }).id);
      expect(migrationIds).toContain('019_native_automation_engine');
      expect(migrationIds).toContain('020_automation_task_supervisor');
      expect(upgraded.connection.prepare(
        'SELECT value FROM settings WHERE key = ?',
      ).get('m8-legacy-marker')).toMatchObject({ value: 'preserve-me' });
      expect(upgraded.connection.prepare(
        'SELECT id FROM goals WHERE id = ?',
      ).get('goal-legacy')).toMatchObject({ id: 'goal-legacy' });

      const automation = new SqliteAutomationRepository(upgraded);
      expect(await automation.getRunByGoalId('goal-legacy')).toBeNull();
      const columns = upgraded.connection.prepare(
        'PRAGMA table_info(automation_task_bindings)',
      ).all().map((row) => (row as { name: string }).name);
      expect(columns).toEqual(expect.arrayContaining([
        'deadline_at',
        'last_observed_at',
        'last_state',
        'last_detail',
        'terminal_at',
      ]));
    } finally {
      upgraded.close();
    }

    const manifestNames = (await readdir(backupDirectory))
      .filter((name) => name.endsWith('.json'));
    expect(manifestNames).toHaveLength(1);
    const manifest = JSON.parse(
      await readFile(path.join(backupDirectory, manifestNames[0]!), 'utf8'),
    ) as {
      reason: string;
      databaseFile: string;
      dataSchemaVersion?: number;
    };
    expect(manifest).toMatchObject({
      reason: 'pre-migration',
      dataSchemaVersion: 18,
    });
    const snapshot = new DatabaseSync(
      path.join(backupDirectory, manifest.databaseFile),
      { readOnly: true },
    );
    try {
      expect(snapshot.prepare(
        'SELECT value FROM settings WHERE key = ?',
      ).get('m8-legacy-marker')).toMatchObject({ value: 'preserve-me' });
      expect(snapshot.prepare(
        'SELECT id FROM goals WHERE id = ?',
      ).get('goal-legacy')).toMatchObject({ id: 'goal-legacy' });
      const automationTable = snapshot.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automation_runs'",
      ).get();
      expect(automationTable).toBeUndefined();
    } finally {
      snapshot.close();
    }

    const reopened = new SqliteDatabase(databaseFile, {
      backupDirectory,
      platform: 'win32',
      arch: 'x64',
    });
    reopened.close();
    expect((await readdir(backupDirectory)).filter((name) => name.endsWith('.json')))
      .toHaveLength(1);
  });
});
