import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hash } from './release-envelope.mjs';
import { sourceRecoveryContracts } from './source-recovery-contracts.mjs';
import { prepareBaselineSigningBundle } from './build-signing-candidate.mjs';
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
