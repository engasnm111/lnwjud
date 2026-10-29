import { Buffer } from 'node:buffer';
import { hash, parseStrictJson, refuse } from './release-envelope.mjs';
import { inspectAuthorizationPayloadV2 } from './release-authorization-v2.mjs';

const candidateRoles = ['candidate', 'artifact', 'provenance', 'artifactBundle', 'provenanceBundle'];
const predecessorRoles = ['envelope', 'artifact', 'provenance'];
const limits = { candidate: 32768n, envelope: 49152n, artifact: 2147483648n, provenance: 1048576n,
  artifactBundle: 16777216n, provenanceBundle: 16777216n };
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function files(value, roles) {
  if (!exact(value, roles)) refuse('SIGNING_MANIFEST_INVALID');
  const names = new Set();
  for (const role of roles) {
    const item = value[role];
    if (!exact(item, ['name', 'sizeBytes', 'sha256']) || typeof item.name !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.name) || /[. ]$/.test(item.name)
      || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(item.name)
      || !decimal(item.sizeBytes) || BigInt(item.sizeBytes) > limits[role] || !digest(item.sha256)
      || names.has(item.name.toLowerCase())) refuse('SIGNING_MANIFEST_INVALID');
    names.add(item.name.toLowerCase());
  }
}

export function parseSigningVerificationManifest(bytes) {
  const result = parseStrictJson(bytes, 32768, 8);
  if (!exact(result, ['schema', 'verification', 'policySha256', 'purpose', 'candidate', ...(result?.purpose === 'update' ? ['predecessor'] : [])])
    || result.schema !== 'lnwjud.signing-verification/v1' || !['baseline', 'update'].includes(result.purpose)
    || !digest(result.policySha256) || !exact(result.verification, ['repositoryId', 'runId', 'runAttempt'])
    || !decimal(result.verification.repositoryId) || !decimal(result.verification.runId)
    || !Number.isSafeInteger(result.verification.runAttempt) || result.verification.runAttempt < 1) refuse('SIGNING_MANIFEST_INVALID');
  files(result.candidate, candidateRoles);
  if (result.purpose === 'update') files(result.predecessor, predecessorRoles);
  return freeze(result);
}

export function inspectManifestCandidate(manifestBytes, candidateBytes, policyBytes, now, keyId) {
  const manifest = parseSigningVerificationManifest(manifestBytes);
  if (!Buffer.isBuffer(candidateBytes) || candidateBytes.length > 32768 || !Buffer.isBuffer(policyBytes) || policyBytes.length > 65536)
    refuse('SIGNING_MANIFEST_BINDING_INVALID');
  const candidate = Buffer.from(candidateBytes), policySnapshot = Buffer.from(policyBytes);
  if (hash(policySnapshot) !== manifest.policySha256 || hash(candidate) !== manifest.candidate.candidate.sha256
    || String(candidate.length) !== manifest.candidate.candidate.sizeBytes) refuse('SIGNING_MANIFEST_BINDING_INVALID');
  const policy = parseStrictJson(policySnapshot, 65536);
  const inspected = inspectAuthorizationPayloadV2(candidate, policy, now, manifest.purpose, keyId);
  for (const role of ['artifact', 'provenance']) {
    const declared = inspected.payload.release[role], actual = manifest.candidate[role];
    if (declared.name !== actual.name || declared.sha256 !== actual.sha256 || declared.sizeBytes !== actual.sizeBytes
      || inspected.payload.release.buildEvidence[`${role}AttestationSha256`] !== manifest.candidate[`${role}Bundle`].sha256)
      refuse('SIGNING_MANIFEST_BINDING_INVALID');
  }
  return inspected;
}
