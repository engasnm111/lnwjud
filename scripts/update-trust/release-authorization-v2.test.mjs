import test from 'node:test';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { authenticateAuthorizationV2, inspectAuthorizationPayloadV2 } from './release-authorization-v2.mjs';
import { authenticatePreviousMetadataV2, authenticatePreviousV2, parseArgumentsV2, produceReleaseAuthorizationV2, validatePreviousTimeV2 } from './produce-release-authorization-v2.mjs';
import { publishEnvelope } from './produce-release-envelope.mjs';
import { hash, loadProductionPolicy } from './release-envelope.mjs';

const fixture = JSON.parse(await readFile(new URL('../../tests/fixtures/update-release/release-identity-v1.json', import.meta.url), 'utf8'));
const interop = JSON.parse(await readFile(new URL('../../tests/fixtures/update-release/authorization-v2.json', import.meta.url), 'utf8'));
const now = 1800000000n;

async function removeFixtureDirectory(directory, base, prefix, error) {
  const resolved = await realpath(directory);
  if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith(prefix)) throw new Error(error);
  await rm(resolved, { recursive: true, force: true });
}

test('shared signed public fixture authenticates in Node', () => {
  const baseline = authenticateAuthorizationV2(Buffer.from(interop.baselineEnvelope, 'base64'), interop.policy, now, 'baseline');
  const update = authenticateAuthorizationV2(Buffer.from(interop.updateEnvelope, 'base64'), interop.policy, now, 'update');
  assert.equal(baseline.identitySha256, interop.identitySha256);
  assert.equal(update.identitySha256, interop.candidateIdentitySha256);
});

function createFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const policy = loadProductionPolicy();
  policy.roots = [{ keyId: 'test-only', algorithm: 'ecdsa-p256-sha256-p1363', spkiBase64: spki.toString('base64'),
    spkiSha256: hash(spki), roles: ['release', 'recovery'], notBefore: '0', expiresAt: '2000000000', revoked: false, allowHistoricalRecovery: true }];
  const source = fixture.release.source;
  policy.authorities = [{ repository: source.repository, workflow: source.workflow, ref: source.ref,
    issuer: 'https://token.actions.githubusercontent.com', runnerEnvironment: 'github-hosted',
    builderWorkflowUri: `${source.repository}/.github/workflows/builder.yml@refs/heads/main`, builderDigest: 'b'.repeat(40),
    buildConfigUri: `${source.repository}/${source.workflow}@${source.ref}`, buildConfigDigestRule: 'source-commit' }];
  policy.verifier = { filename: 'gh.exe', version: '2.102.0', sha256: '0'.repeat(64) };
  const payload = { protocol: 2, policyRevision: 1, kind: 'baseline', release: globalThis.structuredClone(fixture.release),
    issuedAt: String(now), notBefore: String(now), expiresAt: String(now + 3600n) };
  const envelope = (value, signatureDomain = 'lnwjud-update-release-v2\0') => {
    const payloadBytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const signature = sign('sha256', Buffer.concat([Buffer.from(signatureDomain), payloadBytes]), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return Buffer.from(JSON.stringify({ protocol: 2, keyId: 'test-only', payload: payloadBytes.toString('base64'), signature: signature.toString('base64') }));
  };
  return { policy, payload, envelope };
}

test('fresh baseline authorizations retain the same immutable release identity', () => {
  const f = createFixture();
  const first = authenticateAuthorizationV2(f.envelope(f.payload), f.policy, now, 'baseline');
  const renewed = globalThis.structuredClone(f.payload);
  renewed.issuedAt = renewed.notBefore = String(now + 86400n); renewed.expiresAt = String(now + 90000n);
  const second = authenticateAuthorizationV2(f.envelope(renewed), f.policy, now + 86400n, 'baseline');
  assert.equal(first.identitySha256, fixture.sha256);
  assert.equal(second.identitySha256, first.identitySha256);
  assert.notEqual(second.envelopeSha256, first.envelopeSha256);
});

test('baseline and update are separate signed purposes', () => {
  const f = createFixture();
  const update = { ...f.payload, kind: 'update', recovery: { purpose: 'failed-candidate-only', previousReleaseIdentity: 'a'.repeat(64), maximumAttempts: 1 } };
  const signed = f.envelope(update);
  assert.equal(authenticateAuthorizationV2(signed, f.policy, now, 'update').payload.recovery.previousReleaseIdentity, 'a'.repeat(64));
  assert.throws(() => authenticateAuthorizationV2(signed, f.policy, now, 'baseline'));
  assert.throws(() => authenticateAuthorizationV2(f.envelope(f.payload), f.policy, now, 'update'));
});

