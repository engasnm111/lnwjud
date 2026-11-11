import { Buffer } from 'node:buffer';
import { hash, parseStrictJson } from './release-envelope.mjs';
import { selectVerifiedAttestation } from './verify-build-evidence.mjs';

const repository = 'https://github.com/engasnm111/lnwjud';
const workflow = `${repository}/.github/workflows/update-signing.yml@refs/heads/main`;
const builderSha = 'cd833d7df45a8ecf2e87bc89ffb9ee3c85d20406';
const receiptFields = [
  'builderSha', 'candidateSha256', 'manifestSha256', 'policySha256',
  'schema', 'sourceRunId', 'sourceSha', 'status',
];
const expectedFields = [
  'candidateSha256', 'manifestSha256', 'policySha256', 'sourceRunId',
  'sourceSha', 'verifiedAt', 'verifierRunId',
];
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha1 = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const runId = value => typeof value === 'string' && /^[1-9][0-9]{0,14}$/.test(value)
  && Number.isSafeInteger(Number(value));
const shape = (value, keys) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.join(',');
const refuse = () => { throw new Error('KEYFREE_RECEIPT_CONSUMER_REFUSED'); };

/**
 * Read-only receipt consumer for a future independent signer. The callback
 * MUST be backed by an independently pinned verifier that checks the actual
 * receipt and bundle. Caller-provided JSON or a mocked callback is not proof
 * of signature verification, OS identity isolation or signing authority.
 * Never use this diagnostic result to enable production authorities.
 */
export async function inspectKeyFreeReceiptAttestation({ receiptBytes, expected, verify }) {
  if (!Buffer.isBuffer(receiptBytes) || receiptBytes.length > 2048
    || !shape(expected, expectedFields) || typeof verify !== 'function'
    || !sha1(expected.sourceSha) || !runId(expected.sourceRunId)
    || !runId(expected.verifierRunId) || expected.sourceRunId === expected.verifierRunId
    || !runId(expected.verifiedAt) || !sha256(expected.policySha256)
    || !sha256(expected.candidateSha256) || !sha256(expected.manifestSha256)) refuse();
  // Snapshot mutable caller metadata before invoking asynchronous verification.
  const bound = Object.freeze(Object.fromEntries(expectedFields.map(key => [key, expected[key]])));
  const boundReceiptBytes = Buffer.from(receiptBytes);
  let receipt;
  try { receipt = parseStrictJson(boundReceiptBytes, 2048, 4); } catch { refuse(); }
  if (!shape(receipt, receiptFields)
    || receipt.schema !== 'lnwjud.keyfree-evidence/v1'
    || receipt.status !== 'key-free-attestations-observed-only'
    || receipt.sourceSha !== bound.sourceSha
    || receipt.sourceRunId !== bound.sourceRunId
    || receipt.builderSha !== builderSha
    || receipt.policySha256 !== bound.policySha256
    || receipt.candidateSha256 !== bound.candidateSha256
    || receipt.manifestSha256 !== bound.manifestSha256) refuse();

  // The attestation belongs to the separate verifier workflow run, not to
  // the earlier package-builder/source CI run recorded in the receipt.
  const identity = Object.freeze({ name: 'receipt.json', sha256: hash(boundReceiptBytes) });
  const source = Object.freeze({
    repository, workflow: '.github/workflows/update-signing.yml',
    ref: 'refs/heads/main', commit: bound.sourceSha,
    runId: bound.verifierRunId, runAttempt: '1',
  });
  const authority = Object.freeze({
    issuer: 'https://token.actions.githubusercontent.com',
    builderWorkflowUri: workflow, builderDigest: bound.sourceSha,
    buildConfigUri: workflow, buildConfigDigestRule: 'source-commit',
  });
  let output;
  try {
    output = await verify({ identity, source, authority, receiptBytes: Buffer.from(boundReceiptBytes) });
    if (!Buffer.isBuffer(output)
      || selectVerifiedAttestation(output, { source, issuedAt: bound.verifiedAt },
        identity, authority) !== 1) refuse();
  } catch { refuse(); }
  return Object.freeze({
    schema: 'lnwjud.keyfree-receipt-consumer/v1',
    status: 'receipt-attestation-metadata-matched-only',
    receiptSha256: identity.sha256, sourceSha: receipt.sourceSha,
    sourceRunId: receipt.sourceRunId, verifierRunId: bound.verifierRunId,
    policySha256: receipt.policySha256, candidateSha256: receipt.candidateSha256,
    manifestSha256: receipt.manifestSha256,
  });
}
