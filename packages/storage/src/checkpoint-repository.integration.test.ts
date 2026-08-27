import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Checkpoint } from '@lnwjud/workspace';
import { AesGcmCheckpointCipher } from './checkpoint-cipher.js';
import { SqliteCheckpointRepository } from './checkpoint-repository.js';
import { SqliteDatabase } from './database.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SqliteCheckpointRepository', () => {
  it('round-trips bounded checkpoint metadata and content', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteCheckpointRepository(database);
    const checkpoint = fixtureCheckpoint('before');

    await repository.insert(checkpoint);

    await expect(repository.get(checkpoint.id)).resolves.toEqual(checkpoint);
    database.close();
  });

  it('lists only one workspace newest-first without exposing another workspace', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteCheckpointRepository(database);
    const older = { ...fixtureCheckpoint('older'), id: 'checkpoint-a', createdAt: new Date(1).toISOString() };
    const newer = { ...fixtureCheckpoint('newer'), id: 'checkpoint-b', createdAt: new Date(2).toISOString() };
    const other = { ...fixtureCheckpoint('other'), id: 'checkpoint-c', workspaceId: 'workspace-2', createdAt: new Date(3).toISOString() };
    await repository.insert(older);
    await repository.insert(newer);
    await repository.insert(other);

    await expect(repository.list('workspace-1')).resolves.toEqual([newer, older]);
    await expect(repository.list('workspace-2')).resolves.toEqual([other]);
    database.close();
  });

  it('encrypts checkpoint file content at rest with AES-256-GCM', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const cipher = new AesGcmCheckpointCipher(Buffer.alloc(32, 7));
    const repository = new SqliteCheckpointRepository(database, cipher);
    const checkpoint = fixtureCheckpoint('sensitive-checkpoint-marker');

    await repository.insert(checkpoint);

    const row = database.connection.prepare('SELECT files_json FROM checkpoints WHERE id = ?').get(checkpoint.id) as { files_json?: string } | undefined;
    expect(row?.files_json).toMatch(/^lnwjud:checkpoint:v1:/);
    expect(row?.files_json).not.toContain('sensitive-checkpoint-marker');
    await expect(repository.get(checkpoint.id)).resolves.toEqual(checkpoint);
    database.close();
  });

  it('upgrades a legacy plaintext checkpoint to ciphertext when the encrypted repository starts', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const cipher = new AesGcmCheckpointCipher(Buffer.alloc(32, 9));
    const checkpoint = fixtureCheckpoint('legacy-plaintext-marker');
    const legacyPayload = JSON.stringify(checkpoint.files);
    database.connection.prepare(
      'INSERT INTO checkpoints (id, workspace_id, created_at, files_json) VALUES (?, ?, ?, ?)',
    ).run(checkpoint.id, checkpoint.workspaceId, checkpoint.createdAt, legacyPayload);
    const repository = new SqliteCheckpointRepository(database, cipher);

    await expect(repository.get(checkpoint.id)).resolves.toEqual(checkpoint);

    const row = database.connection.prepare('SELECT files_json FROM checkpoints WHERE id = ?').get(checkpoint.id) as { files_json?: string } | undefined;
    expect(row?.files_json).toMatch(/^lnwjud:checkpoint:v1:/);
    expect(row?.files_json).not.toContain('legacy-plaintext-marker');
    database.close();
  });

  it('fails closed when an encrypted checkpoint payload is tampered with', async () => {
    const root = await temporaryRoot();
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const cipher = new AesGcmCheckpointCipher(Buffer.alloc(32, 11));
    const repository = new SqliteCheckpointRepository(database, cipher);
    const checkpoint = fixtureCheckpoint('tamper-marker');
    await repository.insert(checkpoint);
    const row = database.connection.prepare('SELECT files_json FROM checkpoints WHERE id = ?').get(checkpoint.id) as { files_json: string };
    const tampered = row.files_json.slice(0, -1) + (row.files_json.endsWith('A') ? 'B' : 'A');
    database.connection.prepare('UPDATE checkpoints SET files_json = ? WHERE id = ?').run(tampered, checkpoint.id);

    await expect(repository.get(checkpoint.id)).resolves.toBeNull();
    database.close();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-checkpoint-db-'));
  temporaryRoots.push(root);
  return root;
}

function fixtureCheckpoint(content: string): Checkpoint {
  return {
    id: 'checkpoint-1',
    workspaceId: 'workspace-1',
    createdAt: new Date(0).toISOString(),
    files: [{ path: 'src/file.txt', content, contentSha256: 'hash', size: Buffer.byteLength(content) }],
  };
}
