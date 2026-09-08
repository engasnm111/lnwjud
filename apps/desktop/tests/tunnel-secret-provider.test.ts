import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExplicitKeySecretProtector } from '@lnwjud/shared';
import { TunnelController } from '../src/main/tunnel-controller.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('TunnelController protected secret provider', () => {
  it('persists a purpose-bound safe envelope and never writes the API key plaintext', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-secret-provider-'));
    temporaryRoots.push(root);
    vi.stubEnv('APPDATA', path.join(root, 'appdata'));
    const protector = createExplicitKeySecretProtector(Buffer.alloc(32, 0x42));
    const controller = new TunnelController({
      getClientPath: (): null => null,
      setClientPath: (): void => undefined,
      getDataPath: (): string => root,
      isExternalTunnelRunning: async (): Promise<boolean> => false,
      secretProtector: protector,
    });
    const plaintext = 'lnwjud-provider-secret';

    await expect(controller.saveApiKey(plaintext)).resolves.toBeUndefined();
    const ciphertext = await readFile(controller.secretPath(), 'utf8');
    expect(ciphertext).toMatch(/^safe:v1:/);
    expect(ciphertext).not.toContain(plaintext);
    await expect(protector.decrypt('tunnel_api_key', ciphertext)).resolves.toMatchObject({ plainText: plaintext, shouldReEncrypt: false });
  });

  it('fails closed when no provider or explicit test seam is injected', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tunnel-secret-provider-missing-'));
    temporaryRoots.push(root);
    vi.stubEnv('APPDATA', path.join(root, 'appdata'));
    const controller = new TunnelController({
      getClientPath: (): null => null,
      setClientPath: (): void => undefined,
      getDataPath: (): string => root,
      isExternalTunnelRunning: async (): Promise<boolean> => false,
    });
    await expect(controller.saveApiKey('must-fail')).rejects.toThrow(/provider was not injected/i);
  });
});
