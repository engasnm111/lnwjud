import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { protectWithWindowsDpapi } from '@lnwjud/shared';
import { bootstrapDesktopSecrets } from '../src/main/desktop-secret-store.js';
import { legacyTunnelSecretPath } from '../src/main/tunnel-auth.js';
import type { SafeStorageAdapter } from '../src/main/safe-storage-secret-store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function adapter(backend = 'gnome_libsecret'): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText) => Buffer.from(`safe:${plainText}`, 'utf8'),
    decryptString: (encrypted) => encrypted.toString('utf8').replace(/^safe:/, ''),
    getSelectedStorageBackend: () => backend,
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-desktop-secret-'));
  roots.push(root);
  return root;
}

describe('desktop secret bootstrap', () => {
  it('creates and reuses one protected checkpoint master key', async () => {
    const root = await tempRoot();
    const first = await bootstrapDesktopSecrets({ dataPath: root, safeStorage: adapter(), platform: 'darwin', environment: {}, });
    const second = await bootstrapDesktopSecrets({ dataPath: root, safeStorage: adapter(), platform: 'darwin', environment: {}, });
    expect(first.checkpointEncryptionKey).toHaveLength(32);
    expect(second.checkpointEncryptionKey).toEqual(first.checkpointEncryptionKey);
    const raw = await readFile(path.join(root, 'checkpoint-master.key'), 'utf8');
    expect(raw).toMatch(/^lnwjud-secret:v3:macos-keychain:/);
  });

  it('refuses insecure Linux basic_text before a checkpoint key is created', async () => {
    const root = await tempRoot();
    await expect(bootstrapDesktopSecrets({ dataPath: root, safeStorage: adapter('basic_text'), platform: 'linux', environment: {} })).rejects.toThrow('basic_text');
    await expect(readFile(path.join(root, 'checkpoint-master.key'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.runIf(process.platform === 'win32')('backs up and migrates a legacy Windows DPAPI checkpoint key', async () => {
    const root = await tempRoot();
    const originalKey = Buffer.alloc(32, 19);
    await writeFile(path.join(root, 'checkpoint-master.key'), `dpapi:v2:${protectWithWindowsDpapi(originalKey.toString('base64'))}`, 'utf8');
    const result = await bootstrapDesktopSecrets({ dataPath: root, safeStorage: adapter(), platform: 'win32', environment: { APPDATA: root } });
    expect(result.checkpointEncryptionKey).toEqual(originalKey);
    await expect(readFile(path.join(root, 'checkpoint-master.key.legacy.bak'), 'utf8')).resolves.toMatch(/^dpapi:v2:/);
    await expect(readFile(path.join(root, 'checkpoint-master.key'), 'utf8')).resolves.toMatch(/^lnwjud-secret:v3:windows-dpapi:/);
  });

  it('migrates a legacy tunnel secret only on Windows and preserves the original backup', async () => {
    const root = await tempRoot();
    const environment = { APPDATA: root } as NodeJS.ProcessEnv;
    const checkpoint = await bootstrapDesktopSecrets({ dataPath: root, safeStorage: adapter(), platform: 'win32', environment, legacyTunnelDecrypt: async (raw) => raw === 'legacy-tunnel' ? 'sk-migrated' : '' });
    const tunnelPath = legacyTunnelSecretPath(environment, 'win32');
    await writeFile(tunnelPath, 'legacy-tunnel', { encoding: 'utf8', flag: 'w' }).catch(async () => {
      await import('node:fs/promises').then(({ mkdir }) => mkdir(path.dirname(tunnelPath), { recursive: true }));
      await writeFile(tunnelPath, 'legacy-tunnel', 'utf8');
    });
    const stored = await checkpoint.secretStore.get({ namespace: 'tunnel', name: 'legacy-api-key', version: 1 });
    expect(Buffer.from(stored ?? []).toString('utf8')).toBe('sk-migrated');
    await expect(readFile(`${tunnelPath}.legacy.bak`, 'utf8')).resolves.toBe('legacy-tunnel');
    await expect(readFile(tunnelPath, 'utf8')).resolves.toMatch(/^lnwjud-secret:v3:windows-dpapi:/);
  });
});
