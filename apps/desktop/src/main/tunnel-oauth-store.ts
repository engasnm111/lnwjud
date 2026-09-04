import { secretRef, type SecretRef, type SecretStore } from '@lnwjud/shared';

export const TUNNEL_OAUTH_SESSION_REF = secretRef('tunnel', 'oauth-session', 1);

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
  readonly secretStore: SecretStore;
  readonly secretRef?: SecretRef;
}

/** Stores OAuth refresh/session secrets only inside the configured secure SecretStore. */
export class TunnelOAuthSessionStore {
  private readonly ref: SecretRef;

  public constructor(private readonly options: TunnelOAuthSessionStoreOptions) {
    this.ref = options.secretRef ?? TUNNEL_OAUTH_SESSION_REF;
  }

  public async read(): Promise<TunnelOAuthStoredSession | null> {
    const stored = await this.options.secretStore.get(this.ref);
    if (stored === null || stored.byteLength === 0) return null;
    const parsed: unknown = JSON.parse(Buffer.from(stored).toString('utf8'));
    return validateStoredSession(parsed);
  }

  public async write(session: TunnelOAuthStoredSession): Promise<void> {
    const validated = validateStoredSession(session);
    await this.options.secretStore.set(this.ref, Buffer.from(JSON.stringify(validated), 'utf8'));
  }

  public async clear(): Promise<void> {
    await this.options.secretStore.delete(this.ref);
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
