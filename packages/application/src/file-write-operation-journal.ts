import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Result } from '@lnwjud/domain';
import type { FileActor, WriteFileRequest, WriteFileResult } from './file-service.js';

export interface FileWriteOperationReceipt {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly actorClientId: string;
  readonly requestDigest: string;
  readonly state: 'pending' | 'settled';
  readonly createdAt: string;
  readonly finishedAt?: string;
  readonly result?: Result<WriteFileResult>;
}

const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validFileWriteOperationId(value: string): boolean {
  return operationIdPattern.test(value);
}

/**
 * An append-once admission marker, followed by an atomic terminal receipt.
 * A pending marker after a crash is deliberately NOT replayable: the write
 * might have committed before its response or terminal receipt was persisted.
 * Never infer a failed mutation from transport disconnect or process death.
 */
export class FileWriteOperationJournal {
  constructor(private readonly directory: string) {}

  private receiptPath(operationId: string): string {
    if (!validFileWriteOperationId(operationId)) throw new Error('Invalid write operation ID');
    return path.join(this.directory, `${operationId.toLowerCase()}.json`);
  }

  private digest(actor: FileActor, workspaceId: string, request: WriteFileRequest): string {
    return createHash('sha256').update(JSON.stringify({
      actorClientId: actor.clientId, workspaceId, path: request.path, content: request.content,
      overwriteExisting: request.overwriteExisting ?? null, mode: request.mode ?? null,
      userConfirmed: request.userConfirmed ?? null,
    })).digest('hex');
  }

  private async load(operationId: string): Promise<FileWriteOperationReceipt | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.receiptPath(operationId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const receipt: unknown = JSON.parse(raw);
    if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) throw new Error('Invalid write operation receipt');
    const record = receipt as Partial<FileWriteOperationReceipt>;
    if (record.operationId?.toLowerCase() !== operationId.toLowerCase()
      || typeof record.workspaceId !== 'string' || typeof record.actorClientId !== 'string'
      || !/^[0-9a-f]{64}$/.test(record.requestDigest ?? '')
      || (record.state !== 'pending' && record.state !== 'settled')
      || typeof record.createdAt !== 'string'
      || (record.state === 'settled' && (record.result === undefined || typeof record.finishedAt !== 'string'))) {
      throw new Error('Invalid write operation receipt');
    }
    return record as FileWriteOperationReceipt;
  }

  async status(operationId: string, actor: FileActor, workspaceId: string): Promise<FileWriteOperationReceipt | undefined> {
    const receipt = await this.load(operationId);
    if (receipt !== undefined && (receipt.actorClientId !== actor.clientId || receipt.workspaceId !== workspaceId)) {
      throw new Error('Write operation belongs to a different actor or workspace');
    }
    return receipt;
  }

  async begin(operationId: string, actor: FileActor, workspaceId: string, request: WriteFileRequest):
    Promise<{ readonly fresh: boolean; readonly receipt: FileWriteOperationReceipt }> {
    const receipt: FileWriteOperationReceipt = {
      operationId: operationId.toLowerCase(), workspaceId, actorClientId: actor.clientId,
      requestDigest: this.digest(actor, workspaceId, request),
      state: 'pending', createdAt: new Date().toISOString(),
    };
    await mkdir(this.directory, { recursive: true });
    try {
      await writeFile(this.receiptPath(operationId), JSON.stringify(receipt), { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
      return { fresh: true, receipt };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const existing = await this.status(operationId, actor, workspaceId);
    if (existing === undefined || existing.requestDigest !== receipt.requestDigest) {
      throw new Error('Write operation ID was reused with a different request');
    }
    return { fresh: false, receipt: existing };
  }

  async settle(receipt: FileWriteOperationReceipt, result: Result<WriteFileResult>): Promise<void> {
    const terminal: FileWriteOperationReceipt = {
      ...receipt, state: 'settled', finishedAt: new Date().toISOString(), result,
    };
    const temporary = path.join(this.directory, `${receipt.operationId}.${process.pid}.${Date.now()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(terminal), { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
      await rename(temporary, this.receiptPath(receipt.operationId));
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
