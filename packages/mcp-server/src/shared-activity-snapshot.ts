import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ActivitySink, ActivitySinkEvent } from './activity-tracker.js';

const execFileAsync = promisify(execFile);
const LEGACY_SNAPSHOT_FILE = 'lnwjud.mcp.activity.json';
const LEASE_DIRECTORY = 'lnwjud.mcp.activity.v2';
const LEGACY_SNAPSHOT_VERSION = 1;
const LEASE_SNAPSHOT_VERSION = 2;
const DEFAULT_STALE_AFTER_MS = 5_000;
const DEFAULT_HEARTBEAT_MS = 1_000;
const DEFAULT_PROCESS_PROBE_TIMEOUT_MS = 1_750;
const DEFAULT_PROCESS_PROBE_ATTEMPTS = 2;
const MAX_SNAPSHOT_BYTES = 16 * 1024;
const MAX_ACTIVITY_LEASES = 128;
const ISO_UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LEASE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export interface SharedActivityOwner {
  readonly pid: number;
  readonly processStartedAt: string;
}

interface LegacySharedActivitySnapshot {
  readonly version: 1;
  readonly owner: SharedActivityOwner;
  readonly activeCount: number;
  readonly revision: number;
  readonly updatedAt: string;
}

interface SharedActivityLeaseSnapshot {
  readonly version: 2;
  readonly leaseId: string;
  readonly owner: SharedActivityOwner;
  readonly activeCount: number;
  readonly revision: number;
  readonly updatedAt: string;
}

interface SnapshotCandidate {
  readonly filePath: string;
  readonly snapshot: LegacySharedActivitySnapshot | SharedActivityLeaseSnapshot;
}

export interface SharedActivityLeaseObservation extends SharedActivityOwner {
  readonly leaseId: string;
}

export type ProcessProbeResult =
  | { readonly state: 'live'; readonly processStartedAt: string }
  | { readonly state: 'gone' }
  | { readonly state: 'unverifiable'; readonly reason: string };

export interface ProcessProbeOptions {
  readonly runProbe?: (pid: number, timeoutMs: number) => Promise<string>;
  readonly timeoutMs?: number;
  readonly attempts?: number;
}

export type SharedActivityObservation =
  | {
    readonly state: 'available';
    readonly owners: readonly SharedActivityLeaseObservation[];
    readonly ownerKey: string;
    readonly activeCount: number;
    readonly revision: number;
    readonly updatedAt: string;
  }
  | { readonly state: 'missing'; readonly reason: 'snapshot_missing' }
  | { readonly state: 'stale'; readonly reason: 'snapshot_expired' | 'owner_gone' | 'owner_reused' }
  | { readonly state: 'unverifiable'; readonly reason: string };

export interface SharedActivitySnapshotLeaseOptions {
  readonly profileDirectory: string;
  readonly owner: SharedActivityOwner;
  readonly leaseId?: string;
  readonly now?: () => Date;
  readonly heartbeatMs?: number;
  readonly hooks?: { readonly afterCloseQuarantine?: () => Promise<void> };
}

export class SharedActivitySnapshotLease implements ActivitySink {
  private readonly leaseId: string;
  private readonly snapshotPath: string;
  private readonly now: () => Date;
  private readonly heartbeatMs: number;
  private activeCount = 0;
  private revision = 0;
  private initialized = false;
  private closed = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private operations: Promise<unknown> = Promise.resolve();

  public constructor(private readonly options: SharedActivitySnapshotLeaseOptions) {
    if (!validOwner(options.owner)) throw new Error('Shared activity owner metadata is invalid');
    this.leaseId = options.leaseId ?? randomUUID();
    if (!validLeaseId(this.leaseId)) throw new Error('Shared activity lease ID is invalid');
    this.snapshotPath = sharedActivityLeasePath(options.profileDirectory, options.owner, this.leaseId);
    this.now = options.now ?? ((): Date => new Date());
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  }

