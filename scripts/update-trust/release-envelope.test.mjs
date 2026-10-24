import test from 'node:test';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authenticateEnvelope, authenticateHistoricalEnvelope, canonicalBase64, domain, hash, loadProductionPolicy,
  parseStrictJson, signAuthenticatedPayload } from './release-envelope.mjs';
import { authenticatePrevious, parseArguments, produceReleaseEnvelope, publishEnvelope } from './produce-release-envelope.mjs';
import { readBoundedFile, selectVerifiedAttestation } from './verify-build-evidence.mjs';

export function disposableFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const policy = loadProductionPolicy();
  policy.roots = [{ keyId: 'disposable-test-only', algorithm: 'ecdsa-p256-sha256-p1363', spkiBase64: spki.toString('base64'),
    spkiSha256: hash(spki), roles: ['release', 'recovery'], notBefore: '0', expiresAt: '2000000000', revoked: false, allowHistoricalRecovery: true }];
  policy.authorities = [{ repository: 'https://github.com/engasnm111/lnwjud', workflow: '.github/workflows/test-builder.yml', ref: 'refs/heads/main',
    issuer: 'https://token.actions.githubusercontent.com', runnerEnvironment: 'github-hosted',
    builderWorkflowUri: 'https://github.com/engasnm111/lnwjud/.github/workflows/test-builder.yml@refs/heads/main',
    builderDigest: 'b'.repeat(40), buildConfigUri: 'https://github.com/engasnm111/lnwjud/.github/workflows/test-builder.yml@refs/heads/main', buildConfigDigestRule: 'source-commit' }];
  policy.verifier = { filename: 'gh.exe', version: '0.0.0', sha256: '0'.repeat(64) };
  const identity = (name, digest) => ({ name, sha256: digest.repeat(64), sizeBytes: '1' });
  const payload = { protocol: 1, product: 'lnwjud', policyRevision: 1, releaseId: 'test-only-2', channel: 'stable', platform: 'win32', architecture: 'x64',
    distribution: 'windows-nsis', version: '2.0.0', releaseSequence: '2', issuedAt: '1800000000', notBefore: '1800000000', expiresAt: '1800003600',
    source: { repository: policy.authorities[0].repository, commit: 'a'.repeat(40), workflow: policy.authorities[0].workflow, ref: 'refs/heads/main', runId: '1', runAttempt: '1' },
    buildEvidence: { kind: 'github-artifact-attestation-v1', artifactAttestationSha256: 'b'.repeat(64), provenanceAttestationSha256: 'c'.repeat(64), sourceTree: 'clean' },
    artifact: identity('lnwjud-Setup-2.0.0.exe', 'd'), provenance: identity('PROVENANCE.json', 'e'),
    previous: { version: '1.0.0', releaseSequence: '1', envelopeSha256: 'f'.repeat(64), artifact: identity('lnwjud-Setup-1.0.0.exe', '1'), provenance: identity('PROVENANCE.json', '2') },
    compatibility: { migrationContractSha256: '3'.repeat(64), workerContractSha256: '4'.repeat(64), serviceContractSha256: '5'.repeat(64) },
    recoveryAuthorization: { purpose: 'failed-candidate-only', candidateArtifactSha256: 'd'.repeat(64), candidateReleaseSequence: '2', previousEnvelopeSha256: 'f'.repeat(64),
      previousArtifactSha256: '1'.repeat(64), previousProvenanceSha256: '2'.repeat(64), expiresAt: '1800003600', maximumAttempts: 1 } };
  const privateBytes = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const bytes = signAuthenticatedPayload(payload, policy, 'disposable-test-only', privateBytes, 1800000000n);
  return { privateKey, privateBytes, policy, payload, bytes };
}

function rawEnvelope(fixture, payloadBytes, messageDomain = domain, signatureOptions = {}) {
  const signature = sign('sha256', Buffer.concat([messageDomain, payloadBytes]), { key: fixture.privateKey, dsaEncoding: 'ieee-p1363', ...signatureOptions });
  return Buffer.from(JSON.stringify({ protocol: 1, keyId: 'disposable-test-only', payload: payloadBytes.toString('base64'), signature: signature.toString('base64') }));
}

test('disposable signature authenticates exact bytes and empty production policy refuses', () => {
  const fixture = disposableFixture();
  assert.equal(authenticateEnvelope(fixture.bytes, fixture.policy, 1800000000n).envelopeSha256, hash(fixture.bytes));
  assert.throws(() => authenticateEnvelope(fixture.bytes, fixture.policy, 1799999999n), /RELEASE_TIME_INVALID/);
  assert.throws(() => authenticateEnvelope(fixture.bytes, loadProductionPolicy(), 1800000000n), /RELEASE_TRUST_UNCONFIGURED/);
});

