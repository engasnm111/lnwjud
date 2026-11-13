import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign } from 'node:crypto';
import { URL } from 'node:url';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hash } from './release-envelope.mjs';
import { sourceRecoveryContracts } from './source-recovery-contracts.mjs';
import { prepareBaselineSigningBundle, prepareUpdateSigningBundle, readSourceReleasePolicy } from './build-signing-candidate.mjs';
import { parseSigningVerificationManifest, inspectManifestCandidate } from './signing-verification-manifest.mjs';

const sha = 'a'.repeat(40);
const context = { commit: sha, runId: '123456789', runAttempt: '1', ref: 'refs/heads/main', builderSha: 'b'.repeat(40) };
const identities = (name, bytes) => ({ name, sha256: hash(bytes), sizeBytes: bytes.length });

async function setup(root) {
  const source = path.join(root, '_source');
  const required = [
    'packages/storage/src/backup-service.ts',
    'native/update-worker/UpdateTransactionJournal.cs',
    'native/update-admission-broker/AdmissionProtocol.cs',
  ];
  for (const name of required) {
    const full = path.join(source, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, 'stable rollback contract\n');
  }
  const contracts = await sourceRecoveryContracts(source);
  const incoming = path.join(root, '_incoming');
  await mkdir(incoming);
  const installer = Buffer.from('mock installed package'), artifactBundle = Buffer.from('signed-artifact-bundle-test'),
    provenanceBundle = Buffer.from('signed-provenance-bundle-test');
  const artifact = identities('lnwjud-Setup-5.9.1.exe', installer);
  const metadata = {
    schemaVersion: 1, product: 'lnwjud', version: '5.9.1', platform: 'win32', arch: 'x64',
    source: { repository: 'https://github.com/engasnm111/lnwjud', commit: sha, dirty: false },
    build: { environment: 'github-actions', runId: context.runId, runAttempt: '1', ref: 'refs/heads/main',
      signingCredentialConfigured: false, windowsAuthenticode: [{ name: artifact.name, status: 'NotSigned', sha256: artifact.sha256 }] },
    recoveryCompatibility: contracts,
    artifacts: [artifact],
  };
  const provenance = Buffer.from(JSON.stringify(metadata));
  for (const [name, bytes] of [
    [artifact.name, installer], ['PROVENANCE.json', provenance],
    ['artifact.bundle.json', artifactBundle], ['provenance.bundle.json', provenanceBundle],
  ]) await writeFile(path.join(incoming, name), bytes);
}


