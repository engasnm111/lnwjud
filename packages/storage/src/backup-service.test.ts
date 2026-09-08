import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  it.each([null, '2026-09-01'])('treats foreign workspace paths as runtime authority only when not archived (%s)', async (archivedAt) => {
    const root = await temporaryRoot();
    const databaseFile = path.join(root, 'lnwjud.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new SqliteDatabase(databaseFile);
    database.connection.prepare('INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('history', 'Imported history', 'C:\\old-project', 'C:\\old-project', '2026-01-01', archivedAt);
    const secretPath = path.join(root, 'checkpoint-master.key');
    await writeFile(secretPath, 'local-key-must-survive', 'utf8');
    const service = new SqliteBackupService(database, { databaseFilename: databaseFile, backupDirectory, platform: 'linux', arch: 'x64' });
    const snapshot = await service.create('manual');
    await service.scheduleRestore(snapshot.id);
    database.close();
    const result = applyPendingSqliteRestoreSync(databaseFile, backupDirectory, { platform: 'linux', arch: 'x64' });
    if (archivedAt === null) {
      expect(result).toMatchObject({ applied: true, crossHost: true });
      await expect(readFile(secretPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      return;
    }
    expect(result)
      .toMatchObject({ applied: true, crossHost: false, hostCompatibility: 'same_host', quarantinedItems: [] });
    expect(await readFile(secretPath, 'utf8')).toBe('local-key-must-survive');
  });

  it('quarantines Remote MCP and external tunnel OAuth credentials on a cross-host restore', async () => {
    const root = await temporaryRoot();
    const dataPath = path.join(root, 'data');
    const tunnelPath = path.join(root, 'external-tunnel-profile');
    await mkdir(dataPath);
    await mkdir(tunnelPath);
    await mkdir(path.join(dataPath, 'remote-mcp'));
    const databaseFile = path.join(dataPath, 'lnwjud.sqlite');
    const backupDirectory = path.join(dataPath, 'backups');
    const files = [
      path.join(dataPath, 'remote-mcp', 'oauth-state.secret'),
      path.join(dataPath, 'remote-mcp', 'ngrok-authtoken.secret'),
      path.join(tunnelPath, 'lnwjud.oauth.session.secret'),
    ];
    for (const filename of files) await writeFile(filename, 'host-bound-ciphertext', 'utf8');
    const database = new SqliteDatabase(databaseFile);
    const service = new SqliteBackupService(database, { databaseFilename: databaseFile, backupDirectory, platform: 'win32', arch: 'x64' });
    const snapshot = await service.create('manual');
    await service.scheduleRestore(snapshot.id);
    database.close();
    const result = applyPendingSqliteRestoreSync(databaseFile, backupDirectory, {
      platform: 'linux', arch: 'x64', hostBoundPaths: [path.join(tunnelPath, 'lnwjud.runtime.secret')],
    });
    expect(result).toMatchObject({ applied: true, crossHost: true });
    for (const filename of files) {
      await expect(readFile(filename, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(dataPath, 'restore-quarantine', snapshot.id, path.basename(filename)), 'utf8')).toBe('host-bound-ciphertext');
    }
    expect(result.quarantinedItems).toHaveLength(3);
  });

  it('records the source host and data schema in every new manifest', async () => {
    const root = await temporaryRoot();
    const databaseFile = path.join(root, 'lnwjud.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new SqliteDatabase(databaseFile, { backupDirectory });
    const service = new SqliteBackupService(database, {
      backupDirectory,
      databaseFilename: databaseFile,
      platform: 'darwin',
      arch: 'arm64',
    });

    const snapshot = await service.create('manual');
    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(backupDirectory, snapshot.id + '.json'), 'utf8')) as Record<string, unknown>;

    expect(manifest).toMatchObject({ platform: 'darwin', arch: 'arm64', dataSchemaVersion: expect.any(Number) });
    expect(snapshot).toMatchObject({ platform: 'darwin', arch: 'arm64', dataSchemaVersion: expect.any(Number) });
    database.close();
  });

  it('quarantines host-bound state and preserves foreign workspace paths during cross-host restore', async () => {
    const root = await temporaryRoot();
    const databaseFile = path.join(root, 'lnwjud.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new SqliteDatabase(databaseFile, { backupDirectory });
    database.connection.prepare('INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at, archived_at) VALUES (?, ?, ?, ?, ?, NULL)')
      .run('foreign-workspace', 'Foreign project', 'C:\\Users\\alice\\project', 'C:\\Users\\alice\\project', '2026-08-01T00:00:00.000Z');
    database.connection.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('portable_setting', 'keep-me');
    database.connection.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('pdf_provider_path', 'C:\\tools\\pdftotext.exe');
    database.connection.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('secret_receipt', 'safe:v1:not-transplanted');
    database.connection.prepare(`
      INSERT INTO goals (
        id, workspace_id, goal_key, owner_client_id, objective, plan_json, status, revision,
        current_phase, next_action, blockers_json, active_task_ids_json, created_at, updated_at
      ) VALUES ('foreign-goal', 'foreign-workspace', 'goal', 'client', 'objective', '{}', 'active', 0, 'phase', 'next', '[]', '[]', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
    `).run();
    database.connection.prepare(`
      INSERT INTO goal_scheduled_continuations (
        id, goal_id, source_session_id, generation, source_goal_revision, status, occurrence, destination,
        execution_preference, confirmed_runs_on, due_at, native_task_id, request_fingerprint, version,
        created_at, updated_at
      ) VALUES ('foreign-continuation', 'foreign-goal', 'session', 1, 0, 'scheduled', 'once', 'current_chat',
        'auto', 'local', '2026-08-02T00:00:00.000Z', 'native-task-1', 'fingerprint', 0,
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
    `).run();
    expect(database.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'goal_scheduled%'").all()).toEqual([
      { name: 'goal_scheduled_continuations' },
      { name: 'goal_scheduled_continuation_runs' },
    ]);
    expect(database.connection.prepare('SELECT id, status, native_task_id FROM goal_scheduled_continuations').all()).toEqual([
      expect.objectContaining({ id: 'foreign-continuation', status: 'scheduled', native_task_id: 'native-task-1' }),
    ]);
    await (await import('node:fs/promises')).writeFile(path.join(root, 'checkpoint-master.key'), 'safe:v1:host-bound', 'utf8');
    const service = new SqliteBackupService(database, { backupDirectory, databaseFilename: databaseFile, platform: 'win32', arch: 'x64' });
    const snapshot = await service.create('manual');
    await service.scheduleRestore(snapshot.id);
    database.close();

    expect(applyPendingSqliteRestoreSync(databaseFile, backupDirectory, { platform: 'linux', arch: 'x64' })).toMatchObject({
      applied: true,
      backupId: snapshot.id,
      crossHost: true,
      quarantinedItems: expect.arrayContaining(['workspace:foreign-workspace', 'setting:pdf_provider_path', 'setting:secret_receipt', 'continuation:foreign-continuation']),
    });

    const restored = new SqliteDatabase(databaseFile);
    const workspace = restored.connection.prepare('SELECT root_path, real_root_path, archived_at FROM workspaces WHERE id = ?').get('foreign-workspace') as { root_path?: string; real_root_path?: string; archived_at?: string | null } | undefined;
    expect(workspace).toMatchObject({ root_path: 'C:\\Users\\alice\\project', real_root_path: 'C:\\Users\\alice\\project' });
    expect(workspace?.archived_at).toEqual(expect.any(String));
    expect(restored.connection.prepare('SELECT value FROM settings WHERE key = ?').get('portable_setting')).toEqual({ value: 'keep-me' });
    expect(restored.connection.prepare('SELECT value FROM settings WHERE key = ?').get('pdf_provider_path')).toBeUndefined();
    expect(restored.connection.prepare('SELECT value FROM settings WHERE key = ?').get('secret_receipt')).toBeUndefined();
    expect(restored.connection.prepare('SELECT status, native_task_id FROM goal_scheduled_continuations WHERE id = ?').get('foreign-continuation')).toMatchObject({ status: 'cancelled', native_task_id: null });
    const notice = restored.connection.prepare('SELECT value FROM settings WHERE key = ?').get('cross_host_restore_notice') as { value?: string } | undefined;
    expect(notice?.value).toContain(snapshot.id);
    expect(restored.connection.prepare('SELECT COUNT(*) AS count FROM restore_quarantine').get()).toMatchObject({ count: expect.any(Number) });
    restored.close();
    await expect((await import('node:fs/promises')).stat(path.join(root, 'checkpoint-master.key')).catch(() => null)).resolves.toBeNull();
    const quarantineRoot = path.join(root, 'restore-quarantine');
    const quarantineEntries = await readdir(path.join(quarantineRoot, snapshot.id));
    expect(quarantineEntries.some((name) => name.includes('checkpoint-master.key'))).toBe(true);
  });

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