test('shared persisted Node-to-native public byte fixtures authenticate and malformed bytes refuse', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../tests/fixtures/update-release/metadata-v1.json', import.meta.url), 'utf8'));
  for (const encoded of [fixture.candidateEnvelope, fixture.baselineEnvelope])
    authenticateEnvelope(Buffer.from(encoded, 'base64'), fixture.policy, BigInt(fixture.now));
  for (const malformed of fixture.malformedCases)
    assert.throws(() => authenticateEnvelope(Buffer.from(malformed.envelope, 'base64'), fixture.policy, BigInt(fixture.now)), malformed.name);
});

for (const malformed of ['{"a":1,"\\u0061":2}', '{"a":{"b":1,"b":2}}', '{"a":1e0}', '{"a":1.0}', '{"a":01}',
  '{"a":-1}', '{"a":"\\ud800"}', '{} {}', '{"a":null,}', '[1,]', '{"a":9007199254740992}']) {
  test(`strict parser rejects ${malformed}`, () => assert.throws(() => parseStrictJson(Buffer.from(malformed), 32768), /RELEASE_JSON_INVALID/));
}
test('strict parser rejects UTF8, BOM, size, depth and noncanonical base64', () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xef, 0xbb, 0xbf, 123, 125]), Buffer.alloc(32769)])
    assert.throws(() => parseStrictJson(bytes, 32768));
  assert.throws(() => parseStrictJson(Buffer.from('['.repeat(14) + '0' + ']'.repeat(14)), 32768));
  for (const text of ['AB==', 'YQ', 'YQ==\n', 'YQ-_']) assert.throws(() => canonicalBase64(text, 32768));
});

test('generic GitHub JSON accepts paired emoji while signed payload identifiers remain ASCII', () => {
  assert.equal(parseStrictJson(Buffer.from('{"unused":"\\ud83d\\ude00"}'), 32768).unused, '😀');
  for (const value of ['\\ud800', '\\udc00', '\\ud800a', '\\ud800\\ud800'])
    assert.throws(() => parseStrictJson(Buffer.from(`{"x":"${value}"}`), 32768));
  const fixture = disposableFixture(); fixture.payload.releaseId = '😀';
  assert.throws(() => authenticateEnvelope(rawEnvelope(fixture, Buffer.from(JSON.stringify(fixture.payload))), fixture.policy, 1800000000n));
});

for (const [name, change] of Object.entries({
  unknown: payload => { payload.extra = true; }, nestedUnknown: payload => { payload.source.extra = 'x'; },
  dirty: payload => { payload.buildEvidence.sourceTree = 'dirty'; }, target: payload => { payload.platform = 'darwin'; },
  numericSequence: payload => { payload.releaseSequence = 2; }, overflow: payload => { payload.releaseSequence = '18446744073709551616'; },
  paddedSequence: payload => { payload.releaseSequence = '02'; }, version: payload => { payload.version = '02.0.0'; },
  nullSource: payload => { payload.source = null; }, source: payload => { payload.source.repository += '-other'; },
  workflow: payload => { payload.source.workflow = '.github/workflows/other.yml'; }, replay: payload => { payload.releaseSequence = '1'; },
  recoveryDigest: payload => { payload.recoveryAuthorization.previousArtifactSha256 = '0'.repeat(64); },
  recoveryBudget: payload => { payload.recoveryAuthorization.maximumAttempts = 2; },
  ttl: payload => { payload.expiresAt = '1800086401'; }, issue: payload => { payload.issuedAt = '1800000301'; payload.notBefore = payload.issuedAt; },
  artifactPath: payload => { payload.artifact.name = '../lnwjud-Setup-2.0.0.exe'; },
  tooLarge: payload => { payload.artifact.sizeBytes = '2147483649'; },
})) {
  test(`authenticated malformed ${name} refuses`, () => {
    const fixture = disposableFixture(); change(fixture.payload);
    const bytes = rawEnvelope(fixture, Buffer.from(JSON.stringify(fixture.payload)));
    assert.throws(() => authenticateEnvelope(bytes, fixture.policy, 1800000000n));
  });
}

