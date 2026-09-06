import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptV3WindowsSafeStorageSecretIfPresent, loadV3CheckpointKeyIfPresent } from '../src/main/checkpoint-key-compat.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-v3-key-'));
  roots.push(root);
  return root;
}

describe('generic Windows v3 safeStorage compatibility', () => {
  it('decrypts migrated tunnel secret bytes before legacy PowerShell DPAPI sees them', () => {
    const plain = Buffer.from('runtime-key-fixture', 'utf8');
    const encrypted = Buffer.from('safe-storage-ciphertext');
    const envelope = `lnwjud-secret:v3:windows-dpapi:${encrypted.toString('base64')}`;
    const decryptString = vi.fn(() => plain.toString('base64'));

    expect(decryptV3WindowsSafeStorageSecretIfPresent(envelope, { decryptString })).toEqual(plain);
    expect(decryptString).toHaveBeenCalledExactlyOnceWith(encrypted);
  });

  it('delegates non-v3 tunnel secrets to the legacy DPAPI reader', () => {
    expect(decryptV3WindowsSafeStorageSecretIfPresent('01000000legacy-dpapi', { decryptString: vi.fn() }))
      .toBeUndefined();
  });
});

describe('checkpoint key v3 compatibility', () => {
  it('decrypts the Windows safeStorage v3 envelope without rewriting it', async () => {
    const root = await tempRoot();
    const key = Buffer.alloc(32, 7);
    const encrypted = Buffer.from('safe-storage-ciphertext');
    const envelope = `lnwjud-secret:v3:windows-dpapi:${encrypted.toString('base64')}`;
    const filePath = path.join(root, 'checkpoint-master.key');
    await writeFile(filePath, envelope, 'utf8');
    const decryptString = vi.fn(() => key.toString('base64'));
    const loaded = loadV3CheckpointKeyIfPresent(root, { decryptString });

    expect(loaded).toEqual(key);
    expect(decryptString).toHaveBeenCalledExactlyOnceWith(encrypted);
    await expect(import('node:fs/promises').then(({ readFile }) => readFile(filePath, 'utf8')))
      .resolves.toBe(envelope);
  });

  it('leaves legacy dpapi files to the existing loader', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'checkpoint-master.key'), 'dpapi:v2:legacy-value', 'utf8');
    const decryptString = vi.fn(() => 'unused');

    expect(loadV3CheckpointKeyIfPresent(root, { decryptString })).toBeUndefined();
    expect(decryptString).not.toHaveBeenCalled();
  });

  it('rejects a v3 envelope from a different secure-storage provider', async () => {
    const root = await tempRoot();
    await writeFile(
      path.join(root, 'checkpoint-master.key'),
      `lnwjud-secret:v3:macos-keychain:${Buffer.from('cipher').toString('base64')}`,
      'utf8',
    );
    expect(() => loadV3CheckpointKeyIfPresent(root, { decryptString: vi.fn() }))
      .toThrow(/provider macos-keychain cannot be opened/);
  });

  it('returns undefined when no checkpoint key exists yet', async () => {
    const root = await tempRoot();
    expect(loadV3CheckpointKeyIfPresent(root, { decryptString: vi.fn() })).toBeUndefined();
  });
});
