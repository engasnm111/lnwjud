import { lstat, readdir, realpath } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { canonicalBase64, hash, parseStrictJson, refuse } from './release-envelope.mjs';
import { authenticatePreviousMetadataV2 } from './produce-release-authorization-v2.mjs';
import { inspectManifestCandidate, parseSigningVerificationManifest } from './signing-verification-manifest.mjs';
import { readBoundedFile } from './verify-build-evidence.mjs';

async function directory(root, name, roles) {
  const location = path.join(root, name);
  const info = await lstat(location);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(location) !== location) refuse('SIGNING_FILES_INVALID');
  const entries = await readdir(location, { withFileTypes: true });
  const expected = Object.values(roles).map(item => item.name).sort();
  if (entries.some(item => !item.isFile()) || entries.map(item => item.name).sort().join('\0') !== expected.join('\0'))
    refuse('SIGNING_FILES_INVALID');
  return location;
}

async function readRoles(location, roles) {
  const result = Object.create(null);
  for (const [role, expected] of Object.entries(roles)) {
    const actual = await readBoundedFile(path.join(location, expected.name), BigInt(expected.sizeBytes));
    if (actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes) refuse('SIGNING_FILES_INVALID');
    result[role] = actual;
  }
  return result;
}

export async function inspectSigningFiles(root, manifestBytes, policyBytes, observeTime, keyId, expectedManifestSha256,
  expectedRepositoryId, expectedRunId, expectedAttempt) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !Buffer.isBuffer(manifestBytes) || manifestBytes.length > 32768
    || !Buffer.isBuffer(policyBytes) || policyBytes.length > 65536 || typeof expectedManifestSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(expectedManifestSha256) || typeof observeTime !== 'function') refuse('SIGNING_FILES_INVALID');
  const started = observeTime();
  if (typeof started !== 'bigint' || started < 0n || started > 253402300799n) refuse('SIGNING_FILES_INVALID');
  const manifestSnapshot = Buffer.from(manifestBytes), policySnapshot = Buffer.from(policyBytes);
  if (hash(manifestSnapshot) !== expectedManifestSha256) refuse('SIGNING_FILES_INVALID');
  const manifest = parseSigningVerificationManifest(manifestSnapshot);
  if (manifest.verification.repositoryId !== expectedRepositoryId || manifest.verification.runId !== expectedRunId
    || String(manifest.verification.runAttempt) !== expectedAttempt) refuse('SIGNING_FILES_INVALID');
  const location = path.resolve(root), info = await lstat(location);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(location) !== location) refuse('SIGNING_FILES_INVALID');
  const entries = await readdir(location, { withFileTypes: true });
  const expected = manifest.purpose === 'update' ? ['candidate', 'predecessor'] : ['candidate'];
  if (entries.some(item => !item.isDirectory()) || entries.map(item => item.name).sort().join('\0') !== expected.join('\0'))
    refuse('SIGNING_FILES_INVALID');
  const candidateDirectory = await directory(location, 'candidate', manifest.candidate);
  const candidateFiles = await readRoles(candidateDirectory, manifest.candidate);
  let previousFiles;
  if (manifest.purpose === 'update') {
    const previousDirectory = await directory(location, 'predecessor', manifest.predecessor);
    previousFiles = await readRoles(previousDirectory, manifest.predecessor);
  }
  const completed = observeTime();
  if (typeof completed !== 'bigint' || completed < started || completed > 253402300799n) refuse('SIGNING_FILES_INVALID');
  const candidate = inspectManifestCandidate(manifestSnapshot, candidateFiles.candidate.bytes, policySnapshot, completed, keyId);
  let previousIdentity;
  if (previousFiles !== undefined) {
    const outer = parseStrictJson(previousFiles.envelope.bytes, 49152, 12);
    const payload = parseStrictJson(canonicalBase64(outer.payload, 32768), 32768, 12);
    if (!['baseline', 'update'].includes(payload.kind)) refuse('SIGNING_FILES_INVALID');
    const policy = parseStrictJson(policySnapshot, 65536);
    const previous = authenticatePreviousMetadataV2(candidate, previousFiles.envelope.bytes, payload.kind, policy, completed);
    for (const role of ['artifact', 'provenance']) {
      const declared = previous.payload.release[role], observed = manifest.predecessor[role];
      if (declared.name !== observed.name || declared.sha256 !== observed.sha256 || declared.sizeBytes !== observed.sizeBytes)
        refuse('SIGNING_FILES_INVALID');
    }
    previousIdentity = previous.identitySha256;
  }
  return Object.freeze({ status: 'diagnostic-only', candidateIdentitySha256: candidate.identitySha256,
    ...(previousIdentity === undefined ? {} : { previousIdentitySha256: previousIdentity }) });
}