test('signature domain, curve, DER, tampering, revocation, expiry and history permission refuse', () => {
  const fixture = disposableFixture(); const payload = Buffer.from(JSON.stringify(fixture.payload));
  for (const bytes of [rawEnvelope(fixture, payload, Buffer.from('wrong')), rawEnvelope(fixture, payload, domain, { dsaEncoding: 'der' }),
    Buffer.from(fixture.bytes.toString().replace('disposable-test-only', 'wrong'))]) assert.throws(() => authenticateEnvelope(bytes, fixture.policy, 1800000000n));
  assert.throws(() => authenticateEnvelope(fixture.bytes, fixture.policy, 1800003600n), /RELEASE_TIME_INVALID/);
  assert.equal(authenticateHistoricalEnvelope(fixture.bytes, fixture.policy, 1800003600n).payload.version, '2.0.0');
  fixture.policy.roots[0].allowHistoricalRecovery = false;
  assert.throws(() => authenticateHistoricalEnvelope(fixture.bytes, fixture.policy, 1800003600n));
  fixture.policy.roots[0].revoked = true;
  assert.throws(() => authenticateEnvelope(fixture.bytes, fixture.policy, 1800000000n));
  const other = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  assert.throws(() => signAuthenticatedPayload(fixture.payload, disposableFixture().policy, 'disposable-test-only', other.privateKey.export({ format: 'pem', type: 'pkcs8' }), 1800000000n));
});

test('root requires canonical DER SPKI rather than a permissive import equivalent', () => {
  const fixture = disposableFixture(); const root = fixture.policy.roots[0];
  const original = Buffer.from(root.spkiBase64, 'base64');
  const nonminimal = Buffer.concat([original.subarray(0, 1), Buffer.from([0x81]), original.subarray(1)]);
  root.spkiBase64 = nonminimal.toString('base64'); root.spkiSha256 = hash(nonminimal);
  assert.throws(() => authenticateEnvelope(fixture.bytes, fixture.policy, 1800000000n), /RELEASE_KEY_UNTRUSTED/);
});

test('ordinary offer issue time must fall inside its signing root validity', () => {
  const fixture = disposableFixture(); fixture.policy.roots[0].notBefore = '1800000001';
  assert.throws(() => authenticateEnvelope(fixture.bytes, fixture.policy, 1800000002n), /RELEASE_KEY_UNTRUSTED/);
  assert.throws(() => signAuthenticatedPayload(fixture.payload, fixture.policy, 'disposable-test-only', fixture.privateBytes, 1800000002n));
});

test('caller digest policy supports exact source commits and refuses literal or unknown rules', () => {
  const fixture = disposableFixture();
  fixture.payload.source.commit = 'c'.repeat(40);
  const bytes = signAuthenticatedPayload(fixture.payload, fixture.policy, 'disposable-test-only', fixture.privateBytes, 1800000000n);
  assert.equal(authenticateEnvelope(bytes, fixture.policy, 1800000000n).payload.source.commit, 'c'.repeat(40));
  fixture.policy.authorities[0].buildConfigDigestRule = 'any';
  assert.throws(() => authenticateEnvelope(bytes, fixture.policy, 1800000000n), /RELEASE_POLICY_INVALID/);
  delete fixture.policy.authorities[0].buildConfigDigestRule;
  fixture.policy.authorities[0].buildConfigDigest = 'c'.repeat(40);
  assert.throws(() => authenticateEnvelope(bytes, fixture.policy, 1800000000n), /RELEASE_POLICY_INVALID/);
});

