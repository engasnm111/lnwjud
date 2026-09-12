import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

  it('refuses to create an empty canonical database while another process owns a restore claim', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-restore-race-'));
    temporaryRoots.push(root);
    const filename = path.join(root, 'lnwjud.sqlite');
    const backupDirectory = path.join(root, 'backups');
    await mkdir(backupDirectory, { recursive: true });
    await writeFile(path.join(backupDirectory, 'restore-pending.json.claim-123-fixture'), '{}', 'utf8');

    expect(() => new SqliteDatabase(filename, { backupDirectory })).toThrow(/restore is in progress/i);
    expect(existsSync(filename)).toBe(false);
  });

  it('waits through the canonical restore swap instead of opening the temporary gap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-restore-lock-'));
    temporaryRoots.push(root);
    const filename = path.join(root, 'lnwjud.sqlite');
    const backupDirectory = path.join(root, 'backups');
    await mkdir(backupDirectory, { recursive: true });

    const original = new SqliteDatabase(filename);
    original.close();

    const childScript = String.raw`
      const fs = require('node:fs');
      const path = require('node:path');
      const { DatabaseSync } = require('node:sqlite');
      const filename = process.argv[1];
      const backupDirectory = process.argv[2];
      const lockPath = path.join(backupDirectory, 'sqlite-lifecycle.lock');
      const claimPath = path.join(backupDirectory, 'restore-pending.json.claim-child-fixture');
      const oldPath = filename + '.pre-restore';
      const lock = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      fs.writeFileSync(claimPath, '{}');
      fs.renameSync(filename, oldPath);
      process.stdout.write('gap\n');
      setTimeout(() => {
        const replacement = new DatabaseSync(filename);
        replacement.exec('CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);');
        replacement.prepare("INSERT INTO settings (key, value) VALUES ('sentinel', 'replacement')").run();
        replacement.close();
        fs.rmSync(oldPath, { force: true });
        fs.rmSync(claimPath, { force: true });
        fs.closeSync(lock);
        fs.rmSync(lockPath, { force: true });
      }, 200);
    `;
    const child = spawn(process.execPath, ['-e', childScript, filename, backupDirectory], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('gap')) resolve();
      });
    });

    const database = new SqliteDatabase(filename, { backupDirectory });
    expect(database.connection.prepare("SELECT value FROM settings WHERE key = 'sentinel'").get()).toEqual({ value: 'replacement' });
    database.close();
    expect(await exit).toBe(0);
    expect(stderr).toBe('');
  }, 20_000);

  it('waits for the lifecycle lock before reopening a live canonical connection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-live-restore-lock-'));
    temporaryRoots.push(root);
    const filename = path.join(root, 'lnwjud.sqlite');
    const backupDirectory = path.join(root, 'backups');
    await mkdir(backupDirectory, { recursive: true });
    let identity: string | null = 'first';
    let replacements = 0;
    const database = new SqliteDatabase(filename, {
      backupDirectory,
      fileIdentityProvider: (): string | null => identity,
      onCanonicalFileReplaced: (): void => { replacements += 1; },
    });

    const childScript = String.raw`
      const fs = require('node:fs');
      const path = require('node:path');
      const lockPath = path.join(process.argv[1], 'sqlite-lifecycle.lock');
      const lock = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      process.stdout.write('locked\\n');
      setTimeout(() => {
        fs.closeSync(lock);
        fs.rmSync(lockPath, { force: true });
      }, 200);
    `;
    const child = spawn(process.execPath, ['-e', childScript, backupDirectory], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('locked')) resolve();
      });
    });

    identity = 'second';
    const startedAt = Date.now();
    expect(database.connection.prepare('SELECT 1 as value').get()).toEqual({ value: 1 });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    expect(replacements).toBe(1);
    database.close();
    expect(await exit).toBe(0);
    expect(stderr).toBe('');
  }, 20_000);

  it('reopens the canonical database when the file identity changes under a live runtime', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-replaced-'));
    temporaryRoots.push(root);
    const filename = path.join(root, 'lnwjud.sqlite');
    let identity: string | null = 'first';
    let replacements = 0;
    const database = new SqliteDatabase(filename, {
      fileIdentityProvider: (): string | null => identity,
      onCanonicalFileReplaced: (): void => { replacements += 1; },
    });
    database.connection.prepare("INSERT INTO settings (key, value) VALUES ('sentinel', 'kept')").run();

    identity = 'second';
    const replacementConnection = database.connection;
    expect(replacementConnection.prepare("SELECT value FROM settings WHERE key = 'sentinel'").get()).toEqual({ value: 'kept' });
    expect(replacements).toBe(1);

    identity = null;
    expect(() => database.connection).toThrow(/temporarily unavailable/i);
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
