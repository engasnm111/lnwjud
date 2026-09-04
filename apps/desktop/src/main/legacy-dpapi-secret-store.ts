import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type SecretRef, type SecretStore, type SecretStoreStatus } from '@lnwjud/shared';
import { protectTunnelSecret, unprotectTunnelSecret } from './tunnel-secret-dpapi.js';

export interface LegacyDpapiSecretStoreOptions {
  readonly pathForRef: (ref: SecretRef) => string;
  readonly platform?: NodeJS.Platform;
  readonly encryptSecret?: (plainText: string) => Promise<string>;
  readonly decryptSecret?: (cipherText: string) => Promise<string>;
}

/** Windows-only compatibility store used while legacy ciphertext is being migrated to v3 safeStorage envelopes. */
export class LegacyDpapiSecretStore implements SecretStore {
  public readonly providerId = 'windows-dpapi';
  private readonly platform: NodeJS.Platform;

  public constructor(private readonly options: LegacyDpapiSecretStoreOptions) {
    this.platform = options.platform ?? process.platform;
  }

  public async status(): Promise<SecretStoreStatus> {
    return this.platform === 'win32' || this.options.encryptSecret !== undefined || this.options.decryptSecret !== undefined
      ? { availability: 'available', security: 'secure', providerId: this.providerId, message: null }
      : { availability: 'unsupported', security: 'secure', providerId: this.providerId, message: 'Legacy Windows DPAPI storage is unavailable on this platform' };
  }

  public async has(ref: SecretRef): Promise<boolean> {
    try {
      return (await readFile(this.options.pathForRef(ref), 'utf8')).trim().length > 0;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  public async set(ref: SecretRef, value: Uint8Array): Promise<void> {
    await this.requireAvailable();
    const plain = Buffer.from(value).toString('utf8');
    if (plain.length === 0) throw new Error('Secret value must not be empty');
    const filePath = this.options.pathForRef(ref);
    await mkdir(path.dirname(filePath), { recursive: true });
    const encrypted = await (this.options.encryptSecret?.(plain) ?? protectTunnelSecret(plain));
    await writeFile(filePath, encrypted, { encoding: 'utf8', mode: 0o600 });
  }

  public async get(ref: SecretRef): Promise<Uint8Array | null> {
    await this.requireAvailable();
    let encrypted: string;
    try {
      encrypted = await readFile(this.options.pathForRef(ref), 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    if (encrypted.trim().length === 0) return null;
    const plain = await (this.options.decryptSecret?.(encrypted) ?? unprotectTunnelSecret(encrypted));
    return Buffer.from(plain, 'utf8');
  }

  public async delete(ref: SecretRef): Promise<void> {
    await rm(this.options.pathForRef(ref), { force: true });
  }

  private async requireAvailable(): Promise<void> {
    const status = await this.status();
    if (status.availability !== 'available' || status.security !== 'secure') {
      throw new Error(status.message ?? 'Legacy Windows DPAPI storage is unavailable');
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { readonly code?: unknown }).code === 'ENOENT';
}
