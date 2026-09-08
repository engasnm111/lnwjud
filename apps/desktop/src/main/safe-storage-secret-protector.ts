import {
  assertSecretPlaintext,
  decodeSecretEnvelope,
  encodeSecretEnvelope,
  type SecretProtector,
  type SecretProtectionStatus,
  type SecretPurpose,
} from '@lnwjud/shared';

export interface AsyncSafeStorageApi {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ readonly result: string; readonly shouldReEncrypt: boolean }>;
  getSelectedStorageBackend?(): string;
}

export interface SafeStorageSecretProtectorOptions {
  readonly api: AsyncSafeStorageApi;
  readonly platform?: NodeJS.Platform;
}

/** Electron safeStorage adapter. It deliberately refuses Linux basic_text/unknown backends. */
export class SafeStorageSecretProtector implements SecretProtector {
  private readonly platform: NodeJS.Platform;

  public constructor(private readonly options: SafeStorageSecretProtectorOptions) {
    this.platform = options.platform ?? process.platform;
  }

  public async status(): Promise<SecretProtectionStatus> {
    if (this.platform !== 'win32' && this.platform !== 'darwin' && this.platform !== 'linux') {
      return { available: false, secure: false, backend: 'unsupported', reason: 'unsupported_platform' };
    }
    const backend = this.backendName();
    if (this.platform === 'linux' && backend === 'basic_text') {
      return { available: true, secure: false, backend, reason: 'plaintext_backend' };
    }
    if (this.platform === 'linux' && backend === 'unknown') {
      return { available: false, secure: false, backend, reason: 'temporarily_unavailable' };
    }
    try {
      const available = await this.options.api.isAsyncEncryptionAvailable();
      return available
        ? { available: true, secure: true, backend }
        : { available: false, secure: false, backend, reason: 'temporarily_unavailable' };
    } catch {
      return { available: false, secure: false, backend, reason: 'temporarily_unavailable' };
    }
  }

  public async encrypt(purpose: SecretPurpose, plainText: string): Promise<string> {
    assertSecretPlaintext(plainText);
    await this.requireSecureStatus();
    let encrypted: Buffer;
    try {
      encrypted = await this.options.api.encryptStringAsync(plainText);
    } catch {
      throw new Error('Secure secret storage is temporarily unavailable');
    }
    return encodeSecretEnvelope(purpose, encrypted);
  }

  public async decrypt(purpose: SecretPurpose, envelope: string): Promise<{ readonly plainText: string; readonly shouldReEncrypt: boolean }> {
    const encrypted = decodeSecretEnvelope(purpose, envelope);
    await this.requireSecureStatus();
    let result: { readonly result: string; readonly shouldReEncrypt: boolean };
    try {
      result = await this.options.api.decryptStringAsync(encrypted);
    } catch {
      throw new Error('Secure secret storage could not decrypt the saved value');
    }
    if (typeof result.result !== 'string') throw new Error('Secure secret storage returned an invalid value');
    assertSecretPlaintext(result.result);
    return { plainText: result.result, shouldReEncrypt: result.shouldReEncrypt === true };
  }

  private async requireSecureStatus(): Promise<SecretProtectionStatus> {
    const status = await this.status();
    if (status.secure) return status;
    if (status.reason === 'plaintext_backend') throw new Error('Secure secret storage is disabled because the Linux keyring uses basic_text');
    if (status.reason === 'unsupported_platform') throw new Error('Secure secret storage is unsupported on this platform');
    throw new Error('Secure secret storage is temporarily unavailable');
  }

  private backendName(): string {
    if (this.platform === 'darwin') return 'macos_keychain';
    if (this.platform === 'win32') return 'windows_dpapi';
    try {
      const value = this.options.api.getSelectedStorageBackend?.();
      return typeof value === 'string' && value.trim().length > 0 ? value : 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
