import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { assertSecretPlaintext, type SecretProtector } from '@lnwjud/shared';

export interface CheckpointKeyStoreOptions {
  readonly filePath: string;
  readonly secretProtector: SecretProtector;
  readonly byteLength?: number;
  readonly quarantineUnsupported?: boolean;
}

/**
 * Owns the protected checkpoint master-key file. Creation and rotation are
 * atomic so concurrent Desktop/STDIO startup cannot silently create two keys.
 */
export class CheckpointKeyStore {
  private readonly byteLength: number;

  public constructor(private readonly options: CheckpointKeyStoreOptions) {
    this.byteLength = options.byteLength ?? 32;
    if (!Number.isInteger(this.byteLength) || this.byteLength < 16 || this.byteLength > 64) {
      throw new Error('Checkpoint key length is invalid');
    }
  }

  public async loadOrCreate(): Promise<Buffer> {
    const existing = await this.readExisting();
    if (existing !== null) return existing;

    const generated = randomBytes(this.byteLength);
    const encrypted = await this.options.secretProtector.encrypt('checkpoint_master_key', generated.toString('base64'));
    await mkdir(path.dirname(path.resolve(this.options.filePath)), { recursive: true });
    try {
      await writeExclusive(this.options.filePath, encrypted);
      return generated;
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
      const concurrent = await this.readExisting();
      if (concurrent === null) throw new Error('Checkpoint key appeared during concurrent startup but could not be read');
      return concurrent;
    }
  }

  private async readExisting(): Promise<Buffer | null> {
    let encrypted: string;
    try {
      const metadata = await lstat(this.options.filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Protected checkpoint key is not a trusted regular file');
      encrypted = await readFile(this.options.filePath, 'utf8');
    } catch (error: unknown) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    const trimmed = encrypted.trim();
    try {
      const result = await this.options.secretProtector.decrypt('checkpoint_master_key', trimmed);
      assertSecretPlaintext(result.plainText);
      const key = Buffer.from(result.plainText, 'base64');
      if (key.byteLength !== this.byteLength || key.toString('base64') !== result.plainText) {
        throw new Error('Protected checkpoint key has an invalid key length');
      }
      if (result.shouldReEncrypt) {
        const next = await this.options.secretProtector.encrypt('checkpoint_master_key', result.plainText);
        await writeAtomic(this.options.filePath, next);
      }
      return key;
    } catch (error: unknown) {
      if (this.options.quarantineUnsupported === true && isQuarantinableSecretError(error)) {
        const quarantinePath = `${this.options.filePath}.unsupported-${Date.now()}`;
        await rename(this.options.filePath, quarantinePath).catch(() => undefined);
        return null;
      }
      throw error;
    }
  }
}

function isQuarantinableSecretError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (message.includes('basic_text') || message.includes('temporarily unavailable') || message.includes('unsupported platform')) {
    return false;
  }
  return true;
}

async function writeExclusive(filePath: string, contents: string): Promise<void> {
  const handle = await open(path.resolve(filePath), 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  const absolutePath = path.resolve(filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeExclusive(temporaryPath, contents);
    await rename(temporaryPath, absolutePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}