async function signedPredecessor(root, change = () => undefined) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const policy = JSON.parse(await readFile(new URL('../../config/update-release-policy.json', import.meta.url)));
  policy.roots = [{ keyId: 'fixture-root', algorithm: 'ecdsa-p256-sha256-p1363',
    spkiBase64: spki.toString('base64'), spkiSha256: hash(spki),
    roles: ['release', 'recovery'], notBefore: '1700000000', expiresAt: '1900000000',
    revoked: false, allowHistoricalRecovery: true }];
  policy.authorities = [{ repository: 'https://github.com/engasnm111/lnwjud', workflow: '.github/workflows/ci.yml',
    ref: 'refs/heads/main', builderWorkflowUri: 'https://github.com/engasnm111/lnwjud/.github/workflows/update-package-builder.yml@refs/heads/main',
    builderDigest: 'b'.repeat(40), buildConfigUri: 'https://github.com/engasnm111/lnwjud/.github/workflows/ci.yml@refs/heads/main',
    buildConfigDigestRule: 'source-commit', issuer: 'https://token.actions.githubusercontent.com', runnerEnvironment: 'github-hosted' }];
  policy.verifier = { filename: 'gh.exe', version: '2.102.0', sha256: 'c'.repeat(64) };
  const contracts = await sourceRecoveryContracts(path.join(root, '_source'));
  const previousArtifact = Buffer.from('authenticated preexisting Windows setup');
  const previousProvenance = Buffer.from('authenticated preexisting release evidence');
  const release = {
    product: 'lnwjud', releaseId: 'lnwjud-5.9.0-100', channel: 'stable',
    platform: 'win32', architecture: 'x64', distribution: 'windows-nsis',
    version: '5.9.0', releaseSequence: '100',
    source: { repository: 'https://github.com/engasnm111/lnwjud', commit: sha,
      workflow: '.github/workflows/ci.yml', ref: 'refs/heads/main', runId: '100', runAttempt: '1' },
    buildEvidence: { kind: 'github-artifact-attestation-v1',
      artifactAttestationSha256: 'd'.repeat(64), provenanceAttestationSha256: 'e'.repeat(64), sourceTree: 'clean' },
    artifact: { name: 'lnwjud-Setup-5.9.0.exe', sha256: hash(previousArtifact), sizeBytes: String(previousArtifact.length) },
    provenance: { name: 'PROVENANCE.json', sha256: hash(previousProvenance), sizeBytes: String(previousProvenance.length) },
    compatibility: contracts,
  };
  const payload = { protocol: 2, policyRevision: 1, kind: 'baseline', release,
    issuedAt: '1799998000', notBefore: '1799998000', expiresAt: '1799999000' };
  change({ release, payload, previousArtifact, previousProvenance });
  const bytes = Buffer.from(JSON.stringify(payload));
  const signature = sign('sha256', Buffer.concat([Buffer.from('lnwjud-update-release-v2\0'), bytes]),
    { key: privateKey, dsaEncoding: 'ieee-p1363' });
  const envelope = Buffer.from(JSON.stringify({
    protocol: 2, keyId: 'fixture-root', payload: bytes.toString('base64'), signature: signature.toString('base64'),
  }));
  const folder = path.join(root, '_predecessor');
  await mkdir(folder);
  await writeFile(path.join(folder, 'RELEASE.json'), envelope);
  await writeFile(path.join(folder, 'lnwjud-Setup-5.9.0.exe'), previousArtifact);
  await writeFile(path.join(folder, 'PROVENANCE.json'), previousProvenance);
  return { policyBytes: Buffer.from(JSON.stringify(policy)), folder, release };
}

