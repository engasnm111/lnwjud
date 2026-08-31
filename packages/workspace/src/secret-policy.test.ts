import { describe, expect, it } from 'vitest';
import { SecretPolicy } from './secret-policy.js';

describe('SecretPolicy', () => {
  it.each([
    '.env',
    '.env.local',
    'server.pem',
    'private.key',
    'id_ed25519',
    'id_ecdsa',
    'id_dsa',
    'id_ecdsa_sk',
    'id_ed25519_sk',
    'config\\id_rsa',
    '.ssh\\id_ed25519',
    '.aws\\credentials',
    '.gnupg\\private-keys-v1.d\\key.asc',
    'cert.p12',
    'cert.pfx',
    'vault.kdbx',
    'credentials.json',
  ])('denies %s', (relativePath) => {
      const result = new SecretPolicy().assertReadable(relativePath);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('SECRET_ACCESS_DENIED');
    });

  it('allows the example environment file', () => {
    expect(new SecretPolicy().assertReadable('.env.example')).toEqual({ ok: true, value: undefined });
  });
});
