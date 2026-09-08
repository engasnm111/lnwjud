import { readFile, rm, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExplicitKeySecretProtector, type SecretProtector } from '@lnwjud/shared';
import { CheckpointKeyStore } from './checkpoint-key-store.js';

describe('CheckpointKeyStore', () => {
  it('creates a protected 32-byte key and reuses it after restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-checkpoint-key-'));
    try {
      const protector = createExplicitKeySecretProtector(Buffer.alloc(32, 3));
      const filePath = path.join(root, 'checkpoint-master.key');
      const first = await new CheckpointKeyStore({ filePath, secretProtector: protector }).loadOrCreate();
      const second = await new CheckpointKeyStore({ filePath, secretProtector: protector }).loadOrCreate();
      expect(first.byteLength).toBe(32);
      expect(second).toEqual(first);
      expect(await readFile(filePath, 'utf8')).toMatch(/^safe:v1:/);
      expect((await readFile(filePath, 'utf8'))).not.toContain(first.toString('base64'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the protected key cannot be decrypted instead of generating a replacement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-checkpoint-key-fail-'));
    try {
      const filePath = path.join(root, 'checkpoint-master.key');
      const firstProtector = createExplicitKeySecretProtector(Buffer.alloc(32, 4));
      await new CheckpointKeyStore({ filePath, secretProtector: firstProtector }).loadOrCreate();
      const secondProtector = createExplicitKeySecretProtector(Buffer.alloc(32, 5));
      await expect(new CheckpointKeyStore({ filePath, secretProtector: secondProtector }).loadOrCreate()).rejects.toThrow(/decrypt|envelope/i);
      expect(await readFile(filePath, 'utf8')).toMatch(/^safe:v1:/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns the winner when two initializers race to create the file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-checkpoint-key-race-'));
    try {
      const filePath = path.join(root, 'checkpoint-master.key');
      const protector = createExplicitKeySecretProtector(Buffer.alloc(32, 6));
      const stores = [1, 2].map(() => new CheckpointKeyStore({ filePath, secretProtector: protector }));
      const keys = await Promise.all(stores.map((store) => store.loadOrCreate()));
      expect(keys[0]).toEqual(keys[1]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('re-encrypts a rotated envelope without changing the key', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-checkpoint-key-rotate-'));
    try {
      const filePath = path.join(root, 'checkpoint-master.key');
      let reencrypt = false;
      const backing = createExplicitKeySecretProtector(Buffer.alloc(32, 8));
      const rotating: SecretProtector = {
        status: backing.status,
        encrypt: backing.encrypt,
        decrypt: async (purpose, envelope) => {
          const result = await backing.decrypt(purpose, envelope);
          return { ...result, shouldReEncrypt: reencrypt };
        },
      };
      const first = await new CheckpointKeyStore({ filePath, secretProtector: backing }).loadOrCreate();
      const previous = await readFile(filePath, 'utf8');
      reencrypt = true;
      const second = await new CheckpointKeyStore({ filePath, secretProtector: rotating }).loadOrCreate();
      expect(second).toEqual(first);
      expect(await readFile(filePath, 'utf8')).not.toBe(previous);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
