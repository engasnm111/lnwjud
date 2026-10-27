import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appError, err, ok, type Result } from '@lnwjud/domain';

export interface WorkspaceWriterGlobalExclusion {
  holdExclusiveProbe(workspaceId: string): Promise<Result<{
    releaseAfterVerifiedTermination(): Promise<void>;
  }>>;
}

/**
 * Cross-process SQLite admission journal. Every mutation is checked with an
 * IMMEDIATE transaction. Expiry does not preempt a verified-live in-flight
 * invocation; ambiguous process liveness fails closed.
 *
 * This protects lnwjud MCP dispatches, not unrelated filesystem writers.
 */
export interface WorkspaceWriterLeaseProof {
  readonly leaseId: string;
  readonly leaseToken: string;
  readonly generation: number;
}

export interface WorkspaceWriterLeaseStatus {
  readonly workspaceId: string;
  readonly state: 'unleased' | 'active' | 'expired' | 'blocked';
  readonly generation: number;
  readonly ownerClientId?: string;
  readonly expiresAt?: string;
  readonly activeCalls: number;
}

interface LeaseRow {
  workspace_id: string;
  generation: number;
  lease_id: string | null;
  token_hash: string | null;
  owner_client_id: string | null;
  owner_session_id: string | null;
  expires_at: number;
  last_activity_at: number;
}

interface CallRow { call_id: string; pid: number; generation: number; }

export interface WorkspaceWriterLeasePort {
  acquire(workspaceId: string, ownerClientId: string, ownerSessionId: string, ttlSeconds: number, recoverAbandonedSameClient?: boolean): Promise<Result<WorkspaceWriterLeaseProof & { expiresAt: string }>>;
  inspect(workspaceId: string): Promise<Result<WorkspaceWriterLeaseStatus>>;
  begin(workspaceId: string, ownerClientId: string, ownerSessionId: string, callId: string, proof?: WorkspaceWriterLeaseProof): Promise<Result<{ required: boolean; generation: number }>>;
  heartbeat(workspaceId: string, callId: string, generation: number): Promise<void>;
  end(workspaceId: string, callId: string, generation: number): Promise<void>;
  renew(workspaceId: string, ownerClientId: string, ownerSessionId: string, proof: WorkspaceWriterLeaseProof, ttlSeconds: number): Promise<Result<{ expiresAt: string }>>;
  release(workspaceId: string, ownerClientId: string, ownerSessionId: string, proof: WorkspaceWriterLeaseProof): Promise<Result<void>>;
}

