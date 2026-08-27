import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { SqliteDatabase } from './database.js';

export type BackupReason = 'daily' | 'manual' | 'pre-update' | 'pre-migration';

export interface BackupSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly reason: BackupReason;
  readonly sizeBytes: number;
}

interface BackupManifest extends BackupSummary {
  readonly schemaVersion: 1;
  readonly databaseFile: string;
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
  readonly dailyRetention?: number;
  readonly weeklyRetention?: number;
  readonly manualRetention?: number;
  readonly migrationRetention?: number;
}

const RETENTION_ARCHIVE_DIRECTORY = 'retention-archive';

export class SqliteBackupService {
  private readonly backupDirectory: string;
  private readonly now: () => Date;
  private readonly dailyRetention: number;
  private readonly weeklyRetention: number;
  private readonly manualRetention: number;
  private readonly migrationRetention: number;

  public constructor(private readonly database: SqliteDatabase, options: SqliteBackupServiceOptions) {
    this.backupDirectory = path.resolve(options.backupDirectory);
    // Resolve here so a malformed configuration fails at construction rather than during restore.
    path.resolve(options.databaseFilename);
    this.now = options.now ?? ((): Date => new Date());
    this.dailyRetention = boundedRetention(options.dailyRetention, 7);
    this.weeklyRetention = boundedRetention(options.weeklyRetention, 4);
    this.manualRetention = boundedRetention(options.manualRetention, 10);
    this.migrationRetention = boundedRetention(options.migrationRetention, 5);
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
    const manifest: BackupManifest = { schemaVersion: 1, id, createdAt, reason, sizeBytes, databaseFile };
    await writeFile(manifestPath(this.backupDirectory, id), JSON.stringify(manifest, null, 2), 'utf8');
    await this.rotateRetention();
    return summary(manifest);
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
    return (await listManifests(this.backupDirectory)).map(summary);
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

export function createPreMigrationBackupSync(database: DatabaseSync, backupDirectory: string): BackupSummary {
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
  };
  writeFileSync(manifestPath(directory, id), JSON.stringify(manifest, null, 2), 'utf8');
  return summary(manifest);
}

export interface PendingRestoreResult {
  readonly applied: boolean;
  readonly backupId?: string;
  readonly error?: string;
}

export function applyPendingSqliteRestoreSync(databaseFilename: string, backupDirectory: string): PendingRestoreResult {
  const dbPath = path.resolve(databaseFilename);
  const directory = path.resolve(backupDirectory);
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

    if (existsSync(dbPath)) createEmergencyBackup(dbPath, directory);

    const temporary = dbPath + '.restore-' + randomUUID() + '.tmp';
    copyFileSync(source, temporary);
    validateDatabase(temporary);
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
    rmSync(claimPath, { force: true });
    return { applied: true, backupId: marker.backupId };
  } catch (error) {
    const failedPath = markerPath + '.failed-' + Date.now();
    try { renameSync(claimPath, failedPath); } catch { /* best effort */ }
    return { applied: false, error: errorMessage(error) };
  }
}

function createEmergencyBackup(dbPath: string, directory: string): void {
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
    const manifest: BackupManifest = { schemaVersion: 1, id, createdAt, reason: 'manual', sizeBytes: statSync(destination).size, databaseFile };
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

function summary(value: BackupManifest): BackupSummary {
  return { id: value.id, createdAt: value.createdAt, reason: value.reason, sizeBytes: value.sizeBytes };
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
  if (!existsSync(path.join(directory, value.databaseFile))) return null;
  return { schemaVersion: 1, id: value.id, createdAt: value.createdAt, reason: value.reason, sizeBytes: value.sizeBytes, databaseFile: value.databaseFile };
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
