import { open, realpath, link, unlink } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { authenticateEnvelope, authenticateHistoricalEnvelope, hash, loadProductionPolicy, parseStrictJson,
  refuse, requireConfigured, schema, signAuthenticatedPayload, validateRelationships } from './release-envelope.mjs';
import { authenticateBuildEvidence, readBoundedFile } from './verify-build-evidence.mjs';

export async function authenticatePrevious(payload, paths, policy, now) {
  const envelope = await readBoundedFile(paths.previousEnvelope, BigInt(schema.limits.envelopeBytes));
  let previous;
  try { previous = authenticateEnvelope(envelope.bytes, policy, now); }
  catch (error) {
    if (!['RELEASE_TIME_INVALID', 'RELEASE_KEY_UNTRUSTED'].includes(error.message)) throw error;
    previous = authenticateHistoricalEnvelope(envelope.bytes, policy, now);
  }
  const expected = payload.previous;
  if (previous.envelopeSha256 !== expected.envelopeSha256 || previous.payload.version !== expected.version
    || previous.payload.releaseSequence !== expected.releaseSequence) refuse('RELEASE_PREVIOUS_UNTRUSTED');
  for (const kind of ['artifact', 'provenance']) {
    const actual = await readBoundedFile(paths[kind === 'artifact' ? 'previousArtifact' : 'previousProvenance'], BigInt(expected[kind].sizeBytes));
    if (previous.payload[kind].name !== expected[kind].name || previous.payload[kind].sha256 !== expected[kind].sha256
      || previous.payload[kind].sizeBytes !== expected[kind].sizeBytes || actual.sha256 !== expected[kind].sha256
      || actual.sizeBytes !== expected[kind].sizeBytes) refuse('RELEASE_PREVIOUS_UNTRUSTED');
  }
  return previous;
}

export async function publishEnvelope(filename, bytes) {
  const destination = path.resolve(filename);
  const directory = path.dirname(destination);
  if (await realpath(directory) !== directory) refuse('RELEASE_OUTPUT_INVALID');
  const temporary = path.join(directory, `.lnwjud-release-${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await link(temporary, destination);
  } finally {
    if (created) await unlink(temporary);
  }
}

export async function produceReleaseEnvelope(options) {
  const policy = loadProductionPolicy();
  requireConfigured(policy);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const source = await readBoundedFile(options.payload, BigInt(schema.limits.payloadBytes));
  const payload = parseStrictJson(source.bytes, schema.limits.payloadBytes);
  validateRelationships(payload, policy, now);
  await authenticatePrevious(payload, options, policy, now);
  await authenticateBuildEvidence(payload, options, policy);
  if (hash((await readBoundedFile(options.payload, BigInt(schema.limits.payloadBytes))).bytes) !== source.sha256) refuse('RELEASE_INPUT_CHANGED');
  let secret;
  try {
    secret = process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM;
    delete process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM;
    if (typeof secret !== 'string' || secret.length === 0 || secret.length > 16384) refuse('RELEASE_SIGNER_INVALID');
    const keyBytes = Buffer.from(secret, 'utf8');
    secret = undefined;
    let bytes;
    try { bytes = signAuthenticatedPayload(payload, policy, options.keyId, keyBytes, BigInt(Math.floor(Date.now() / 1000))); }
    finally { keyBytes.fill(0); }
    await publishEnvelope(options.output, bytes);
    return { envelopeSha256: hash(bytes) };
  } finally {
    delete process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM;
    secret = undefined;
  }
}

const required = ['payload', 'artifact', 'provenance', 'artifactBundle', 'provenanceBundle', 'previousEnvelope',
  'previousArtifact', 'previousProvenance', 'keyId', 'output'];

export function parseArguments(args) {
  if (args.length !== required.length * 2) refuse('RELEASE_ARGUMENTS_INVALID');
  const options = Object.create(null);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index].slice(2);
    if (!args[index].startsWith('--') || !required.includes(key) || Object.hasOwn(options, key)
      || typeof args[index + 1] !== 'string' || args[index + 1].length === 0 || args[index + 1].length > 4096) refuse('RELEASE_ARGUMENTS_INVALID');
    options[key] = args[index + 1];
  }
  return options;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await produceReleaseEnvelope(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    delete process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM;
    const code = /^RELEASE_[A-Z_]+$/.test(error?.message) ? error.message : 'RELEASE_PRODUCTION_REFUSED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
