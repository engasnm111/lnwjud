import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { backup, DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { isForeignAbsolutePath } from '@lnwjud/workspace';
import type { SqliteDatabase } from './database.js';
import { withSqliteLifecycleLockSync } from './sqlite-lifecycle-lock.js';

export type BackupReason = 'daily' | 'manual' | 'pre-update' | 'pre-migration';

export interface BackupSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly reason: BackupReason;
  readonly sizeBytes: number;
  /** Host that created the snapshot. Absent on v1 manifests created before host metadata existed. */
  readonly platform?: NodeJS.Platform;
  /** Node architecture that created the snapshot. Absent on v1 manifests. */
  readonly arch?: string;
  /** Highest recorded SQLite migration number at snapshot time. */
  readonly dataSchemaVersion?: number;
  /** Compatibility with the host currently reading the summary. */
  readonly hostCompatibility?: BackupHostCompatibility;
}

interface BackupManifest extends BackupSummary {
  readonly schemaVersion: 1;
  readonly databaseFile: string;
}

export type BackupHostCompatibility = 'same_host' | 'cross_host' | 'legacy_unknown';

export const BACKUP_RESTORE_NOTICE_SETTING_KEY = 'cross_host_restore_notice';

export interface BackupRestoreNotice {
  readonly schemaVersion: 1;
  readonly backupId: string;
  readonly restoredAt: string;
  readonly sourcePlatform: NodeJS.Platform | null;
  readonly sourceArch: string | null;
  readonly targetPlatform: NodeJS.Platform;
  readonly targetArch: string;
  readonly hostCompatibility: BackupHostCompatibility;
  readonly incomplete: boolean;
  readonly relinkRequired: boolean;
  readonly quarantinedItems: readonly string[];
}

interface StoredBackupManifest {
  readonly manifest: BackupManifest;
  readonly directory: string;
}

interface RestoreMarker {
  readonly schemaVersion: 1;
  readonly backupId: string;
  readonly requestedAt: string;
}

export interface SqliteBackupServiceOptions {
  readonly backupDirectory: string;
  readonly databaseFilename: string;
  readonly now?: () => Date;
  /** Metadata only; no storage behavior is selected from this value. */
  readonly platform?: NodeJS.Platform;
  /** Metadata only; no storage behavior is selected from this value. */
  readonly arch?: string;
  readonly dailyRetention?: number;
  readonly weeklyRetention?: number;
  readonly manualRetention?: number;
  readonly migrationRetention?: number;
}

export interface SqliteRestoreOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly now?: () => Date;
  /** Exact application-owned secret/provider files to quarantine after a cross-host restore. */
  readonly hostBoundPaths?: readonly string[];
}

const RETENTION_ARCHIVE_DIRECTORY = 'retention-archive';

export class SqliteBackupService {
  private readonly backupDirectory: string;
  private readonly now: () => Date;
  private readonly dailyRetention: number;
  private readonly weeklyRetention: number;
  private readonly manualRetention: number;
  private readonly migrationRetention: number;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;

  public constructor(private readonly database: SqliteDatabase, options: SqliteBackupServiceOptions) {
    this.backupDirectory = path.resolve(options.backupDirectory);
    // Resolve here so a malformed configuration fails at construction rather than during restore.
    path.resolve(options.databaseFilename);
    this.now = options.now ?? ((): Date => new Date());
    this.dailyRetention = boundedRetention(options.dailyRetention, 7);
    this.weeklyRetention = boundedRetention(options.weeklyRetention, 4);
    this.manualRetention = boundedRetention(options.manualRetention, 10);
    this.migrationRetention = boundedRetention(options.migrationRetention, 5);
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
  }

  public async create(reason: BackupReason): Promise<BackupSummary> {
    await mkdir(this.backupDirectory, { recursive: true });
    const createdAt = this.now().toISOString();
    const id = backupId(createdAt);
    const databaseFile = id + '.sqlite';
    const destination = path.join(this.backupDirectory, databaseFile);
    await backup(this.database.connection, destination);
    validateDatabase(destination);
    const sizeBytes = (await stat(destination)).size;
    const manifest: BackupManifest = {
      schemaVersion: 1,
      id,
      createdAt,
      reason,
      sizeBytes,
      databaseFile,
      platform: this.platform,
      arch: this.arch,
      dataSchemaVersion: readDataSchemaVersion(this.database.connection),
    };
    await writeFile(manifestPath(this.backupDirectory, id), JSON.stringify(manifest, null, 2), 'utf8');
    await this.rotateRetention();
    return summary(manifest, this.platform, this.arch);
  }

  public async ensureRecent(maxAgeMs = 24 * 60 * 60 * 1000): Promise<BackupSummary | null> {
    await mkdir(this.backupDirectory, { recursive: true });
    const lease = await acquireAutomaticBackupLease(this.backupDirectory, this.now());
    if (lease === null) return null;
    try {
      const daily = (await listManifests(this.backupDirectory)).find((value) => value.reason === 'daily');
      if (daily !== undefined && this.now().getTime() - Date.parse(daily.createdAt) < maxAgeMs) return null;
      return await this.create('daily');
    } finally {
      await lease.handle.close().catch(() => undefined);
      await rm(lease.path, { force: true }).catch(() => undefined);
    }
  }

