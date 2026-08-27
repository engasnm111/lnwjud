import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const KEY_PREFIX_V2 = 'dpapi:v2:';
const KEY_PREFIX_V1 = 'dpapi:v1:';
// Portable storage prefix used on platforms without Windows DPAPI so checkpoint
// master keys can be created and reopened on macOS/Linux hosts as well.
const KEY_PREFIX_RAW = 'raw:v1:';
const DEFAULT_MAX_BUFFER = 1024 * 1024;

export function protectWithWindowsDpapi(plainText: string): string {
  if (plainText.length === 0) throw new Error('DPAPI plaintext must not be empty');
  const script = [
    '$ErrorActionPreference = "Stop"',
    "[Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a') | Out-Null",
    '$plain = [Console]::In.ReadToEnd()',
    '$bytes = [Text.Encoding]::UTF8.GetBytes($plain)',
    '$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($protected)',
  ].join('; ');
  return runPowerShellDpapi(script, plainText);
}

export function unprotectWithWindowsDpapi(cipherText: string): string {
  if (cipherText.trim().length === 0) throw new Error('DPAPI ciphertext must not be empty');
  const script = [
    '$ErrorActionPreference = "Stop"',
    "[Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a') | Out-Null",
    '$encrypted = [Console]::In.ReadToEnd().Trim()',
    '$protected = [Convert]::FromBase64String($encrypted)',
    '$bytes = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Text.Encoding]::UTF8.GetString($bytes)',
  ].join('; ');
  return runPowerShellDpapi(script, cipherText);
}

export function loadOrCreateWindowsProtectedKey(filePath: string, byteLength = 32): Buffer {
  if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > 64) throw new Error('Invalid protected key length');
  const absolutePath = path.resolve(filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  try {
    const stored = readFileSync(absolutePath, 'utf8');
    const decoded = decodeProtectedKey(stored, byteLength);
    // Migrate legacy SecureString keys to DPAPI v2 only where DPAPI exists; raw
    // portable keys stay format-stable across platforms.
    if (stored.trim().startsWith(KEY_PREFIX_V1) && process.platform === 'win32') writeProtectedKeyV2(absolutePath, decoded);
    return decoded;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const generated = randomBytes(byteLength);
  const protectedValue = encodeProtectedKey(generated);
  try {
    writeFileSync(absolutePath, protectedValue, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return generated;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    return decodeProtectedKey(readFileSync(absolutePath, 'utf8'), byteLength);
  }
}

export function loadCheckpointEncryptionKey(dataPath: string): Buffer {
  const configured = process.env.LNWJUD_CHECKPOINT_KEY_BASE64;
  if (configured !== undefined && configured.trim().length > 0) {
    const key = Buffer.from(configured.trim(), 'base64');
    if (key.byteLength !== 32) throw new Error('LNWJUD_CHECKPOINT_KEY_BASE64 must decode to 32 bytes');
    return key;
  }
  return loadOrCreateWindowsProtectedKey(path.join(dataPath, 'checkpoint-master.key'), 32);
}

function encodeProtectedKey(key: Buffer): string {
  if (process.platform === 'win32') return KEY_PREFIX_V2 + protectWithWindowsDpapi(key.toString('base64'));
  return KEY_PREFIX_RAW + key.toString('base64');
}

function writeProtectedKeyV2(filePath: string, key: Buffer): void {
  writeFileSync(filePath, KEY_PREFIX_V2 + protectWithWindowsDpapi(key.toString('base64')), { encoding: 'utf8', mode: 0o600 });
}

function decodeProtectedKey(value: string, expectedLength: number): Buffer {
  const trimmed = value.trim();
  let plain: string;
  if (trimmed.startsWith(KEY_PREFIX_V2)) {
    plain = unprotectWithWindowsDpapi(trimmed.slice(KEY_PREFIX_V2.length));
  } else if (trimmed.startsWith(KEY_PREFIX_V1)) {
    plain = unprotectLegacySecureString(trimmed.slice(KEY_PREFIX_V1.length));
  } else if (trimmed.startsWith(KEY_PREFIX_RAW)) {
    plain = trimmed.slice(KEY_PREFIX_RAW.length);
  } else {
    throw new Error('Protected key file has an unsupported format');
  }
  const key = Buffer.from(plain.trim(), 'base64');
  if (key.byteLength !== expectedLength) throw new Error('Protected key file has an invalid key length');
  return key;
}

function unprotectLegacySecureString(cipherText: string): string {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$encrypted = [Console]::In.ReadToEnd().Trim()',
    '$secure = ConvertTo-SecureString -String $encrypted',
    '$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
    'try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }',
  ].join('; ');
  return runPowerShellDpapi(script, cipherText);
}

function runPowerShellDpapi(script: string, input: string): string {
  if (process.platform !== 'win32') throw new Error('Windows DPAPI is only available on Windows');
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const powershell = systemRoot === undefined
    ? 'powershell.exe'
    : path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: DEFAULT_MAX_BUFFER,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr ?? '').trim() || 'Windows DPAPI command failed');
  const value = (result.stdout ?? '').replace(/\r?\n$/, '');
  if (value.length === 0) throw new Error('Windows DPAPI command returned an empty result');
  return value;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}