test('authenticated metadata remains bound to the bytes that were verified', () => {
  const f = createFixture();
  const update = { ...f.payload, kind: 'update', recovery: { purpose: 'failed-candidate-only', previousReleaseIdentity: 'a'.repeat(64), maximumAttempts: 1 } };
  const result = authenticateAuthorizationV2(f.envelope(update), f.policy, now, 'update');
  assert.throws(() => { result.payload.recovery.previousReleaseIdentity = 'b'.repeat(64); }, TypeError);
  assert.throws(() => { result.payload.release.artifact.sha256 = 'b'.repeat(64); }, TypeError);
  assert.throws(() => { result.identitySha256 = 'b'.repeat(64); }, TypeError);
  assert.equal(result.payload.recovery.previousReleaseIdentity, 'a'.repeat(64));
});

test('wrong domain, expired offers, malformed recovery and unconfigured trust refuse', () => {
  const f = createFixture();
  assert.throws(() => authenticateAuthorizationV2(f.envelope(f.payload, 'lnwjud-update-release-v1\0'), f.policy, now, 'baseline'), /RELEASE_SIGNATURE_INVALID/);
  assert.throws(() => authenticateAuthorizationV2(f.envelope(f.payload), f.policy, now + 3600n, 'baseline'), /RELEASE_TIME_INVALID/);
  const bad = { ...f.payload, kind: 'update', recovery: { purpose: 'failed-candidate-only', previousReleaseIdentity: 'a'.repeat(64), maximumAttempts: 2 } };
  assert.throws(() => authenticateAuthorizationV2(f.envelope(bad), f.policy, now, 'update'), /RELEASE_SCHEMA_INVALID/);
  assert.throws(() => authenticateAuthorizationV2(f.envelope(f.payload), loadProductionPolicy(), now, 'baseline'), /RELEASE_TRUST_UNCONFIGURED/);
  const otherArtifact = globalThis.structuredClone(f.payload); otherArtifact.release.artifact.name = 'different.exe';
  assert.throws(() => authenticateAuthorizationV2(f.envelope(otherArtifact), f.policy, now, 'baseline'), /RELEASE_ARTIFACT_INVALID/);
});

test('signature, key role, revocation, source, target and root time are checked', () => {
  const f = createFixture();
  const signed = JSON.parse(f.envelope(f.payload));
  const signature = Buffer.from(signed.signature, 'base64'); signature[0] ^= 1; signed.signature = signature.toString('base64');
  assert.throws(() => authenticateAuthorizationV2(Buffer.from(JSON.stringify(signed)), f.policy, now, 'baseline'), /RELEASE_SIGNATURE_INVALID/);
  signed.keyId = 'unknown';
  assert.throws(() => authenticateAuthorizationV2(Buffer.from(JSON.stringify(signed)), f.policy, now, 'baseline'), /RELEASE_KEY_UNTRUSTED/);
  const revoked = globalThis.structuredClone(f.policy); revoked.roots[0].revoked = true;
  assert.throws(() => authenticateAuthorizationV2(f.envelope(f.payload), revoked, now, 'baseline'), /RELEASE_KEY_UNTRUSTED/);
  const noRecovery = globalThis.structuredClone(f.policy); noRecovery.roots[0].roles = ['release'];
  assert.throws(() => authenticateAuthorizationV2(f.envelope(f.payload), noRecovery, now, 'baseline'), /RELEASE_KEY_UNTRUSTED/);
  const source = globalThis.structuredClone(f.payload); source.release.source.workflow = '.github/workflows/other.yml';
  assert.throws(() => authenticateAuthorizationV2(f.envelope(source), f.policy, now, 'baseline'), /RELEASE_SOURCE_UNTRUSTED/);
  const target = globalThis.structuredClone(f.payload); target.release.platform = 'darwin';
  assert.throws(() => authenticateAuthorizationV2(f.envelope(target), f.policy, now, 'baseline'), /RELEASE_TARGET_UNSUPPORTED/);
  const lateRoot = globalThis.structuredClone(f.policy); lateRoot.roots[0].notBefore = String(now + 10n);
  assert.throws(() => authenticateAuthorizationV2(f.envelope(f.payload), lateRoot, now + 20n, 'baseline'), /RELEASE_KEY_UNTRUSTED/);
});