  public async list(): Promise<readonly BackupSummary[]> {
    await mkdir(this.backupDirectory, { recursive: true });
    return (await listManifests(this.backupDirectory)).map((value) => summary(value, this.platform, this.arch));
  }

  public async scheduleRestore(backupIdValue: string): Promise<void> {
    await mkdir(this.backupDirectory, { recursive: true });
    const stored = await readStoredManifestById(this.backupDirectory, backupIdValue);
    if (stored === null) throw new Error('Backup was not found');
    validateDatabase(path.join(stored.directory, stored.manifest.databaseFile));
    const marker: RestoreMarker = { schemaVersion: 1, backupId: stored.manifest.id, requestedAt: this.now().toISOString() };
    const markerPath = restoreMarkerPath(this.backupDirectory);
    const temporary = markerPath + '.tmp-' + randomUUID();
    await writeFile(temporary, JSON.stringify(marker, null, 2), { encoding: 'utf8', flag: 'wx' });
    try {
      await rename(temporary, markerPath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private async rotateRetention(): Promise<void> {
    const manifests = await listManifests(this.backupDirectory);
    const daily = manifests.filter((value) => value.reason === 'daily');
    const dailyKeep = selectDailyAndWeeklyRetention(daily, this.dailyRetention, this.weeklyRetention);
    await archiveNotKept(this.backupDirectory, daily, dailyKeep);
    await archiveBeyond(this.backupDirectory, manifests.filter((value) => value.reason === 'pre-migration'), this.migrationRetention);
    await archiveBeyond(this.backupDirectory, manifests.filter((value) => value.reason === 'manual' || value.reason === 'pre-update'), this.manualRetention);
  }
}

export function createPreMigrationBackupSync(
  database: DatabaseSync,
  backupDirectory: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): BackupSummary {
  const directory = path.resolve(backupDirectory);
  mkdirSync(directory, { recursive: true });
  const createdAt = new Date().toISOString();
  const id = backupId(createdAt);
  const databaseFile = id + '.sqlite';
  const destination = path.join(directory, databaseFile);
  database.exec('VACUUM INTO ' + sqliteString(destination) + ';');
  validateDatabase(destination);
  const manifest: BackupManifest = {
    schemaVersion: 1,
    id,
    createdAt,
    reason: 'pre-migration',
    sizeBytes: statSync(destination).size,
    databaseFile,
    platform,
    arch,
    dataSchemaVersion: readDataSchemaVersion(database),
  };
  writeFileSync(manifestPath(directory, id), JSON.stringify(manifest, null, 2), 'utf8');
  return summary(manifest, platform, arch);
}

export interface PendingRestoreResult {
  readonly applied: boolean;
  readonly backupId?: string;
  readonly error?: string;
  readonly crossHost?: boolean;
  readonly hostCompatibility?: BackupHostCompatibility;
  readonly quarantinedItems?: readonly string[];
}

export function applyPendingSqliteRestoreSync(
  databaseFilename: string,
  backupDirectory: string,
  options: SqliteRestoreOptions = {},
): PendingRestoreResult {
  const directory = path.resolve(backupDirectory);
  return withSqliteLifecycleLockSync(directory, () => applyPendingSqliteRestoreUnlocked(databaseFilename, directory, options));
}

function applyPendingSqliteRestoreUnlocked(
  databaseFilename: string,
  backupDirectory: string,
  options: SqliteRestoreOptions,
): PendingRestoreResult {
  const dbPath = path.resolve(databaseFilename);
  const directory = path.resolve(backupDirectory);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const now = options.now ?? ((): Date => new Date());
  const markerPath = restoreMarkerPath(directory);
  if (!existsSync(markerPath)) return { applied: false };

  mkdirSync(directory, { recursive: true });
  const claimPath = markerPath + `.claim-${process.pid}-${randomUUID()}`;
  try {
    renameSync(markerPath, claimPath);
  } catch (error) {
    return isMissingFile(error) ? { applied: false } : { applied: false, error: errorMessage(error) };
  }

  try {
    const marker = parseRestoreMarker(readFileSync(claimPath, 'utf8'));
    const stored = readStoredManifestByIdSync(directory, marker.backupId);
    if (stored === null) throw new Error('Scheduled backup was not found');
    const source = path.join(stored.directory, stored.manifest.databaseFile);
    validateDatabase(source);
    mkdirSync(path.dirname(dbPath), { recursive: true });

    const compatibility = determineBackupHostCompatibility(stored.manifest, source, platform, arch);
    const crossHost = compatibility === 'cross_host';

    const temporary = dbPath + '.restore-' + randomUUID() + '.tmp';
    copyFileSync(source, temporary);
    const restore = crossHost
      ? sanitizeCrossHostDatabase(temporary, {
        backupId: stored.manifest.id,
        restoredAt: now().toISOString(),
        sourcePlatform: stored.manifest.platform ?? null,
        sourceArch: stored.manifest.arch ?? null,
        targetPlatform: platform,
        targetArch: arch,
      })
      : emptyCrossHostRestore(stored.manifest, platform, arch, now);
    validateDatabase(temporary);
    if (existsSync(dbPath)) createEmergencyBackup(dbPath, directory, platform, arch);
    const oldPath = dbPath + '.pre-restore';
    rmSync(oldPath, { force: true });
    if (existsSync(dbPath)) renameSync(dbPath, oldPath);
    try {
      renameSync(temporary, dbPath);
    } catch (error) {
      if (existsSync(oldPath) && !existsSync(dbPath)) renameSync(oldPath, dbPath);
      rmSync(temporary, { force: true });
      throw error;
    }
    rmSync(oldPath, { force: true });
    rmSync(dbPath + '-wal', { force: true });
    rmSync(dbPath + '-shm', { force: true });
    const quarantinedFiles = crossHost ? quarantineHostBoundFiles(dbPath, marker.backupId, options.hostBoundPaths) : [];
    const allQuarantinedItems = [...new Set([...restore.quarantinedItems, ...quarantinedFiles])];
    if (crossHost && quarantinedFiles.length > 0) {
      try { appendRestoreNotice(dbPath, restore.notice, allQuarantinedItems); } catch { /* the database replacement itself remains authoritative */ }
    }
    rmSync(claimPath, { force: true });
    return {
      applied: true,
      backupId: marker.backupId,
      crossHost,
      hostCompatibility: compatibility,
      quarantinedItems: allQuarantinedItems,
    };
  } catch (error) {
    const failedPath = markerPath + '.failed-' + Date.now();
    try { renameSync(claimPath, failedPath); } catch { /* best effort */ }
    return { applied: false, error: errorMessage(error) };
  }
}

function createEmergencyBackup(dbPath: string, directory: string, platform: NodeJS.Platform, arch: string): void {
  const active = new DatabaseSync(dbPath);
  try {
    active.exec('PRAGMA busy_timeout = 5000;');
    active.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const createdAt = new Date().toISOString();
    const id = backupId(createdAt);
    const databaseFile = id + '.sqlite';
    const destination = path.join(directory, databaseFile);
    active.exec('VACUUM INTO ' + sqliteString(destination) + ';');
    validateDatabase(destination);
    const manifest: BackupManifest = {
      schemaVersion: 1,
      id,
      createdAt,
      reason: 'manual',
      sizeBytes: statSync(destination).size,
      databaseFile,
      platform,
      arch,
      dataSchemaVersion: readDataSchemaVersion(active),
    };
    writeFileSync(manifestPath(directory, id), JSON.stringify(manifest, null, 2), 'utf8');
  } finally {
    active.close();
  }
}

interface AutomaticBackupLease {
  readonly handle: FileHandle;
  readonly path: string;
}

async function acquireAutomaticBackupLease(directory: string, now: Date): Promise<AutomaticBackupLease | null> {
  const leasePath = path.join(directory, 'automatic-backup.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(leasePath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: now.toISOString() }), 'utf8');
      return { handle, path: leasePath };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (attempt > 0) return null;
      try {
        const info = await stat(leasePath);
        if (now.getTime() - info.mtimeMs <= 60 * 60 * 1000) return null;
        await rm(leasePath, { force: true });
      } catch (staleError) {
        if (!isMissingFile(staleError)) return null;
      }
    }
  }
  return null;
}

function selectDailyAndWeeklyRetention(values: readonly BackupManifest[], dailyKeep: number, weeklyKeep: number): ReadonlySet<string> {
  const keep = new Set(values.slice(0, dailyKeep).map((value) => value.id));
  const seenWeeks = new Set<string>();
  for (const value of values.slice(dailyKeep)) {
    if (seenWeeks.size >= weeklyKeep) break;
    const week = isoWeekKey(value.createdAt);
    if (week === null || seenWeeks.has(week)) continue;
    seenWeeks.add(week);
    keep.add(value.id);
  }
  return keep;
}

function isoWeekKey(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${utc.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}

function backupId(createdAt: string): string {
  return 'backup-' + createdAt.replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
}

function manifestPath(directory: string, id: string): string {
  return path.join(directory, id + '.json');
}

function retentionArchiveDirectory(directory: string): string {
  return path.join(directory, RETENTION_ARCHIVE_DIRECTORY);
}

function restoreMarkerPath(directory: string): string {
  return path.join(directory, 'restore-pending.json');
}

function summary(value: BackupManifest, targetPlatform: NodeJS.Platform = process.platform, targetArch: string = process.arch): BackupSummary {
  return {
    id: value.id,
    createdAt: value.createdAt,
    reason: value.reason,
    sizeBytes: value.sizeBytes,
    ...(value.platform === undefined ? {} : { platform: value.platform }),
    ...(value.arch === undefined ? {} : { arch: value.arch }),
    ...(value.dataSchemaVersion === undefined ? {} : { dataSchemaVersion: value.dataSchemaVersion }),
    hostCompatibility: backupHostCompatibility(value, targetPlatform, targetArch),
  };
}

interface CrossHostRestoreContext {
  readonly backupId: string;
  readonly restoredAt: string;
  readonly sourcePlatform: NodeJS.Platform | null;
  readonly sourceArch: string | null;
  readonly targetPlatform: NodeJS.Platform;
  readonly targetArch: string;
}

interface CrossHostRestoreResult {
  readonly notice: BackupRestoreNotice;
  readonly quarantinedItems: readonly string[];
}

function backupHostCompatibility(manifest: BackupManifest, targetPlatform: NodeJS.Platform, targetArch: string): BackupHostCompatibility {
  if (manifest.platform === undefined || manifest.arch === undefined) return 'legacy_unknown';
  return manifest.platform === targetPlatform && manifest.arch === targetArch ? 'same_host' : 'cross_host';
}

function determineBackupHostCompatibility(manifest: BackupManifest, sourceDatabase: string, targetPlatform: NodeJS.Platform, targetArch: string): BackupHostCompatibility {
  const declared = backupHostCompatibility(manifest, targetPlatform, targetArch);
  // Treat an impossible path syntax as foreign even when a producer supplied
  // stale or incorrect host metadata. Never let metadata turn a path-boundary
  // violation into a same-host restore.
  if (hasForeignWorkspacePath(sourceDatabase, targetPlatform)) return 'cross_host';
  return declared;
}

function emptyCrossHostRestore(
  manifest: BackupManifest,
  targetPlatform: NodeJS.Platform,
  targetArch: string,
  now: () => Date,
): CrossHostRestoreResult {
  return {
    notice: {
      schemaVersion: 1,
      backupId: manifest.id,
      restoredAt: now().toISOString(),
      sourcePlatform: manifest.platform ?? null,
      sourceArch: manifest.arch ?? null,
      targetPlatform,
      targetArch,
      hostCompatibility: backupHostCompatibility(manifest, targetPlatform, targetArch),
      incomplete: false,
      relinkRequired: false,
      quarantinedItems: [],
    },
    quarantinedItems: [],
  };
}

/**
 * A database backup contains portable history and host-bound runtime state in
 * the same SQLite file. When the source host differs, keep the history but
 * remove runtime authority before the replacement becomes visible.
 */
function sanitizeCrossHostDatabase(filename: string, context: CrossHostRestoreContext): CrossHostRestoreResult {
  const database = new DatabaseSync(filename);
  const quarantinedItems: string[] = [];
  const noticeBase = {
    schemaVersion: 1 as const,
    backupId: context.backupId,
    restoredAt: context.restoredAt,
    sourcePlatform: context.sourcePlatform,
    sourceArch: context.sourceArch,
    targetPlatform: context.targetPlatform,
    targetArch: context.targetArch,
    hostCompatibility: 'cross_host' as const,
  };
  try {
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec('BEGIN IMMEDIATE;');
    database.exec(`
      CREATE TABLE IF NOT EXISTS restore_quarantine (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        item_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        value_sha256 TEXT,
        value_length INTEGER,
        source_platform TEXT,
        source_arch TEXT,
        created_at TEXT NOT NULL
      );
    `);

    quarantineHostBoundSettings(database, context, quarantinedItems);
    quarantineForeignWorkspaces(database, context, quarantinedItems);
    quarantineScheduledContinuations(database, context, quarantinedItems);
    quarantineGoalLeases(database, context, quarantinedItems);
    quarantineAgentSwarms(database, context, quarantinedItems);
    quarantineOpenMutationFences(database, context);

    const uniqueItems = [...new Set(quarantinedItems)];
    const notice: BackupRestoreNotice = {
      ...noticeBase,
      incomplete: uniqueItems.length > 0,
      relinkRequired: uniqueItems.some((value) => value.startsWith('workspace:')),
      quarantinedItems: uniqueItems,
    };
    writeRestoreNotice(database, notice);
    database.exec('COMMIT;');
    return { notice, quarantinedItems: uniqueItems };
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch { /* best effort */ }
    throw error;
  } finally {
    database.close();
  }
}

function quarantineHostBoundSettings(database: DatabaseSync, context: CrossHostRestoreContext, quarantinedItems: string[]): void {
  if (!hasTable(database, 'settings')) return;
  const rows = database.prepare('SELECT key, value FROM settings').all() as unknown as Array<{ key?: unknown; value?: unknown }>;
  const remove = rows.filter((row): row is { key: string; value: string } => (
    typeof row.key === 'string' && typeof row.value === 'string' && isHostBoundSetting(row.key, row.value)
  ));
  for (const row of remove) {
    recordQuarantine(database, 'setting', row.key, 'host_bound_setting', row.value, context);
    database.prepare('DELETE FROM settings WHERE key = ?').run(row.key);
    quarantinedItems.push(`setting:${row.key}`);
  }

  // Workspace selections refer to IDs that are deliberately archived below;
  // clearing them prevents a restored foreign path from becoming Primary on
  // the first startup before the user has relinked a local folder.
  database.prepare('DELETE FROM settings WHERE key IN (?, ?)').run('selected_workspace_id', 'active_workspace_ids');
}

function quarantineForeignWorkspaces(database: DatabaseSync, context: CrossHostRestoreContext, quarantinedItems: string[]): void {
  if (!hasTable(database, 'workspaces') || !hasColumn(database, 'workspaces', 'archived_at')) return;
  const rows = database.prepare('SELECT id, root_path, real_root_path, archived_at FROM workspaces').all() as unknown as Array<{ id?: unknown; root_path?: unknown; real_root_path?: unknown; archived_at?: unknown }>;
  const update = database.prepare('UPDATE workspaces SET archived_at = ? WHERE id = ? AND archived_at IS NULL');
  for (const row of rows) {
    if (typeof row.id !== 'string' || typeof row.root_path !== 'string' || typeof row.real_root_path !== 'string' || row.archived_at !== null) continue;
    recordQuarantine(database, 'workspace', row.id, 'foreign_host_root_requires_relink', `${row.root_path}\n${row.real_root_path}`, context);
    update.run(context.restoredAt, row.id);
    quarantinedItems.push(`workspace:${row.id}`);
  }
}

function quarantineScheduledContinuations(database: DatabaseSync, context: CrossHostRestoreContext, quarantinedItems: string[]): void {
  if (!hasTable(database, 'goal_scheduled_continuations')) return;
  const columns = tableColumns(database, 'goal_scheduled_continuations');
  if (!columns.has('status')) return;
  const liveStatuses = ['prepared', 'scheduled', 'create_uncertain', 'reschedule_required', 'reschedule_failed', 'reschedule_uncertain', 'cancel_required', 'cancel_failed', 'cancel_uncertain'];
  const rows = database.prepare(`SELECT id, status, native_task_id FROM goal_scheduled_continuations WHERE status IN (${liveStatuses.map(() => '?').join(', ')})`).all(...liveStatuses) as unknown as Array<{ id?: unknown; status?: unknown; native_task_id?: unknown }>;
  if (rows.length === 0) return;
  const terminalStatus = scheduledContinuationTerminalStatus(database);
  const assignments: string[] = ['status = ?'];
  if (columns.has('native_task_id')) assignments.push('native_task_id = NULL');
  if (columns.has('confirmed_runs_on')) assignments.push("confirmed_runs_on = 'unverified'");
  if (columns.has('last_detail')) assignments.push('last_detail = ?');
  if (columns.has('terminal_at')) assignments.push('terminal_at = ?');
  if (columns.has('updated_at')) assignments.push('updated_at = ?');
  const values: SQLInputValue[] = [terminalStatus];
  if (columns.has('last_detail')) values.push('cross-host restore quarantined the native scheduler receipt');
  if (columns.has('terminal_at')) values.push(context.restoredAt);
  if (columns.has('updated_at')) values.push(context.restoredAt);
  database.prepare(`UPDATE goal_scheduled_continuations SET ${assignments.join(', ')} WHERE status IN (${liveStatuses.map(() => '?').join(', ')})`)
    .run(...values, ...liveStatuses);
  for (const row of rows) if (typeof row.id === 'string') {
    recordQuarantine(database, 'scheduled_continuation', row.id, 'host_bound_native_task_receipt', typeof row.native_task_id === 'string' ? row.native_task_id : null, context);
    quarantinedItems.push(`continuation:${row.id}`);
  }
}

function quarantineGoalLeases(database: DatabaseSync, context: CrossHostRestoreContext, quarantinedItems: string[]): void {
  if (!hasTable(database, 'goals')) return;
  const columns = tableColumns(database, 'goals');
  const leaseColumns = ['lease_owner_client_id', 'lease_owner_session_id', 'lease_token_hash', 'lease_duration_seconds', 'lease_heartbeat_at', 'lease_expires_at'].filter((column) => columns.has(column));
  if (leaseColumns.length === 0) return;
  const rows = database.prepare(`SELECT id FROM goals WHERE ${leaseColumns.map((column) => `${column} IS NOT NULL`).join(' OR ')}`).all() as unknown as Array<{ id?: unknown }>;
  if (rows.length === 0) return;
  const assignments = leaseColumns.map((column) => `${column} = NULL`);
  if (columns.has('lease_generation')) assignments.push('lease_generation = lease_generation + 1');
  if (columns.has('lease_activity_seq')) assignments.push('lease_activity_seq = lease_activity_seq + 1');
  database.prepare(`UPDATE goals SET ${assignments.join(', ')} WHERE ${leaseColumns.map((column) => `${column} IS NOT NULL`).join(' OR ')}`).run();
  for (const row of rows) if (typeof row.id === 'string') {
    recordQuarantine(database, 'goal_lease', row.id, 'host_bound_goal_lease', null, context);
    quarantinedItems.push(`goal-lease:${row.id}`);
  }
}

function quarantineAgentSwarms(database: DatabaseSync, context: CrossHostRestoreContext, quarantinedItems: string[]): void {
  if (!hasTable(database, 'agent_swarms')) return;
  const swarmColumns = tableColumns(database, 'agent_swarms');
  if (!swarmColumns.has('state')) return;
  const rows = database.prepare("SELECT id FROM agent_swarms WHERE state IN ('queued', 'running')").all() as unknown as Array<{ id?: unknown }>;
  if (rows.length > 0) {
    database.prepare("UPDATE agent_swarms SET state = 'termination_unverified' WHERE state IN ('queued', 'running')").run();
    for (const row of rows) if (typeof row.id === 'string') {
      recordQuarantine(database, 'agent_swarm', row.id, 'host_bound_child_process_state', null, context);
      quarantinedItems.push(`swarm:${row.id}`);
    }
  }
  if (!hasTable(database, 'agent_swarm_tasks')) return;
  const taskColumns = tableColumns(database, 'agent_swarm_tasks');
  const assignments: string[] = [];
  if (taskColumns.has('state')) assignments.push("state = 'termination_unverified'");
  if (taskColumns.has('codex_task_id')) assignments.push('codex_task_id = NULL');
  if (taskColumns.has('error')) assignments.push("error = 'cross-host restore quarantined host task state'");
  if (assignments.length > 0) database.prepare(`UPDATE agent_swarm_tasks SET ${assignments.join(', ')} WHERE state IN ('blocked', 'queued', 'running')`).run();
}

function quarantineOpenMutationFences(database: DatabaseSync, context: CrossHostRestoreContext): void {
  if (!hasTable(database, 'goal_fenced_mutation_calls') || !hasColumn(database, 'goal_fenced_mutation_calls', 'completed_at')) return;
  database.prepare("UPDATE goal_fenced_mutation_calls SET completed_at = ? WHERE completed_at IS NULL").run(context.restoredAt);
}

function writeRestoreNotice(database: DatabaseSync, notice: BackupRestoreNotice): void {
  if (!hasTable(database, 'settings')) return;
  database.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(BACKUP_RESTORE_NOTICE_SETTING_KEY, JSON.stringify(notice));
}

function appendRestoreNotice(databaseFilename: string, original: BackupRestoreNotice, quarantinedItems: readonly string[]): void {
  const database = new DatabaseSync(databaseFilename);
  try {
    const notice: BackupRestoreNotice = {
      ...original,
      incomplete: quarantinedItems.length > 0,
      relinkRequired: original.relinkRequired,
      quarantinedItems: [...new Set(quarantinedItems)],
    };
    database.exec('BEGIN IMMEDIATE;');
    writeRestoreNotice(database, notice);
    database.exec('COMMIT;');
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch { /* best effort */ }
    throw error;
  } finally {
    database.close();
  }
}

function quarantineHostBoundFiles(databaseFilename: string, backupIdValue: string, configuredPaths: readonly string[] | undefined): string[] {
  const dataDirectory = path.dirname(databaseFilename);
  const quarantineDirectory = path.join(dataDirectory, 'restore-quarantine', backupIdValue);
  const defaultCandidates = [
    path.join(dataDirectory, 'checkpoint-master.key'),
    path.join(dataDirectory, 'checkpoint-master.key.migration.json'),
    path.join(dataDirectory, 'lnwjud.runtime.secret'),
    path.join(dataDirectory, 'tunnel-client', 'lnwjud.runtime.secret'),
    path.join(dataDirectory, 'tunnel-client', 'lnwjud.oauth.session.secret'),
    path.join(dataDirectory, 'remote-mcp', 'oauth-state.secret'),
    path.join(dataDirectory, 'remote-mcp', 'ngrok-authtoken.secret'),
  ];
  // Desktop passes the resolved legacy API-key path, which can live outside
  // userData. Its OAuth sibling belongs to that same profile even if the API
  // key itself does not exist (OAuth-only accounts).
  const tunnelSessions = (configuredPaths ?? [])
    .filter((candidate) => path.basename(candidate) === 'lnwjud.runtime.secret')
    .map((candidate) => path.join(path.dirname(candidate), 'lnwjud.oauth.session.secret'));
  const candidates = [...new Set([...(configuredPaths ?? []), ...defaultCandidates, ...tunnelSessions])];
  const moved: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      mkdirSync(quarantineDirectory, { recursive: true });
      const destination = path.join(quarantineDirectory, path.basename(candidate));
      const uniqueDestination = existsSync(destination) ? `${destination}.${randomUUID()}` : destination;
      renameSync(candidate, uniqueDestination);
      moved.push(`file:${path.relative(dataDirectory, candidate).replaceAll(path.sep, '/')}`);
    } catch {
      moved.push(`file:${path.relative(dataDirectory, candidate).replaceAll(path.sep, '/')}:quarantine_failed`);
    }
  }
  return moved;
}

function recordQuarantine(database: DatabaseSync, kind: string, itemKey: string, reason: string, value: string | null, context: CrossHostRestoreContext): void {
  database.prepare(`
    INSERT INTO restore_quarantine (id, kind, item_key, reason, value_sha256, value_length, source_platform, source_arch, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    kind,
    itemKey,
    reason,
    value === null ? null : createHash('sha256').update(value, 'utf8').digest('hex'),
    value === null ? null : Buffer.byteLength(value, 'utf8'),
    context.sourcePlatform,
    context.sourceArch,
    context.restoredAt,
  );
}

function isHostBoundSetting(key: string, value: string): boolean {
  const normalized = key.trim().toLowerCase();
  if (normalized === BACKUP_RESTORE_NOTICE_SETTING_KEY) return false;
  if (value.trim().startsWith('safe:v1:')) return true;
  if (new Set([
    'tunnel_client_path',
    'pdf_provider_path',
    'capability_roots',
    'stdio_allowed_roots',
    'lsp_commands',
    'tunnel_identity_id',
    'client_path',
  ]).has(normalized)) return true;
  return /(?:secret|credential|password|api[_-]?key|token|provider|(?:^|_)path$|(?:^|_)roots$|receipt)/i.test(normalized);
}

function hasForeignWorkspacePath(filename: string, platform: NodeJS.Platform): boolean {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    if (!hasTable(database, 'workspaces')) return false;
    // Archived imports carry history, not runtime authority. Including them
    // would quarantine newly created local keys on every subsequent restore.
    const activeOnly = hasColumn(database, 'workspaces', 'archived_at') ? ' WHERE archived_at IS NULL' : '';
    const rows = database.prepare(`SELECT root_path, real_root_path FROM workspaces${activeOnly}`).all() as unknown as Array<{ root_path?: unknown; real_root_path?: unknown }>;
    return rows.some((row) => (typeof row.root_path === 'string' && isForeignAbsolutePath(row.root_path, platform))
      || (typeof row.real_root_path === 'string' && isForeignAbsolutePath(row.real_root_path, platform)));
  } finally {
    database.close();
  }
}

function hasTable(database: DatabaseSync, name: string): boolean {
  const row = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { present?: number } | undefined;
  return row?.present === 1;
}

function tableColumns(database: DatabaseSync, table: string): ReadonlySet<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name?: unknown }>;
  return new Set(rows.flatMap((row) => typeof row.name === 'string' ? [row.name] : []));
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  return tableColumns(database, table).has(column);
}

function scheduledContinuationTerminalStatus(database: DatabaseSync): 'cancelled' | 'superseded' {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'goal_scheduled_continuations'").get() as { sql?: unknown } | undefined;
  return typeof row?.sql === 'string' && row.sql.includes("'cancelled'") ? 'cancelled' : 'superseded';
}

function readDataSchemaVersion(database: DatabaseSync): number {
  if (!hasTable(database, 'schema_migrations')) return 0;
  const rows = database.prepare('SELECT id FROM schema_migrations').all() as unknown as Array<{ id?: unknown }>;
  return rows.reduce((highest, row) => {
    if (typeof row.id !== 'string') return highest;
    const match = /^(\d+)(?:_|$)/.exec(row.id);
    return match === null ? highest : Math.max(highest, Number(match[1]));
  }, 0);
}

function parsePlatform(value: unknown): NodeJS.Platform | null {
  return typeof value === 'string' && value.trim().length > 0 ? value as NodeJS.Platform : null;
}

export function parseBackupRestoreNotice(raw: string | null | undefined): BackupRestoreNotice | null {
  if (raw === null || raw === undefined || raw.trim().length === 0) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.backupId !== 'string'
      || typeof value.restoredAt !== 'string' || typeof value.targetPlatform !== 'string'
      || typeof value.targetArch !== 'string' || !isBackupHostCompatibility(value.hostCompatibility)
      || typeof value.incomplete !== 'boolean' || typeof value.relinkRequired !== 'boolean'
      || !Array.isArray(value.quarantinedItems) || !value.quarantinedItems.every((entry) => typeof entry === 'string')) return null;
    const sourcePlatform = value.sourcePlatform === null || value.sourcePlatform === undefined ? null : parsePlatform(value.sourcePlatform);
    const sourceArch = value.sourceArch === null || value.sourceArch === undefined ? null : typeof value.sourceArch === 'string' && value.sourceArch.trim().length > 0 ? value.sourceArch : null;
    if ((value.sourcePlatform !== null && value.sourcePlatform !== undefined && sourcePlatform === null)
      || (value.sourceArch !== null && value.sourceArch !== undefined && sourceArch === null)) return null;
    return {
      schemaVersion: 1,
      backupId: value.backupId,
      restoredAt: value.restoredAt,
      sourcePlatform,
      sourceArch,
      targetPlatform: value.targetPlatform as NodeJS.Platform,
      targetArch: value.targetArch,
      hostCompatibility: value.hostCompatibility,
      incomplete: value.incomplete,
      relinkRequired: value.relinkRequired,
      quarantinedItems: value.quarantinedItems,
    };
  } catch {
    return null;
  }
}

function isBackupHostCompatibility(value: unknown): value is BackupHostCompatibility {
  return value === 'same_host' || value === 'cross_host' || value === 'legacy_unknown';
}

function validDataSchemaVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000;
}

async function listManifests(directory: string): Promise<BackupManifest[]> {
  await mkdir(directory, { recursive: true });
  const names = await readdir(directory);
  const values = await Promise.all(names.filter((name) => name.startsWith('backup-') && name.endsWith('.json')).map(async (name) => {
    try { return parseManifest(await readFile(path.join(directory, name), 'utf8'), directory); } catch { return null; }
  }));
  return values.filter((value): value is BackupManifest => value !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function readStoredManifestById(directory: string, id: string): Promise<StoredBackupManifest | null> {
  if (!isSafeBackupId(id)) return null;
  for (const candidateDirectory of [directory, retentionArchiveDirectory(directory)]) {
    try {
      const manifest = parseManifest(await readFile(manifestPath(candidateDirectory, id), 'utf8'), candidateDirectory);
      if (manifest !== null) return { manifest, directory: candidateDirectory };
    } catch {
      // Try the next recovery location.
    }
  }
  return null;
}

function readStoredManifestByIdSync(directory: string, id: string): StoredBackupManifest | null {
  if (!isSafeBackupId(id)) return null;
  for (const candidateDirectory of [directory, retentionArchiveDirectory(directory)]) {
    try {
      const manifest = parseManifest(readFileSync(manifestPath(candidateDirectory, id), 'utf8'), candidateDirectory);
      if (manifest !== null) return { manifest, directory: candidateDirectory };
    } catch {
      // Try the next recovery location.
    }
  }
  return null;
}

function parseManifest(raw: string, directory: string): BackupManifest | null {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !isSafeBackupId(value.id)
    || typeof value.createdAt !== 'string' || !isBackupReason(value.reason) || typeof value.sizeBytes !== 'number'
    || typeof value.databaseFile !== 'string' || value.databaseFile !== value.id + '.sqlite') return null;
  const platform = value.platform === undefined ? undefined : parsePlatform(value.platform);
  const arch = value.arch === undefined ? undefined : typeof value.arch === 'string' && value.arch.trim().length > 0 ? value.arch.trim() : null;
  const dataSchemaVersion = value.dataSchemaVersion === undefined ? undefined : validDataSchemaVersion(value.dataSchemaVersion) ? value.dataSchemaVersion : null;
  if (platform === null || arch === null || dataSchemaVersion === null) return null;
  if (!existsSync(path.join(directory, value.databaseFile))) return null;
  return {
    schemaVersion: 1,
    id: value.id,
    createdAt: value.createdAt,
    reason: value.reason,
    sizeBytes: value.sizeBytes,
    databaseFile: value.databaseFile,
    ...(platform === undefined ? {} : { platform }),
    ...(arch === undefined ? {} : { arch }),
    ...(dataSchemaVersion === undefined ? {} : { dataSchemaVersion }),
  };
}

function parseRestoreMarker(raw: string): RestoreMarker {
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.backupId !== 'string' || !isSafeBackupId(value.backupId) || typeof value.requestedAt !== 'string') throw new Error('Restore marker is invalid');
  return { schemaVersion: 1, backupId: value.backupId, requestedAt: value.requestedAt };
}

function validateDatabase(filename: string): void {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const row = database.prepare('PRAGMA quick_check;').get();
    if (!isRecord(row) || !Object.values(row).includes('ok')) throw new Error('SQLite backup integrity check failed');
  } finally {
    database.close();
  }
}

async function archiveBeyond(directory: string, values: readonly BackupManifest[], keep: number): Promise<void> {
  for (const value of values.slice(keep)) await archiveBackup(directory, value);
}

async function archiveNotKept(directory: string, values: readonly BackupManifest[], keep: ReadonlySet<string>): Promise<void> {
  for (const value of values) if (!keep.has(value.id)) await archiveBackup(directory, value);
}

async function archiveBackup(directory: string, value: BackupManifest): Promise<void> {
  const archiveDirectory = retentionArchiveDirectory(directory);
  await mkdir(archiveDirectory, { recursive: true });
  const sourceDatabase = path.join(directory, value.databaseFile);
  const sourceManifest = manifestPath(directory, value.id);
  const archivedDatabase = path.join(archiveDirectory, value.databaseFile);
  const archivedManifest = manifestPath(archiveDirectory, value.id);

  await rename(sourceDatabase, archivedDatabase);
  try {
    await rename(sourceManifest, archivedManifest);
  } catch (error) {
    await rename(archivedDatabase, sourceDatabase).catch(() => undefined);
    throw error;
  }
}

function isSafeBackupId(value: string): boolean {
  return /^backup-[0-9TZ-]+-[0-9a-f]{8}$/i.test(value);
}

function isBackupReason(value: unknown): value is BackupReason {
  return value === 'daily' || value === 'manual' || value === 'pre-update' || value === 'pre-migration';
}

function boundedRetention(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value >= 1 && value <= 100 ? value : fallback;
}

function sqliteString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Restore failed';
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === 'EEXIST';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