export class SqliteWorkspaceWriterLease implements WorkspaceWriterLeasePort {
  constructor(private readonly filename: string, private readonly now: () => number = Date.now, private readonly globalExclusion?: WorkspaceWriterGlobalExclusion) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.transaction((db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS workspace_writer_leases (
        workspace_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, lease_id TEXT,
        token_hash TEXT, owner_client_id TEXT, owner_session_id TEXT,
        expires_at INTEGER NOT NULL DEFAULT 0
      ); CREATE TABLE IF NOT EXISTS workspace_writer_calls (
        call_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        generation INTEGER NOT NULL, pid INTEGER NOT NULL
      ); CREATE INDEX IF NOT EXISTS workspace_writer_calls_workspace ON workspace_writer_calls(workspace_id)`);
      // Existing rows have unknown activity: do not early-recover pre-migration leases.
      const columns = db.prepare('PRAGMA table_info(workspace_writer_leases)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'last_activity_at')) {
        db.exec('ALTER TABLE workspace_writer_leases ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0');
      }
    });
  }

  public async acquire(workspaceId: string, clientId: string, sessionId: string, ttlSeconds: number, recoverAbandonedSameClient = false): Promise<Result<WorkspaceWriterLeaseProof & { expiresAt: string }>> {
    if (!validIdentity(workspaceId, clientId, sessionId) || !validTtl(ttlSeconds)) return invalid();
    const globalProbe = this.globalExclusion === undefined ? undefined
      : await this.globalExclusion.holdExclusiveProbe(workspaceId).catch(() => unavailable());
    if (globalProbe !== undefined && !globalProbe.ok) return globalProbe;
    try {
      return this.transaction((db) => {
        const row = this.row(db, workspaceId);
        const now = this.now();
        if (row?.lease_id !== null && row?.lease_id !== undefined && row.expires_at > now) {
          // Explicit same-client recovery revokes an idle session. Generation fencing
          // prevents any previous proof from authorizing later mutations.
          if (!recoverAbandonedSameClient || row.owner_client_id !== clientId
            || row.owner_session_id === sessionId || row.last_activity_at <= 0
            || now - row.last_activity_at < 60_000) {
            return conflict('Workspace writer lease is active; same-client idle recovery is not eligible');
          }
        }
        // Every in-flight writer is journaled, including mutations without an active lease.
        if (!this.clearVerifiedDeadCalls(db, workspaceId)) return conflict('Prior writer invocation is live or its termination cannot be proved');
        const generation = (row?.generation ?? 0) + 1;
        const leaseId = randomUUID();
        const leaseToken = randomUUID() + randomUUID();
        const expiry = now + ttlSeconds * 1000;
        db.prepare(`INSERT INTO workspace_writer_leases
          (workspace_id,generation,lease_id,token_hash,owner_client_id,owner_session_id,expires_at,last_activity_at)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET
          generation=excluded.generation,lease_id=excluded.lease_id,token_hash=excluded.token_hash,
          owner_client_id=excluded.owner_client_id,owner_session_id=excluded.owner_session_id,
          expires_at=excluded.expires_at,last_activity_at=excluded.last_activity_at`)
          .run(workspaceId, generation, leaseId, digest(leaseToken), clientId, sessionId, expiry, now);
        return ok({ leaseId, leaseToken, generation, expiresAt: new Date(expiry).toISOString() });
      });
    } catch { return unavailable(); }
    finally {
      if (globalProbe?.ok === true) await globalProbe.value.releaseAfterVerifiedTermination().catch(() => undefined);
    }
  }

  public async inspect(workspaceId: string): Promise<Result<WorkspaceWriterLeaseStatus>> {
    if (!workspaceId) return invalid();
    try {
      return this.database((db) => {
        const row = this.row(db, workspaceId);
        const calls = this.calls(db, workspaceId);
        // A mutation admitted before a lease exists still holds a durable call
        // reservation. No lease row must never be misreported as idle.
        if (row === undefined) return ok({ workspaceId, generation: 0,
          state: calls.length > 0 ? 'blocked' as const : 'unleased' as const,
          activeCalls: calls.length });
        const state = row.lease_id === null
          ? calls.length > 0 ? 'blocked' : 'unleased'
          : row.expires_at > this.now() ? 'active'
          : calls.some((entry) => processAlive(entry.pid) !== 'dead') ? 'blocked' : 'expired';
        return ok({ workspaceId, state, generation: row.generation,
          activeCalls: calls.length,
          ...(row.owner_client_id === null ? {} : { ownerClientId: row.owner_client_id }),
          ...(row.lease_id === null ? {} : { expiresAt: new Date(row.expires_at).toISOString() }),
        });
      });
    } catch { return unavailable(); }
  }

  /** Atomic read + call reservation eliminates validation-versus-expiry TOCTOU. */
  public async begin(workspaceId: string, clientId: string, sessionId: string, callId: string, proof?: WorkspaceWriterLeaseProof): Promise<Result<{ required: boolean; generation: number }>> {
    if (!validIdentity(workspaceId, clientId, sessionId) || !callId) return invalid();
    try {
      return this.transaction((db) => {
        const row = this.row(db, workspaceId);
        if (row === undefined || row.lease_id === null) {
          if (proof !== undefined) return conflict('No active workspace writer lease accepts this proof');
          const generation = row?.generation ?? 0;
          db.prepare('INSERT INTO workspace_writer_calls(call_id,workspace_id,generation,pid) VALUES(?,?,?,?)')
            .run(callId, workspaceId, generation, process.pid);
          return ok({ required: false, generation });
        }
        if (row.expires_at <= this.now()) return conflict('Workspace lease expired; owner must renew or acquire a new fenced generation');
        if (proof === undefined || !matches(row, clientId, sessionId, proof)) return conflict('Workspace writer lease proof is missing, stale or belongs to another session');
        db.prepare('INSERT INTO workspace_writer_calls(call_id,workspace_id,generation,pid) VALUES(?,?,?,?)')
          .run(callId, workspaceId, row.generation, process.pid);
        db.prepare('UPDATE workspace_writer_leases SET last_activity_at=? WHERE workspace_id=? AND generation=?')
          .run(this.now(), workspaceId, row.generation);
        return ok({ required: true, generation: row.generation });
      });
    } catch { return unavailable(); }
  }

  public async heartbeat(workspaceId: string, callId: string, generation: number): Promise<void> {
    this.transaction((db) => {
      const row = this.row(db, workspaceId);
      const tracked = db.prepare('SELECT call_id FROM workspace_writer_calls WHERE call_id=? AND workspace_id=? AND generation=?').get(callId, workspaceId, generation);
      if (row === undefined || row.generation !== generation || row.lease_id === null || tracked === undefined) throw new Error('stale workspace writer fence');
      const now = this.now();
      db.prepare('UPDATE workspace_writer_leases SET expires_at=?,last_activity_at=? WHERE workspace_id=? AND generation=?')
        .run(Math.max(row.expires_at, now + 30_000), now, workspaceId, generation);
    });
  }

  public async end(workspaceId: string, callId: string, generation: number): Promise<void> {
    this.transaction((db) => {
      db.prepare('DELETE FROM workspace_writer_calls WHERE call_id=? AND workspace_id=? AND generation=?')
        .run(callId, workspaceId, generation);
      db.prepare('UPDATE workspace_writer_leases SET last_activity_at=? WHERE workspace_id=? AND generation=?')
        .run(this.now(), workspaceId, generation);
    });
  }

  public async renew(workspaceId: string, clientId: string, sessionId: string, proof: WorkspaceWriterLeaseProof, ttlSeconds: number): Promise<Result<{ expiresAt: string }>> {
    if (!validIdentity(workspaceId, clientId, sessionId) || !validTtl(ttlSeconds) || !validProof(proof)) return invalid();
    try {
      return this.transaction((db) => {
        const row = this.row(db, workspaceId);
        if (row === undefined || !matches(row, clientId, sessionId, proof)) return conflict('Stale or foreign workspace writer lease');
        const expiry = this.now() + ttlSeconds * 1000;
        db.prepare('UPDATE workspace_writer_leases SET expires_at=?,last_activity_at=? WHERE workspace_id=?')
          .run(expiry, this.now(), workspaceId);
        return ok({ expiresAt: new Date(expiry).toISOString() });
      });
    } catch { return unavailable(); }
  }

  public async release(workspaceId: string, clientId: string, sessionId: string, proof: WorkspaceWriterLeaseProof): Promise<Result<void>> {
    if (!validIdentity(workspaceId, clientId, sessionId) || !validProof(proof)) return invalid();
    const globalProbe = this.globalExclusion === undefined ? undefined
      : await this.globalExclusion.holdExclusiveProbe(workspaceId).catch(() => unavailable());
    if (globalProbe !== undefined && !globalProbe.ok) return globalProbe;
    try {
      return this.transaction((db) => {
        const row = this.row(db, workspaceId);
        if (row === undefined || !matches(row, clientId, sessionId, proof)) return conflict('Stale or foreign workspace writer lease');
        if (this.calls(db, workspaceId).length > 0) return conflict('Cannot release while a fenced mutation remains in flight');
        db.prepare(`UPDATE workspace_writer_leases SET lease_id=NULL,token_hash=NULL,
          owner_client_id=NULL,owner_session_id=NULL,expires_at=0 WHERE workspace_id=?`).run(workspaceId);
        return ok(undefined);
      });
    } catch { return unavailable(); }
    finally {
      if (globalProbe?.ok === true) await globalProbe.value.releaseAfterVerifiedTermination().catch(() => undefined);
    }
  }

  private row(db: DatabaseSync, workspaceId: string): LeaseRow | undefined {
    return db.prepare('SELECT * FROM workspace_writer_leases WHERE workspace_id=?').get(workspaceId) as unknown as LeaseRow | undefined;
  }

  private calls(db: DatabaseSync, workspaceId: string): CallRow[] {
    return db.prepare('SELECT call_id,pid,generation FROM workspace_writer_calls WHERE workspace_id=?')
      .all(workspaceId) as unknown as CallRow[];
  }

  private clearVerifiedDeadCalls(db: DatabaseSync, workspaceId: string): boolean {
    for (const call of this.calls(db, workspaceId)) {
      if (processAlive(call.pid) !== 'dead') return false;
    }
    db.prepare('DELETE FROM workspace_writer_calls WHERE workspace_id=?').run(workspaceId);
    return true;
  }

  private database<T>(action: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.filename, { timeout: 3000 });
    try { return action(db); } finally { db.close(); }
  }

  private transaction<T>(action: (db: DatabaseSync) => T): T {
    return this.database((db) => {
      db.exec('BEGIN IMMEDIATE');
      try { const value = action(db); db.exec('COMMIT'); return value; }
      catch (error) { try { db.exec('ROLLBACK'); } catch { /* preserve prior failure */ } throw error; }
    });
  }
}

function digest(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function matches(row: LeaseRow, clientId: string, sessionId: string, proof: WorkspaceWriterLeaseProof): boolean {
  if (row.lease_id !== proof.leaseId || row.owner_client_id !== clientId || row.owner_session_id !== sessionId
    || row.generation !== proof.generation || row.token_hash === null || !proof.leaseToken) return false;
  return timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(digest(proof.leaseToken)));
}
function validIdentity(...identities: string[]): boolean { return identities.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 256); }
function validTtl(value: number): boolean { return Number.isInteger(value) && value >= 30 && value <= 3600; }
/** Reject missing or malformed proofs before the fenced transaction so a wiring or contract error surfaces as INVALID_INPUT, never as a fail-closed INTERNAL_ERROR. Shape mirrors the MCP proof schema (zod 4.2.0): leaseId matches z.string().uuid() (versions 1-8 with RFC 9562 variant bits, plus Nil and Max), leaseToken string 1..256, generation a nonnegative safe integer per z.number().int().nonnegative(). */
function validProof(proof: unknown): proof is WorkspaceWriterLeaseProof {
  if (typeof proof !== 'object' || proof === null) return false;
  const candidate = proof as WorkspaceWriterLeaseProof;
  return isUuid(candidate.leaseId) && validIdentity(candidate.leaseToken)
    && Number.isSafeInteger(candidate.generation) && candidate.generation >= 0;
}
/** Mirrors the zod@4.2.0 uuid validation: version 1-8 with 8/9/a/b variant bits, or the Nil and Max UUIDs. */
function isUuid(value: unknown): boolean {
  return typeof value === 'string'
    && /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/.test(value);
}
function processAlive(pid: number): 'alive' | 'dead' | 'unknown' {
  try { process.kill(pid, 0); return 'alive'; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'; }
}
function conflict(message: string): Result<never> { return err(appError('CONFLICT', message, true)); }
function invalid(): Result<never> { return err(appError('INVALID_INPUT', 'Workspace writer lease arguments are invalid')); }
function unavailable(): Result<never> { return err(appError('INTERNAL_ERROR', 'Durable workspace writer lease state is unavailable; fail closed', true)); }
