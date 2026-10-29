import { Buffer } from 'node:buffer';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { canonicalBase64, hash, loadProductionPolicy, parseStrictJson, refuse, requireConfigured, rootKey } from './release-envelope.mjs';
import { authenticateAuthorizationV2, inspectAuthorizationPayloadV2 } from './release-authorization-v2.mjs';
import { publishEnvelope } from './produce-release-envelope.mjs';
import { authenticateBuildEvidence, readBoundedFile } from './verify-build-evidence.mjs';

export function validatePreviousTimeV2(previous, policy, now) {
  if (typeof now !== 'bigint' || now < BigInt(previous.payload.issuedAt) || now > 253402300799n) refuse('RELEASE_TIME_INVALID');
  const root = policy.roots.find(item => item.keyId === previous.keyId);
  if (root === undefined || root.revoked !== false || !root.roles.includes('recovery')) refuse('RELEASE_KEY_UNTRUSTED');
  if ((now >= BigInt(previous.payload.expiresAt) || now >= BigInt(root.expiresAt)) && !root.allowHistoricalRecovery)
    refuse('RELEASE_HISTORICAL_BASELINE_UNAUTHORIZED');
}

export function authenticatePreviousMetadataV2(candidate, envelopeBytes, purpose, policy, now) {
  if (!Buffer.isBuffer(envelopeBytes) || envelopeBytes.length > 49152) refuse('RELEASE_JSON_INVALID');
  const snapshot = Buffer.from(envelopeBytes);
  const outer = parseStrictJson(snapshot, 49152, 12);
  const unsigned = parseStrictJson(canonicalBase64(outer.payload, 32768), 32768, 12);
  if (typeof unsigned.issuedAt !== 'string' || !/^(?:0|[1-9][0-9]{0,11})$/.test(unsigned.issuedAt)
    || BigInt(unsigned.issuedAt) > now) refuse('RELEASE_PREVIOUS_UNTRUSTED');
  const previous = authenticateAuthorizationV2(snapshot, policy, BigInt(unsigned.issuedAt), purpose);
  validatePreviousTimeV2(previous, policy, now);
  const oldRelease = previous.payload.release;
  const newRelease = candidate.payload.release;
  if (candidate.payload.kind !== 'update' || candidate.payload.recovery.previousReleaseIdentity !== previous.identitySha256)
    refuse('RELEASE_PREVIOUS_UNTRUSTED');
  const oldVersion = oldRelease.version.split('.').map(BigInt);
  const newVersion = newRelease.version.split('.').map(BigInt);
  const difference = newVersion.findIndex((part, index) => part !== oldVersion[index]);
  if (difference < 0 || newVersion[difference] <= oldVersion[difference]
    || BigInt(newRelease.releaseSequence) <= BigInt(oldRelease.releaseSequence)) refuse('RELEASE_REPLAY');
  for (const name of ['platform', 'architecture', 'distribution'])
    if (oldRelease[name] !== newRelease[name]) refuse('RELEASE_PREVIOUS_UNTRUSTED');
  for (const name of ['migrationContractSha256', 'workerContractSha256', 'serviceContractSha256'])
    if (oldRelease.compatibility[name] !== newRelease.compatibility[name]) refuse('RELEASE_RECOVERY_CONTRACT_UNSUPPORTED');
  return previous;
}

export async function authenticatePreviousV2(candidate, paths, policy, now) {
  const original = await readBoundedFile(paths.previousEnvelope, 49152n);
  const previous = authenticatePreviousMetadataV2(candidate, original.bytes, paths.previousPurpose, policy, now);
  const oldRelease = previous.payload.release;
  for (const kind of ['artifact', 'provenance']) {
    const expected = oldRelease[kind];
    const filename = paths[kind === 'artifact' ? 'previousArtifact' : 'previousProvenance'];
    const actual = await readBoundedFile(filename, BigInt(expected.sizeBytes));
    if (path.basename(filename) !== expected.name || actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes)
      refuse('RELEASE_PREVIOUS_UNTRUSTED');
  }
  return previous;
}