  public initialize(): Promise<void> {
    return this.enqueue(async () => {
      if (this.initialized) return;
      if (this.closed) throw new Error('Shared activity lease is closed');
      await mkdir(sharedActivityLeaseDirectoryPath(this.options.profileDirectory), { recursive: true });
      await this.publish();
      this.initialized = true;
      this.startHeartbeat();
    });
  }

  public record(event: ActivitySinkEvent): Promise<void> {
    return this.enqueue(async () => {
      await this.initializeInsideOperation();
      if (event.phase === 'started') this.activeCount += 1;
      else this.activeCount = Math.max(0, this.activeCount - 1);
      this.revision += 1;
      await this.publish();
    });
  }

  public close(): Promise<boolean> {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    return this.enqueue(async () => {
      this.closed = true;
      const quarantinePath = `${this.snapshotPath}.closed.${process.pid}.${randomUUID()}`;
      try {
        await rename(this.snapshotPath, quarantinePath);
      } catch {
        return false;
      }
      try {
        const moved = parseLeaseSnapshot(await readBoundedSnapshot(quarantinePath));
        if (moved === null || moved.leaseId !== this.leaseId || !sameOwner(moved.owner, this.options.owner)) {
          await restoreSnapshot(quarantinePath, this.snapshotPath);
          return false;
        }
        await this.options.hooks?.afterCloseQuarantine?.();
        await rm(quarantinePath, { force: false });
        return true;
      } catch {
        await restoreSnapshot(quarantinePath, this.snapshotPath).catch(() => undefined);
        return false;
      }
    });
  }

  private refresh(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.initialized || this.closed) return;
      await this.publish();
    }).catch(() => undefined);
  }

  private async initializeInsideOperation(): Promise<void> {
    if (this.initialized) return;
    if (this.closed) throw new Error('Shared activity lease is closed');
    await mkdir(sharedActivityLeaseDirectoryPath(this.options.profileDirectory), { recursive: true });
    await this.publish();
    this.initialized = true;
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeatMs <= 0 || this.heartbeat !== null) return;
    this.heartbeat = setInterval(() => { void this.refresh(); }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  private async publish(): Promise<void> {
    const snapshot: SharedActivityLeaseSnapshot = {
      version: LEASE_SNAPSHOT_VERSION,
      leaseId: this.leaseId,
      owner: this.options.owner,
      activeCount: this.activeCount,
      revision: this.revision,
      updatedAt: this.now().toISOString(),
    };
    await atomicWriteSnapshot(this.snapshotPath, snapshot);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operations.then(operation, operation);
    this.operations = next.catch(() => undefined);
    return next;
  }
}

export interface ReadSharedActivitySnapshotOptions {
  readonly profileDirectory: string;
  readonly inspectProcess?: (pid: number) => Promise<ProcessProbeResult>;
  readonly now?: () => Date;
  readonly staleAfterMs?: number;
}

