import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { canonicalGoalEvent, GOAL_EVENT_CONTRACT, type GoalCommitEvent, type GoalRecord } from '@lnwjud/domain';
import type { SqliteDatabase } from './database.js';

export interface GoalEventSubscriber {
  readonly id: string;
  readonly workspaceId: string;
  readonly companionName: string;
  readonly epoch: number;
  readonly ackCursor: number;
  readonly enrolledKeyId: string;
}

export interface GoalEventSigningKey {
  readonly keyId: string;
  readonly publicKey: string;
  readonly encryptedPrivateKey: string;
  readonly certificateJson: string;
  readonly previousSignature: string | null;
}

export class SqliteGoalEventStore {
  public constructor(private readonly database: SqliteDatabase) {}

  public stageTransition(before: GoalRecord | null, after: GoalRecord, authorizationMode: 'standard' | 'full_bypass' | 'unknown'): void {
    if (authorizationMode !== 'standard' || before?.status === after.status) return;
    const consent = this.database.connection.prepare('SELECT 1 FROM goal_event_subscribers WHERE workspace_id = ? AND revoked_at IS NULL LIMIT 1').get(after.workspaceId);
    if (consent === undefined) return;
    const event: GoalCommitEvent = {
      contract: GOAL_EVENT_CONTRACT, eventId: randomUUID(), workspaceId: after.workspaceId, goalId: after.id,
      revision: after.revision, fromStatus: before?.status ?? null, toStatus: after.status,
      committedAt: after.updatedAt, origin: 'host-goal-repository', authorizationMode: 'standard',
    };
    this.database.connection.prepare(`INSERT INTO goal_commit_events (event_id, workspace_id, goal_id, revision, payload_json) VALUES (?, ?, ?, ?, ?)`)
      .run(event.eventId, event.workspaceId, event.goalId, event.revision, canonicalGoalEvent(event));
  }

