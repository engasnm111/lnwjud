import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { DatabaseRuntimeService } from './database-runtime.js';
import type { McpApplicationServices } from './tools/tool-types.js';

const actor = { clientId: 'test-client', clientName: 'test' };

function servicesWithRoot(root: string): McpApplicationServices {
  return {
    workspaceInfo: {
      info: async (_actor: unknown, workspaceId: string) => (
        workspaceId === 'ws-1'
          ? ok({ id: 'ws-1', realRootPath: root, rootPath: root })
          : { ok: false as const, error: { code: 'WORKSPACE_NOT_FOUND' as const, message: 'Workspace was not found', recoverable: false } }
      ),
    },
  } as unknown as McpApplicationServices;
}

async function withDatabase(run: (root: string, database: string) => Promise<void>): Promise<void> {
  const rawRoot = await mkdtemp(path.join(tmpdir(), 'lnwjud-db-test-'));
  const root = process.platform === 'win32' ? path.win32.normalize(rawRoot) : rawRoot;
  const database = path.join(root, 'app.db');
  const connection = new DatabaseSync(database);
  connection.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\nCREATE VIEW fancy_users AS SELECT id FROM users;\nCREATE INDEX users_name ON users(name);\nINSERT INTO users (name) VALUES (\'alice\'), (\'bob\');');
  connection.close();
  try {
    await run(root, database);
  } finally {
    // Temp directory is left for the OS to clean up.
  }
}

describe('DatabaseRuntimeService', () => {
  it('inspects tables, views, and indexes through a read-only connection', async () => {
    await withDatabase(async (root, database) => {
      const runtime = new DatabaseRuntimeService(servicesWithRoot(root), actor);
      const result = await runtime.inspect({ workspaceId: 'ws-1', target: 'app.db' });
      expect(result).toMatchObject({ ok: true, value: {
        tool: 'db_inspect', available: true,
        tables: [expect.objectContaining({ name: 'users', rowCount: 2, columns: [expect.objectContaining({ name: 'id', primaryKey: true }), expect.objectContaining({ name: 'name', notNull: true })] })],
        views: ['fancy_users'],
        indexes: [expect.objectContaining({ name: 'users_name', table: 'users' })],
      } });
      if (result.ok) expect(result.value.target).toBe(database);
    });
  }, 15_000);

  it('runs a single SELECT with bounded rows and rejects anything mutating', async () => {
    await withDatabase(async (root) => {
      const runtime = new DatabaseRuntimeService(servicesWithRoot(root), actor);
      const select = await runtime.query({ workspaceId: 'ws-1', target: 'app.db', sql: 'SELECT id, name FROM users ORDER BY id', max_rows: 1 });
      expect(select).toMatchObject({ ok: true, value: { rows: 1, truncated: true, columns: ['id', 'name'], result: [{ id: 1, name: 'alice' }] } });

      await expect(runtime.query({ workspaceId: 'ws-1', target: 'app.db', sql: 'DELETE FROM users' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      await expect(runtime.query({ workspaceId: 'ws-1', target: 'app.db', sql: 'DROP TABLE users; SELECT 1' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      await expect(runtime.query({ workspaceId: 'ws-1', target: 'app.db', sql: 'PRAGMA journal_mode = WAL' })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      await expect(runtime.query({ workspaceId: 'ws-1', target: 'app.db', sql: "SELECT name FROM users WHERE name = 'x'; --" })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
  });

  it('confines targets to registered workspace SQLite files', async () => {
    await withDatabase(async (root) => {
      const runtime = new DatabaseRuntimeService(servicesWithRoot(root), actor);
      await expect(runtime.inspect({ workspaceId: 'ws-1', target: '../outside.db' })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
      await expect(runtime.inspect({ workspaceId: 'ws-1', target: path.join(root, '..', 'notes.txt') })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      await expect(runtime.inspect({ workspaceId: 'ws-1', target: 'missing.db' })).resolves.toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
      await expect(runtime.query({ workspaceId: 'missing-ws', target: 'app.db', sql: 'SELECT 1' })).resolves.toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } });
    });
  });

  it('fails closed when the file is not a SQLite database', async () => {
    const rawRoot = await mkdtemp(path.join(tmpdir(), 'lnwjud-db-test-'));
    const root = process.platform === 'win32' ? path.win32.normalize(rawRoot) : rawRoot;
    await writeFile(path.join(root, 'fake.db'), 'this is not sqlite', 'utf8');
    const runtime = new DatabaseRuntimeService(servicesWithRoot(root), actor);
    await expect(runtime.query({ workspaceId: 'ws-1', target: 'fake.db', sql: 'SELECT 1' })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
