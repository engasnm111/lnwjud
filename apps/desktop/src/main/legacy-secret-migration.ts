import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertSecretPlaintext, SECRET_ENVELOPE_PREFIX, type SecretProtector } from '@lnwjud/shared';

const MAX_LEGACY_FILE_BYTES = 64 * 1024;
const MAX_HELPER_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const MIGRATION_RECEIPT_VERSION = 1;

export interface LegacySecretMigrationOptions {
  readonly platform?: NodeJS.Platform;
  readonly checkpointPath: string;
  readonly tunnelSecretPath: string;
  readonly secretProtector: SecretProtector;
  /** Tests may provide a deterministic helper without starting a process. */
  readonly runHelper?: (request: LegacySecretHelperRequest) => Promise<string>;
  readonly helperPath?: string;
  readonly helperSha256Path?: string;
  readonly lockTimeoutMs?: number;
  readonly now?: () => Date;
}

export type LegacySecretHelperRequest =
  | { readonly op: 'dpapi_v2'; readonly ciphertextBase64: string }
  | { readonly op: 'secure_string_v1'; readonly ciphertextHex: string };

export interface LegacySecretMigrationResult {
  readonly checkpoint: LegacySecretMigrationState;
  readonly tunnel: LegacySecretMigrationState;
}

export type LegacySecretMigrationState = 'not_windows' | 'missing' | 'not_legacy' | 'already_safe' | 'migrated';

/**
 * Converts only the two v4.44.0 Windows formats. Non-Windows hosts return
 * without reading secret files, so native macOS/Linux startup cannot execute or
 * import a Windows secret implementation.
 */
export async function migrateLegacyWindowsSecrets(options: LegacySecretMigrationOptions): Promise<LegacySecretMigrationResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { checkpoint: 'not_windows', tunnel: 'not_windows' };

  const runner = options.runHelper ?? createNativeHelperRunner({
    helperPath: options.helperPath ?? resolveHelperPath(),
    ...(options.helperSha256Path === undefined ? {} : { helperSha256Path: options.helperSha256Path }),
  });
  const common = {
    secretProtector: options.secretProtector,
    runHelper: runner,
    lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    now: options.now ?? ((): Date => new Date()),
  };
  const checkpoint = await migrateFile({
    ...common,
    filePath: options.checkpointPath,
    purpose: 'checkpoint_master_key',
    detect: detectCheckpointLegacy,
    validate: validateCheckpointPlaintext,
  });
  const tunnel = await migrateFile({
    ...common,
    filePath: options.tunnelSecretPath,
    purpose: 'tunnel_api_key',
    detect: detectTunnelLegacy,
    validate: validateTunnelPlaintext,
  });
  // main.ts supplies the resolved data and tunnel profile locations through
  // these two paths. OAuth sessions and Remote MCP used the same raw Windows
  // SecureString format as the API key, even when that key file was absent.
  const dataDirectory = path.dirname(options.checkpointPath);
  const additionalSecrets = [
    path.join(path.dirname(options.tunnelSecretPath), 'lnwjud.oauth.session.secret'),
    path.join(dataDirectory, 'remote-mcp', 'oauth-state.secret'),
    path.join(dataDirectory, 'remote-mcp', 'ngrok-authtoken.secret'),
  ];
  for (const filePath of additionalSecrets) {
    await migrateFile({
      ...common,
      filePath,
      purpose: 'tunnel_api_key',
      detect: detectTunnelLegacy,
      validate: validateTunnelPlaintext,
    });
  }
  return { checkpoint, tunnel };
}

interface MigrateFileOptions {
  readonly filePath: string;
  readonly purpose: 'checkpoint_master_key' | 'tunnel_api_key';
  readonly secretProtector: SecretProtector;
  readonly runHelper: (request: LegacySecretHelperRequest) => Promise<string>;
  readonly lockTimeoutMs: number;
  readonly now: () => Date;
  readonly detect: (raw: string) => LegacySecretHelperRequest | null;
  readonly validate: (plainText: string) => void;
}

