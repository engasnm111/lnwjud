import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LegacyApiKeyCredentialProvider } from '../src/main/tunnel-auth.js';

const roots: string[] = [];

afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ readonly root: string; readonly secretPath: string; readonly provider: LegacyApiKeyCredentialProvider }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-auth-'));
  roots.push(root);
  const secretPath = path.join(root, 'tunnel-client', 'lnwjud.runtime.secret');
  const provider = new LegacyApiKeyCredentialProvider({
    secretPath: (): string => secretPath,
    encryptSecret: async (plainText: string): Promise<string> => `dpapi-fixture:${plainText}`,
    decryptSecret: async (cipherText: string): Promise<string> => cipherText.replace(/^dpapi-fixture:/, ''),
  });
  return { root, secretPath, provider };
}

describe('LegacyApiKeyCredentialProvider', () => {
  it('reports auth-neutral missing state without exposing a secret', async () => {
    const { provider } = await fixture();
    await expect(provider.status()).resolves.toEqual({
      mode: 'legacy_api_key',
      authReady: false,
      runtimeCredentialAvailable: false,
      hasLegacyApiKey: false,
      accountLabel: null,
      organizationId: null,
      workspaceId: null,
      expiresAt: null,
      requiresUserAction: true,
      message: 'Save a Runtime API key first',
    });
    await expect(provider.getRuntimeCredential()).resolves.toBeNull();
  });

  it('preserves the legacy secret file contract while exposing a runtime credential only to main process code', async () => {
    const { secretPath, provider } = await fixture();
    await provider.saveLegacyApiKey('  sk-fixture-secret  ');

    await expect(readFile(secretPath, 'utf8')).resolves.toBe('dpapi-fixture:sk-fixture-secret');
    await expect(provider.status()).resolves.toMatchObject({
      mode: 'legacy_api_key',
      authReady: true,
      runtimeCredentialAvailable: true,
      hasLegacyApiKey: true,
      requiresUserAction: false,
      message: null,
    });
    await expect(provider.getRuntimeCredential()).resolves.toEqual({
      value: 'sk-fixture-secret',
      authMode: 'legacy_api_key',
      expiresAt: null,
    });
  });

  it('treats an empty stored secret as unavailable and rejects blank writes', async () => {
    const { secretPath, provider } = await fixture();
    await expect(provider.saveLegacyApiKey('   ')).rejects.toThrow('Runtime API key is required');
    await writeFile(secretPath, '   ', { encoding: 'utf8', flag: 'w' }).catch(async () => {
      await provider.saveLegacyApiKey('fixture');
      await writeFile(secretPath, '   ', 'utf8');
    });
    await expect(provider.status()).resolves.toMatchObject({ authReady: false, runtimeCredentialAvailable: false });
    await expect(provider.getRuntimeCredential()).resolves.toBeNull();
  });
});
