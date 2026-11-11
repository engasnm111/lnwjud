import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { inspectPinnedKeyFreeReceipt, receiptAttestationArgs } from './pinned-receipt-verifier.mjs';

const expected = Object.freeze({
  sourceSha: 'a'.repeat(40), sourceRunId: '500', verifierRunId: '600',
  policySha256: '1'.repeat(64), candidateSha256: '2'.repeat(64),
  manifestSha256: '3'.repeat(64), verifiedAt: '1800000000',
});
const receiptPath = path.resolve('fixtures/receipt.json');
const bundlePath = path.resolve('fixtures/receipt.bundle.json');

test('pins hosted workflow and source identity in actual CLI verification arguments', () => {
  const source = { commit: expected.sourceSha, ref: 'refs/heads/main' };
  const authority = {
    issuer: 'https://token.actions.githubusercontent.com',
    builderWorkflowUri: 'https://github.com/engasnm111/lnwjud/.github/workflows/update-signing.yml@refs/heads/main',
    builderDigest: expected.sourceSha,
  };
  assert.deepEqual(receiptAttestationArgs(receiptPath, bundlePath, source, authority), [
    'attestation', 'verify', receiptPath, '--repo', 'engasnm111/lnwjud',
    '--bundle', bundlePath, '--cert-oidc-issuer', authority.issuer,
    '--signer-workflow', 'engasnm111/lnwjud/.github/workflows/update-signing.yml',
    '--signer-digest', expected.sourceSha, '--source-digest', expected.sourceSha,
    '--source-ref', 'refs/heads/main', '--deny-self-hosted-runners',
    '--predicate-type', 'https://slsa.dev/provenance/v1', '--format', 'json',
  ]);
});

test('refuses ambiguous or noncanonical receipt/bundle inputs before invoking the verifier', async () => {
  const invalid = [
    ['receipt.txt', 'receipt.bundle.json'],
    ['receipt.json', 'bundle.json'],
    ['receipt.json', '../receipt.bundle.json'],
  ];
  for (const [receipt, bundle] of invalid) {
    await assert.rejects(inspectPinnedKeyFreeReceipt({
      receiptPath: path.resolve('fixtures', receipt),
      bundlePath: path.resolve('fixtures', bundle), expected,
    }), /KEYFREE_RECEIPT_PINNED_VERIFIER_REFUSED/);
  }
  await assert.rejects(inspectPinnedKeyFreeReceipt({
    receiptPath: 'receipt.json', bundlePath, expected,
  }), /KEYFREE_RECEIPT_PINNED_VERIFIER_REFUSED/);
});

test('refuses accessor-controlled or extra expected authority before any file or network access', async () => {
  const injected = { ...expected, extra: 'untrusted' };
  const accessor = { ...expected };
  Object.defineProperty(accessor, 'sourceSha', { get() { throw new Error('GETTER_EXECUTED'); } });
  for (const value of [injected, accessor]) {
    await assert.rejects(inspectPinnedKeyFreeReceipt({
      receiptPath, bundlePath, expected: value,
    }), /KEYFREE_RECEIPT_PINNED_VERIFIER_REFUSED/);
  }
});
