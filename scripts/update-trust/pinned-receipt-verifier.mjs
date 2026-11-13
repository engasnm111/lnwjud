import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStrictJson, refuse } from './release-envelope.mjs';
import { readBoundedFile } from './verify-build-evidence.mjs';
import { acquirePinnedVerifier } from './pinned-verifier.mjs';
import { inspectKeyFreeReceiptAttestation } from './keyfree-receipt-consumer.mjs';

const policyPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../config/update-release-policy.json');
const expectedKeys = ['candidateSha256', 'manifestSha256', 'policySha256', 'sourceRunId',
  'sourceSha', 'verifiedAt', 'verifierRunId'];
const receiptMaximum = 2048n;
const bundleMaximum = 16n * 1024n * 1024n;

function snapshotExpected(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('KEYFREE_RECEIPT_PINNED_VERIFIER_REFUSED');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).sort().join(',') !== expectedKeys.join(',')
    || expectedKeys.some(key => !Object.prototype.hasOwnProperty.call(descriptors[key], 'value') || typeof descriptors[key].value !== 'string'))
    refuse('KEYFREE_RECEIPT_PINNED_VERIFIER_REFUSED');
  return Object.freeze(Object.fromEntries(expectedKeys.map(key => [key, descriptors[key].value])));
}

// These flags constrain the real GitHub CLI's certificate verification.
// The caller-supplied expected run is still NOT an authenticated signing authority.
export function receiptAttestationArgs(receiptPath, bundlePath, source, authority) {
  return ['attestation', 'verify', receiptPath, '--repo', 'engasnm111/lnwjud',
    '--bundle', bundlePath, '--cert-oidc-issuer', authority.issuer,
    '--signer-workflow', authority.builderWorkflowUri.replace('https://github.com/', '').split('@')[0],
    '--signer-digest', authority.builderDigest, '--source-digest', source.commit,
    '--source-ref', source.ref, '--deny-self-hosted-runners',
    '--predicate-type', 'https://slsa.dev/provenance/v1', '--format', 'json'];
}

// Metadata-only diagnostic. No signing key, release permission, artifact acquisition,
// independent signer identity or installed updater transaction is supplied here.
export async function inspectPinnedKeyFreeReceipt({ receiptPath, bundlePath, expected }) {
  const bound = snapshotExpected(expected);
  if (typeof receiptPath !== 'string' || typeof bundlePath !== 'string'
    || !path.isAbsolute(receiptPath) || !path.isAbsolute(bundlePath)
    || path.basename(receiptPath) !== 'receipt.json'
    || path.basename(bundlePath) !== 'receipt.bundle.json'
    || path.dirname(receiptPath) !== path.dirname(bundlePath)
    || receiptPath === bundlePath) refuse('KEYFREE_RECEIPT_PINNED_VERIFIER_REFUSED');

  const policyBytes = (await readBoundedFile(policyPath, 65536n)).bytes;
  const policy = parseStrictJson(policyBytes, 65536, 16);
  const configured = policy.verifier;
  if (configured?.filename !== 'gh.exe' || configured.version !== '2.103.3'
    || configured.sha256 !== 'd303d8ac3f5e9438bf7c977b64dd6425513eae46218f8881d30694f28c1d0dfd')
    refuse('KEYFREE_RECEIPT_PINNED_VERIFIER_REFUSED');

  const session = await acquirePinnedVerifier(configured);
  try {
    const version = (await session.run(['version'])).toString('utf8').split(/\r?\n/)[0];
    if (!version.startsWith(`gh version ${configured.version} `)) refuse('KEYFREE_RECEIPT_PINNED_VERIFIER_REFUSED');
    await session.pinInputs([receiptPath, bundlePath]);
    const beforeReceipt = await readBoundedFile(receiptPath, receiptMaximum);
    const beforeBundle = await readBoundedFile(bundlePath, bundleMaximum);
    const selected = await inspectKeyFreeReceiptAttestation({
      receiptBytes: beforeReceipt.bytes, expected: bound,
      verify: ({ source, authority }) => session.run(
        receiptAttestationArgs(receiptPath, bundlePath, source, authority)),
    });
    const afterReceipt = await readBoundedFile(receiptPath, receiptMaximum);
    const afterBundle = await readBoundedFile(bundlePath, bundleMaximum);
    if (beforeReceipt.sha256 !== afterReceipt.sha256 || beforeReceipt.sizeBytes !== afterReceipt.sizeBytes
      || beforeBundle.sha256 !== afterBundle.sha256 || beforeBundle.sizeBytes !== afterBundle.sizeBytes)
      refuse('KEYFREE_RECEIPT_PINNED_VERIFIER_REFUSED');
    return selected;
  } finally {
    await session.close();
  }
}