export async function produceReleaseAuthorizationV2(options) {
  let secret;
  try {
    options = snapshotOptions(options);
    const policy = loadProductionPolicy();
    requireConfigured(policy);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const source = await readBoundedFile(options.payload, 32768n);
    const inspected = inspectAuthorizationPayloadV2(source.bytes, policy, now, options.purpose, options.keyId);
    let previous;
    if (options.purpose === 'update') previous = await authenticatePreviousV2(inspected, options, policy, now);
    await authenticateBuildEvidence({ ...inspected.payload.release, issuedAt: inspected.payload.issuedAt }, options, policy);
    if ((await readBoundedFile(options.payload, 32768n)).sha256 !== source.sha256) refuse('RELEASE_INPUT_CHANGED');
    if (options.purpose === 'update') previous = await authenticatePreviousV2(inspected, options, policy, BigInt(Math.floor(Date.now() / 1000)));
    const signingTime = BigInt(Math.floor(Date.now() / 1000));
    inspectAuthorizationPayloadV2(source.bytes, policy, signingTime, options.purpose, options.keyId);
    if (previous) validatePreviousTimeV2(previous, policy, signingTime);
    const { spki } = rootKey(policy, options.keyId, signingTime);
    secret = process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM;
    delete process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM;
    if (typeof secret !== 'string' || secret.length === 0 || secret.length > 16384) refuse('RELEASE_SIGNER_INVALID');
    const keyBytes = Buffer.from(secret, 'utf8'); secret = undefined;
    let bytes;
    try {
      const key = createPrivateKey(keyBytes);
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
        || !createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(spki)) refuse('RELEASE_SIGNER_INVALID');
      const signature = sign('sha256', Buffer.concat([Buffer.from('lnwjud-update-release-v2\0', 'ascii'), source.bytes]), { key, dsaEncoding: 'ieee-p1363' });
      bytes = Buffer.from(JSON.stringify({ protocol: 2, keyId: options.keyId, payload: source.bytes.toString('base64'), signature: signature.toString('base64') }));
    } finally { keyBytes.fill(0); }
    const authenticated = authenticateAuthorizationV2(bytes, policy, signingTime, options.purpose);
    if (authenticated.identitySha256 !== inspected.identitySha256) refuse('RELEASE_INPUT_CHANGED');
    await publishEnvelope(options.output, bytes, () => {
      const publicationTime = BigInt(Math.floor(Date.now() / 1000));
      authenticateAuthorizationV2(bytes, policy, publicationTime, options.purpose);
      if (previous) validatePreviousTimeV2(previous, policy, publicationTime);
    });
    return { envelopeSha256: hash(bytes), identitySha256: authenticated.identitySha256 };
  } finally {
    delete process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM;
    secret = undefined;
  }
}

const common = ['purpose', 'payload', 'artifact', 'provenance', 'artifactBundle', 'provenanceBundle', 'keyId', 'output'];
const previous = ['previousPurpose', 'previousEnvelope', 'previousArtifact', 'previousProvenance'];
export function parseArgumentsV2(args) {
  if (args.length % 2 !== 0) refuse('RELEASE_ARGUMENTS_INVALID');
  const result = Object.create(null);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index].slice(2);
    if (!args[index].startsWith('--') || ![...common, ...previous].includes(name) || Object.hasOwn(result, name)
      || typeof args[index + 1] !== 'string' || args[index + 1].length === 0 || args[index + 1].length > 4096) refuse('RELEASE_ARGUMENTS_INVALID');
    result[name] = args[index + 1];
  }
  if (!['baseline', 'update'].includes(result.purpose)) refuse('RELEASE_ARGUMENTS_INVALID');
  const required = result.purpose === 'update' ? [...common, ...previous] : common;
  if (Object.keys(result).length !== required.length || required.some(name => !Object.hasOwn(result, name))
    || result.purpose === 'update' && !['baseline', 'update'].includes(result.previousPurpose)) refuse('RELEASE_ARGUMENTS_INVALID');
  return result;
}

function snapshotOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) refuse('RELEASE_ARGUMENTS_INVALID');
  const args = [];
  for (const name of Reflect.ownKeys(options)) {
    if (typeof name !== 'string') refuse('RELEASE_ARGUMENTS_INVALID');
    const descriptor = Object.getOwnPropertyDescriptor(options, name);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') refuse('RELEASE_ARGUMENTS_INVALID');
    args.push(`--${name}`, descriptor.value);
  }
  return Object.freeze(parseArgumentsV2(args));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await produceReleaseAuthorizationV2(parseArgumentsV2(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    delete process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM;
    const code = /^RELEASE_[A-Z_]+$/.test(error?.message) ? error.message : 'RELEASE_PRODUCTION_REFUSED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
