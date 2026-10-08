import {
  decodeActivityTargetReference,
  redactActivityTargetDetail,
  type ActivityAuditEvent,
  type ActivitySessionSummary,
  type ActivityTargetDetail,
  type AuditEvent,
  type AuditEventQuery,
  type AuditEventRepository,
  type AuditEventSummaryProjection,
  type AuditCallHistoryQuery,
  type AuditCallHistoryPage,
  type AuditCallHistoryRow,
  type AuditMutationReceiptRow,
} from '@lnwjud/audit';
import type { SqliteDatabase } from './database.js';

interface AuditEventRow {
  readonly id: string;
  readonly timestamp: string;
  readonly actor_id: string;
  readonly actor_name: string;
  readonly workspace_id: string | null;
  readonly session_id: string | null;
  readonly action: string;
  readonly target_summary: string | null;
  readonly permission_decision: string | null;
  readonly result_code: string;
  readonly duration_ms: number;
  readonly metadata_json: string;
}

interface ActivityEventRow {
  readonly id: string;
  readonly timestamp: string;
  readonly workspace_id: string | null;
  readonly session_id: string | null;
  readonly action: string;
  readonly target_summary: string | null;
  readonly result_code: string;
  readonly duration_ms: number | null;
  readonly tool_name: string | null;
  readonly call_id: string | null;
  readonly phase: string | null;
  readonly error_message: string | null;
  readonly target_detail_json: string | null;
}

interface AuditSummaryRow {
  readonly id: string;
  readonly timestamp: string;
  readonly action: string;
  readonly result_code: string;
}

function makeAuditCallCursor(timestamp: string, id: string): string {
  return Buffer.from(JSON.stringify([timestamp, id])).toString('base64url');
}
function parseAuditCallCursor(cursor: string): { timestamp: string; id: string } {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) throw new Error('Invalid audit cursor');
  let values: unknown;
  try { values = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
  catch { throw new Error('Invalid audit cursor'); }
  if (!Array.isArray(values) || values.length !== 2 || typeof values[0] !== 'string' || typeof values[1] !== 'string'
      || Number.isNaN(Date.parse(values[0])) || values[1].length > 256 || values[1].length === 0) {
    throw new Error('Invalid audit cursor');
  }
  return { timestamp: values[0], id: values[1] };
}

const AUDIT_SELECT = 'SELECT id, timestamp, actor_id, actor_name, workspace_id, session_id, action, target_summary, permission_decision, result_code, duration_ms, metadata_json FROM audit_events';