export async function readSharedActivitySnapshot(options: ReadSharedActivitySnapshotOptions): Promise<SharedActivityObservation> {
  const candidatesResult = await readSnapshotCandidates(options.profileDirectory);
  if (!candidatesResult.ok) return { state: 'unverifiable', reason: candidatesResult.reason };
  if (candidatesResult.candidates.length === 0) return { state: 'missing', reason: 'snapshot_missing' };

  const now = options.now?.() ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const probeCache = new Map<number, Promise<ProcessProbeResult>>();
  const live: Array<LegacySharedActivitySnapshot | SharedActivityLeaseSnapshot> = [];
  let staleReason: 'snapshot_expired' | 'owner_gone' | 'owner_reused' | undefined;

  for (const candidate of candidatesResult.candidates) {
    const ageMs = now.getTime() - new Date(candidate.snapshot.updatedAt).getTime();
    if (ageMs > staleAfterMs) {
      staleReason = 'snapshot_expired';
      if (!(await quarantineStaleCandidate(candidate))) return { state: 'unverifiable', reason: 'stale_snapshot_cleanup_race' };
      continue;
    }

    let probePromise = probeCache.get(candidate.snapshot.owner.pid);
    if (probePromise === undefined) {
      probePromise = options.inspectProcess?.(candidate.snapshot.owner.pid) ?? probeProcessStart(candidate.snapshot.owner.pid);
      probeCache.set(candidate.snapshot.owner.pid, probePromise);
    }
    const probe = await probePromise;
    if (probe.state === 'unverifiable') return { state: 'unverifiable', reason: probe.reason };
    if (probe.state === 'gone') {
      staleReason = 'owner_gone';
      if (!(await quarantineStaleCandidate(candidate))) return { state: 'unverifiable', reason: 'stale_snapshot_cleanup_race' };
      continue;
    }
    if (probe.processStartedAt !== candidate.snapshot.owner.processStartedAt) {
      staleReason = 'owner_reused';
      if (!(await quarantineStaleCandidate(candidate))) return { state: 'unverifiable', reason: 'stale_snapshot_cleanup_race' };
      continue;
    }
    live.push(candidate.snapshot);
  }

  if (live.length === 0) {
    return staleReason === undefined
      ? { state: 'missing', reason: 'snapshot_missing' }
      : { state: 'stale', reason: staleReason };
  }

  const owners = live.map((snapshot) => ({
    ...snapshot.owner,
    leaseId: snapshot.version === LEASE_SNAPSHOT_VERSION ? snapshot.leaseId : 'legacy-v1',
  })).sort(compareLeaseOwners);
  const activeCount = live.reduce((total, snapshot) => safeAdd(total, snapshot.activeCount), 0);
  const revision = live.reduce((total, snapshot) => safeAdd(total, snapshot.revision), 0);
  const updatedAt = live.reduce((latest, snapshot) => snapshot.updatedAt > latest ? snapshot.updatedAt : latest, live[0]!.updatedAt);
  return {
    state: 'available',
    owners,
    ownerKey: owners.map((entry) => `${entry.pid}:${entry.processStartedAt}:${entry.leaseId}`).join('|'),
    activeCount,
    revision,
    updatedAt,
  };
}

export async function currentSharedActivityOwner(): Promise<SharedActivityOwner> {
  const probe = await probeProcessStart(process.pid);
  if (probe.state !== 'live') throw new Error(`Could not verify STDIO activity owner process: ${probe.state === 'unverifiable' ? probe.reason : 'gone'}`);
  return { pid: process.pid, processStartedAt: probe.processStartedAt };
}

export async function probeProcessStart(pid: number, options: ProcessProbeOptions = {}): Promise<ProcessProbeResult> {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647) return { state: 'unverifiable', reason: 'invalid_pid' };
  const runProbe = options.runProbe ?? runWindowsProcessProbe;
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_PROCESS_PROBE_TIMEOUT_MS);
  const attempts = Math.min(3, positiveInteger(options.attempts, DEFAULT_PROCESS_PROBE_ATTEMPTS));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return parseProcessProbeOutput(await runProbe(pid, timeoutMs));
    } catch (error: unknown) {
      if (!isProcessProbeTimeout(error)) return { state: 'unverifiable', reason: 'probe_failed' };
      if (attempt === attempts) return { state: 'unverifiable', reason: 'probe_timeout' };
    }
  }
  return { state: 'unverifiable', reason: 'probe_timeout' };
}

export function parseProcessProbeOutput(stdout: string): ProcessProbeResult {
  const value = stdout.trim();
  if (value === 'GONE') return { state: 'gone' };
  if (value.startsWith('LIVE|') && validTimestamp(value.slice(5))) return { state: 'live', processStartedAt: value.slice(5) };
  return { state: 'unverifiable', reason: 'invalid_probe_response' };
}

