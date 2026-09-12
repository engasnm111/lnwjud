import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPreMigrationBackupSync } from './backup-service.js';
import { withSqliteLifecycleLockSync } from './sqlite-lifecycle-lock.js';
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
import { AGENT_SWARM_MIGRATION_SQL } from './migrations/agent-swarm-migration.js';
import { RECURRING_SCHEDULED_CONTINUATION_MIGRATION_SQL } from './migrations/recurring-scheduled-continuation-migration.js';
import { GOAL_PONYTAIL_MODE_MIGRATION_SQL } from './migrations/goal-ponytail-mode-migration.js';

export interface SqliteDatabaseOptions {
  readonly backupDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly fileIdentityProvider?: (filename: string) => string | null;
  readonly onCanonicalFileReplaced?: (filename: string) => void;
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

const CANONICAL_FILE_IDENTITY_CHECK_INTERVAL_MS = 1_000;
const RESTORE_CLAIM_PREFIX = 'restore-pending.json.claim-';

export class SqliteDatabase {
  private _connection!: DatabaseSync;
  private existedBeforeOpen = false;
  private preMigrationBackupCreated = false;
  private isClosed = false;
  private canonicalFileIdentity: string | null | undefined;
  private lastCanonicalIdentityCheckAt = 0;
  private refreshingCanonicalFile = false;

  public constructor(private readonly filename: string, private readonly options: SqliteDatabaseOptions = {}) {
    const openCanonical = (): void => {
      this.ensureDirectory();
      this.assertNoConcurrentRestore();
      this.existedBeforeOpen = existsSync(filename);
      this._connection = this.createConnection();
      try {
        this.assertNoConcurrentRestore();
        this.initPragmas(this._connection);
        this.initializeSchema();
        this.canonicalFileIdentity = this.readCanonicalFileIdentity();
      } catch (error) {
        this._connection.close();
        throw error;
      }
    };

    if (filename === ':memory:' || options.backupDirectory === undefined) openCanonical();
    else withSqliteLifecycleLockSync(options.backupDirectory, openCanonical);
  }

  private initializeSchema(): void {
    this._connection.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY NOT NULL);');
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
    this.applyMigration({ id: '015_agent_swarm', sql: AGENT_SWARM_MIGRATION_SQL });
    this.applyMigration({ id: '016_recurring_scheduled_continuation', sql: RECURRING_SCHEDULED_CONTINUATION_MIGRATION_SQL });
    this.applyMigration({ id: '017_goal_ponytail_mode', sql: GOAL_PONYTAIL_MODE_MIGRATION_SQL });
  }

  private ensureDirectory(): void {
    if (this.filename !== ':memory:') {
      mkdirSync(path.dirname(this.filename), { recursive: true });
    }
  }

  private assertNoConcurrentRestore(): void {
    if (this.filename === ':memory:' || this.options.backupDirectory === undefined) return;
    try {
      if (readdirSync(this.options.backupDirectory).some((name) => name.startsWith(RESTORE_CLAIM_PREFIX))) {
        throw new Error(`SQLite restore is in progress; refusing to open the canonical database: ${this.filename}`);
      }
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
  }

  private createConnection(): DatabaseSync {
    this.ensureDirectory();
    return new DatabaseSync(this.filename, { timeout: 5_000 });
  }

  private initPragmas(conn: DatabaseSync): void {
    conn.exec('PRAGMA journal_mode = WAL;');
    conn.exec('PRAGMA busy_timeout = 5000;');
    conn.exec('PRAGMA foreign_keys = ON;');
  }

  private readCanonicalFileIdentity(): string | null {
    if (this.filename === ':memory:') return null;
    if (this.options.fileIdentityProvider !== undefined) return this.options.fileIdentityProvider(this.filename);
    try {
      const stats = statSync(this.filename, { bigint: true });
      return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  private refreshCanonicalConnectionIfNeeded(): void {
    if (this.filename === ':memory:' || this.refreshingCanonicalFile || this.canonicalFileIdentity === undefined) return;
    const now = Date.now();
    if (this.options.fileIdentityProvider === undefined && now - this.lastCanonicalIdentityCheckAt < CANONICAL_FILE_IDENTITY_CHECK_INTERVAL_MS) return;
    this.lastCanonicalIdentityCheckAt = now;
    const observedIdentity = this.readCanonicalFileIdentity();
    if (observedIdentity === this.canonicalFileIdentity) return;

    const refresh = (): void => {
      const currentIdentity = this.readCanonicalFileIdentity();
      if (currentIdentity === null) throw new Error(`Canonical SQLite database is temporarily unavailable: ${this.filename}`);
      if (currentIdentity === this.canonicalFileIdentity) return;

      const previous = this._connection;
      const previousBackupState = this.preMigrationBackupCreated;
      const replacement = this.createConnection();
      this.initPragmas(replacement);
      this._connection = replacement;
      this.preMigrationBackupCreated = false;
      this.refreshingCanonicalFile = true;
      try {
        this.initializeSchema();
      } catch (error) {
        this._connection = previous;
        this.preMigrationBackupCreated = previousBackupState;
        replacement.close();
        throw error;
      } finally {
        this.refreshingCanonicalFile = false;
      }
      previous.close();
      this.canonicalFileIdentity = currentIdentity;
      this.options.onCanonicalFileReplaced?.(this.filename);
    };

    if (this.options.backupDirectory === undefined) refresh();
    else withSqliteLifecycleLockSync(this.options.backupDirectory, refresh);
  }

  public get connection(): DatabaseSync {
    if (this.isClosed) throw new Error('SqliteDatabase is closed');
    this.refreshCanonicalConnectionIfNeeded();
    return this._connection;
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
    createPreMigrationBackupSync(this.connection, this.options.backupDirectory, this.options.platform, this.options.arch);
    this.preMigrationBackupCreated = true;
  }

  public close(): void {
    if (!this.isClosed) {
      this.isClosed = true;
      try {
        this._connection.close();
      } catch {
        // Ignored if already closed
      }
    }
  }

  private hasMigrationId(value: unknown, expectedId: string): boolean {
    if (typeof value !== 'object' || value === null || !('id' in value)) return false;
    const id = value.id;
    return typeof id === 'string' && id === expectedId;
  }
}
