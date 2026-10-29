import test from 'node:test';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hash, loadProductionPolicy } from './release-envelope.mjs';
import { authenticateAuthorizationV2 } from './release-authorization-v2.mjs';
import { inspectSigningFiles } from './signing-files-diagnostic.mjs';

const template = JSON.parse(await readFile(new URL('../../tests/fixtures/update-release/release-identity-v1.json', import.meta.url), 'utf8'));
const now = 1800000000n;
const binding = (name, bytes) => ({ name, sizeBytes: String(bytes.length), sha256: hash(bytes) });

async function removeFixtureDirectory(root, base) {
  const resolved = await realpath(root);
  if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('lnwjud-signing-files-')) throw new Error('TEST_DIRECTORY_INVALID');
  await rm(resolved, { recursive: true, force: true });
}

function fixture(update) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const policy = loadProductionPolicy(), source = template.release.source;
  policy.roots = [{ keyId: 'test-only', algorithm: 'ecdsa-p256-sha256-p1363', spkiBase64: spki.toString('base64'), spkiSha256: hash(spki),
    roles: ['release', 'recovery'], notBefore: '0', expiresAt: '2000000000', revoked: false, allowHistoricalRecovery: true }];
  policy.authorities = [{ repository: source.repository, workflow: source.workflow, ref: source.ref,
    issuer: 'https://token.actions.githubusercontent.com', runnerEnvironment: 'github-hosted',
    builderWorkflowUri: `${source.repository}/.github/workflows/builder.yml@refs/heads/main`, builderDigest: 'b'.repeat(40),
    buildConfigUri: `${source.repository}/${source.workflow}@${source.ref}`, buildConfigDigestRule: 'source-commit' }];
  policy.verifier = { filename: 'gh.exe', version: '2.102.0', sha256: '0'.repeat(64) };
  const policyBytes = Buffer.from(JSON.stringify(policy));
  const artifact = Buffer.from('candidate package'), provenance = Buffer.from('candidate provenance');
  const artifactBundle = Buffer.from('candidate artifact bundle'), provenanceBundle = Buffer.from('candidate provenance bundle');
  const oldArtifact = Buffer.from('previous package'), oldProvenance = Buffer.from('previous provenance');
  const previousPayload = { protocol: 2, policyRevision: 1, kind: 'baseline', release: globalThis.structuredClone(template.release),
    issuedAt: String(now), notBefore: String(now), expiresAt: String(now + 3600n) };
  previousPayload.release.artifact = binding('lnwjud-Setup-5.9.0.exe', oldArtifact);
  previousPayload.release.provenance = binding('PROVENANCE.json', oldProvenance);
  const oldBytes = Buffer.from(JSON.stringify(previousPayload));
  const signature = sign('sha256', Buffer.concat([Buffer.from('lnwjud-update-release-v2\0'), oldBytes]), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  const envelope = Buffer.from(JSON.stringify({ protocol: 2, keyId: 'test-only', payload: oldBytes.toString('base64'), signature: signature.toString('base64') }));
  const oldIdentity = authenticateAuthorizationV2(envelope, policy, now, 'baseline').identitySha256;
  const candidate = globalThis.structuredClone(previousPayload);
  if (update) {
    candidate.kind = 'update'; candidate.release.version = '5.9.1'; candidate.release.releaseSequence = '101';
    candidate.recovery = { purpose: 'failed-candidate-only', previousReleaseIdentity: oldIdentity, maximumAttempts: 1 };
  }
  candidate.release.artifact = binding(`lnwjud-Setup-${candidate.release.version}.exe`, artifact);
  candidate.release.provenance = binding('PROVENANCE.json', provenance);
  candidate.release.buildEvidence.artifactAttestationSha256 = hash(artifactBundle);
  candidate.release.buildEvidence.provenanceAttestationSha256 = hash(provenanceBundle);
  const candidateBytes = Buffer.from(JSON.stringify(candidate));
  const candidateFiles = { candidate: ['CANDIDATE.json', candidateBytes], artifact: [candidate.release.artifact.name, artifact],
    provenance: ['PROVENANCE.json', provenance], artifactBundle: ['artifact.bundle.json', artifactBundle],
    provenanceBundle: ['provenance.bundle.json', provenanceBundle] };
  const previousFiles = { envelope: ['RELEASE.json', envelope], artifact: [previousPayload.release.artifact.name, oldArtifact],
    provenance: ['PROVENANCE.json', oldProvenance] };
  const roles = files => Object.fromEntries(Object.entries(files).map(([role, [name, bytes]]) => [role, binding(name, bytes)]));
  const manifest = { schema: 'lnwjud.signing-verification/v1', verification: { repositoryId: '1', runId: '2', runAttempt: 1 },
    policySha256: hash(policyBytes), purpose: candidate.kind, candidate: roles(candidateFiles), ...(update ? { predecessor: roles(previousFiles) } : {}) };
  return { manifest, policyBytes, candidateFiles, previousFiles, oldIdentity };
}

async function withinTemp(fn) {
  const base = await realpath(os.tmpdir()), root = await mkdtemp(path.join(base, 'lnwjud-signing-files-'));
  try { await fn(root); }
  finally {
    await removeFixtureDirectory(root, base);
  }
}