test('publication never overwrites existing output; bounded file hashes real bytes', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-envelope-')));
  try {
    const filename = path.join(directory, 'envelope.json'); const bytes = disposableFixture().bytes;
    await publishEnvelope(filename, bytes);
    assert.deepEqual(await readFile(filename), bytes);
    await assert.rejects(publishEnvelope(filename, Buffer.from('changed')));
    assert.deepEqual(await readFile(filename), bytes);
    assert.equal((await readBoundedFile(filename, 49152n)).sha256, hash(bytes));
    await assert.rejects(readBoundedFile(filename, 1n));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('previous descriptor binds exact original envelope, package and provenance bytes', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-previous-')));
  try {
    const fixture = disposableFixture(); const artifact = Buffer.from('previous package'); const provenance = Buffer.from('{}');
    fixture.payload.artifact.sha256 = hash(artifact); fixture.payload.artifact.sizeBytes = String(artifact.length);
    fixture.payload.provenance.sha256 = hash(provenance); fixture.payload.provenance.sizeBytes = String(provenance.length);
    fixture.payload.recoveryAuthorization.candidateArtifactSha256 = hash(artifact);
    const baseline = signAuthenticatedPayload(fixture.payload, fixture.policy, 'disposable-test-only', fixture.privateBytes, 1800000000n);
    const payload = { previous: { version: '2.0.0', releaseSequence: '2', envelopeSha256: hash(baseline), artifact: fixture.payload.artifact, provenance: fixture.payload.provenance } };
    const paths = { previousEnvelope: path.join(directory, 'previous.json'), previousArtifact: path.join(directory, 'package.exe'), previousProvenance: path.join(directory, 'PROVENANCE.json') };
    await writeFile(paths.previousEnvelope, baseline); await writeFile(paths.previousArtifact, artifact); await writeFile(paths.previousProvenance, provenance);
    assert.equal((await authenticatePrevious(payload, paths, fixture.policy, 1800000000n)).envelopeSha256, hash(baseline));
    assert.equal((await authenticatePrevious(payload, paths, fixture.policy, 1800004000n)).envelopeSha256, hash(baseline));
    fixture.policy.roots[0].allowHistoricalRecovery = false;
    await assert.rejects(authenticatePrevious(payload, paths, fixture.policy, 1800004000n));
    await writeFile(paths.previousArtifact, Buffer.from('changed package!'));
    await assert.rejects(authenticatePrevious(payload, paths, fixture.policy, 1800000000n));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('production producer refuses before file reads/key access and accepts no policy/evidence boolean arguments', async () => {
  process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM = 'sentinel-test-only';
  try {
    await assert.rejects(produceReleaseEnvelope({}), /RELEASE_TRUST_UNCONFIGURED/);
    assert.equal(process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM, 'sentinel-test-only');
    assert.throws(() => parseArguments(['--policy', 'untrusted.json']));
    assert.throws(() => parseArguments(['--verified', 'true']));
  } finally { delete process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM; }
});

test('verified result selector binds certificate observations, subjects and timestamps', () => {
  const fixture = disposableFixture(); const source = fixture.payload.source; const authority = fixture.policy.authorities[0];
  const certificate = { issuer: authority.issuer, subjectAlternativeName: authority.builderWorkflowUri, sourceRepositoryURI: source.repository,
    sourceRepositoryDigest: source.commit, sourceRepositoryRef: source.ref, buildSignerURI: authority.builderWorkflowUri, buildSignerDigest: authority.builderDigest,
    buildConfigURI: authority.buildConfigUri, buildConfigDigest: source.commit, runnerEnvironment: 'github-hosted',
    runInvocationURI: `${source.repository}/actions/runs/1/attempts/1` };
  const result = { verificationResult: { signature: { certificate }, verifiedTimestamps: [{ type: 'Tlog', uri: 'https://rekor.sigstore.dev', timestamp: '2027-01-15T08:00:00Z' }],
    statement: { predicateType: 'https://slsa.dev/provenance/v1', subject: [{ name: fixture.payload.artifact.name, digest: { sha256: fixture.payload.artifact.sha256 } }] } } };
  const select = value => selectVerifiedAttestation(Buffer.from(JSON.stringify([value])), fixture.payload, fixture.payload.artifact, authority);
  assert.equal(select(result), 1);
  assert.notEqual(certificate.buildConfigDigest, authority.builderDigest);
  const wrongCaller = globalThis.structuredClone(result); wrongCaller.verificationResult.signature.certificate.buildConfigDigest = authority.builderDigest;
  assert.throws(() => select(wrongCaller));
  const callerSupplied = globalThis.structuredClone(result); callerSupplied.verificationResult.statement.predicate = { buildConfigDigest: source.commit, buildVerified: true };
  callerSupplied.verificationResult.signature.certificate.buildConfigDigest = authority.builderDigest;
  assert.throws(() => select(callerSupplied));
  for (const key of Object.keys(certificate)) { const changed = globalThis.structuredClone(result); changed.verificationResult.signature.certificate[key] += 'wrong'; assert.throws(() => select(changed)); }
  const missing = globalThis.structuredClone(result); missing.verificationResult.verifiedTimestamps = []; assert.throws(() => select(missing));
  for (const timestamps of [[{}], [{ type: 'Tlog' }], [{ type: 'CurrentTime', uri: '', timestamp: '2027-01-15T08:00:00Z' }],
    [{ type: 'Tlog', uri: 'http://rekor.sigstore.dev', timestamp: '2027-01-15T08:00:00Z' }],
    [{ type: 'Tlog', uri: 'https://rekor.sigstore.dev', timestamp: '2027-02-31T08:00:00Z' }],
    [{ type: 'Tlog', uri: 'https://rekor.sigstore.dev', timestamp: '2028-01-15T08:00:00Z' }]]) {
    const changed = globalThis.structuredClone(result); changed.verificationResult.verifiedTimestamps = timestamps; assert.throws(() => select(changed));
  }
  const wrongSubject = globalThis.structuredClone(result); wrongSubject.verificationResult.statement.subject[0].digest.sha256 = '0'.repeat(64); assert.throws(() => select(wrongSubject));
  assert.throws(() => select({ verified: true, buildVerified: true }));
});