/** Legacy v1 fixed path retained only for migration/read compatibility. */
export function sharedActivitySnapshotPath(profileDirectory: string): string {
  return path.join(profileDirectory, LEGACY_SNAPSHOT_FILE);
}

export function sharedActivityLeaseDirectoryPath(profileDirectory: string): string {
  return path.join(profileDirectory, LEASE_DIRECTORY);
}

export function sharedActivityLeasePath(profileDirectory: string, owner: SharedActivityOwner, leaseId: string): string {
  const fingerprint = createHash('sha256')
    .update(`${owner.pid}\0${owner.processStartedAt}\0${leaseId}`)
    .digest('hex')
    .slice(0, 32);
  return path.join(sharedActivityLeaseDirectoryPath(profileDirectory), `lease-${fingerprint}.json`);
}

async function readSnapshotCandidates(profileDirectory: string): Promise<
  | { readonly ok: true; readonly candidates: SnapshotCandidate[] }
  | { readonly ok: false; readonly reason: string }
> {
  const candidates: SnapshotCandidate[] = [];
  const legacyPath = sharedActivitySnapshotPath(profileDirectory);
  try {
    const raw = await readBoundedSnapshot(legacyPath);
    const snapshot = parseLegacySnapshot(raw);
    if (snapshot === null) return { ok: false, reason: 'invalid_snapshot' };
    candidates.push({ filePath: legacyPath, snapshot });
  } catch (error: unknown) {
    if (!isNotFound(error)) return { ok: false, reason: 'snapshot_read_failed' };
  }

  const directory = sharedActivityLeaseDirectoryPath(profileDirectory);
  let entries: string[];
  try {
    entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^lease-[a-f0-9]{32}\.json$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error: unknown) {
    if (isNotFound(error)) return { ok: true, candidates };
    return { ok: false, reason: 'snapshot_directory_read_failed' };
  }
  if (entries.length > MAX_ACTIVITY_LEASES) return { ok: false, reason: 'too_many_activity_leases' };

  for (const name of entries) {
    const filePath = path.join(directory, name);
    try {
      const snapshot = parseLeaseSnapshot(await readBoundedSnapshot(filePath));
      if (snapshot === null) return { ok: false, reason: 'invalid_snapshot' };
      candidates.push({ filePath, snapshot });
    } catch (error: unknown) {
      if (isNotFound(error)) continue;
      return { ok: false, reason: 'snapshot_read_failed' };
    }
  }
  return { ok: true, candidates };
}

async function quarantineStaleCandidate(candidate: SnapshotCandidate): Promise<boolean> {
  const quarantinePath = `${candidate.filePath}.stale.${process.pid}.${randomUUID()}`;
  try {
    await rename(candidate.filePath, quarantinePath);
  } catch {
    return false;
  }
  try {
    const raw = await readBoundedSnapshot(quarantinePath);
    const moved = candidate.snapshot.version === LEGACY_SNAPSHOT_VERSION ? parseLegacySnapshot(raw) : parseLeaseSnapshot(raw);
    if (moved === null || !sameSnapshot(candidate.snapshot, moved)) {
      await restoreSnapshot(quarantinePath, candidate.filePath);
      return false;
    }
    await rm(quarantinePath, { force: false });
    return true;
  } catch {
    await restoreSnapshot(quarantinePath, candidate.filePath).catch(() => undefined);
    return false;
  }
}

async function atomicWriteSnapshot(filePath: string, snapshot: SharedActivityLeaseSnapshot): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.publish.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(temporaryPath, JSON.stringify(snapshot), { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function parseLegacySnapshot(raw: string): LegacySharedActivitySnapshot | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== LEGACY_SNAPSHOT_VERSION || !isRecord(value.owner)) return null;
    const parsedOwner = { pid: value.owner.pid, processStartedAt: value.owner.processStartedAt };
    if (!validOwner(parsedOwner) || !validSnapshotCounters(value) || typeof value.updatedAt !== 'string' || !validTimestamp(value.updatedAt)) return null;
    return { version: 1, owner: parsedOwner, activeCount: value.activeCount as number, revision: value.revision as number, updatedAt: value.updatedAt };
  } catch {
    return null;
  }
}

