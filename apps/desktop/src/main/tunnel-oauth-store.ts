import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { protectTunnelSecret, unprotectTunnelSecret } from './tunnel-secret-dpapi.js';

export interface TunnelOAuthStoredSession {
  readonly schemaVersion: 1;
  readonly providerId: string;
  readonly refreshToken: string;
  readonly accountId: string | null;
  readonly accountLabel: string | null;
  readonly organizationId: string | null;
  readonly workspaceId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TunnelOAuthSessionStoreOptions {
  readonly filePath: string;
  readonly encryptSecret?: (plainText: string) => Promise<string>;
  readonly decryptSecret?: (cipherText: string) => Promise<string>;
}

/** Stores OAuth refresh/session secrets only inside a DPAPI-encrypted blob. */
export class TunnelOAuthSessionStore {
  public constructor(private readonly options: TunnelOAuthSessionStoreOptions) {}

  public async read(): Promise<TunnelOAuthStoredSession | null> {
    let encrypted: string;
    try {
      encrypted = await readFile(this.options.filePath, 'utf8');
    } catch {
      return null;
    }
    if (encrypted.trim().length === 0) return null;
    const plain = await (this.options.decryptSecret?.(encrypted) ?? unprotectTunnelSecret(encrypted));
    const parsed: unknown = JSON.parse(plain);
    return validateStoredSession(parsed);
  }

  public async write(session: TunnelOAuthStoredSession): Promise<void> {
    const validated = validateStoredSession(session);
    await mkdir(path.dirname(this.options.filePath), { recursive: true });
    const encrypted = await (this.options.encryptSecret?.(JSON.stringify(validated)) ?? protectTunnelSecret(JSON.stringify(validated)));
    await writeFile(this.options.filePath, encrypted, 'utf8');
  }

  public async clear(): Promise<void> {
    await rm(this.options.filePath, { force: true });
  }
}

function validateStoredSession(value: unknown): TunnelOAuthStoredSession {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid OAuth session payload');
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw new Error('Unsupported OAuth session schema');
  const providerId = requiredString(record.providerId, 'providerId');
  const refreshToken = requiredString(record.refreshToken, 'refreshToken');
  return {
    schemaVersion: 1,
    providerId,
    refreshToken,
    accountId: nullableString(record.accountId, 'accountId'),
    accountLabel: nullableString(record.accountLabel, 'accountLabel'),
    organizationId: nullableString(record.organizationId, 'organizationId'),
    workspaceId: nullableString(record.workspaceId, 'workspaceId'),
    createdAt: isoDate(record.createdAt, 'createdAt'),
    updatedAt: isoDate(record.updatedAt, 'updatedAt'),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`Invalid OAuth session ${field}`);
  return value.trim();
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`Invalid OAuth session ${field}`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function isoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`Invalid OAuth session ${field}`);
  return new Date(value).toISOString();
}
