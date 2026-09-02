import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { decodeSecretEnvelope, encodeSecretEnvelope, requireSecureSecretStore, secretRefKey, type SecretRef, type SecretStore, type SecretStoreStatus } from '@lnwjud/shared';

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export interface SafeStorageSecretStoreOptions {
  readonly rootPath: string;
  readonly platform?: NodeJS.Platform;
  readonly safeStorage: SafeStorageAdapter;
  readonly pathForRef?: (ref: SecretRef) => string;
  readonly legacyDecrypt?: (ref: SecretRef, raw: string) => Promise<Uint8Array | null>;
}

export class SafeStorageSecretStore implements SecretStore {
  private readonly platform: NodeJS.Platform;

  public constructor(private readonly options: SafeStorageSecretStoreOptions) {
    this.platform = options.platform ?? process.platform;
  }

  public get providerId(): string {
    return this.currentStatus().providerId;
  }

  public async status(): Promise<SecretStoreStatus> {
    return this.currentStatus();
  }

  public async set(ref: SecretRef, value: Uint8Array): Promise<void> {
    if (value.byteLength === 0) throw new Error('Secret value must not be empty');
    const status = await requireSecureSecretStore(this);
    const encrypted = this.options.safeStorage.encryptString(Buffer.from(value).toString('base64'));
    const envelope = encodeSecretEnvelope(status.providerId, encrypted);
    const filePath = this.filePath(ref);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, envelope, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, filePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  public async get(ref: SecretRef): Promise<Uint8Array | null> {
    const filePath = this.filePath(ref);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    if (raw.trim().length === 0) return null;

    let envelope;
    try {
      envelope = decodeSecretEnvelope(raw);
    } catch (error) {
      if (this.options.legacyDecrypt === undefined) throw error;
      const migrated = await this.options.legacyDecrypt(ref, raw);
      if (migrated === null || migrated.byteLength === 0) throw error;
      await this.backupLegacy(filePath);
      await this.set(ref, migrated);
      return Buffer.from(migrated);
    }

    const status = await requireSecureSecretStore(this);
    if (envelope.providerId !== status.providerId) {
      throw new Error(`Secret was protected by ${envelope.providerId} and cannot be reinterpreted as ${status.providerId}; re-authentication is required`);
    }
    const plainBase64 = this.options.safeStorage.decryptString(Buffer.from(envelope.payload));
    const plain = Buffer.from(plainBase64, 'base64');
    if (plain.byteLength === 0) throw new Error('Secret provider returned an empty value');
    return plain;
  }

  public async delete(ref: SecretRef): Promise<void> {
    await rm(this.filePath(ref), { force: true });
  }

  private currentStatus(): SecretStoreStatus {
    if (!this.options.safeStorage.isEncryptionAvailable()) {
      return { availability: 'temporarily_unavailable', security: 'secure', providerId: providerIdForPlatform(this.platform, this.options.safeStorage), message: 'OS secure storage is temporarily unavailable' };
    }
    if (this.platform === 'linux') {
      const backend = this.options.safeStorage.getSelectedStorageBackend?.() ?? 'unknown';
      if (backend === 'basic_text') {
        return { availability: 'available', security: 'insecure', providerId: 'linux-basic-text', message: 'Electron basic_text storage is not accepted for persisted lnwjud secrets' };
      }
      if (backend === 'unknown') {
        return { availability: 'temporarily_unavailable', security: 'secure', providerId: 'linux-secret-service', message: 'Linux secure storage backend is not ready' };
      }
    }
    return { availability: 'available', security: 'secure', providerId: providerIdForPlatform(this.platform, this.options.safeStorage), message: null };
  }

  private filePath(ref: SecretRef): string {
    return this.options.pathForRef?.(ref) ?? path.join(this.options.rootPath, `${secretRefKey(ref)}.secret`);
  }

  private async backupLegacy(filePath: string): Promise<void> {
    try {
      await copyFile(filePath, `${filePath}.legacy.bak`, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
}

function providerIdForPlatform(platform: NodeJS.Platform, safeStorage: SafeStorageAdapter): string {
  if (platform === 'win32') return 'windows-dpapi';
  if (platform === 'darwin') return 'macos-keychain';
  if (platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend?.() ?? 'unknown';
    return backend.startsWith('kwallet') ? 'linux-kwallet' : 'linux-secret-service';
  }
  return `unsupported-${platform}`;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { readonly code?: unknown }).code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { readonly code?: unknown }).code === 'EEXIST';
}
