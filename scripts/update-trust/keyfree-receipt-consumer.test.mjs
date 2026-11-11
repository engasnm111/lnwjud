import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { inspectKeyFreeReceiptAttestation } from './keyfree-receipt-consumer.mjs';

const sha = 'a'.repeat(40);
const expected = Object.freeze({
  sourceSha: sha, sourceRunId: '500', verifierRunId: '600',
  policySha256: '1'.repeat(64), candidateSha256: '2'.repeat(64),
  manifestSha256: '3'.repeat(64), verifiedAt: '1800000000',
});
const receipt = Object.freeze({
  schema: 'lnwjud.keyfree-evidence/v1',
  status: 'key-free-attestations-observed-only',
  sourceSha: sha, sourceRunId: '500',
  builderSha: 'cd833d7df45a8ecf2e87bc89ffb9ee3c85d20406',
  policySha256: expected.policySha256,
  candidateSha256: expected.candidateSha256,
  manifestSha256: expected.manifestSha256,
});
const bytes = value => Buffer.from(JSON.stringify(value) + '\n');
const verified = ({ identity, source, authority }, change = () => {}) => {
  const item = { verificationResult: {
    signature: { certificate: {
      issuer: authority.issuer,
      subjectAlternativeName: authority.builderWorkflowUri,
      sourceRepositoryURI: source.repository,
      sourceRepositoryDigest: source.commit,
      sourceRepositoryRef: source.ref,
      buildSignerURI: authority.builderWorkflowUri,
      buildSignerDigest: authority.builderDigest,
      buildConfigURI: authority.buildConfigUri,
      buildConfigDigest: source.commit,
      runnerEnvironment: 'github-hosted',
      runInvocationURI: `${source.repository}/actions/runs/${source.runId}/attempts/1`,
    } },
    verifiedTimestamps: [{
      type: 'Tlog', timestamp: new Date(1800000000 * 1000).toISOString(),
      uri: 'https://rekor.sigstore.dev/log/1',
    }],
    statement: { predicateType: 'https://slsa.dev/provenance/v1',
      subject: [{ name: identity.name, digest: { sha256: identity.sha256 } }] },
  } };
  change(item);
  return bytes([item]);
};
const inspect = (r = receipt, e = expected, change) => inspectKeyFreeReceiptAttestation({
  receiptBytes: bytes(r), expected: e,
  verify: async args => verified(args, change),
});

test('matches exact receipt bytes and the separate hosted verifier run', async () => {
  const result = await inspect();
  assert.equal(result.status, 'receipt-attestation-metadata-matched-only');
  assert.equal(result.sourceRunId, '500');
  assert.equal(result.verifierRunId, '600');
  assert.equal(result.candidateSha256, expected.candidateSha256);
});

test('rejects substituted receipt fields before invoking the verifier', async () => {
  for (const [key, value] of [
    ['sourceSha', 'b'.repeat(40)], ['sourceRunId', '501'],
    ['builderSha', 'b'.repeat(40)], ['policySha256', 'b'.repeat(64)],
    ['candidateSha256', 'b'.repeat(64)], ['manifestSha256', 'b'.repeat(64)],
    ['status', 'signed'], ['schema', 'lnwjud.keyfree-evidence/v2'],
    ['extra', true],
  ]) {
    let invoked = false;
    await assert.rejects(inspectKeyFreeReceiptAttestation({
      receiptBytes: bytes({ ...receipt, [key]: value }), expected,
      verify: async () => { invoked = true; return Buffer.from('[]'); },
    }), /KEYFREE_RECEIPT_CONSUMER_REFUSED/);
    assert.equal(invoked, false, key);
  }
});

test('rejects unbound run IDs, policy and malformed expected authority', async () => {
  for (const changes of [
    { verifierRunId: '500' }, { verifierRunId: '0' },
    { sourceRunId: '501' }, { sourceSha: 'b'.repeat(40) },
    { policySha256: '0'.repeat(64) }, { candidateSha256: '0'.repeat(64) },
    { manifestSha256: '0'.repeat(64) }, { verifiedAt: '0' }, { extra: true },
  ]) await assert.rejects(inspect(receipt, { ...expected, ...changes }),
    /KEYFREE_RECEIPT_CONSUMER_REFUSED/);
});

test('rejects a verifier result with a different OIDC workflow, run or subject', async () => {
  for (const mutate of [
    item => { item.verificationResult.signature.certificate.buildSignerURI = 'https://example.com/other'; },
    item => { item.verificationResult.signature.certificate.runInvocationURI = 'https://github.com/engasnm111/lnwjud/actions/runs/500/attempts/1'; },
    item => { item.verificationResult.signature.certificate.sourceRepositoryDigest = 'b'.repeat(40); },
    item => { item.verificationResult.signature.certificate.runnerEnvironment = 'self-hosted'; },
    item => { item.verificationResult.statement.subject[0].digest.sha256 = '0'.repeat(64); },
    item => { item.verificationResult.verifiedTimestamps = []; },
  ]) await assert.rejects(inspect(receipt, expected, mutate), /KEYFREE_RECEIPT_CONSUMER_REFUSED/);
});

test('snapshots caller metadata and receipt bytes across asynchronous verification', async () => {
  const mutable = { ...expected };
  const original = bytes(receipt);
  const output = await inspectKeyFreeReceiptAttestation({
    receiptBytes: original, expected: mutable,
    verify: async args => {
      mutable.verifierRunId = '601';
      mutable.verifiedAt = '1';
      original.fill(0);
      assert.equal(args.receiptBytes.toString(), bytes(receipt).toString());
      return verified(args);
    },
  });
  assert.equal(output.verifierRunId, '600');
});

test('refuses signer secret present before or injected during receipt verification', async () => {
  const key = 'LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM';
  const before = process.env[key];
  try {
    process.env[key] = 'test-only';
    await assert.rejects(inspect(), /KEYFREE_RECEIPT_CONSUMER_REFUSED/);
    delete process.env[key];
    await assert.rejects(inspectKeyFreeReceiptAttestation({
      receiptBytes: bytes(receipt), expected,
      verify: async args => {
        process.env[key] = 'test-only';
        return verified(args);
      },
    }), /KEYFREE_RECEIPT_CONSUMER_REFUSED/);
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
});

test('rejects unauthenticated or duplicated verification output', async () => {
  await assert.rejects(inspectKeyFreeReceiptAttestation({
    receiptBytes: bytes(receipt), expected, verify: async () => Buffer.from('[]'),
  }), /KEYFREE_RECEIPT_CONSUMER_REFUSED/);
  await assert.rejects(inspectKeyFreeReceiptAttestation({
    receiptBytes: bytes(receipt), expected,
    verify: async args => { const item = JSON.parse(verified(args).toString())[0]; return bytes([item, item]); },
  }), /KEYFREE_RECEIPT_CONSUMER_REFUSED/);
});
