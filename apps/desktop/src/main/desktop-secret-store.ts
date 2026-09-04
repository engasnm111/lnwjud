import path from 'node:path';
import { decodeLegacyWindowsProtectedKey, DEFAULT_CHECKPOINT_SECRET_REF, loadOrCreateCheckpointEncryptionKeyFromStore, type SecretRef, type SecretStore } from '@lnwjud/shared';
import { legacyTunnelSecretPath, oauthTunnelSessionPath, LEGACY_TUNNEL_SECRET_REF, OAUTH_TUNNEL_SESSION_REF } from './tunnel-auth.js';
import { SafeStorageSecretStore, type SafeStorageAdapter } from './safe-storage-secret-store.js';
import { unprotectTunnelSecret } from './tunnel-secret-dpapi.js';

export interface DesktopSecretBootstrap {
  readonly secretStore: SecretStore;
  readonly checkpointEncryptionKey: Buffer;
}

export interface DesktopSecretStoreOptions {
  readonly dataPath: string;
  readonly safeStorage: SafeStorageAdapter;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly legacyTunnelDecrypt?: (cipherText: string) => Promise<string>;
}

export async function bootstrapDesktopSecrets(options: DesktopSecretStoreOptions): Promise<DesktopSecretBootstrap> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const checkpointPath = path.join(options.dataPath, 'checkpoint-master.key');
  const tunnelPath = legacyTunnelSecretPath(environment, platform);
  const oauthPath = oauthTunnelSessionPath(environment, platform);
  const secretStore = new SafeStorageSecretStore({
    rootPath: path.join(options.dataPath, 'secrets'),
    platform,
    safeStorage: options.safeStorage,
    pathForRef: (ref): string => pathForSecretRef(ref, checkpointPath, tunnelPath, oauthPath),
    legacyDecrypt: async (ref, raw): Promise<Uint8Array | null> => {
      if (platform !== 'win32') return null;
      if (sameRef(ref, DEFAULT_CHECKPOINT_SECRET_REF)) return decodeLegacyWindowsProtectedKey(raw, 32);
      if (sameRef(ref, LEGACY_TUNNEL_SECRET_REF) || sameRef(ref, OAUTH_TUNNEL_SESSION_REF)) {
        const decrypt = options.legacyTunnelDecrypt ?? unprotectTunnelSecret;
        return Buffer.from(await decrypt(raw), 'utf8');
      }
      return null;
    },
  });
  const checkpointEncryptionKey = await loadOrCreateCheckpointEncryptionKeyFromStore(secretStore);
  return { secretStore, checkpointEncryptionKey };
}

function pathForSecretRef(ref: SecretRef, checkpointPath: string, tunnelPath: string, oauthPath: string): string {
  if (sameRef(ref, DEFAULT_CHECKPOINT_SECRET_REF)) return checkpointPath;
  if (sameRef(ref, LEGACY_TUNNEL_SECRET_REF)) return tunnelPath;
  if (sameRef(ref, OAUTH_TUNNEL_SESSION_REF)) return oauthPath;
  return path.join(path.dirname(checkpointPath), 'secrets', `${ref.namespace}.${ref.name}.v${ref.version}.secret`);
}

function sameRef(left: SecretRef, right: SecretRef): boolean {
  return left.namespace === right.namespace && left.name === right.name && left.version === right.version;
}
