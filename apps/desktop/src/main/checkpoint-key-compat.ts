import { readFileSync } from 'node:fs';
import path from 'node:path';

const V3_SECRET_PREFIX = 'lnwjud-secret:v3:';
const WINDOWS_PROVIDER = 'windows-dpapi';

export interface SafeStorageDecryptor {
  decryptString(value: Buffer): string;
}

export function loadV3CheckpointKeyIfPresent(
  dataPath: string,
  safeStorage: SafeStorageDecryptor,
): Buffer | undefined {
  const filePath = path.join(dataPath, 'checkpoint-master.key');
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  const trimmed = raw.trim();
  if (!trimmed.startsWith(V3_SECRET_PREFIX)) return undefined;
  const body = trimmed.slice(V3_SECRET_PREFIX.length);
  const delimiter = body.indexOf(':');
  if (delimiter <= 0) throw new Error('Checkpoint secret has an invalid v3 envelope');
  const providerId = body.slice(0, delimiter);
  if (providerId !== WINDOWS_PROVIDER) {
    throw new Error(`Checkpoint secret provider ${providerId} cannot be opened by this Windows build`);
  }

  const encoded = body.slice(delimiter + 1);
  if (encoded.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('Checkpoint secret has invalid ciphertext encoding');
  }
  const encrypted = Buffer.from(encoded, 'base64');
  if (encrypted.byteLength === 0) throw new Error('Checkpoint secret has empty ciphertext');

  let plainBase64: string;
  try {
    plainBase64 = safeStorage.decryptString(encrypted);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown secure-storage error';
    throw new Error(`Checkpoint secret could not be decrypted: ${detail}`);
  }

  const key = Buffer.from(plainBase64.trim(), 'base64');
  if (key.byteLength !== 32) throw new Error('Checkpoint secret has an invalid key length');
  return key;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