export class SqliteAuditRepository implements AuditEventRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async insert(event: AuditEvent): Promise<void> {
    this.database.connection.prepare(
      `INSERT INTO audit_events
        (id, timestamp, actor_id, actor_name, workspace_id, session_id, action, target_summary, permission_decision, result_code, duration_ms, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      event.timestamp,
      event.actorId,
      event.actorName,
      event.workspaceId ?? null,
      event.sessionId ?? null,
      event.action,
      event.targetSummary ?? null,
      event.permissionDecision ?? null,
      event.resultCode,
      event.durationMs ?? null,
      JSON.stringify(event.metadata),
    );
  }

  public list(limit = 100): Promise<AuditEvent[]> {
    return this.listScoped({}, limit);
  }

  public listByActionPrefix(prefix: string, limit = 100): Promise<AuditEvent[]> {
    return this.listScoped({ actionPrefix: prefix }, limit);
  }

  public async listScoped(query: AuditEventQuery, limit = 100): Promise<AuditEvent[]> {
    const boundedLimit = Number.isInteger(limit) && limit >= 1 && limit <= 500 ? limit : 100;
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.actionPrefix !== undefined) {
      clauses.push('action LIKE ?');
      parameters.push(`${query.actionPrefix}%`);
    }
    appendNullableScopeClause(clauses, parameters, 'workspace_id', query.workspaceId);
    appendNullableScopeClause(clauses, parameters, 'session_id', query.sessionId);
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.database.connection.prepare(
      `${AUDIT_SELECT}${where} ORDER BY timestamp DESC, id DESC LIMIT ?`,
    ).all(...parameters, boundedLimit);
    return this.toEvents(rows);
  }

  /** Keyset-paged, per-call correlation. Full retained metadata is never returned. */
  public async listCallHistory(query: AuditCallHistoryQuery): Promise<AuditCallHistoryPage> {
    const limit = Number.isInteger(query.limit) && query.limit > 0 && query.limit <= 200 ? query.limit : 50;
    const clauses = ['r.rn = 1'];
    const params: Array<string | number> = [query.workspaceId];
    if (query.goalId !== undefined) { clauses.push('r.goal_id = ?'); params.push(query.goalId); }
    if (query.toolName !== undefined) { clauses.push('r.tool_name = ?'); params.push(query.toolName); }
    if (query.since !== undefined) { clauses.push('r.timestamp >= ?'); params.push(query.since); }
    if (query.until !== undefined) { clauses.push('r.timestamp <= ?'); params.push(query.until); }
    if (query.cursor !== undefined) {
      const decoded = parseAuditCallCursor(query.cursor);
      clauses.push('(r.timestamp < ? OR (r.timestamp = ? AND r.id < ?))');
      params.push(decoded.timestamp, decoded.timestamp, decoded.id);
    }
    // Keyset paging should stop after the requested calls; avoid ranking the entire audit
    // history with ROW_NUMBER on every search. Correlation uses the existing callId index.
    const rows = this.database.connection.prepare(`
      WITH r AS (
        SELECT e.id, e.timestamp, e.workspace_id, e.session_id, e.result_code, e.duration_ms,
          json_extract(e.metadata_json, '$.callId') AS call_id,
          json_extract(e.metadata_json, '$.toolName') AS tool_name,
          json_extract(e.metadata_json, '$.phase') AS phase,
          json_extract(e.metadata_json, '$.goalId') AS goal_id,
          1 AS rn
        FROM audit_events e
        WHERE e.workspace_id = ? AND e.action LIKE 'mcp_tool:%'
          AND json_extract(e.metadata_json, '$.callId') IS NOT NULL
          AND json_extract(e.metadata_json, '$.phase') IN ('started', 'completed')
          AND NOT EXISTS (
            SELECT 1 FROM audit_events newer
            WHERE newer.workspace_id = e.workspace_id AND newer.session_id IS e.session_id
              AND newer.action LIKE 'mcp_tool:%'
              AND json_extract(newer.metadata_json, '$.callId') = json_extract(e.metadata_json, '$.callId')
              AND (
                (json_extract(newer.metadata_json, '$.phase') = 'completed'
                  AND json_extract(e.metadata_json, '$.phase') = 'started')
                OR (
                  json_extract(newer.metadata_json, '$.phase') = json_extract(e.metadata_json, '$.phase')
                  AND (newer.timestamp > e.timestamp OR (newer.timestamp = e.timestamp AND newer.id > e.id))
                )
              )
          )
      )
      SELECT r.id, r.timestamp, r.workspace_id, r.session_id, r.result_code, r.duration_ms,
        r.call_id, r.tool_name, r.phase, r.goal_id,
        (SELECT MIN(s.timestamp) FROM audit_events s
          WHERE s.workspace_id = r.workspace_id
            AND s.session_id IS r.session_id
            AND json_extract(s.metadata_json, '$.callId') = r.call_id
            AND json_extract(s.metadata_json, '$.phase') = 'started'
        ) AS started_at
      FROM r WHERE ${clauses.join(' AND ')}
      ORDER BY r.timestamp DESC, r.id DESC LIMIT ?
    `).all(...params, limit + 1);
    const items: AuditCallHistoryRow[] = [];
    for (const value of rows.slice(0, limit)) {
      if (!isRecord(value) || typeof value.id !== 'string' || typeof value.timestamp !== 'string'
        || typeof value.call_id !== 'string' || typeof value.tool_name !== 'string'
        || typeof value.workspace_id !== 'string'
        || (value.phase !== 'started' && value.phase !== 'completed')) continue;
      items.push({
        eventId: value.id, callId: value.call_id, toolName: value.tool_name,
        workspaceId: value.workspace_id, goalId: typeof value.goal_id === 'string' ? value.goal_id : null,
        resultCode: value.phase === 'completed' && typeof value.result_code === 'string' ? value.result_code : null,
        durationMs: value.phase === 'completed' && typeof value.duration_ms === 'number' && Number.isFinite(value.duration_ms) && value.duration_ms >= 0 ? value.duration_ms : null,
        phase: value.phase,
        startedAt: typeof value.started_at === 'string' ? value.started_at : null,
        sampledAt: value.timestamp,
      });
    }
    const last = rows.length > limit ? items.at(-1) : undefined;
    return { items, nextCursor: last ? makeAuditCallCursor(last.sampledAt, last.eventId) : null };
  }

  public async listGoalMutationReceipts(workspaceId: string, goalId: string, limit = 200): Promise<readonly AuditMutationReceiptRow[]> {
    const count = Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 200;
    const rows = this.database.connection.prepare(`
      SELECT id, timestamp, json_extract(metadata_json, '$.mutationReceipt') AS receipt
      FROM audit_events
      WHERE workspace_id = ? AND result_code = 'SUCCESS'
        AND action LIKE 'mcp_tool:%' AND json_extract(metadata_json, '$.phase') = 'completed'
        AND json_extract(metadata_json, '$.goalId') = ?
        AND json_type(metadata_json, '$.mutationReceipt') = 'object'
      ORDER BY timestamp DESC, id DESC LIMIT ?
    `).all(workspaceId, goalId, count);
    const result: AuditMutationReceiptRow[] = [];
    for (const row of rows) {
      if (!isRecord(row) || typeof row.id !== 'string' || typeof row.timestamp !== 'string'
        || typeof row.receipt !== 'string') continue;
      let receipt: unknown;
      try { receipt = JSON.parse(row.receipt); } catch { continue; }
      if (!isRecord(receipt)
        || typeof receipt.path !== 'string' || receipt.path.length === 0 || receipt.path.length > 4096
        || typeof receipt.action !== 'string' || !['write_file','edit_file','copy_file','move_file','office_excel'].includes(receipt.action)) continue;
      result.push({
        operationId: row.id, observedAt: row.timestamp, path: receipt.path, action: receipt.action,
        ...(typeof receipt.checkpointId === 'string' && receipt.checkpointId.length <= 128 ? { checkpointId: receipt.checkpointId } : {}),
        ...(typeof receipt.afterSha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.afterSha256) ? { afterSha256: receipt.afterSha256 } : {}),
        ...(typeof receipt.sizeBytes === 'number' && Number.isSafeInteger(receipt.sizeBytes) && receipt.sizeBytes >= 0 ? { sizeBytes: receipt.sizeBytes } : {}),
        ...(receipt.verification === 'verified' ? { verification: 'verified' as const } : {}),
      });
    }
    return result;
  }

  public async listSummaries(limit = 100): Promise<AuditEventSummaryProjection[]> {
    const rows = this.database.connection.prepare(
      'SELECT id, timestamp, action, result_code FROM audit_events ORDER BY timestamp DESC, id DESC LIMIT ?',
    ).all(boundedQueryLimit(limit));
    return rows.flatMap((row) => isAuditSummaryRow(row) ? [{
      id: row.id,
      timestamp: row.timestamp,
      action: row.action,
      resultCode: row.result_code,
    }] : []);
  }

  public async listActivitySessions(actionPrefix?: string): Promise<ActivitySessionSummary[]> {
    const rows = this.database.connection.prepare(
      `SELECT session_id, workspace_id, MIN(timestamp) AS started_at, MAX(timestamp) AS last_activity_at
       FROM audit_events
       WHERE session_id IS NOT NULL${actionPrefix === undefined ? '' : ' AND action LIKE ?'}
       GROUP BY session_id, workspace_id
       ORDER BY last_activity_at DESC, session_id ASC`,
    ).all(...(actionPrefix === undefined ? [] : [`${actionPrefix}%`]));
    return rows.flatMap((row) => {
      if (!isRecord(row)
        || typeof row.session_id !== 'string'
        || (typeof row.workspace_id !== 'string' && row.workspace_id !== null)
        || typeof row.started_at !== 'string'
        || typeof row.last_activity_at !== 'string') return [];
      return [{
        sessionId: row.session_id,
        ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
        startedAt: row.started_at,
        lastActivityAt: row.last_activity_at,
      }];
    });
  }

  public async listActivityScoped(query: AuditEventQuery, limit = 100): Promise<ActivityAuditEvent[]> {
    const boundedLimit = boundedQueryLimit(limit);
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.actionPrefix !== undefined) {
      clauses.push('action LIKE ?');
      parameters.push(`${query.actionPrefix}%`);
    }
    appendNullableScopeClause(clauses, parameters, 'workspace_id', query.workspaceId);
    appendNullableScopeClause(clauses, parameters, 'session_id', query.sessionId);
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.database.connection.prepare(
      `SELECT id, timestamp, workspace_id, session_id, action, target_summary, result_code, duration_ms,
        json_extract(metadata_json, '$.toolName') AS tool_name,
        json_extract(metadata_json, '$.callId') AS call_id,
        json_extract(metadata_json, '$.phase') AS phase,
        json_extract(metadata_json, '$.errorMessage') AS error_message,
        json_extract(metadata_json, '$.targetDetail') AS target_detail_json
       FROM audit_events${where} ORDER BY timestamp DESC, id DESC LIMIT ?`,
    ).all(...parameters, boundedLimit);
    return rows.flatMap((row) => {
      const event = toActivityEvent(row);
      return event === null ? [] : [event];
    });
  }

  public async resolveActivityTargetDetail(idOrCallId: string): Promise<ActivityTargetDetail | null> {
    if (idOrCallId.length === 0 || idOrCallId.length > 512) return null;
    const completedSuffix = ':completed';
    const phase = idOrCallId.endsWith(completedSuffix) ? 'completed' : 'started';
    const lookup = phase === 'completed' ? idOrCallId.slice(0, -completedSuffix.length) : idOrCallId;
    const row = this.database.connection.prepare(
      `SELECT metadata_json FROM audit_events
       WHERE (id = ? OR json_extract(metadata_json, '$.callId') = ?)
         AND json_extract(metadata_json, '$.phase') = ?
         AND json_type(metadata_json, '$.activityTargetDetail') = 'object'
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, timestamp DESC, id DESC LIMIT 1`,
    ).get(lookup, lookup, phase, lookup);
    if (!isMetadataRow(row)) return null;
    try {
      const metadata = JSON.parse(row.metadata_json) as unknown;
      if (!isRecord(metadata)) return null;
      const detail = metadata.activityTargetDetail;
      if (!isActivityTargetDetail(detail)) return null;
      return redactActivityTargetDetail(detail);
    } catch {
      return null;
    }
  }

  /** Resolves one compact activity event without loading another row's metadata. */
  public async resolveActivityEvent(id: string, mode: 'event' | 'started-call' = 'event'): Promise<ActivityAuditEvent | null> {
    if (id.length === 0 || id.length > 512) return null;
    const identityClause = mode === 'event'
      ? 'id = ?'
      : "json_extract(metadata_json, '$.callId') = ? AND json_extract(metadata_json, '$.phase') = 'started'";
    const row = this.database.connection.prepare(
      `SELECT id, timestamp, workspace_id, session_id, action, target_summary, result_code, duration_ms,
        json_extract(metadata_json, '$.toolName') AS tool_name,
        json_extract(metadata_json, '$.callId') AS call_id,
        json_extract(metadata_json, '$.phase') AS phase,
        json_extract(metadata_json, '$.errorMessage') AS error_message,
        json_extract(metadata_json, '$.targetDetail') AS target_detail_json
       FROM audit_events WHERE ${identityClause}
       ORDER BY timestamp DESC, id DESC LIMIT 1`,
    ).get(id);
    return toActivityEvent(row);
  }

  /** Searches full retained items in SQLite and returns no detail content to the caller. */
  public async activityTargetDetailMatches(detailRef: string, query: string): Promise<boolean> {
    return (await this.activityTargetDetailsMatching([detailRef], query)).has(detailRef);
  }

  /**
   * Searches many retained detail references in bounded batches instead of issuing one
   * synchronous better-sqlite3 query per visible log row. The yield between batches is
   * intentional: desktop callers run on Electron's main process and must keep pumping the
   * Windows message loop while a large log search is in progress.
   */
  public async activityTargetDetailsMatching(detailRefs: readonly string[], query: string): Promise<ReadonlySet<string>> {
    const needle = query.trim().toLocaleLowerCase();
    if (needle.length === 0 || needle.length > 512) return new Set();
    const requested = [...new Set(detailRefs)]
      .filter((detailRef) => detailRef.length > 0 && detailRef.length <= 512)
      .map((detailRef) => {
        const completedSuffix = ':completed';
        const phase: 'completed' | 'started' = detailRef.endsWith(completedSuffix) ? 'completed' : 'started';
        return {
          detailRef,
          lookup: phase === 'completed' ? detailRef.slice(0, -completedSuffix.length) : detailRef,
          phase,
        };
      })
      .filter((entry) => entry.lookup.length > 0);
    if (requested.length === 0) return new Set();

    const requestedByPhase = new Map<'started' | 'completed', Map<string, string[]>>([
      ['started', new Map()],
      ['completed', new Map()],
    ]);
    for (const entry of requested) {
      const byLookup = requestedByPhase.get(entry.phase)!;
      const refs = byLookup.get(entry.lookup) ?? [];
      refs.push(entry.detailRef);
      byLookup.set(entry.lookup, refs);
    }

    const matched = new Set<string>();
    const batchSize = 500;
    const statement = this.database.connection.prepare(
      `WITH requested AS (SELECT value AS lookup FROM json_each(?))
       SELECT
         audit_events.id AS event_id,
         json_extract(audit_events.metadata_json, '$.callId') AS call_id
       FROM audit_events
       WHERE json_extract(audit_events.metadata_json, '$.phase') = ?
         AND (
           audit_events.id IN (SELECT lookup FROM requested)
           OR json_extract(audit_events.metadata_json, '$.callId') IN (SELECT lookup FROM requested)
         )
         AND EXISTS (
           SELECT 1
           FROM json_each(audit_events.metadata_json, '$.activityTargetDetail.items') AS item
           WHERE typeof(item.value) = 'text'
             AND instr(lower(item.value), ?) > 0
         )`,
    );
    const totalBatches = [...requestedByPhase.values()]
      .reduce((count, byLookup) => count + Math.ceil(byLookup.size / batchSize), 0);
    let completedBatches = 0;
    for (const [phase, byLookup] of requestedByPhase) {
      const lookups = [...byLookup.keys()];
      for (let offset = 0; offset < lookups.length; offset += batchSize) {
        const batch = lookups.slice(offset, offset + batchSize);
        const rows = statement.all(JSON.stringify(batch), phase, needle);
        for (const row of rows) {
          if (!isRecord(row) || typeof row.event_id !== 'string') continue;
          const matchingLookups = typeof row.call_id === 'string' && row.call_id !== row.event_id
            ? [row.event_id, row.call_id]
            : [row.event_id];
          for (const lookup of matchingLookups) {
            for (const detailRef of byLookup.get(lookup) ?? []) matched.add(detailRef);
          }
        }
        completedBatches += 1;
        if (completedBatches < totalBatches) await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return matched;
  }

  private toEvents(rows: unknown[]): AuditEvent[] {
    return rows.flatMap((row) => {
      const event = this.toEvent(row);
      return event === null ? [] : [event];
    });
  }

  private toEvent(value: unknown): AuditEvent | null {
    if (!this.isAuditEventRow(value)) return null;
    let metadata: unknown;
    try {
      metadata = JSON.parse(value.metadata_json) as unknown;
    } catch {
      return null;
    }
    if (!isRecord(metadata)) return null;
    return {
      id: value.id,
      timestamp: value.timestamp,
      actorId: value.actor_id,
      actorName: value.actor_name,
      ...(value.workspace_id === null ? {} : { workspaceId: value.workspace_id }),
      ...(value.session_id === null ? {} : { sessionId: value.session_id }),
      action: value.action,
      ...(value.target_summary === null ? {} : { targetSummary: value.target_summary }),
      ...(value.permission_decision === null ? {} : { permissionDecision: value.permission_decision }),
      resultCode: value.result_code,
      durationMs: typeof value.duration_ms === 'number' ? value.duration_ms : 0,
      metadata,
    };
  }

  private isAuditEventRow(value: unknown): value is AuditEventRow {
    if (typeof value !== 'object' || value === null) return false;
    if (!('id' in value) || !('timestamp' in value) || !('actor_id' in value) || !('actor_name' in value)
      || !('workspace_id' in value) || !('session_id' in value) || !('action' in value) || !('target_summary' in value)
      || !('permission_decision' in value) || !('result_code' in value) || !('duration_ms' in value) || !('metadata_json' in value)) return false;
    return typeof value.id === 'string'
      && typeof value.timestamp === 'string'
      && typeof value.actor_id === 'string'
      && typeof value.actor_name === 'string'
      && (typeof value.workspace_id === 'string' || value.workspace_id === null)
      && (typeof value.session_id === 'string' || value.session_id === null)
      && typeof value.action === 'string'
      && (typeof value.target_summary === 'string' || value.target_summary === null)
      && (typeof value.permission_decision === 'string' || value.permission_decision === null)
      && typeof value.result_code === 'string'
      && (typeof value.duration_ms === 'number' || value.duration_ms === null)
      && typeof value.metadata_json === 'string';
  }
}

function boundedQueryLimit(limit: number): number {
  return Number.isInteger(limit) && limit >= 1 && limit <= 500 ? limit : 100;
}

function toActivityEvent(value: unknown): ActivityAuditEvent | null {
  if (!isActivityEventRow(value)) return null;
  const toolName = value.tool_name ?? value.action.replace(/^mcp_tool:/, '');
  const phase = value.phase === 'started' ? 'started' : 'completed';
  let targetDetailValue: unknown;
  if (value.target_detail_json !== null) {
    try { targetDetailValue = JSON.parse(value.target_detail_json) as unknown; } catch { targetDetailValue = undefined; }
  }
  return {
    id: value.id,
    timestamp: value.timestamp,
    ...(value.workspace_id === null ? {} : { workspaceId: value.workspace_id }),
    ...(value.session_id === null ? {} : { sessionId: value.session_id }),
    action: value.action,
    ...(value.target_summary === null ? {} : { targetSummary: value.target_summary }),
    resultCode: value.result_code,
    durationMs: value.duration_ms ?? 0,
    toolName,
    ...(value.call_id === null ? {} : { callId: value.call_id }),
    phase,
    ...(value.error_message === null ? {} : { errorMessage: value.error_message }),
    targetDetail: decodeActivityTargetReference(targetDetailValue, value.target_summary ?? undefined),
  };
}

function isActivityEventRow(value: unknown): value is ActivityEventRow {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.timestamp === 'string'
    && (typeof value.workspace_id === 'string' || value.workspace_id === null)
    && (typeof value.session_id === 'string' || value.session_id === null)
    && typeof value.action === 'string'
    && (typeof value.target_summary === 'string' || value.target_summary === null)
    && typeof value.result_code === 'string'
    && (typeof value.duration_ms === 'number' || value.duration_ms === null)
    && (typeof value.tool_name === 'string' || value.tool_name === null)
    && (typeof value.call_id === 'string' || value.call_id === null)
    && (typeof value.phase === 'string' || value.phase === null)
    && (typeof value.error_message === 'string' || value.error_message === null)
    && (typeof value.target_detail_json === 'string' || value.target_detail_json === null);
}

function isAuditSummaryRow(value: unknown): value is AuditSummaryRow {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.timestamp === 'string'
    && typeof value.action === 'string'
    && typeof value.result_code === 'string';
}

function isMetadataRow(value: unknown): value is { readonly metadata_json: string } {
  return isRecord(value) && typeof value.metadata_json === 'string';
}

function isActivityTargetDetail(value: unknown): value is ActivityTargetDetail {
  return isRecord(value)
    && (value.kind === 'files' || value.kind === 'tools' || value.kind === 'details')
    && Array.isArray(value.items)
    && value.items.every((item) => typeof item === 'string');
}

function appendNullableScopeClause(
  clauses: string[],
  parameters: Array<string | number>,
  column: 'workspace_id' | 'session_id',
  value: string | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) {
    clauses.push(`${column} IS NULL`);
    return;
  }
  clauses.push(`${column} = ?`);
  parameters.push(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
