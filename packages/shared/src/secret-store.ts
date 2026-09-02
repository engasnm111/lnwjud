export type SecretStoreAvailability = 'available' | 'temporarily_unavailable' | 'unsupported';
export type SecretStoreSecurity = 'secure' | 'insecure';

export interface SecretRef {
  readonly namespace: string;
  readonly name: string;
  readonly version: number;
}

export interface SecretStoreStatus {
  readonly availability: SecretStoreAvailability;
  readonly security: SecretStoreSecurity;
  readonly providerId: string;
  readonly message: string | null;
}

export interface SecretStore {
  readonly providerId: string;
  status(): Promise<SecretStoreStatus>;
  set(ref: SecretRef, value: Uint8Array): Promise<void>;
  get(ref: SecretRef): Promise<Uint8Array | null>;
  delete(ref: SecretRef): Promise<void>;
}

const ENVELOPE_PREFIX = 'lnwjud-secret:v3:';
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export interface SecretEnvelope {
  readonly providerId: string;
  readonly payload: Uint8Array;
}

export function secretRef(namespace: string, name: string, version = 1): SecretRef {
  if (!IDENTIFIER_PATTERN.test(namespace)) throw new Error('Secret namespace is invalid');
  if (!IDENTIFIER_PATTERN.test(name)) throw new Error('Secret name is invalid');
  if (!Number.isInteger(version) || version < 1 || version > 9999) throw new Error('Secret version is invalid');
  return { namespace, name, version };
}

export function secretRefKey(ref: SecretRef): string {
  const validated = secretRef(ref.namespace, ref.name, ref.version);
  return `${validated.namespace}.${validated.name}.v${validated.version}`;
}

export function encodeSecretEnvelope(providerId: string, payload: Uint8Array): string {
  if (!IDENTIFIER_PATTERN.test(providerId)) throw new Error('Secret provider ID is invalid');
  if (payload.byteLength === 0) throw new Error('Secret envelope payload must not be empty');
  return `${ENVELOPE_PREFIX}${providerId}:${Buffer.from(payload).toString('base64')}`;
}

export function decodeSecretEnvelope(value: string): SecretEnvelope {
  const trimmed = value.trim();
  if (!trimmed.startsWith(ENVELOPE_PREFIX)) throw new Error('Secret payload has an unsupported format');
  const body = trimmed.slice(ENVELOPE_PREFIX.length);
  const delimiter = body.indexOf(':');
  if (delimiter <= 0) throw new Error('Secret payload has an invalid provider envelope');
  const providerId = body.slice(0, delimiter);
  if (!IDENTIFIER_PATTERN.test(providerId)) throw new Error('Secret payload has an invalid provider ID');
  const encoded = body.slice(delimiter + 1);
  if (encoded.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Secret payload has invalid ciphertext encoding');
  const payload = Buffer.from(encoded, 'base64');
  if (payload.byteLength === 0) throw new Error('Secret payload has empty ciphertext');
  return { providerId, payload };
}

export async function requireSecureSecretStore(store: SecretStore): Promise<SecretStoreStatus> {
  const status = await store.status();
  if (status.availability !== 'available' || status.security !== 'secure') {
    throw new Error(status.message ?? `Secure secret storage is unavailable (${status.providerId})`);
  }
  return status;
}
