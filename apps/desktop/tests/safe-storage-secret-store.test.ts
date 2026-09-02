import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { secretRef } from '@lnwjud/shared';
import { SafeStorageSecretStore, type SafeStorageAdapter } from '../src/main/safe-storage-secret-store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function adapter(backend = 'gnome_libsecret', available = true): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText) => Buffer.from(`enc:${plainText}`, 'utf8'),
    decryptString: (encrypted) => encrypted.toString('utf8').replace(/^enc:/, ''),
    getSelectedStorageBackend: () => backend,
  };
}

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-secret-store-'));
  roots.push(value);
  return value;
}

describe('SafeStorageSecretStore', () => {
  it('round-trips a versioned Windows envelope without plaintext persistence', async () => {
    const directory = await root();
    const ref = secretRef('tunnel', 'runtime-api-key');
    const store = new SafeStorageSecretStore({ rootPath: directory, platform: 'win32', safeStorage: adapter() });
    await store.set(ref, Buffer.from('super-secret', 'utf8'));
    const raw = await readFile(path.join(directory, 'tunnel.runtime-api-key.v1.secret'), 'utf8');
    expect(raw).toMatch(/^lnwjud-secret:v3:windows-dpapi:/);
    expect(raw).not.toContain('super-secret');
    await expect(store.get(ref)).resolves.toEqual(Buffer.from('super-secret', 'utf8'));
  });

  it('maps macOS and Linux secure backends and rejects Linux basic_text', async () => {
    const directory = await root();
    await expect(new SafeStorageSecretStore({ rootPath: directory, platform: 'darwin', safeStorage: adapter() }).status()).resolves.toMatchObject({ providerId: 'macos-keychain', security: 'secure', availability: 'available' });
    await expect(new SafeStorageSecretStore({ rootPath: directory, platform: 'linux', safeStorage: adapter('gnome_libsecret') }).status()).resolves.toMatchObject({ providerId: 'linux-secret-service', security: 'secure', availability: 'available' });
    const insecure = new SafeStorageSecretStore({ rootPath: directory, platform: 'linux', safeStorage: adapter('basic_text') });
    await expect(insecure.status()).resolves.toMatchObject({ providerId: 'linux-basic-text', security: 'insecure' });
    await expect(insecure.set(secretRef('test', 'secret'), Buffer.from('x'))).rejects.toThrow('basic_text');
  });

  it('fails closed on a provider mismatch instead of reinterpreting host-bound ciphertext', async () => {
    const directory = await root();
    const ref = secretRef('tunnel', 'session');
    const windows = new SafeStorageSecretStore({ rootPath: directory, platform: 'win32', safeStorage: adapter() });
    await windows.set(ref, Buffer.from('secret', 'utf8'));
    const mac = new SafeStorageSecretStore({ rootPath: directory, platform: 'darwin', safeStorage: adapter() });
    await expect(mac.get(ref)).rejects.toThrow('cannot be reinterpreted');
  });

  it('backs up and migrates a legacy payload only after successful legacy decryption', async () => {
    const directory = await root();
    const ref = secretRef('tunnel', 'legacy-api-key');
    const filePath = path.join(directory, 'legacy.secret');
    await writeFile(filePath, 'legacy-cipher', 'utf8');
    const store = new SafeStorageSecretStore({
      rootPath: directory,
      platform: 'win32',
      safeStorage: adapter(),
      pathForRef: () => filePath,
      legacyDecrypt: async (_ref, raw) => raw === 'legacy-cipher' ? Buffer.from('legacy-secret', 'utf8') : null,
    });
    await expect(store.get(ref)).resolves.toEqual(Buffer.from('legacy-secret', 'utf8'));
    await expect(readFile(`${filePath}.legacy.bak`, 'utf8')).resolves.toBe('legacy-cipher');
    const migrated = await readFile(filePath, 'utf8');
    expect(migrated).toMatch(/^lnwjud-secret:v3:windows-dpapi:/);
    expect(migrated).not.toContain('legacy-secret');
  });
});