test('immutable builder uses protected source policy instead of an obsolete builder policy', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-source-policy-')));
  try {
    const source = path.join(root, '_source');
    const builder = path.join(root, '_trusted-builder');
    await mkdir(path.join(source, 'config'), { recursive: true });
    await mkdir(path.join(builder, 'config'), { recursive: true });
    const verifiedSourcePolicy = Buffer.from(JSON.stringify({ protocol: 1, revision: 1,
      roots: [{ keyId: 'protected-source-root' }], authorities: [{ workflow: '.github/workflows/ci.yml' }] }));
    await writeFile(path.join(source, 'config/update-release-policy.json'), verifiedSourcePolicy);
    await writeFile(path.join(builder, 'config/update-release-policy.json'), Buffer.from('{}'));
    assert.deepEqual(await readSourceReleasePolicy(source), verifiedSourcePolicy);
    await writeFile(path.join(source, 'config/update-release-policy.json'), Buffer.from('{}'));
    await assert.rejects(readSourceReleasePolicy(source), /UPDATE_SIGNING_CANDIDATE_UNVERIFIED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('builds update manifest only from signed prior release and authenticated predecessor files', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-update-candidate-')));
  try {
    await setup(root);
    const { policyBytes, release } = await signedPredecessor(root);
    const result = await prepareUpdateSigningBundle({ workspace: root, context, policyBytes, observedTime: 1800000000 });
    assert.equal(result.kind, 'unsigned-update-data-only');
    const folder = path.join(root, '_signing-bundle');
    const manifestBytes = await readFile(path.join(folder, 'manifest.json'));
    const manifest = parseSigningVerificationManifest(manifestBytes);
    assert.equal(manifest.purpose, 'update');
    const candidateBytes = await readFile(path.join(folder, 'files/candidate/CANDIDATE.json'));
    const candidate = JSON.parse(candidateBytes.toString('utf8'));
    const verified = inspectManifestCandidate(manifestBytes, candidateBytes, policyBytes, 1800000000n, 'fixture-root');
    assert.equal(verified.payload.kind, 'update');
    assert.equal(candidate.recovery.maximumAttempts, 1);
    assert.equal(candidate.release.version, '5.9.1');
    assert.ok(BigInt(candidate.release.releaseSequence) > BigInt(release.releaseSequence));
    assert.equal(manifest.predecessor.artifact.sha256, release.artifact.sha256);
    assert.equal(manifest.predecessor.provenance.sha256, release.provenance.sha256);
    for (const member of Object.values(manifest.predecessor)) {
      const stored = await readFile(path.join(folder, 'files/predecessor', member.name));
      assert.equal(hash(stored), member.sha256);
      assert.equal(String(stored.length), member.sizeBytes);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('update candidate refuses changed predecessor package and incompatible recovery contract', async () => {
  for (const tamper of ['installer', 'compatibility', 'replay']) {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-update-candidate-')));
    try {
      await setup(root);
      const { policyBytes, folder } = await signedPredecessor(root, ({ release }) => {
        if (tamper === 'compatibility') release.compatibility = { ...release.compatibility, serviceContractSha256: 'f'.repeat(64) };
        if (tamper === 'replay') release.releaseSequence = '999999999999999';
      });
      if (tamper === 'installer')
        await writeFile(path.join(folder, 'lnwjud-Setup-5.9.0.exe'), Buffer.from('changed predecessor setup'));
      await assert.rejects(
        prepareUpdateSigningBundle({ workspace: root, context, policyBytes, observedTime: 1800000000 }),
        /RELEASE_|UPDATE_SIGNING_PREDECESSOR_UNVERIFIED/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('builds a real-file-bound unsigned baseline bundle with the exact manifest ZIP member layout', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-candidate-bundle-')));
  try {
    await setup(root);
    const policy = JSON.parse(await readFile(new URL('../../config/update-release-policy.json', import.meta.url)));
    policy.authorities = [{ repository: 'https://github.com/engasnm111/lnwjud', workflow: '.github/workflows/ci.yml',
      ref: 'refs/heads/main', builderWorkflowUri: 'https://github.com/engasnm111/lnwjud/.github/workflows/update-package-builder.yml@refs/heads/main',
      builderDigest: 'b'.repeat(40), buildConfigUri: 'https://github.com/engasnm111/lnwjud/.github/workflows/ci.yml@refs/heads/main',
      buildConfigDigestRule: 'source-commit', issuer: 'https://token.actions.githubusercontent.com', runnerEnvironment: 'github-hosted' }];
    policy.verifier = { filename: 'gh.exe', version: '2.102.0', sha256: 'c'.repeat(64) };
    const policyBytes = Buffer.from(JSON.stringify(policy));
    const result = await prepareBaselineSigningBundle({ workspace: root, context, policyBytes, observedTime: 1800000000 });
    assert.equal(result.kind, 'unsigned-baseline-data-only');
    const folder = path.join(root, '_signing-bundle');
    const manifest = parseSigningVerificationManifest(await readFile(path.join(folder, 'manifest.json')));
    const candidateBytes = await readFile(path.join(folder, 'files/candidate/CANDIDATE.json'));
    const candidate = JSON.parse(candidateBytes.toString('utf8'));
    const inspected = inspectManifestCandidate(await readFile(path.join(folder, 'manifest.json')),
      candidateBytes, policyBytes, 1800000000n, 'lnwjud-update-release-2026-11');
    assert.equal(inspected.payload.release.releaseId, candidate.release.releaseId);
    assert.equal(manifest.purpose, 'baseline');
    assert.equal(manifest.verification.runId, context.runId);
    assert.equal(manifest.candidate.artifact.sha256, candidate.release.artifact.sha256);
    assert.equal(manifest.candidate.provenance.sha256, candidate.release.provenance.sha256);
    assert.deepEqual(candidate.release.compatibility, await sourceRecoveryContracts(path.join(root, '_source')));
    assert.equal(result.manifestSha256, hash(await readFile(path.join(folder, 'manifest.json'))));
    assert.equal(Object.hasOwn(result, 'canSign'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('refuses a source-compatibility mismatch before producing a signing candidate', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-candidate-bundle-')));
  try {
    await setup(root);
    await writeFile(path.join(root, '_source/native/update-worker/UpdateTransactionJournal.cs'), 'different contract\n');
    const policyBytes = await readFile(new URL('../../config/update-release-policy.json', import.meta.url));
    await assert.rejects(prepareBaselineSigningBundle({ workspace: root, context, policyBytes, observedTime: 1800000000 }),
      /UPDATE_RECOVERY_CONTRACT_UNVERIFIED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
