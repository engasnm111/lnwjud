import type { Checkpoint, CheckpointFile, CheckpointRepository } from '@lnwjud/workspace';
import type { SqliteDatabase } from './database.js';
import type { CheckpointPayloadCipher } from './checkpoint-cipher.js';

interface CheckpointRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly created_at: string;
  readonly files_json: string;
}

export class SqliteCheckpointRepository implements CheckpointRepository {
  public constructor(
    private readonly database: SqliteDatabase,
    private readonly cipher?: CheckpointPayloadCipher,
  ) {
    this.encryptLegacyRowsAtRest();
  }

  public async insert(checkpoint: Checkpoint): Promise<void> {
    this.database.connection.prepare(
      'INSERT INTO checkpoints (id, workspace_id, created_at, files_json) VALUES (?, ?, ?, ?)',
    ).run(checkpoint.id, checkpoint.workspaceId, checkpoint.createdAt, this.encodeFiles(checkpoint.files));
  }

  public async get(id: string): Promise<Checkpoint | null> {
    const row = this.database.connection.prepare(
      'SELECT id, workspace_id, created_at, files_json FROM checkpoints WHERE id = ?',
    ).get(id);
    return this.toCheckpoint(row);
  }

  public async list(workspaceId: string, limit = 100): Promise<Checkpoint[]> {
    const boundedLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 100;
    const rows = this.database.connection.prepare(
      'SELECT id, workspace_id, created_at, files_json FROM checkpoints WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    ).all(workspaceId, boundedLimit);
    return rows.flatMap((row) => {
      const checkpoint = this.toCheckpoint(row);
      return checkpoint === null ? [] : [checkpoint];
    });
  }

  public async deleteOlderThan(cutoffIso: string): Promise<number> {
    if (!Number.isFinite(Date.parse(cutoffIso))) throw new Error('Checkpoint retention cutoff is invalid');
    const result = this.database.connection.prepare('DELETE FROM checkpoints WHERE created_at < ?').run(cutoffIso);
    return Number(result.changes);
  }

  private toCheckpoint(value: unknown): Checkpoint | null {
    if (!this.isCheckpointRow(value)) return null;
    let files: unknown;
    try {
      const decoded = this.decodeFiles(value.files_json);
      files = JSON.parse(decoded) as unknown;
      if (this.cipher !== undefined && !this.cipher.isEncrypted(value.files_json)) {
        this.database.connection.prepare('UPDATE checkpoints SET files_json = ? WHERE id = ? AND files_json = ?').run(
          this.cipher.encrypt(decoded), value.id, value.files_json,
        );
      }
    } catch {
      return null;
    }
    if (!Array.isArray(files) || !files.every(isCheckpointFile)) return null;
    return { id: value.id, workspaceId: value.workspace_id, createdAt: value.created_at, files };
  }

  private encryptLegacyRowsAtRest(): void {
    if (this.cipher === undefined) return;
    const rows = this.database.connection.prepare('SELECT id, files_json FROM checkpoints').all();
    const update = this.database.connection.prepare('UPDATE checkpoints SET files_json = ? WHERE id = ? AND files_json = ?');
    for (const row of rows) {
      if (!isLegacyPayloadRow(row) || this.cipher.isEncrypted(row.files_json)) continue;
      update.run(this.cipher.encrypt(row.files_json), row.id, row.files_json);
    }
  }

  private encodeFiles(files: readonly CheckpointFile[]): string {
    const serialized = JSON.stringify(files);
    return this.cipher === undefined ? serialized : this.cipher.encrypt(serialized);
  }

  private decodeFiles(payload: string): string {
    if (this.cipher === undefined || !this.cipher.isEncrypted(payload)) return payload;
    return this.cipher.decrypt(payload);
  }

  private isCheckpointRow(value: unknown): value is CheckpointRow {
    if (typeof value !== 'object' || value === null || !('id' in value) || !('workspace_id' in value) || !('created_at' in value) || !('files_json' in value)) return false;
    return typeof value.id === 'string' && typeof value.workspace_id === 'string' && typeof value.created_at === 'string' && typeof value.files_json === 'string';
  }
}

function isCheckpointFile(value: unknown): value is CheckpointFile {
  if (typeof value !== 'object' || value === null || !('path' in value) || !('content' in value) || !('contentSha256' in value) || !('size' in value)) return false;
  return typeof value.path === 'string' && typeof value.content === 'string' && typeof value.contentSha256 === 'string' && typeof value.size === 'number';
}

function isLegacyPayloadRow(value: unknown): value is { readonly id: string; readonly files_json: string } {
  return typeof value === 'object' && value !== null && 'id' in value && 'files_json' in value
    && typeof value.id === 'string' && typeof value.files_json === 'string';
}
