import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPendingSqliteRestoreSync, SqliteBackupService } from './backup-service.js';
import { SqliteDatabase } from './database.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SqliteBackupService', { timeout: 30_000 }, () => {
  it('creates a WAL-consistent snapshot and restores it on the next startup', async () => {
    const root = await temporaryRoot();
    const databaseFile = path.join(root, 'lnwjud.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new SqliteDatabase(databaseFile, { backupDirectory });
    database.connection.exec('CREATE TABLE restore_fixture (value TEXT NOT NULL);');
    database.connection.prepare('INSERT INTO restore_fixture (value) VALUES (?)').run('before-backup');
    const service = new SqliteBackupService(database, { backupDirectory, databaseFilename: databaseFile });

    const snapshot = await service.create('manual');
    database.connection.prepare('UPDATE restore_fixture SET value = ?').run('after-backup');
    await service.scheduleRestore(snapshot.id);
    database.close();

    expect(applyPendingSqliteRestoreSync(databaseFile, backupDirectory)).toMatchObject({ applied: true, backupId: snapshot.id });
    expect(applyPendingSqliteRestoreSync(databaseFile, backupDirectory)).toEqual({ applied: false });

    const restored = new SqliteDatabase(databaseFile);
    const row = restored.connection.prepare('SELECT value FROM restore_fixture').get() as { value?: string } | undefined;
    expect(row?.value).toBe('before-backup');
    restored.close();
    expect((await readdir(backupDirectory)).some((name) => name.endsWith('.sqlite'))).toBe(true);
  });

  it('does not duplicate the automatic daily backup inside the 24-hour window', async () => {
    const root = await temporaryRoot();
    const databaseFile = path.join(root, 'lnwjud.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new SqliteDatabase(databaseFile, { backupDirectory });
    let now = new Date('2026-08-01T00:00:00.000Z');
    const service = new SqliteBackupService(database, { backupDirectory, databaseFilename: databaseFile, now: (): Date => now });

    const first = await service.ensureRecent();
    expect(first?.reason).toBe('daily');
    await expect(service.ensureRecent()).resolves.toBeNull();
    now = new Date('2026-08-02T00:00:01.000Z');
    await expect(service.ensureRecent()).resolves.toMatchObject({ reason: 'daily' });
    database.close();
  });

  it('coordinates the daily backup lease across concurrent database runtimes', async () => {
    const root = await temporaryRoot();
    const databaseFile = path.join(root, 'lnwjud.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const firstDatabase = new SqliteDatabase(databaseFile, { backupDirectory });
    const secondDatabase = new SqliteDatabase(databaseFile, { backupDirectory });
    const now = new Date('2026-08-01T00:00:00.000Z');
    const firstService = new SqliteBackupService(firstDatabase, { backupDirectory, databaseFilename: databaseFile, now: (): Date => now });
    const secondService = new SqliteBackupService(secondDatabase, { backupDirectory, databaseFilename: databaseFile, now: (): Date => now });

    const results = await Promise.all([firstService.ensureRecent(), secondService.ensureRecent()]);

    expect(results.filter((value) => value !== null)).toHaveLength(1);
    expect((await firstService.list()).filter((value) => value.reason === 'daily')).toHaveLength(1);
    firstDatabase.close();
    secondDatabase.close();
  });

  it('creates a pre-migration snapshot before upgrading an existing database schema', async () => {
    const root = await temporaryRoot();
    const databaseFile = path.join(root, 'legacy.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const legacy = new DatabaseSync(databaseFile);
    legacy.exec(`
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY NOT NULL, display_name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE, real_root_path TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      INSERT INTO schema_migrations (id) VALUES ('001_initial');
      INSERT INTO settings (key, value) VALUES ('legacy-marker', 'before-migration');
    `);
    legacy.close();

    const upgraded = new SqliteDatabase(databaseFile, { backupDirectory });
    upgraded.close();

    const manifests = await readdir(backupDirectory);
    const manifestName = manifests.find((name) => name.endsWith('.json'));
    expect(manifestName).toBeDefined();
    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(backupDirectory, manifestName!), 'utf8')) as { reason?: string; databaseFile?: string };
    expect(manifest.reason).toBe('pre-migration');
    const snapshot = new DatabaseSync(path.join(backupDirectory, manifest.databaseFile!), { readOnly: true });
    const marker = snapshot.prepare('SELECT value FROM settings WHERE key = ?').get('legacy-marker') as { value?: string } | undefined;
    expect(marker?.value).toBe('before-migration');
    const migrationRows = snapshot.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id?: string }>;
    expect(migrationRows.map((row) => row.id)).toEqual(['001_initial']);
    snapshot.close();
  });

  it('retains seven recent daily snapshots plus four older weekly representatives', async () => {
    const root = await temporaryRoot();
    const databaseFile = path.join(root, 'lnwjud.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new SqliteDatabase(databaseFile, { backupDirectory });
    try {
      let now = new Date('2026-01-01T00:00:00.000Z');
      const service = new SqliteBackupService(database, { backupDirectory, databaseFilename: databaseFile, now: (): Date => now });

      for (let index = 0; index < 15; index += 1) {
        now = new Date(Date.UTC(2026, 0, 1 + index * 8));
        await service.create('daily');
      }

      const listed = (await service.list()).filter((entry) => entry.reason === 'daily');
      expect(listed).toHaveLength(11);
    } finally {
      database.close();
    }
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-backup-'));
  temporaryRoots.push(root);
  return root;
}
