import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '@lnwjud/audit';
import { SqliteAuditRepository } from './audit-repository.js';
import { SqliteDatabase } from './database.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SqliteDatabase WAL', () => {
  it('opens in WAL mode so desktop and stdio MCP can share lnwjud.sqlite', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-wal-'));
    temporaryRoots.push(root);
    const filename = path.join(root, 'lnwjud.sqlite');
    const writer = new SqliteDatabase(filename);
    const mode = writer.connection.prepare('PRAGMA journal_mode;').get() as { journal_mode?: string } | undefined;
    expect(mode?.journal_mode?.toLowerCase()).toBe('wal');

    const repository = new SqliteAuditRepository(writer);
    const event: AuditEvent = {
      id: 'event-mcp-1',
      timestamp: new Date().toISOString(),
      actorId: 'cli-mcp-stdio',
      actorName: 'lnwjud cli MCP',
      action: 'mcp_tool:read_file',
      resultCode: 'SUCCESS',
      durationMs: 3,
      metadata: { toolName: 'read_file', callId: 'c1', phase: 'completed' },
    };
    await repository.insert(event);

    const reader = new SqliteDatabase(filename);
    const listed = await new SqliteAuditRepository(reader).listByActionPrefix('mcp_tool:', 10);
    expect(listed.map((item) => item.id)).toEqual(['event-mcp-1']);
    writer.close();
    reader.close();
  });

  it('automatically creates parent directory when database path does not exist yet', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-dir-'));
    temporaryRoots.push(root);
    const filename = path.join(root, 'nested', 'deep', 'lnwjud.sqlite');
    const database = new SqliteDatabase(filename);
    expect(database.connection.prepare('SELECT 1 as val').get()).toEqual({ val: 1 });
    database.close();
  });

  it('does not resurrect a database after its owner closes it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-closed-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'lnwjud.sqlite'));
    expect(database.connection.prepare('SELECT 1 as val').get()).toEqual({ val: 1 });
    database.close();
    database.close();
    expect(() => database.connection).toThrow(/closed/i);
  });
});
