import { realpath } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { FileActor } from '@lnwjud/application';
import { hostPathApi, isAbsoluteHostPath, isHostPathWithin, resolveHostPath } from '@lnwjud/workspace';
import type { McpApplicationServices } from './tools/tool-types.js';

/**
 * Wave 6 read-only SQLite runtime behind `db_inspect` and `db_query`.
 * Targets must be SQLite files inside a registered workspace, connections
 * open with `readOnly: true`, and queries accept exactly one SELECT/PRAGMA
 * statement with bounded rows.
 */

const SQLITE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3']);
const MAX_QUERY_ROWS = 500;

export class DatabaseRuntimeService {
  public constructor(
    private readonly services: McpApplicationServices,
    private readonly actor: FileActor,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  public async inspect(input: Record<string, unknown>): Promise<Result<unknown>> {
    const target = await this.resolveTarget(input);
    if (!target.ok) return target;
    const database = this.openReadonly(target.value);
    if (!database.ok) return database;
    try {
      const objects = database.value.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Record<string, unknown>[];
      const tables: Record<string, unknown>[] = [];
      for (const entry of objects.filter((candidate) => candidate.type === 'table')) {
        const name = String(entry.name);
        const columns = database.value.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Record<string, unknown>[];
        const rowCount = safeCount(database.value, name);
        tables.push({ name, rowCount, columns: columns.map((column) => ({ name: String(column.name), type: column.type === null ? null : String(column.type), notNull: column.notnull === 1, primaryKey: column.pk === 1 })) });
      }
      return ok({
        tool: 'db_inspect', status: 'ready', available: true,
        target: target.value,
        sqliteVersion: sqliteVersion(database.value),
        tables,
        views: objects.filter((candidate) => candidate.type === 'view').map((candidate) => String(candidate.name)),
        indexes: objects.filter((candidate) => candidate.type === 'index').map((candidate) => ({ name: String(candidate.name), table: String(candidate.tbl_name) })),
      });
    } finally {
      database.value.close();
    }
  }

  public async query(input: Record<string, unknown>): Promise<Result<unknown>> {
    const target = await this.resolveTarget(input);
    if (!target.ok) return target;
    const statement = typeof input.sql === 'string' ? input.sql.trim() : '';
    if (statement.length === 0) return err(appError('INVALID_INPUT', 'db_query requires sql'));
    if (statement.includes(';')) return err(appError('INVALID_INPUT', 'db_query accepts exactly one statement'));
    const readOnly = /^(select|pragma|with)\b/i.test(statement);
    if (!readOnly) return err(appError('PERMISSION_DENIED', 'db_query only accepts a single SELECT, PRAGMA, or WITH...SELECT statement'));
    if (/^(pragma)\b/i.test(statement) && /(=\s*\S|insert|update|delete|attach|journal_mode)/i.test(statement)) {
      return err(appError('PERMISSION_DENIED', 'PRAGMA writes are not permitted'));
    }
    const maxRows = typeof input.max_rows === 'number' ? Math.min(MAX_QUERY_ROWS, Math.max(1, Math.trunc(input.max_rows))) : MAX_QUERY_ROWS;

    const database = this.openReadonly(target.value);
    if (!database.ok) return database;
    try {
      const rows = database.value.prepare(statement).all(...bindParameters(input)) as Record<string, unknown>[];
      const bounded = rows.slice(0, maxRows);
      return ok({
        tool: 'db_query', status: 'ready', available: true,
        target: target.value,
        columns: bounded.length === 0 ? [] : Object.keys(bounded[0]!),
        rows: bounded.length,
        truncated: rows.length > bounded.length,
        result: bounded,
      });
    } catch (error) {
      return err(appError('INVALID_INPUT', `Query failed: ${error instanceof Error ? error.message : String(error)}`));
    } finally {
      database.value.close();
    }
  }

  private openReadonly(file: string): Result<DatabaseSync> {
    try {
      return ok(new DatabaseSync(file, { readOnly: true, timeout: 5_000 }));
    } catch (error) {
      return err(appError('INVALID_INPUT', `Database could not be opened read-only: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private async resolveTarget(input: Record<string, unknown>): Promise<Result<string>> {
    const workspaceId = readTrimmed(input.workspaceId);
    const requested = readTrimmed(input.target ?? input.path ?? input.database);
    if (workspaceId === undefined || requested === undefined) return err(appError('INVALID_INPUT', 'db tools require workspaceId and target'));
    const pathApi = hostPathApi(this.platform);
    if (SQLITE_EXTENSIONS.has(pathApi.extname(requested).toLowerCase()) === false) {
      return err(appError('INVALID_INPUT', `Database target must end with ${[...SQLITE_EXTENSIONS].join(', ')}`));
    }
    const root = await this.workspaceRoot(workspaceId);
    if (!root.ok) return root;
    if (!isAbsoluteHostPath(requested, this.platform) && requested.includes('\\') && this.platform !== 'win32') {
      return err(appError('INVALID_INPUT', 'Database target uses a foreign host path syntax'));
    }
    const requestedAbsolute = isAbsoluteHostPath(requested, this.platform)
      ? resolveHostPath(requested, this.platform)
      : resolveHostPath(pathApi.join(root.value, requested), this.platform);
    if (requestedAbsolute === null) return err(appError('INVALID_INPUT', 'Database target uses a foreign host path syntax'));
    if (!isHostPathWithin(root.value, requestedAbsolute, this.platform)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Database target must stay inside the registered workspace'));
    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(requestedAbsolute);
    } catch (error: unknown) {
      if (isNodeError(error, 'ENOENT')) return err(appError('FILE_NOT_FOUND', `Database target was not found: ${requestedAbsolute}`));
      return err(appError('INVALID_INPUT', 'Database target could not be canonically resolved'));
    }
    if (SQLITE_EXTENSIONS.has(pathApi.extname(canonicalTarget).toLowerCase()) === false) {
      return err(appError('INVALID_INPUT', `Database target must resolve to ${[...SQLITE_EXTENSIONS].join(', ')}`));
    }
    if (!isHostPathWithin(root.value, canonicalTarget, this.platform)) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Database target must stay inside the registered workspace'));
    return ok(canonicalTarget);
  }

  private async workspaceRoot(workspaceId: string): Promise<Result<string>> {
    const workspaceInfo = this.services.workspaceInfo;
    if (workspaceInfo === undefined) return err(appError('WORKSPACE_NOT_FOUND', 'Workspace service is not configured'));
    const info = await workspaceInfo.info(this.actor, workspaceId);
    if (!info.ok) return info;
    const rootPath = typeof (info.value as { realRootPath?: unknown }).realRootPath === 'string'
      ? (info.value as { realRootPath: string }).realRootPath
      : undefined;
    if (rootPath === undefined) return err(appError('INTERNAL_ERROR', 'Workspace root could not be resolved', true));
    const resolvedRoot = resolveHostPath(rootPath, this.platform);
    if (resolvedRoot === null) return err(appError('INVALID_INPUT', 'Workspace root uses a foreign host path syntax'));
    try {
      return ok(await realpath(resolvedRoot));
    } catch {
      return err(appError('INTERNAL_ERROR', 'Workspace root could not be canonically resolved', true));
    }
  }
}

function safeCount(database: DatabaseSync, table: string): number | null {
  try {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count?: unknown } | undefined;
    const count = row?.count;
    return typeof count === 'number' ? count : null;
  } catch {
    return null;
  }
}

function sqliteVersion(database: DatabaseSync): string {
  const row = database.prepare('SELECT sqlite_version() AS version').get() as { version?: unknown } | undefined;
  return typeof row?.version === 'string' ? row.version : 'unknown';
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function bindParameters(input: Record<string, unknown>): (null | number | bigint | string)[] {
  const parameters = input.parameters ?? input.params;
  return Array.isArray(parameters) ? parameters.map((value): null | number | bigint | string => {
    if (value === null || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
    return JSON.stringify(value);
  }) : [];
}

function readTrimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}
