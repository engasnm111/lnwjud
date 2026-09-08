import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { SecretProtector } from '@lnwjud/shared';
import { readRegularSecret, writeSecretAtomically } from './secret-file.js';

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
  readonly secretProtector?: SecretProtector;
  readonly encryptSecret?: (plainText: string) => Promise<string>;
  readonly decryptSecret?: (cipherText: string) => Promise<string>;
}

/** Stores OAuth refresh/session secrets only inside the injected secure envelope. */
export class TunnelOAuthSessionStore {
  public constructor(private readonly options: TunnelOAuthSessionStoreOptions) {}

  public async read(): Promise<TunnelOAuthStoredSession | null> {
    let encrypted: string;
    try {
      encrypted = await readRegularSecret(this.options.filePath);
    } catch {
      return null;
    }
    if (encrypted.trim().length === 0) return null;
    const plain = this.options.secretProtector === undefined
      ? await (this.options.decryptSecret?.(encrypted) ?? Promise.reject(new Error('Secure secret provider was not injected before reading the OAuth session')))
      : (await this.options.secretProtector.decrypt('tunnel_api_key', encrypted)).plainText;
    const parsed: unknown = JSON.parse(plain);
    return validateStoredSession(parsed);
  }

  public async write(session: TunnelOAuthStoredSession): Promise<void> {
    const validated = validateStoredSession(session);
    await mkdir(path.dirname(this.options.filePath), { recursive: true });
    const serialized = JSON.stringify(validated);
    const encrypted = this.options.secretProtector === undefined
      ? await (this.options.encryptSecret?.(serialized) ?? Promise.reject(new Error('Secure secret provider was not injected before saving the OAuth session')))
      : await this.options.secretProtector.encrypt('tunnel_api_key', serialized);
    await writeSecretAtomically(this.options.filePath, encrypted);
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
