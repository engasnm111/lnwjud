import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withInspectedHostedReceiptArchive } from './hosted-receipt-artifact.mjs';
import { inspectPinnedKeyFreeReceipt } from './pinned-receipt-verifier.mjs';
import { readBoundedFile } from './verify-build-evidence.mjs';

// Key-free receipt inspection only. Neither this module nor a successful
// attestation grants production signing authority or updater installation.
const refuse = () => { throw new Error('HOSTED_RECEIPT_VERIFICATION_REFUSED'); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const keys = ['candidateSha256', 'manifestSha256', 'policySha256',
  'sourceRunId', 'sourceSha', 'verifiedAt', 'verifierRunId'];

function snapshotExpected(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).sort().join(',') !== keys.join(',')
    || keys.some(key => !Object.prototype.hasOwnProperty.call(descriptors[key], 'value')
      || typeof descriptors[key].value !== 'string')) refuse();
  return Object.freeze(Object.fromEntries(keys.map(key => [key, descriptors[key].value])));
}

/**
 * Stage only the two bounded, ZIP-inspected members in a fresh private
 * directory for the pinned GitHub CLI. No caller-selected output paths.
 * Refuse if the files change during verification or cleanup cannot be proven.
 */
export async function withEphemeralReceiptFiles(members, consume) {
  if (!members || typeof members !== 'object' || Array.isArray(members)
    || typeof consume !== 'function') refuse();
  const fields = Object.getOwnPropertyDescriptors(members);
  if (Object.keys(fields).sort().join(',') !== 'bundleBytes,receiptBytes'
    || !Object.prototype.hasOwnProperty.call(fields.receiptBytes, 'value')
    || !Object.prototype.hasOwnProperty.call(fields.bundleBytes, 'value')) refuse();
  const rawReceipt = fields.receiptBytes.value, rawBundle = fields.bundleBytes.value;
  if (!Buffer.isBuffer(rawReceipt) || !Buffer.isBuffer(rawBundle)
    || rawReceipt.length < 1 || rawReceipt.length > 2048
    || rawBundle.length < 1 || rawBundle.length > 16 * 1024 * 1024) refuse();
  const receiptBytes = Buffer.from(rawReceipt);
  const bundleBytes = Buffer.from(rawBundle);
  const receiptHash = sha256(receiptBytes), bundleHash = sha256(bundleBytes);
  const base = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(base, 'lnwjud-receipt-'));
  const receiptPath = path.join(directory, 'receipt.json');
  const bundlePath = path.join(directory, 'receipt.bundle.json');
  let result, primary;
  try {
    if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) refuse();
    await writeFile(receiptPath, receiptBytes, { flag: 'wx', mode: 0o600 });
    await writeFile(bundlePath, bundleBytes, { flag: 'wx', mode: 0o600 });
    result = await consume(Object.freeze({ receiptPath, bundlePath }));
    const [receipt, bundle] = await Promise.all([
      readBoundedFile(receiptPath, 2048n),
      readBoundedFile(bundlePath, 16n * 1024n * 1024n),
    ]);
    if (receipt.sha256 !== receiptHash || bundle.sha256 !== bundleHash
      || receipt.sizeBytes !== String(receiptBytes.length)
      || bundle.sizeBytes !== String(bundleBytes.length)) refuse();
  } catch (error) { primary = error; }
  try {
    if (await realpath(directory) !== directory || path.dirname(directory) !== base
      || !path.basename(directory).startsWith('lnwjud-receipt-')
      || !(await lstat(directory)).isDirectory()) refuse();
    await rm(receiptPath, { force: true });
    await rm(bundlePath, { force: true });
    await rmdir(directory);
  } catch {
    throw new Error('HOSTED_RECEIPT_CLEANUP_UNVERIFIED');
  }
  if (primary) throw primary;
  return result;
}

/**
 * Authenticated GitHub metadata -> SHA-256-checked native ZIP spool ->
 * strict two-member ZIP inspection -> pinned CLI OIDC attestation verification.
 * The result is diagnostic evidence only, never an authorization to sign or
 * install a release. The protected-main workflow must exist independently.
 */
export async function inspectPinnedHostedReceipt({ expected, verifierExpected, token, addon, filename, fetchImpl }) {
  const bound = snapshotExpected(verifierExpected);
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) refuse();
  const source = Object.getOwnPropertyDescriptors(expected);
  if (Object.keys(source).sort().join(',') !== 'runId,sourceSha'
    || !Object.prototype.hasOwnProperty.call(source.runId, 'value') || !Object.prototype.hasOwnProperty.call(source.sourceSha, 'value')
    || !Number.isSafeInteger(source.runId.value) || source.runId.value < 1
    || !/^[a-f0-9]{40}$/.test(source.sourceSha.value)
    || String(source.runId.value) !== bound.verifierRunId
    || source.sourceSha.value !== bound.sourceSha) refuse();
  const hostedExpected = Object.freeze({ runId: source.runId.value, sourceSha: source.sourceSha.value });
  return withInspectedHostedReceiptArchive({
    expected: hostedExpected, token, addon, filename,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  }, async (members, selected) => {
    if (selected.runId !== bound.verifierRunId || selected.sourceSha !== bound.sourceSha) refuse();
    return withEphemeralReceiptFiles(members, async ({ receiptPath, bundlePath }) => {
      const verified = await inspectPinnedKeyFreeReceipt({ receiptPath, bundlePath, expected: bound });
      if (verified.receiptSha256 !== sha256(members.receiptBytes)
        || verified.verifierRunId !== selected.runId || verified.sourceSha !== selected.sourceSha) refuse();
      return Object.freeze({
        ...verified, archiveSha256: selected.archiveSha256,
        status: 'hosted-receipt-oidc-diagnostic-only',
      });
    });
  });
}
