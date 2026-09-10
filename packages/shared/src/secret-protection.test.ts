import { describe, expect, it } from 'vitest';
import {
  MAX_SECRET_ENVELOPE_BYTES,
  SecretEnvelopeError,
  assertSecretPlaintext,
  createExplicitKeySecretProtector,
  decodeSecretEnvelope,
  encodeSecretEnvelope,
} from './secret-protection.js';

describe('secret protection contract', () => {
  it('creates a bounded purpose-bound safe:v1 envelope', () => {
    const envelope = encodeSecretEnvelope('checkpoint_master_key', Buffer.from('ciphertext', 'utf8'));
    expect(envelope).toMatch(/^safe:v1:[A-Za-z0-9+/]+=*$/);
    expect(decodeSecretEnvelope('checkpoint_master_key', envelope).toString('utf8')).toBe('ciphertext');
    expect(() => decodeSecretEnvelope('tunnel_api_key', envelope)).toThrow(/purpose/i);
    expect(Buffer.byteLength(envelope, 'utf8')).toBeLessThanOrEqual(MAX_SECRET_ENVELOPE_BYTES);
  });

  it('classifies unsupported versions separately from malformed current envelopes', () => {
    expect(() => decodeSecretEnvelope('checkpoint_master_key', 'dpapi:v2:legacy')).toThrowError(
      expect.objectContaining({ name: 'SecretEnvelopeError', code: 'UNSUPPORTED_ENVELOPE_VERSION' }),
    );
    expect(() => decodeSecretEnvelope('checkpoint_master_key', 'safe:v1:not-base64')).toThrowError(
      expect.objectContaining({ name: 'SecretEnvelopeError', code: 'INVALID_ENVELOPE' }),
    );
    expect(SecretEnvelopeError).toBeDefined();
  });

  it('rejects malformed, non-canonical, empty, and oversized envelopes', () => {
    expect(() => decodeSecretEnvelope('checkpoint_master_key', 'safe:v1:not-base64')).toThrow(/invalid/i);
    expect(() => decodeSecretEnvelope('checkpoint_master_key', 'safe:v1:eyJ2IjoxLCJwdXJwb3NlIjoiY2hlY2twb2ludF9tYXN0ZXJfa2V5IiwicGF5bG9hZCI6IiJ9')).toThrow(/invalid/i);
    expect(() => encodeSecretEnvelope('checkpoint_master_key', Buffer.alloc(MAX_SECRET_ENVELOPE_BYTES))).toThrow(/large|size/i);
    expect(() => assertSecretPlaintext('')).toThrow(/empty/i);
    expect(() => assertSecretPlaintext('x'.repeat(16 * 1024 + 1))).toThrow(/large/i);
  });

  it('binds explicit development encryption to the requested purpose', async () => {
    const protector = createExplicitKeySecretProtector(Buffer.alloc(32, 7));
    const envelope = await protector.encrypt('tunnel_api_key', 'runtime-secret');
    await expect(protector.decrypt('tunnel_api_key', envelope)).resolves.toEqual({ plainText: 'runtime-secret', shouldReEncrypt: false });
    await expect(protector.decrypt('checkpoint_master_key', envelope)).rejects.toThrow(/purpose/i);
    await expect(protector.encrypt('tunnel_api_key', '')).rejects.toThrow(/empty/i);
  });

  it('never includes plaintext in the explicit protector error surface', async () => {
    const protector = createExplicitKeySecretProtector(Buffer.alloc(32, 11));
    const envelope = await protector.encrypt('checkpoint_master_key', 'do-not-leak');
    const corrupted = envelope.slice(0, -2) + 'aa';
    await expect(protector.decrypt('checkpoint_master_key', corrupted)).rejects.toSatisfy((error: unknown) => {
      return error instanceof Error && !error.message.includes('do-not-leak');
    });
  });
});
