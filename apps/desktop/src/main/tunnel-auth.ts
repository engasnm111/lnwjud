import os from 'node:os';
import path from 'node:path';
import type { TunnelAuthStatus } from '@lnwjud/ipc-contracts';
import { createPlatformContext, resolvePlatformPaths } from '@lnwjud/platform';
import { secretRef, type SecretRef, type SecretStore } from '@lnwjud/shared';

export const LEGACY_TUNNEL_SECRET_FILE = 'lnwjud.runtime.secret';
export const OAUTH_TUNNEL_SESSION_FILE = 'lnwjud.oauth.session.secret';
export const LEGACY_TUNNEL_SECRET_REF = secretRef('tunnel', 'legacy-api-key', 1);
export const OAUTH_TUNNEL_SESSION_REF = secretRef('tunnel', 'oauth-session', 1);

export function defaultTunnelProfileDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string {
  const context = createPlatformContext({ platform, arch: process.arch });
  const paths = resolvePlatformPaths(context, environment, homeDir);
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return pathApi.join(pathApi.dirname(paths.configDir), 'tunnel-client');
}

export function legacyTunnelSecretPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return pathApi.join(defaultTunnelProfileDirectory(environment, platform, homeDir), LEGACY_TUNNEL_SECRET_FILE);
}

export function oauthTunnelSessionPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return pathApi.join(defaultTunnelProfileDirectory(environment, platform, homeDir), OAUTH_TUNNEL_SESSION_FILE);
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
  readonly secretStore: SecretStore;
  readonly secretRef?: SecretRef;
}

/** Secure-store adapter for the original lnwjud Runtime API key contract. */
export class LegacyApiKeyCredentialProvider implements TunnelAuthProvider {
  private readonly ref: SecretRef;

  public constructor(private readonly options: LegacyApiKeyCredentialProviderOptions) {
    this.ref = options.secretRef ?? LEGACY_TUNNEL_SECRET_REF;
  }

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
    const stored = await this.options.secretStore.get(this.ref);
    if (stored === null || stored.byteLength === 0) return null;
    const value = Buffer.from(stored).toString('utf8').trim();
    if (value.length === 0) return null;
    return { value, authMode: 'legacy_api_key', expiresAt: null };
  }

  public async saveLegacyApiKey(apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) throw new Error('Runtime API key is required');
    await this.options.secretStore.set(this.ref, Buffer.from(trimmed, 'utf8'));
  }

  private async hasStoredSecret(): Promise<boolean> {
    try {
      if (this.options.secretStore.has !== undefined) return await this.options.secretStore.has(this.ref);
      const stored = await this.options.secretStore.get(this.ref);
      return stored !== null && stored.byteLength > 0;
    } catch {
      return false;
    }
  }
}