async function writeFiles(root, name, files) {
  const directory = path.join(root, name); await mkdir(directory);
  for (const [filename, bytes] of Object.values(files)) await writeFile(path.join(directory, filename), bytes);
}

test('inspects baseline and update fixed-role bytes with separate predecessor namespace', async () => {
  for (const update of [false, true]) await withinTemp(async root => {
    const f = fixture(update);
    await writeFiles(root, 'candidate', f.candidateFiles);
    if (update) await writeFiles(root, 'predecessor', f.previousFiles);
    const manifestBytes = Buffer.from(JSON.stringify(f.manifest));
    const result = await inspectSigningFiles(root, manifestBytes, f.policyBytes, () => now, 'test-only', hash(manifestBytes), '1', '2', '1');
    assert.equal(result.status, 'diagnostic-only');
    assert.match(result.candidateIdentitySha256, /^[a-f0-9]{64}$/);
    if (update) assert.equal(result.previousIdentitySha256, f.oldIdentity);
    else assert.equal(Object.hasOwn(result, 'previousIdentitySha256'), false);
  });
});

test('rejects missing, replaced and unexpected actual files and untrusted predecessor', async () => {
  await withinTemp(async root => {
    const f = fixture(true);
    await writeFiles(root, 'candidate', f.candidateFiles); await writeFiles(root, 'predecessor', f.previousFiles);
    const manifestBytes = Buffer.from(JSON.stringify(f.manifest));
    const inspect = () => inspectSigningFiles(root, manifestBytes, f.policyBytes, () => now, 'test-only', hash(manifestBytes), '1', '2', '1');
    await assert.rejects(inspectSigningFiles(root, manifestBytes, f.policyBytes, () => now, 'test-only', 'f'.repeat(64), '1', '2', '1'));
    await assert.rejects(inspectSigningFiles(root, manifestBytes, f.policyBytes, () => now, 'test-only', hash(manifestBytes), '1', '2', '2'));
    await assert.rejects(inspectSigningFiles(root, manifestBytes, f.policyBytes, () => now, 'test-only', hash(manifestBytes), '1', '3', '1'));
    let tick = 0;
    await assert.rejects(inspectSigningFiles(root, manifestBytes, f.policyBytes, () => tick++ === 0 ? now : now + 3600n,
      'test-only', hash(manifestBytes), '1', '2', '1'), /RELEASE_TIME_INVALID/);
    tick = 0;
    await assert.rejects(inspectSigningFiles(root, manifestBytes, f.policyBytes, () => tick++ === 0 ? now + 1n : now,
      'test-only', hash(manifestBytes), '1', '2', '1'), /SIGNING_FILES_INVALID/);
    await writeFile(path.join(root, 'candidate', f.candidateFiles.artifact[0]), 'tampered');
    await assert.rejects(inspect());
    await writeFile(path.join(root, 'candidate', f.candidateFiles.artifact[0]), f.candidateFiles.artifact[1]);
    await writeFile(path.join(root, 'candidate', 'unexpected'), 'extra');
    await assert.rejects(inspect());
    await unlink(path.join(root, 'candidate', 'unexpected'));
    await unlink(path.join(root, 'candidate', f.candidateFiles.provenance[0]));
    await assert.rejects(inspect());
  });
  await withinTemp(async root => {
    const f = fixture(true);
    await writeFiles(root, 'candidate', f.candidateFiles); await writeFiles(root, 'predecessor', f.previousFiles);
    const outer = JSON.parse(f.previousFiles.envelope[1]);
    const signature = Buffer.from(outer.signature, 'base64'); signature[0] ^= 1; outer.signature = signature.toString('base64');
    const forged = Buffer.from(JSON.stringify(outer));
    f.manifest.predecessor.envelope = binding(f.previousFiles.envelope[0], forged);
    await writeFile(path.join(root, 'predecessor', f.previousFiles.envelope[0]), forged);
    const manifestBytes = Buffer.from(JSON.stringify(f.manifest));
    await assert.rejects(inspectSigningFiles(root, manifestBytes, f.policyBytes, () => now, 'test-only', hash(manifestBytes), '1', '2', '1'), /RELEASE_SIGNATURE_INVALID/);
  });
});

test('rejects previous authorization expiring during reads while candidate remains fresh', async () => {
  await withinTemp(async root => {
    const f = fixture(true);
    const policy = JSON.parse(f.policyBytes); policy.roots[0].allowHistoricalRecovery = false;
    f.policyBytes = Buffer.from(JSON.stringify(policy)); f.manifest.policySha256 = hash(f.policyBytes);
    const payload = JSON.parse(f.candidateFiles.candidate[1]); payload.expiresAt = String(now + 7200n);
    const candidate = Buffer.from(JSON.stringify(payload)); f.candidateFiles.candidate[1] = candidate;
    f.manifest.candidate.candidate = binding(f.candidateFiles.candidate[0], candidate);
    await writeFiles(root, 'candidate', f.candidateFiles); await writeFiles(root, 'predecessor', f.previousFiles);
    const manifest = Buffer.from(JSON.stringify(f.manifest)); let tick = 0;
    await assert.rejects(inspectSigningFiles(root, manifest, f.policyBytes, () => tick++ === 0 ? now : now + 3600n,
      'test-only', hash(manifest), '1', '2', '1'), /RELEASE_HISTORICAL_BASELINE_UNAUTHORIZED/);
  });
});
