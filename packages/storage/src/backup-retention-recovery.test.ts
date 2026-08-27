import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPendingSqliteRestoreSync, SqliteBackupService } from './backup-service.js';
import { SqliteDatabase } from './database.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('recoverable backup retention', () => {
  it('rotates an expired backup out of the active list without destroying its restore path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-retention-recovery-'));
    temporaryRoots.push(root);
    const databaseFile = path.join(root, 'lnwjud.sqlite');
    const backupDirectory = path.join(root, 'backups');
    const database = new SqliteDatabase(databaseFile, { backupDirectory });
    database.connection.exec('CREATE TABLE retention_fixture (value TEXT NOT NULL);');
    database.connection.prepare('INSERT INTO retention_fixture (value) VALUES (?)').run('first');
    let now = new Date('2026-08-01T00:00:00.000Z');
    const service = new SqliteBackupService(database, {
      backupDirectory,
      databaseFilename: databaseFile,
      manualRetention: 1,
      now: (): Date => now,
    });

    const first = await service.create('manual');
    database.connection.prepare('UPDATE retention_fixture SET value = ?').run('second');
    now = new Date('2026-08-02T00:00:00.000Z');
    const second = await service.create('manual');

    expect((await service.list()).map((entry) => entry.id)).toEqual([second.id]);
    await expect(service.scheduleRestore(first.id)).resolves.toBeUndefined();
    database.close();

    expect(applyPendingSqliteRestoreSync(databaseFile, backupDirectory)).toMatchObject({ applied: true, backupId: first.id });
    const restored = new SqliteDatabase(databaseFile);
    const row = restored.connection.prepare('SELECT value FROM retention_fixture').get() as { value?: string } | undefined;
    expect(row?.value).toBe('first');
    restored.close();
  });
});