function parseLeaseSnapshot(raw: string): SharedActivityLeaseSnapshot | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== LEASE_SNAPSHOT_VERSION || !isRecord(value.owner) || !validLeaseId(value.leaseId)) return null;
    const parsedOwner = { pid: value.owner.pid, processStartedAt: value.owner.processStartedAt };
    if (!validOwner(parsedOwner) || !validSnapshotCounters(value) || typeof value.updatedAt !== 'string' || !validTimestamp(value.updatedAt)) return null;
    return { version: 2, leaseId: value.leaseId, owner: parsedOwner, activeCount: value.activeCount as number, revision: value.revision as number, updatedAt: value.updatedAt };
  } catch {
    return null;
  }
}

function validSnapshotCounters(record: Record<string, unknown>): boolean {
  return Number.isSafeInteger(record.activeCount) && (record.activeCount as number) >= 0
    && Number.isSafeInteger(record.revision) && (record.revision as number) >= 0;
}

function validOwner(value: unknown): value is SharedActivityOwner {
  if (!isRecord(value)) return false;
  return Number.isInteger(value.pid) && (value.pid as number) > 0 && (value.pid as number) <= 2_147_483_647
    && typeof value.processStartedAt === 'string' && validTimestamp(value.processStartedAt);
}

function validLeaseId(value: unknown): value is string {
  return typeof value === 'string' && LEASE_ID_PATTERN.test(value);
}

function validTimestamp(value: string): boolean {
  if (!ISO_UTC_MILLISECONDS.test(value) || value.startsWith('0000-')) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function sameOwner(left: SharedActivityOwner, right: SharedActivityOwner): boolean {
  return left.pid === right.pid && left.processStartedAt === right.processStartedAt;
}

function sameSnapshot(left: LegacySharedActivitySnapshot | SharedActivityLeaseSnapshot, right: LegacySharedActivitySnapshot | SharedActivityLeaseSnapshot): boolean {
  if (left.version !== right.version || !sameOwner(left.owner, right.owner) || left.revision !== right.revision || left.updatedAt !== right.updatedAt) return false;
  return left.version === 1 || (right.version === 2 && left.leaseId === right.leaseId);
}

function compareLeaseOwners(left: SharedActivityLeaseObservation, right: SharedActivityLeaseObservation): number {
  return `${left.pid}:${left.processStartedAt}:${left.leaseId}`.localeCompare(`${right.pid}:${right.processStartedAt}:${right.leaseId}`);
}

function safeAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readBoundedSnapshot(filePath: string): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const stats = await handle.stat();
    if (stats.size > MAX_SNAPSHOT_BYTES) throw new Error('activity_snapshot_too_large');
    const buffer = Buffer.alloc(stats.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function restoreSnapshot(quarantinePath: string, snapshotPath: string): Promise<void> {
  try {
    await rename(quarantinePath, snapshotPath);
  } catch (error: unknown) {
    // A fresh publisher may already own the original path. Never overwrite it.
    if (!isAlreadyExists(error) && !isNotFound(error)) throw error;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && ['EEXIST', 'EPERM'].includes(String((error as NodeJS.ErrnoException).code ?? ''));
}

async function runWindowsProcessProbe(pid: number, timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$ErrorActionPreference='Stop'; try{$p=Get-Process -Id ${pid} -ErrorAction Stop}catch{if($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*'){'GONE';exit 0};throw}; 'LIVE|' + $p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ',[Globalization.CultureInfo]::InvariantCulture)`,
  ], { windowsHide: true, encoding: 'utf8', timeout: timeoutMs });
  return stdout;
}

function isProcessProbeTimeout(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.code === 'ETIMEDOUT'
    || error.killed === true
    || (error.code == null && error.signal === 'SIGTERM');
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}
