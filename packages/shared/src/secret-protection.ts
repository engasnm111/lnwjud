import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Secret envelopes are intentionally small, versioned, and purpose-bound. The
 * payload is opaque to the shared package; Electron safeStorage and the
 * explicit development provider can use different ciphertext formats.
 */
export const SECRET_ENVELOPE_PREFIX = 'safe:v1:';
export const MAX_SECRET_PLAINTEXT_BYTES = 16 * 1024;
export const MAX_SECRET_ENVELOPE_BYTES = 64 * 1024;

export type SecretEnvelopeErrorCode =
  | 'INVALID_ENVELOPE'
  | 'UNSUPPORTED_ENVELOPE_VERSION'
  | 'PURPOSE_MISMATCH'
  | 'DECRYPT_FAILED';

export class SecretEnvelopeError extends Error {
  public constructor(
    public readonly code: SecretEnvelopeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SecretEnvelopeError';
  }
}

export type SecretPurpose = 'checkpoint_master_key' | 'tunnel_api_key';

export interface SecretProtectionStatus {
  readonly available: boolean;
  readonly secure: boolean;
  readonly backend: string;
  readonly reason?: 'temporarily_unavailable' | 'plaintext_backend' | 'unsupported_platform';
}

export interface SecretProtector {
  status(): Promise<SecretProtectionStatus>;
  encrypt(purpose: SecretPurpose, plainText: string): Promise<string>;
  decrypt(purpose: SecretPurpose, envelope: string): Promise<{ readonly plainText: string; readonly shouldReEncrypt: boolean }>;
}

interface SecretEnvelopeBody {
  readonly v: 1;
  readonly purpose: SecretPurpose;
  readonly payload: string;
}

/** Encodes provider ciphertext as a bounded, purpose-bound safe:v1 envelope. */
export function encodeSecretEnvelope(purpose: SecretPurpose, payload: Uint8Array): string {
  assertPurpose(purpose);
  if (payload.byteLength === 0 || payload.byteLength > MAX_SECRET_ENVELOPE_BYTES) {
    throw new Error('Secret envelope payload is outside the allowed size');
  }
  const body: SecretEnvelopeBody = { v: 1, purpose, payload: Buffer.from(payload).toString('base64') };
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
  const envelope = SECRET_ENVELOPE_PREFIX + encoded;
  if (Buffer.byteLength(envelope, 'utf8') > MAX_SECRET_ENVELOPE_BYTES) throw new Error('Secret envelope is too large');
  return envelope;
}

/** Decodes and validates a purpose-bound provider ciphertext envelope. */
export function decodeSecretEnvelope(purpose: SecretPurpose, envelope: string): Buffer {
  assertPurpose(purpose);
  if (typeof envelope !== 'string' || envelope.length === 0 || Buffer.byteLength(envelope, 'utf8') > MAX_SECRET_ENVELOPE_BYTES) {
    throw new SecretEnvelopeError('INVALID_ENVELOPE', 'Secret envelope is invalid');
  }
  if (!envelope.startsWith(SECRET_ENVELOPE_PREFIX)) {
    throw new SecretEnvelopeError('UNSUPPORTED_ENVELOPE_VERSION', 'Secret envelope version is unsupported');
  }
  const encoded = envelope.slice(SECRET_ENVELOPE_PREFIX.length);
  const bodyText = decodeBase64(encoded, 'Secret envelope encoding is invalid').toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    throw new SecretEnvelopeError('INVALID_ENVELOPE', 'Secret envelope payload is invalid');
  }
  if (!isSecretEnvelopeBody(parsed)) throw new SecretEnvelopeError('INVALID_ENVELOPE', 'Secret envelope payload is invalid');
  if (parsed.purpose !== purpose) throw new SecretEnvelopeError('PURPOSE_MISMATCH', 'Secret envelope purpose does not match');
  return decodeBase64(parsed.payload, 'Secret envelope payload encoding is invalid');
}

export function assertSecretPlaintext(plainText: string): void {
  if (typeof plainText !== 'string' || plainText.length === 0) throw new Error('Secret plaintext must not be empty');
  if (Buffer.byteLength(plainText, 'utf8') > MAX_SECRET_PLAINTEXT_BYTES) throw new Error('Secret plaintext is too large');
}

/**
 * Development-only protector for pure Node STDIO when the caller explicitly
 * supplies a 32-byte key. Production Desktop always uses Electron safeStorage.
 */
export function createExplicitKeySecretProtector(key: Uint8Array): SecretProtector {
  if (key.byteLength !== 32) throw new Error('Explicit secret-protection key must be 32 bytes');
  const material = Buffer.from(key);
  return {
    status: async (): Promise<SecretProtectionStatus> => ({ available: true, secure: true, backend: 'explicit_key' }),
    encrypt: async (purpose, plainText): Promise<string> => {
      assertSecretPlaintext(plainText);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', material, iv);
      cipher.setAAD(Buffer.from(purpose, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
      return encodeSecretEnvelope(purpose, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]));
    },
    decrypt: async (purpose, envelope): Promise<{ readonly plainText: string; readonly shouldReEncrypt: boolean }> => {
      const payload = decodeSecretEnvelope(purpose, envelope);
      if (payload.byteLength < 28) throw new Error('Secret envelope payload is invalid');
      const iv = payload.subarray(0, 12);
      const tag = payload.subarray(12, 28);
      const ciphertext = payload.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', material, iv);
      decipher.setAAD(Buffer.from(purpose, 'utf8'));
      decipher.setAuthTag(tag);
      let plainText: string;
      try {
        plainText = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        throw new SecretEnvelopeError('DECRYPT_FAILED', 'Secret envelope could not be decrypted');
      }
      assertSecretPlaintext(plainText);
      return { plainText, shouldReEncrypt: false };
    },
  };
}

function assertPurpose(purpose: SecretPurpose): void {
  if (purpose !== 'checkpoint_master_key' && purpose !== 'tunnel_api_key') throw new Error('Secret purpose is unsupported');
}

function decodeBase64(value: string, message: string): Buffer {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new SecretEnvelopeError('INVALID_ENVELOPE', message);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength === 0 || decoded.toString('base64') !== value) {
    throw new SecretEnvelopeError('INVALID_ENVELOPE', message);
  }
  return decoded;
}

function isSecretEnvelopeBody(value: unknown): value is SecretEnvelopeBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return body.v === 1
    && (body.purpose === 'checkpoint_master_key' || body.purpose === 'tunnel_api_key')
    && typeof body.payload === 'string';
}
