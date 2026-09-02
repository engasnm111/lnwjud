import { describe, expect, it } from 'vitest';
import { decodeSecretEnvelope, encodeSecretEnvelope, requireSecureSecretStore, secretRef, secretRefKey, type SecretStore } from './secret-store.js';

describe('SecretStore contract', () => {
  it('creates stable versioned refs and provider envelopes', () => {
    const ref = secretRef('tunnel', 'oauth-session', 2);
    expect(secretRefKey(ref)).toBe('tunnel.oauth-session.v2');
    const encoded = encodeSecretEnvelope('windows-dpapi', Buffer.from('ciphertext', 'utf8'));
    expect(encoded).toMatch(/^lnwjud-secret:v3:windows-dpapi:/);
    const decoded = decodeSecretEnvelope(encoded);
    expect(decoded.providerId).toBe('windows-dpapi');
    expect(Buffer.from(decoded.payload).toString('utf8')).toBe('ciphertext');
  });

  it('rejects malformed refs and envelopes instead of guessing a provider', () => {
    expect(() => secretRef('../outside', 'key')).toThrow('namespace');
    expect(() => decodeSecretEnvelope('dpapi:v2:legacy')).toThrow('unsupported format');
    expect(() => decodeSecretEnvelope('lnwjud-secret:v3:provider:')).toThrow('ciphertext');
  });

  it('fails closed when the selected provider is insecure or unavailable', async () => {
    const store: SecretStore = {
      providerId: 'linux-basic-text',
      status: async () => ({ availability: 'available', security: 'insecure', providerId: 'linux-basic-text', message: 'basic_text is not secure storage' }),
      set: async () => undefined,
      get: async () => null,
      delete: async () => undefined,
    };
    await expect(requireSecureSecretStore(store)).rejects.toThrow('basic_text');
  });
});
