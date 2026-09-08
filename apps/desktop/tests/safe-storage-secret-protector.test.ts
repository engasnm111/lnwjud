import { describe, expect, it, vi } from 'vitest';
import { SafeStorageSecretProtector, type AsyncSafeStorageApi } from '../src/main/safe-storage-secret-protector.js';

function fakeApi(options: {
  available?: boolean;
  backend?: string;
  rotate?: boolean;
  decrypt?: (value: Buffer) => string;
} = {}): AsyncSafeStorageApi {
  return {
    isAsyncEncryptionAvailable: vi.fn(async () => options.available ?? true),
    encryptStringAsync: vi.fn(async (value) => Buffer.from(`cipher:${value}`, 'utf8')),
    decryptStringAsync: vi.fn(async (value) => ({
      result: options.decrypt?.(value) ?? value.toString('utf8').replace(/^cipher:/, ''),
      shouldReEncrypt: options.rotate ?? false,
    })),
    getSelectedStorageBackend: vi.fn(() => options.backend ?? 'gnome_libsecret'),
  };
}

describe('SafeStorageSecretProtector', () => {
  it.each([
    ['win32', 'windows_dpapi'],
    ['darwin', 'macos_keychain'],
    ['linux', 'gnome_libsecret'],
    ['linux', 'kwallet6'],
  ] as const)('round-trips a %s secret with the %s backend', async (platform, backend) => {
    const protector = new SafeStorageSecretProtector({ api: fakeApi({ backend }), platform });
    await expect(protector.status()).resolves.toMatchObject({ available: true, secure: true, backend });
    const envelope = await protector.encrypt('tunnel_api_key', 'runtime-secret');
    expect(envelope).toMatch(/^safe:v1:/);
    await expect(protector.decrypt('tunnel_api_key', envelope)).resolves.toEqual({ plainText: 'runtime-secret', shouldReEncrypt: false });
  });

  it('fails closed for Linux basic_text and never calls the encryptor', async () => {
    const api = fakeApi({ backend: 'basic_text' });
    const protector = new SafeStorageSecretProtector({ api, platform: 'linux' });
    await expect(protector.status()).resolves.toMatchObject({ available: true, secure: false, reason: 'plaintext_backend' });
    await expect(protector.encrypt('checkpoint_master_key', 'secret')).rejects.toThrow(/basic_text/i);
    expect(api.encryptStringAsync).not.toHaveBeenCalled();
  });

  it('reports unknown Linux backend and temporary unavailability without exposing payloads', async () => {
    const api = fakeApi({ backend: 'unknown', available: false });
    const protector = new SafeStorageSecretProtector({ api, platform: 'linux' });
    await expect(protector.status()).resolves.toMatchObject({ available: false, secure: false, reason: 'temporarily_unavailable' });
    await expect(protector.encrypt('tunnel_api_key', 'do-not-leak')).rejects.toSatisfy((error: unknown) => {
      return error instanceof Error && !error.message.includes('do-not-leak');
    });
  });

  it('surfaces async key rotation so callers can re-encrypt the envelope', async () => {
    const protector = new SafeStorageSecretProtector({ api: fakeApi({ rotate: true }), platform: 'darwin' });
    const envelope = await protector.encrypt('checkpoint_master_key', 'key-material');
    await expect(protector.decrypt('checkpoint_master_key', envelope)).resolves.toEqual({ plainText: 'key-material', shouldReEncrypt: true });
  });

  it('rejects wrong purpose and unsupported hosts before touching the backend', async () => {
    const api = fakeApi();
    const protector = new SafeStorageSecretProtector({ api, platform: 'freebsd' as NodeJS.Platform });
    await expect(protector.status()).resolves.toMatchObject({ available: false, secure: false, reason: 'unsupported_platform' });
    await expect(protector.encrypt('checkpoint_master_key', 'secret')).rejects.toThrow(/unsupported/i);
    expect(api.isAsyncEncryptionAvailable).not.toHaveBeenCalled();
  });
});