test('duplicate signed JSON and oversized envelopes refuse before returning metadata', () => {
  const f = createFixture();
  const duplicate = Buffer.from('{"protocol":2,' + JSON.stringify(f.payload).slice(1));
  assert.throws(() => authenticateAuthorizationV2(f.envelope(duplicate), f.policy, now, 'baseline'), /RELEASE_JSON_INVALID/);
  assert.throws(() => authenticateAuthorizationV2(Buffer.alloc(49153), f.policy, now, 'baseline'), /RELEASE_JSON_INVALID/);
});

test('authorization schema pin accepts CRLF and refuses changed policy fields', async () => {
  const base = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(base, 'lnwjud-authorization-schema-'));
  try {
    await mkdir(path.join(directory, 'config'));
    await mkdir(path.join(directory, 'scripts', 'update-trust'), { recursive: true });
    for (const name of ['release-envelope.mjs', 'release-identity.mjs', 'release-authorization-v2.mjs'])
      await copyFile(new URL(`./${name}`, import.meta.url), path.join(directory, 'scripts', 'update-trust', name));
    for (const name of ['update-release-schema.json', 'update-release-identity-v1.json'])
      await copyFile(new URL(`../../config/${name}`, import.meta.url), path.join(directory, 'config', name));
    const target = path.join(directory, 'config', 'update-release-authorization-v2.json');
    const original = (await readFile(new URL('../../config/update-release-authorization-v2.json', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    const invoke = () => spawnSync(process.execPath, ['--input-type=module', '-e', "import './scripts/update-trust/release-authorization-v2.mjs';"], {
      cwd: directory, encoding: 'utf8', windowsHide: true, env: { SystemRoot: process.env.SystemRoot || '', PATH: process.env.PATH || '' },
    });
    await writeFile(target, original.replace(/\n/g, '\r\n'));
    assert.equal(invoke().status, 0);
    const changed = JSON.parse(original); changed.objects.recovery.fields.maximumAttempts.constant = 2;
    await writeFile(target, JSON.stringify(changed));
    const refused = invoke();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /RELEASE_AUTHORIZATION_SCHEMA_VERSION_MISMATCH/);
  } finally {
    await removeFixtureDirectory(directory, base, 'lnwjud-authorization-schema-', 'AUTHORIZATION_TEST_DIRECTORY_INVALID');
  }
});

test('producer accepts only exact authenticated previous release and real previous bytes', async () => {
  const base = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(base, 'lnwjud-v2-previous-'));
  try {
    const f = createFixture();
    const old = globalThis.structuredClone(f.payload);
    const artifact = Buffer.from('disposable previous setup');
    const provenance = Buffer.from('disposable previous provenance');
    old.release.artifact.sha256 = hash(artifact); old.release.artifact.sizeBytes = String(artifact.length);
    old.release.provenance.sha256 = hash(provenance); old.release.provenance.sizeBytes = String(provenance.length);
    const artifactPath = path.join(directory, old.release.artifact.name);
    const provenancePath = path.join(directory, old.release.provenance.name);
    const envelopePath = path.join(directory, 'RELEASE.json');
    await writeFile(artifactPath, artifact); await writeFile(provenancePath, provenance); await writeFile(envelopePath, f.envelope(old));
    const previous = authenticateAuthorizationV2(f.envelope(old), f.policy, now, 'baseline');
    const update = globalThis.structuredClone(old); update.kind = 'update'; update.release.version = '5.9.1'; update.release.releaseSequence = '101';
    update.release.artifact.name = 'lnwjud-Setup-5.9.1.exe';
    update.issuedAt = update.notBefore = String(now + 86400n); update.expiresAt = String(now + 90000n);
    update.recovery = { purpose: 'failed-candidate-only', previousReleaseIdentity: previous.identitySha256, maximumAttempts: 1 };
    const candidate = inspectAuthorizationPayloadV2(Buffer.from(JSON.stringify(update)), f.policy, now + 86400n, 'update', 'test-only');
    const paths = { previousPurpose: 'baseline', previousEnvelope: envelopePath, previousArtifact: artifactPath, previousProvenance: provenancePath };
    assert.equal((await authenticatePreviousV2(candidate, paths, f.policy, now + 86400n)).identitySha256, previous.identitySha256);
    const originalEnvelope = await readFile(envelopePath);
    const originalDigest = hash(originalEnvelope);
    const retained = authenticatePreviousMetadataV2(candidate, originalEnvelope, 'baseline', f.policy, now + 86400n);
    assert.equal(retained.identitySha256, previous.identitySha256);
    const altered = Buffer.from(originalEnvelope); altered[altered.length - 2] ^= 1;
    assert.throws(() => authenticatePreviousMetadataV2(candidate, altered, 'baseline', f.policy, now + 86400n));
    assert.throws(() => authenticatePreviousMetadataV2(candidate, originalEnvelope, 'update', f.policy, now + 86400n));
    originalEnvelope.fill(0);
    assert.equal(retained.identitySha256, previous.identitySha256);
    assert.equal(retained.envelopeSha256, originalDigest);
    const noHistory = globalThis.structuredClone(f.policy); noHistory.roots[0].allowHistoricalRecovery = false;
    await assert.rejects(authenticatePreviousV2(candidate, paths, noHistory, now + 86400n), /RELEASE_HISTORICAL_BASELINE_UNAUTHORIZED/);
    const beforeExpiry = globalThis.structuredClone(update);
    beforeExpiry.issuedAt = beforeExpiry.notBefore = String(now); beforeExpiry.expiresAt = String(now + 3600n);
    const beforeCandidate = inspectAuthorizationPayloadV2(Buffer.from(JSON.stringify(beforeExpiry)), noHistory, now, 'update', 'test-only');
    const checked = await authenticatePreviousV2(beforeCandidate, paths, noHistory, now + 3599n);
    assert.equal(checked.identitySha256, previous.identitySha256);
    assert.doesNotThrow(() => validatePreviousTimeV2(checked, noHistory, now + 3599n));
    assert.throws(() => validatePreviousTimeV2(checked, noHistory, now + 3600n), /RELEASE_HISTORICAL_BASELINE_UNAUTHORIZED/);
    await assert.rejects(authenticatePreviousV2(beforeCandidate, paths, noHistory, now + 3600n), /RELEASE_HISTORICAL_BASELINE_UNAUTHORIZED/);
    const unpublished = path.join(directory, 'not-published.json');
    await assert.rejects(publishEnvelope(unpublished, Buffer.from('{}'), () => validatePreviousTimeV2(checked, noHistory, now + 3600n)), /RELEASE_HISTORICAL_BASELINE_UNAUTHORIZED/);
    await assert.rejects(readFile(unpublished), error => error.code === 'ENOENT');
    await writeFile(artifactPath, 'tampered previous setup');
    await assert.rejects(authenticatePreviousV2(candidate, paths, f.policy, now + 86400n));
  } finally {
    await removeFixtureDirectory(directory, base, 'lnwjud-v2-previous-', 'PREVIOUS_TEST_DIRECTORY_INVALID');
  }
});

