import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TunnelAuthStatus } from '@lnwjud/ipc-contracts';
import type { SecretProtector } from '@lnwjud/shared';

export const LEGACY_TUNNEL_SECRET_FILE = 'lnwjud.runtime.secret';
export const OAUTH_TUNNEL_SESSION_FILE = 'lnwjud.oauth.session.secret';

export function defaultTunnelProfileDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return path.join(environment.APPDATA ?? path.join(homeDirectory, 'AppData', 'Roaming'), 'tunnel-client');
  }
  const dataHome = platform === 'darwin'
    ? path.join(homeDirectory, 'Library', 'Application Support')
    : (environment.XDG_DATA_HOME?.trim() && path.isAbsolute(environment.XDG_DATA_HOME.trim())
      ? environment.XDG_DATA_HOME.trim()
      : path.join(homeDirectory, '.local', 'share'));
  return path.join(dataHome, 'lnwjud', 'tunnel-client');
}

export function legacyTunnelSecretPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(defaultTunnelProfileDirectory(environment, homeDirectory, platform), LEGACY_TUNNEL_SECRET_FILE);
}

export function oauthTunnelSessionPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(defaultTunnelProfileDirectory(environment, homeDirectory, platform), OAUTH_TUNNEL_SESSION_FILE);
}

export interface TunnelRuntimeCredential {
  readonly value: string;
  readonly authMode: TunnelAuthStatus['mode'];
  readonly expiresAt: string | null;
}

export interface TunnelAuthProvider {
  status(): Promise<TunnelAuthStatus>;
  getRuntimeCredential(): Promise<TunnelRuntimeCredential | null>;
  saveLegacyApiKey(apiKey: string): Promise<void>;
}

export interface LegacyApiKeyCredentialProviderOptions {
  readonly secretPath: () => string;
  readonly secretProtector?: SecretProtector;
  readonly encryptSecret?: (plainText: string) => Promise<string>;
  readonly decryptSecret?: (cipherText: string) => Promise<string>;
}

/**
 * Backward-compatible adapter for the original lnwjud Secure Tunnel credential
 * contract. The on-disk file name and runtime secret injection remain stable;
 * new writes use the injected platform secure-storage provider.
 */
export class LegacyApiKeyCredentialProvider implements TunnelAuthProvider {
  public constructor(private readonly options: LegacyApiKeyCredentialProviderOptions) {}

  public async status(): Promise<TunnelAuthStatus> {
    const hasLegacyApiKey = await this.hasStoredSecret();
    return {
      mode: 'legacy_api_key',
      authReady: hasLegacyApiKey,
      runtimeCredentialAvailable: hasLegacyApiKey,
      hasLegacyApiKey,
      accountLabel: null,
      organizationId: null,
      workspaceId: null,
      expiresAt: null,
      requiresUserAction: !hasLegacyApiKey,
      message: hasLegacyApiKey ? null : 'Save a Runtime API key first',
    };
  }

  public async getRuntimeCredential(): Promise<TunnelRuntimeCredential | null> {
    let encrypted: string;
    try {
      encrypted = await readFile(this.options.secretPath(), 'utf8');
    } catch {
      return null;
    }
    if (encrypted.trim().length === 0) return null;
    const decrypted = this.options.secretProtector === undefined
      ? await (this.options.decryptSecret?.(encrypted) ?? Promise.reject(new Error('Secure secret provider was not injected before reading the Runtime API key')))
      : (await this.options.secretProtector.decrypt('tunnel_api_key', encrypted)).plainText;
    const value = decrypted.trim();
    if (value.length === 0) return null;
    return { value, authMode: 'legacy_api_key', expiresAt: null };
  }

  public async saveLegacyApiKey(apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) throw new Error('Runtime API key is required');
    const secretPath = this.options.secretPath();
    await mkdir(path.dirname(secretPath), { recursive: true });
    const encrypted = this.options.secretProtector === undefined
      ? await (this.options.encryptSecret?.(trimmed) ?? Promise.reject(new Error('Secure secret provider was not injected before saving the Runtime API key')))
      : await this.options.secretProtector.encrypt('tunnel_api_key', trimmed);
    await writeFile(secretPath, encrypted, { encoding: 'utf8', mode: 0o600 });
  }

  private async hasStoredSecret(): Promise<boolean> {
    try {
      const raw = await readFile(this.options.secretPath(), 'utf8');
      return raw.trim().length > 0;
    } catch {
      return false;
    }
  }
}
