import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { loadOrCreateWindowsProtectedKey } from './windows-dpapi.js';
import { requireSecureSecretStore, secretRef, type SecretRef, type SecretStore } from './secret-store.js';

export interface CheckpointEncryptionKeyProvider {
  readonly providerId: string;
  load(dataPath: string): Buffer;
}

export class EnvironmentCheckpointEncryptionKeyProvider implements CheckpointEncryptionKeyProvider {
  public readonly providerId = 'environment-injected-key';

  public constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  public load(dataPath: string): Buffer {
    void dataPath;
    const configured = this.environment.LNWJUD_CHECKPOINT_KEY_BASE64;
    if (configured === undefined || configured.trim().length === 0) {
      throw new Error('LNWJUD_CHECKPOINT_KEY_BASE64 is required for this checkpoint key provider');
    }
    const key = Buffer.from(configured.trim(), 'base64');
    if (key.byteLength !== 32) throw new Error('LNWJUD_CHECKPOINT_KEY_BASE64 must decode to 32 bytes');
    return key;
  }
}

export class WindowsDpapiCheckpointEncryptionKeyProvider implements CheckpointEncryptionKeyProvider {
  public readonly providerId = 'windows-dpapi';

  public load(dataPath: string): Buffer {
    if (process.platform !== 'win32') throw new Error('Windows DPAPI checkpoint storage is only available on Windows');
    return loadOrCreateWindowsProtectedKey(path.join(dataPath, 'checkpoint-master.key'), 32);
  }
}

export function selectCheckpointEncryptionKeyProvider(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): CheckpointEncryptionKeyProvider {
  if (environment.LNWJUD_CHECKPOINT_KEY_BASE64?.trim()) return new EnvironmentCheckpointEncryptionKeyProvider(environment);
  if (platform === 'win32') return new WindowsDpapiCheckpointEncryptionKeyProvider();
  throw new Error('Secure checkpoint key storage is unavailable; configure an explicit secure key provider or LNWJUD_CHECKPOINT_KEY_BASE64');
}

export function loadCheckpointEncryptionKey(
  dataPath: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): Buffer {
  return selectCheckpointEncryptionKeyProvider(platform, environment).load(dataPath);
}

export const DEFAULT_CHECKPOINT_SECRET_REF = secretRef('checkpoint', 'master-key', 1);

export async function loadOrCreateCheckpointEncryptionKeyFromStore(
  store: SecretStore,
  ref: SecretRef = DEFAULT_CHECKPOINT_SECRET_REF,
): Promise<Buffer> {
  await requireSecureSecretStore(store);
  const existing = await store.get(ref);
  if (existing !== null) {
    const key = Buffer.from(existing);
    if (key.byteLength !== 32) throw new Error('Stored checkpoint encryption key has an invalid length');
    return key;
  }

  const generated = randomBytes(32);
  await store.set(ref, generated);
  const verified = await store.get(ref);
  if (verified === null || !Buffer.from(verified).equals(generated)) {
    throw new Error('Checkpoint encryption key could not be verified after secure storage write');
  }
  return generated;
}