test('producer rejects accessor-backed options before consulting trust', async () => {
  let reads = 0;
  const options = {};
  Object.defineProperty(options, 'purpose', { enumerable: true, get() { reads++; return 'baseline'; } });
  await assert.rejects(produceReleaseAuthorizationV2(options), /RELEASE_ARGUMENTS_INVALID/);
  assert.equal(reads, 0);
});

test('producer CLI distinguishes baseline and update without trust overrides', () => {
  const common = ['--purpose', 'baseline', '--payload', 'p', '--artifact', 'a', '--provenance', 'p', '--artifactBundle', 'ab', '--provenanceBundle', 'pb', '--keyId', 'k', '--output', 'o'];
  assert.equal(parseArgumentsV2(common).purpose, 'baseline');
  assert.throws(() => parseArgumentsV2([...common, '--previousEnvelope', 'old']), /RELEASE_ARGUMENTS_INVALID/);
  assert.throws(() => parseArgumentsV2([...common, '--policy', 'override']), /RELEASE_ARGUMENTS_INVALID/);
  const update = [...common]; update[1] = 'update';
  assert.throws(() => parseArgumentsV2(update), /RELEASE_ARGUMENTS_INVALID/);
  assert.equal(parseArgumentsV2([...update, '--previousPurpose', 'baseline', '--previousEnvelope', 'e', '--previousArtifact', 'a', '--previousProvenance', 'p']).purpose, 'update');
});

test('production producer refuses empty trust before inputs or signing', () => {
  const cli = fileURLToPath(new URL('./produce-release-authorization-v2.mjs', import.meta.url));
  const args = [cli, '--purpose', 'baseline', '--payload', 'missing-payload', '--artifact', 'missing-artifact',
    '--provenance', 'missing-provenance', '--artifactBundle', 'missing-bundle', '--provenanceBundle', 'missing-bundle',
    '--keyId', 'fixture-only', '--output', 'missing-output'];
  const child = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot || '', PATH: process.env.PATH || '', LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM: 'invalid-disposable-fixture' } });
  assert.notEqual(child.status, 0);
  assert.equal(child.stdout, '');
  assert.match(child.stderr, /^RELEASE_TRUST_UNCONFIGURED\r?\n$/);
});