  public enroll(workspaceId: string, companionName: string, enrolledKeyId: string, now: string, pairingNonce?: string): { readonly subscriber: GoalEventSubscriber; readonly token: string } {
    return this.transaction(() => {
      const pairingNonceHash = tokenHash(pairingNonce ?? randomBytes(32).toString('base64url'));
      const existing = this.database.connection.prepare('SELECT id, companion_name, revoked_at FROM goal_event_subscribers WHERE workspace_id = ? AND pairing_nonce_hash = ?').get(workspaceId, pairingNonceHash);
      const token = randomBytes(32).toString('base64url');
      if (existing !== undefined) {
        if (typeof existing.id !== 'string' || existing.companion_name !== companionName || existing.revoked_at !== null) throw new Error('GOAL_EVENT_REQUEST_INVALID');
        this.database.connection.prepare(`UPDATE goal_event_subscribers SET token_hash = ?, epoch = epoch + 1, enrolled_key_id = ?, authorized_at = ? WHERE id = ? AND revoked_at IS NULL`)
          .run(tokenHash(token), enrolledKeyId, now, existing.id);
        const subscriber = this.lookup(existing.id, workspaceId);
        if (subscriber === null) throw new Error('GOAL_EVENT_AUTHORIZATION_REVOKED');
        return { subscriber, token };
      }
      const active = this.database.connection.prepare('SELECT COUNT(*) AS count FROM goal_event_subscribers WHERE revoked_at IS NULL').get();
      if (typeof active?.count !== 'number' || active.count >= 32) throw new Error('GOAL_EVENT_SUBSCRIBER_LIMIT');
      const cursor = this.database.connection.prepare('SELECT COALESCE(MAX(sequence), 0) AS cursor FROM goal_commit_events').get()?.cursor;
      if (typeof cursor !== 'number') throw new Error('GOAL_EVENT_STORE_INVALID');
      const id = randomUUID();
      this.database.connection.prepare(`INSERT INTO goal_event_subscribers
        (id, workspace_id, companion_name, token_hash, pairing_nonce_hash, epoch, start_cursor, ack_cursor, delivered_cursor, enrolled_key_id, authorized_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
        .run(id, workspaceId, companionName, tokenHash(token), pairingNonceHash, cursor, cursor, cursor, enrolledKeyId, now);
      return { subscriber: { id, workspaceId, companionName, epoch: 1, ackCursor: cursor, enrolledKeyId }, token };
    });
  }

  public authenticate(token: string): GoalEventSubscriber | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.database.connection.prepare('SELECT * FROM goal_event_subscribers WHERE token_hash = ? AND revoked_at IS NULL').get(tokenHash(token));
    if (row === undefined) return null;
    if (typeof row.id !== 'string' || typeof row.workspace_id !== 'string' || typeof row.companion_name !== 'string'
      || typeof row.epoch !== 'number' || typeof row.ack_cursor !== 'number' || typeof row.enrolled_key_id !== 'string') throw new Error('GOAL_EVENT_STORE_INVALID');
    return { id: row.id, workspaceId: row.workspace_id, companionName: row.companion_name, epoch: row.epoch, ackCursor: row.ack_cursor, enrolledKeyId: row.enrolled_key_id };
  }

  public lookup(id: string, workspaceId: string): GoalEventSubscriber | null {
    const row = this.database.connection.prepare('SELECT * FROM goal_event_subscribers WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL').get(id, workspaceId);
    if (row === undefined) return null;
    if (typeof row.companion_name !== 'string' || typeof row.epoch !== 'number' || typeof row.ack_cursor !== 'number' || typeof row.enrolled_key_id !== 'string') throw new Error('GOAL_EVENT_STORE_INVALID');
    return { id, workspaceId, companionName: row.companion_name, epoch: row.epoch, ackCursor: row.ack_cursor, enrolledKeyId: row.enrolled_key_id };
  }

  public read(subscriber: GoalEventSubscriber): readonly { readonly cursor: number; readonly event: GoalCommitEvent }[] {
    return this.transaction(() => {
      this.assertCurrent(subscriber);
      const rows = this.database.connection.prepare(`SELECT sequence, payload_json FROM goal_commit_events
        WHERE workspace_id = ? AND sequence > ? ORDER BY sequence LIMIT 50`).all(subscriber.workspaceId, subscriber.ackCursor);
      const events = rows.map((row) => {
        if (typeof row.sequence !== 'number' || typeof row.payload_json !== 'string') throw new Error('GOAL_EVENT_STORE_INVALID');
        const event: unknown = JSON.parse(row.payload_json);
        if (canonicalGoalEvent(event) !== row.payload_json) throw new Error('GOAL_EVENT_STORE_INVALID');
        return { cursor: row.sequence, event: event as GoalCommitEvent };
      });
      const delivered = events.at(-1)?.cursor;
      if (delivered !== undefined) this.database.connection.prepare(`UPDATE goal_event_subscribers SET delivered_cursor = MAX(delivered_cursor, ?) WHERE id = ? AND epoch = ? AND revoked_at IS NULL`)
        .run(delivered, subscriber.id, subscriber.epoch);
      return events;
    });
  }

  public acknowledge(subscriber: GoalEventSubscriber, cursor: number, eventId: string): void {
    this.transaction(() => {
      this.assertCurrent(subscriber);
      const event = this.database.connection.prepare('SELECT event_id FROM goal_commit_events WHERE sequence = ? AND workspace_id = ?').get(cursor, subscriber.workspaceId);
      if (event?.event_id !== eventId) throw new Error('GOAL_EVENT_ACK_INVALID');
      const changed = this.database.connection.prepare(`UPDATE goal_event_subscribers SET ack_cursor = ?
        WHERE id = ? AND epoch = ? AND revoked_at IS NULL AND ack_cursor <= ? AND delivered_cursor >= ?`).run(cursor, subscriber.id, subscriber.epoch, cursor, cursor);
      if (Number(changed.changes) !== 1) throw new Error('GOAL_EVENT_ACK_INVALID');
    });
  }

  public revoke(subscriber: GoalEventSubscriber, now: string): void {
    this.assertCurrent(subscriber);
    this.database.connection.prepare('UPDATE goal_event_subscribers SET revoked_at = ?, epoch = epoch + 1 WHERE id = ? AND epoch = ?').run(now, subscriber.id, subscriber.epoch);
  }

  public rotateCredential(subscriber: GoalEventSubscriber): string {
    return this.transaction(() => {
      this.assertCurrent(subscriber);
      const token = randomBytes(32).toString('base64url');
      this.database.connection.prepare('UPDATE goal_event_subscribers SET token_hash = ?, epoch = epoch + 1 WHERE id = ? AND epoch = ?').run(tokenHash(token), subscriber.id, subscriber.epoch);
      return token;
    });
  }

  public signingKeys(): readonly GoalEventSigningKey[] {
    return this.database.connection.prepare('SELECT * FROM goal_event_signing_keys ORDER BY sequence').all().map((row) => {
      if (typeof row.key_id !== 'string' || typeof row.public_key !== 'string' || typeof row.encrypted_private_key !== 'string'
        || typeof row.certificate_json !== 'string' || row.previous_signature !== null && typeof row.previous_signature !== 'string') throw new Error('GOAL_EVENT_STORE_INVALID');
      return { keyId: row.key_id, publicKey: row.public_key, encryptedPrivateKey: row.encrypted_private_key, certificateJson: row.certificate_json, previousSignature: row.previous_signature };
    });
  }

  public appendSigningKey(key: GoalEventSigningKey, expectedPreviousKeyId: string | null): void {
    this.transaction(() => {
      const current = this.signingKeys().at(-1)?.keyId ?? null;
      if (current !== expectedPreviousKeyId || this.signingKeys().length >= 64) throw new Error('GOAL_EVENT_KEY_CHANGED');
      this.database.connection.prepare(`INSERT INTO goal_event_signing_keys (key_id, public_key, encrypted_private_key, certificate_json, previous_signature) VALUES (?, ?, ?, ?, ?)`)
        .run(key.keyId, key.publicKey, key.encryptedPrivateKey, key.certificateJson, key.previousSignature);
    });
  }

  private assertCurrent(subscriber: GoalEventSubscriber): void {
    const row = this.database.connection.prepare('SELECT epoch FROM goal_event_subscribers WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL').get(subscriber.id, subscriber.workspaceId);
    if (row?.epoch !== subscriber.epoch) throw new Error('GOAL_EVENT_AUTHORIZATION_REVOKED');
  }

  private transaction<T>(operation: () => T): T {
    const connection = this.database.connection;
    connection.exec('BEGIN IMMEDIATE');
    try { const result = operation(); connection.exec('COMMIT'); return result; }
    catch (error) { connection.exec('ROLLBACK'); throw error; }
  }
}

function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
