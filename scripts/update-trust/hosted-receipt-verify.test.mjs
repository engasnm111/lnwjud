import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectPinnedHostedReceipt, withEphemeralReceiptFiles } from './hosted-receipt-verify.mjs';

const members = () => ({
  receiptBytes: Buffer.from('{"receipt":true}'),
  bundleBytes: Buffer.from('{"bundle":true}'),
});

test('stages exact receipt members privately and deletes them after successful inspection', async () => {
  let directory;
  const result = await withEphemeralReceiptFiles(members(), async ({ receiptPath, bundlePath }) => {
    directory = path.dirname(receiptPath);
    assert.equal(path.dirname(bundlePath), directory);
    assert.equal(path.basename(receiptPath), 'receipt.json');
    assert.equal(path.basename(bundlePath), 'receipt.bundle.json');
    assert.deepEqual(await readFile(receiptPath), members().receiptBytes);
    assert.deepEqual(await readFile(bundlePath), members().bundleBytes);
    return 'checked';
  });
  assert.equal(result, 'checked');
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('discards temporary receipt files when verification throws', async () => {
  let directory;
  await assert.rejects(withEphemeralReceiptFiles(members(), ({ receiptPath }) => {
    directory = path.dirname(receiptPath);
    throw new Error('VERIFIER_REJECTED');
  }), /VERIFIER_REJECTED/);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('rejects receipt or bundle tampering during verification and cleans up', async () => {
  for (const filename of ['receiptPath', 'bundlePath']) {
    let directory;
    await assert.rejects(withEphemeralReceiptFiles(members(), async paths => {
      directory = path.dirname(paths.receiptPath);
      await writeFile(paths[filename], 'tampered');
    }), /HOSTED_RECEIPT_VERIFICATION_REFUSED/);
    await assert.rejects(stat(directory), { code: 'ENOENT' });
  }
});

test('rejects malformed member buffers before creating a temporary directory', async () => {
  for (const value of [
    { receiptBytes: Buffer.alloc(0), bundleBytes: Buffer.from('x') },
    { receiptBytes: Buffer.from('x'), bundleBytes: Buffer.alloc(0) },
    { receiptBytes: Buffer.alloc(2049), bundleBytes: Buffer.from('x') },
    { receiptBytes: Buffer.from('x'), bundleBytes: Buffer.alloc(16 * 1024 * 1024 + 1) },
    { receiptBytes: 'not bytes', bundleBytes: Buffer.from('x') },
    { ...members(), extra: 'untrusted' },
    Object.defineProperty({ bundleBytes: Buffer.from('x') }, 'receiptBytes', {
      get() { throw new Error('GETTER_EXECUTED'); },
    }),
  ]) await assert.rejects(withEphemeralReceiptFiles(value, () => {}), /HOSTED_RECEIPT_VERIFICATION_REFUSED/);
});

test('refuses mismatched run identity and accessor-controlled expected metadata before download', async () => {
  const verifierExpected = {
    sourceSha: 'a'.repeat(40), sourceRunId: '500', verifierRunId: '600',
    policySha256: '1'.repeat(64), candidateSha256: '2'.repeat(64),
    manifestSha256: '3'.repeat(64), verifiedAt: '1800000000',
  };
  const options = { expected: { runId: 600, sourceSha: 'a'.repeat(40) }, verifierExpected,
    token: 'test_token_not_used', addon: {}, filename: 'receipt.zip', fetchImpl: undefined };
  await assert.rejects(inspectPinnedHostedReceipt({
    ...options, expected: { ...options.expected, runId: 601 },
  }), /HOSTED_RECEIPT_VERIFICATION_REFUSED/);
  const accessor = { ...verifierExpected };
  Object.defineProperty(accessor, 'sourceSha', { get() { throw new Error('GETTER_EXECUTED'); } });
  await assert.rejects(inspectPinnedHostedReceipt({
    ...options, verifierExpected: accessor,
  }), /HOSTED_RECEIPT_VERIFICATION_REFUSED/);
  await assert.rejects(inspectPinnedHostedReceipt({
    ...options, verifierExpected: { ...verifierExpected, extra: 'unsafe' },
  }), /HOSTED_RECEIPT_VERIFICATION_REFUSED/);
});
