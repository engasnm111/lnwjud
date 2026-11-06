import { Buffer } from 'node:buffer';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { canonicalBase64, hash, parseStrictJson, refuse, requireConfigured } from './release-envelope.mjs';
import { inspectAuthorizationPayloadV2 } from './release-authorization-v2.mjs';
import { authenticatePreviousMetadataV2 } from './produce-release-authorization-v2.mjs';
import { inspectSigningFiles } from './signing-files-diagnostic.mjs';
import { parseSigningVerificationManifest } from './signing-verification-manifest.mjs';
import { readBoundedFile } from './verify-build-evidence.mjs';

const id = value => typeof value === 'string' && /^[1-9][0-9]{0,14}$/.test(value) && Number.isSafeInteger(Number(value));
const limit = { candidate: 32768n, artifact: 2147483648n, provenance: 1048576n,
  artifactBundle: 16777216n, provenanceBundle: 16777216n, envelope: 49152n };

async function fixedDirectory(location, names) {
  const meta = await lstat(location);
  if (!meta.isDirectory() || meta.isSymbolicLink() || await realpath(location) !== location)
    refuse('SIGNING_MANIFEST_PRODUCTION_REFUSED');
  const entries = await readdir(location, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile() && !entry.isDirectory())
    || entries.map(entry => entry.name).sort().join('\0') !== [...names].sort().join('\0'))
    refuse('SIGNING_MANIFEST_PRODUCTION_REFUSED');
}

async function boundRole(root, role, name) {
  const data = await readBoundedFile(path.join(root, name), limit[role]);
  return Object.freeze({ name, sha256: data.sha256, sizeBytes: data.sizeBytes });
}

async function roleSet(root, roles) {
  const files = Object.fromEntries(await Promise.all(Object.entries(roles)
    .map(async ([role, name]) => [role, await boundRole(root, role, name)])));
  await fixedDirectory(root, Object.values(roles));
  return files;
}

/**
 * Construct a manifest for key-free verification, NEVER an authorization or signing receipt.
 * The verification run identity is a caller claim; it must be independently checked against
 * GitHub's exact protected run, attempt, jobs and artifact ownership before any signing.
 */
export async function constructSigningVerificationManifest({
  root, policyBytes, keyId, repositoryId, runId, runAttempt, observeTime,
}) {
  if (Object.keys(process.env).some(name => name.toUpperCase() === 'LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM')
    || typeof root !== 'string' || !path.isAbsolute(root) || !Buffer.isBuffer(policyBytes)
    || policyBytes.length > 65536 || typeof keyId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(keyId)
    || !id(repositoryId) || !id(runId) || !Number.isSafeInteger(runAttempt) || runAttempt !== 1
    || typeof observeTime !== 'function')
    refuse('SIGNING_MANIFEST_PRODUCTION_REFUSED');
  let previousTime = -1n;
  const readTime = () => {
    const now = observeTime();
    if (typeof now !== 'bigint' || now < previousTime || now > 253402300799n)
      refuse('SIGNING_MANIFEST_PRODUCTION_REFUSED');
    previousTime = now;
    return now;
  };
  const initialTime = readTime();
  const policy = parseStrictJson(policyBytes, 65536);
  requireConfigured(policy);
  const location = path.resolve(root), candidatePath = path.join(location, 'candidate');
  const raw = await readBoundedFile(path.join(candidatePath, 'CANDIDATE.json'), limit.candidate);
  const unsigned = parseStrictJson(raw.bytes, 32768, 12);
  if (unsigned?.kind !== 'baseline' && unsigned?.kind !== 'update') refuse('SIGNING_MANIFEST_PRODUCTION_REFUSED');
  const inspected = inspectAuthorizationPayloadV2(raw.bytes, policy, initialTime, unsigned.kind, keyId);
  const candidate = inspected.payload.release;
  const candidateFiles = await roleSet(candidatePath, {
    candidate: 'CANDIDATE.json', artifact: candidate.artifact.name, provenance: 'PROVENANCE.json',
    artifactBundle: 'artifact.bundle.json', provenanceBundle: 'provenance.bundle.json',
  });
  let predecessorFiles;
  if (unsigned.kind === 'update') {
    const predecessorPath = path.join(location, 'predecessor');
    const original = await readBoundedFile(path.join(predecessorPath, 'RELEASE.json'), limit.envelope);
    const outer = parseStrictJson(original.bytes, 49152, 12);
    const previous = parseStrictJson(canonicalBase64(outer.payload, 32768), 32768, 12);
    if (previous.kind !== 'baseline' && previous.kind !== 'update') refuse('SIGNING_MANIFEST_PRODUCTION_REFUSED');
    const authenticated = authenticatePreviousMetadataV2(inspected, original.bytes, previous.kind, policy, readTime());
    predecessorFiles = await roleSet(predecessorPath, {
      envelope: 'RELEASE.json', artifact: authenticated.payload.release.artifact.name, provenance: 'PROVENANCE.json',
    });
  }
  await fixedDirectory(location, unsigned.kind === 'update' ? ['candidate', 'predecessor'] : ['candidate']);
  const value = {
    schema: 'lnwjud.signing-verification/v1',
    verification: { repositoryId, runId, runAttempt }, policySha256: hash(policyBytes),
    purpose: unsigned.kind, candidate: candidateFiles, ...(predecessorFiles === undefined ? {} : { predecessor: predecessorFiles }),
  };
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  parseSigningVerificationManifest(bytes);
  const digest = hash(bytes);
  const inspectedFiles = await inspectSigningFiles(location, bytes, policyBytes, readTime,
    keyId, digest, repositoryId, runId, String(runAttempt));
  if (inspectedFiles.candidateIdentitySha256 !== inspected.identitySha256)
    refuse('SIGNING_MANIFEST_PRODUCTION_REFUSED');
  return Object.freeze({ status: 'diagnostic-only', bytes, sha256: digest,
    candidateIdentitySha256: inspected.identitySha256 });
}