async function migrateFile(options: MigrateFileOptions): Promise<LegacySecretMigrationState> {
  const raw = await readBoundedFile(options.filePath);
  if (raw === null) return 'missing';
  const trimmed = raw.trim();
  if (trimmed.startsWith(SECRET_ENVELOPE_PREFIX)) return 'already_safe';
  const request = options.detect(trimmed);
  if (request === null) return 'not_legacy';

  const lockPath = `${options.filePath}.migration.lock`;
  const lock = await acquireMigrationLock(lockPath, options.filePath, options.lockTimeoutMs);
  if (lock === null) return 'already_safe';
  try {
    const current = await readBoundedFile(options.filePath);
    if (current === null) return 'missing';
    const currentTrimmed = current.trim();
    if (currentTrimmed.startsWith(SECRET_ENVELOPE_PREFIX)) return 'already_safe';
    const currentRequest = options.detect(currentTrimmed);
    if (currentRequest === null) return 'not_legacy';

    const plainText = await options.runHelper(currentRequest);
    options.validate(plainText);
    const encrypted = await options.secretProtector.encrypt(options.purpose, plainText);
    const backupPath = `${options.filePath}.legacy-backup`;
    await retainBackup(options.filePath, backupPath);
    try {
      await writeAtomic(options.filePath, encrypted);
      const verified = await options.secretProtector.decrypt(options.purpose, encrypted);
      if (verified.plainText !== plainText) throw new Error('Migrated secret verification failed');
      await writeMigrationReceipt(options.filePath, backupPath, current, encrypted, currentRequest.op, options.now());
    } catch (error: unknown) {
      // A failed verification or interrupted receipt must leave the legacy
      // value usable so the next startup can retry safely.
      await writeAtomic(options.filePath, current).catch(() => undefined);
      throw error instanceof Error ? error : new Error('Legacy secret migration failed');
    }
    return 'migrated';
  } finally {
    await lock.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

function detectCheckpointLegacy(value: string): LegacySecretHelperRequest | null {
  if (value.startsWith('dpapi:v2:')) return { op: 'dpapi_v2', ciphertextBase64: value.slice('dpapi:v2:'.length) };
  if (value.startsWith('dpapi:v1:')) return { op: 'secure_string_v1', ciphertextHex: value.slice('dpapi:v1:'.length) };
  return null;
}

function detectTunnelLegacy(value: string): LegacySecretHelperRequest | null {
  // Legacy Windows secure-string storage emits a hexadecimal DPAPI blob.
  // Requiring an even, bounded hex string avoids treating normal text
  // credentials as a migration candidate while still accepting fixture variants.
  if (value.length < 32 || value.length % 2 !== 0 || value.length > MAX_LEGACY_FILE_BYTES * 2 || !/^[0-9a-f]+$/i.test(value)) return null;
  return { op: 'secure_string_v1', ciphertextHex: value };
}

function validateCheckpointPlaintext(value: string): void {
  assertSecretPlaintext(value);
  const key = Buffer.from(value, 'base64');
  if (key.byteLength !== 32 || key.toString('base64') !== value) throw new Error('Legacy checkpoint key has an invalid format');
}

function validateTunnelPlaintext(value: string): void {
  assertSecretPlaintext(value);
}

async function readBoundedFile(filePath: string): Promise<string | null> {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Legacy secret file is not a trusted regular file');
    if (metadata.size > MAX_LEGACY_FILE_BYTES) throw new Error('Legacy secret file is too large');
    return await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function retainBackup(sourcePath: string, backupPath: string): Promise<void> {
  try {
    await copyFile(sourcePath, backupPath, 1);
  } catch (error: unknown) {
    if (!isAlreadyExists(error)) throw error;
  }
}

async function writeMigrationReceipt(sourcePath: string, backupPath: string, legacy: string, encrypted: string, operation: string, now: Date): Promise<void> {
  const receipt = {
    schemaVersion: MIGRATION_RECEIPT_VERSION,
    migratedAt: now.toISOString(),
    operation,
    legacySha256: sha256(legacy),
    replacementSha256: sha256(encrypted),
    backupFile: path.basename(backupPath),
  };
  await writeAtomic(`${sourcePath}.migration.json`, `${JSON.stringify(receipt)}\n`);
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  const absolutePath = path.resolve(filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, absolutePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function acquireMigrationLock(lockPath: string, secretPath: string, timeoutMs: number): Promise<Awaited<ReturnType<typeof open>> | null> {
  const deadline = Date.now() + Math.max(100, timeoutMs);
  while (true) {
    try {
      return await open(lockPath, 'wx', 0o600);
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
      const current = await readBoundedFile(secretPath);
      if (current === null || current.trim().startsWith(SECRET_ENVELOPE_PREFIX)) return null;
      if (Date.now() >= deadline) throw new Error('Legacy secret migration is already in progress');
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
  }
}

function createNativeHelperRunner(options: { readonly helperPath: string; readonly helperSha256Path?: string }): (request: LegacySecretHelperRequest) => Promise<string> {
  let integrity: Promise<void> | null = null;
  return async (request) => {
    integrity ??= verifyHelperIntegrity(options.helperPath, options.helperSha256Path ?? `${options.helperPath.replace(/\.exe$/i, '')}.sha256`);
    await integrity;
    return runHelperProcess(options.helperPath, request);
  };
}

async function verifyHelperIntegrity(helperPath: string, hashPath: string): Promise<void> {
  await assertTrustedRegularFile(helperPath, 'Windows secret migration helper');
  await assertTrustedRegularFile(hashPath, 'Windows secret migration helper integrity metadata');
  const expectedFile = await readFile(hashPath, 'utf8').catch(() => '');
  const match = /^([0-9a-f]{64})\s+/i.exec(expectedFile.trim());
  if (match === null) throw new Error('Windows secret migration helper integrity metadata is unavailable');
  const actual = await hashFile(helperPath);
  if (actual !== match[1]!.toLowerCase()) throw new Error('Windows secret migration helper integrity check failed');
}

async function assertTrustedRegularFile(filePath: string, label: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} is not a trusted regular file`);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(filePath);
  } catch {
    throw new Error(`${label} cannot be canonicalized`);
  }
  if (canonicalPath !== path.resolve(filePath)) throw new Error(`${label} resolves through a link`);
}

function runHelperProcess(helperPath: string, request: LegacySecretHelperRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('Windows secret migration helper timed out'));
    }, 10_000);
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    child.on('error', () => fail(new Error('Windows secret migration helper failed to start')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_HELPER_OUTPUT_BYTES) fail(new Error('Windows secret migration helper returned too much data'));
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(String(chunk), 'utf8');
      if (stderrBytes > MAX_HELPER_OUTPUT_BYTES) fail(new Error('Windows secret migration helper returned too much diagnostic data'));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error('Windows secret migration helper rejected the legacy value'));
        return;
      }
      try {
        const response = JSON.parse(stdout.trim()) as unknown;
        if (!isSuccessfulHelperResponse(response)) throw new Error();
        const bytes = decodeBase64(response.plaintextBase64);
        const plainText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        assertSecretPlaintext(plainText);
        resolve(plainText);
      } catch {
        reject(new Error('Windows secret migration helper returned an invalid response'));
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`, 'utf8');
  });
}

function isSuccessfulHelperResponse(value: unknown): value is { readonly ok: true; readonly plaintextBase64: string } {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>).ok === true
    && typeof (value as Record<string, unknown>).plaintextBase64 === 'string';
}

function decodeBase64(value: string): Buffer {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== value) throw new Error();
  return bytes;
}

async function hashFile(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function resolveHelperPath(): string {
  const configured = process.env.LNWJUD_WINDOWS_SECRET_MIGRATOR?.trim();
  if (configured) return path.resolve(configured);
  const resourcesPath = (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath;
  const candidates = [
    resourcesPath === undefined ? undefined : path.join(resourcesPath, 'windows-secret-migrator', 'lnwjud-windows-secret-migrator.exe'),
    path.join(path.dirname(process.execPath), 'windows-secret-migrator', 'lnwjud-windows-secret-migrator.exe'),
    path.join(path.dirname(process.execPath), 'lnwjud-windows-secret-migrator.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'lnwjud', 'windows-secret-migrator', 'lnwjud-windows-secret-migrator.exe'),
  ].filter((candidate): candidate is string => candidate !== undefined);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}
