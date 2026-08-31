import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createPreMigrationBackupSync } from './backup-service.js';
import { AUDIT_MIGRATION_SQL } from './migrations/audit-migration.js';
import { AUDIT_SCOPE_MIGRATION_SQL } from './migrations/audit-scope-migration.js';
import { CHECKPOINT_MIGRATION_SQL } from './migrations/checkpoint-migration.js';
import { GOAL_CONTINUATION_MIGRATION_SQL } from './migrations/goal-continuation-migration.js';
import { GOAL_CANCELLATION_MIGRATION_SQL } from './migrations/goal-cancellation-migration.js';
import { GOAL_TRACKED_TASKS_MIGRATION_SQL } from './migrations/goal-tracked-tasks-migration.js';
import { GOAL_LEASE_REPAIR_MIGRATION_SQL } from './migrations/goal-lease-repair-migration.js';
import { GOAL_LIVE_CONTINUATION_LEASE_QUARANTINE_MIGRATION_SQL } from './migrations/goal-live-continuation-lease-quarantine-migration.js';
import { SCHEDULED_CONTINUATION_MIGRATION_SQL } from './migrations/scheduled-continuation-migration.js';
import { SCHEDULED_CONTINUATION_SESSION_FENCE_MIGRATION_SQL } from './migrations/scheduled-continuation-session-fence-migration.js';
import { SCHEDULED_CONTINUATION_RESCHEDULE_MIGRATION_SQL } from './migrations/scheduled-continuation-reschedule-migration.js';
import { WORKSPACE_ARCHIVE_MIGRATION_SQL } from './migrations/workspace-archive-migration.js';
import { RETIRE_AUTO_MACHINE_ROOTS_MIGRATION_SQL } from './migrations/retire-auto-machine-roots-migration.js';

export interface SqliteDatabaseOptions {
  readonly backupDirectory?: string;
}

export interface Migration {
  readonly id: string;
  readonly sql: string;
}

export const INITIAL_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  real_root_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
`;

export class SqliteDatabase {
  public readonly connection: DatabaseSync;
  private readonly existedBeforeOpen: boolean;
  private preMigrationBackupCreated = false;

  public constructor(private readonly filename: string, private readonly options: SqliteDatabaseOptions = {}) {
    this.existedBeforeOpen = existsSync(filename);
    this.connection = new DatabaseSync(filename, { timeout: 5_000 });
    this.connection.exec('PRAGMA journal_mode = WAL;');
    this.connection.exec('PRAGMA busy_timeout = 5000;');
    this.connection.exec('PRAGMA foreign_keys = ON;');
    this.connection.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY NOT NULL);');
    this.applyMigration({ id: '001_initial', sql: INITIAL_MIGRATION_SQL });
    this.applyMigration({ id: '002_audit', sql: AUDIT_MIGRATION_SQL });
    this.applyMigration({ id: '003_checkpoints', sql: CHECKPOINT_MIGRATION_SQL });
    this.applyMigration({ id: '004_audit_scope', sql: AUDIT_SCOPE_MIGRATION_SQL });
    this.applyMigration({ id: '005_workspace_archive', sql: WORKSPACE_ARCHIVE_MIGRATION_SQL });
    this.applyMigration({ id: '006_goal_continuation', sql: GOAL_CONTINUATION_MIGRATION_SQL });
    this.applyMigration({ id: '007_scheduled_continuations', sql: SCHEDULED_CONTINUATION_MIGRATION_SQL });
    this.applyMigration({ id: '008_scheduled_continuation_session_fence', sql: SCHEDULED_CONTINUATION_SESSION_FENCE_MIGRATION_SQL });
    this.applyMigration({ id: '009_scheduled_continuation_same_task_reschedule', sql: SCHEDULED_CONTINUATION_RESCHEDULE_MIGRATION_SQL });
    this.applyMigration({ id: '010_goal_lease_repair', sql: GOAL_LEASE_REPAIR_MIGRATION_SQL });
    this.applyMigration({ id: '011_goal_live_continuation_lease_quarantine', sql: GOAL_LIVE_CONTINUATION_LEASE_QUARANTINE_MIGRATION_SQL });
    this.applyMigration({ id: '012_retire_auto_machine_roots', sql: RETIRE_AUTO_MACHINE_ROOTS_MIGRATION_SQL });
    this.applyMigration({ id: '013_goal_cancellation', sql: GOAL_CANCELLATION_MIGRATION_SQL });
    this.applyMigration({ id: '014_goal_tracked_tasks', sql: GOAL_TRACKED_TASKS_MIGRATION_SQL });
  }

  public applyMigration(migration: Migration): void {
    const existing = this.connection.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(migration.id);
    if (this.hasMigrationId(existing, migration.id)) return;
    this.backupBeforeFirstPendingMigration();

    this.connection.exec('BEGIN;');
    try {
      this.connection.exec(migration.sql);
      this.connection.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(migration.id);
      this.connection.exec('COMMIT;');
    } catch (error) {
      this.connection.exec('ROLLBACK;');
      throw error;
    }
  }

  private backupBeforeFirstPendingMigration(): void {
    if (this.preMigrationBackupCreated || !this.existedBeforeOpen || this.options.backupDirectory === undefined) return;
    createPreMigrationBackupSync(this.connection, this.options.backupDirectory);
    this.preMigrationBackupCreated = true;
  }

  public close(): void {
    this.connection.close();
  }

  private hasMigrationId(value: unknown, expectedId: string): boolean {
    if (typeof value !== 'object' || value === null || !('id' in value)) return false;
    const id = value.id;
    return typeof id === 'string' && id === expectedId;
  }
}
