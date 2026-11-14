/* global structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hash, loadProductionPolicy, requireConfigured } from './release-envelope.mjs';
import { prepareSignedOutput, verifySignedOutput } from './signed-release-output.mjs';
import { fetchPublishedPredecessor } from './fetch-published-predecessor.mjs';
import { selectSignedArtifacts } from './release-signed-artifacts.mjs';
import { signingPurposeSelection } from './authenticated-signer-receipt.mjs';

const now = 1800000000n, sourceSha = 'a'.repeat(40), sourceRunId = '500';
const identity = (name, bytes) => ({ name, sizeBytes: String(bytes.length), sha256: hash(bytes) });
async function fixture(action) {
  const base = await realpath(os.tmpdir());
  const workspace = await realpath(await mkdtemp(path.join(base, 'lnwjud-signed-output-')));
  try {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
    const policy = loadProductionPolicy();
    policy.roots = [{ keyId: 'fixture-only', algorithm: 'ecdsa-p256-sha256-p1363', spkiBase64: spki.toString('base64'),
      spkiSha256: hash(spki), roles: ['release', 'recovery'], notBefore: '1790000000', expiresAt: '1900000000', revoked: false, allowHistoricalRecovery: true }];
    const source = { repository: 'https://github.com/engasnm111/lnwjud', commit: sourceSha, workflow: '.github/workflows/ci.yml',
      ref: 'refs/heads/main', runId: sourceRunId, runAttempt: '1' };
    const subjects = new Map([
      ['lnwjud-Setup-5.9.2.exe', Buffer.from('fixture installer bytes')],
      ['lnwjud-Portable-5.9.2.exe', Buffer.from('fixture portable bytes')],
      ['INSTALL-LAYOUT.json', Buffer.from('{"fixture":"layout identity only"}')],
      ['lnwjud-Update-5.9.2-win32-x64.zip', Buffer.from('fixture update ZIP identity only')],
      ['artifact.bundle.json', Buffer.from('fixture artifact bundle identity')],
      ['provenance.bundle.json', Buffer.from('fixture provenance bundle identity')],
    ]);
    const compatibility = { migrationContractSha256: '1'.repeat(64), serviceContractSha256: '2'.repeat(64), workerContractSha256: '3'.repeat(64) };
    const metadata = { schemaVersion: 1, product: 'lnwjud', version: '5.9.2', platform: 'win32', arch: 'x64',
      source: { repository: source.repository, commit: sourceSha, dirty: false },
      build: { environment: 'github-actions', runId: sourceRunId, runAttempt: '1', ref: source.ref, signingCredentialConfigured: false },
      artifacts: ['lnwjud-Setup-5.9.2.exe', 'lnwjud-Portable-5.9.2.exe'].map(name => ({ ...identity(name, subjects.get(name)), sizeBytes: subjects.get(name).length })),
      recoveryCompatibility: compatibility,
      installedLayout: identity('INSTALL-LAYOUT.json', subjects.get('INSTALL-LAYOUT.json')),
      updatePayload: identity('lnwjud-Update-5.9.2-win32-x64.zip', subjects.get('lnwjud-Update-5.9.2-win32-x64.zip')) };
    subjects.set('PROVENANCE.json', Buffer.from(JSON.stringify(metadata)));
    const sums = [...metadata.artifacts, metadata.installedLayout, metadata.updatePayload, identity('PROVENANCE.json', subjects.get('PROVENANCE.json'))];
    subjects.set('SHA256SUMS.txt', Buffer.from(sums.map(item => `${item.sha256}  ${item.name}`).join('\n') + '\n'));
    const release = { product: 'lnwjud', releaseId: 'lnwjud-5.9.2-500', channel: 'stable', version: '5.9.2', releaseSequence: '500',
      platform: 'win32', architecture: 'x64', distribution: 'windows-nsis', source, compatibility,
      artifact: identity('lnwjud-Setup-5.9.2.exe', subjects.get('lnwjud-Setup-5.9.2.exe')),
      provenance: identity('PROVENANCE.json', subjects.get('PROVENANCE.json')),
      buildEvidence: { kind: 'github-artifact-attestation-v1', sourceTree: 'clean',
        artifactAttestationSha256: hash(subjects.get('artifact.bundle.json')), provenanceAttestationSha256: hash(subjects.get('provenance.bundle.json')) } };
    const payload = Buffer.from(JSON.stringify({ protocol: 2, policyRevision: 1, kind: 'baseline', release,
      issuedAt: String(now), notBefore: String(now), expiresAt: String(now + 31536000n) }));
    const envelope = Buffer.from(JSON.stringify({ protocol: 2, keyId: 'fixture-only', payload: payload.toString('base64'),
      signature: sign('sha256', Buffer.concat([Buffer.from('lnwjud-update-release-v2\0'), payload]),
        { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') }));
    await mkdir(path.join(workspace, '_subjects'));
    for (const [name, bytes] of subjects) await writeFile(path.join(workspace, '_subjects', name), bytes);
    await mkdir(path.join(workspace, '_signed-release/public'), { recursive: true });
    await writeFile(path.join(workspace, '_signed-release/public/BASELINE-win32-x64.json'), envelope);
    return await action({ workspace, policy, release, subjects, envelope });
  } finally {
    assert.equal(path.dirname(await realpath(workspace)), base);
    assert.ok(path.basename(workspace).startsWith('lnwjud-signed-output-'));
    await rm(workspace, { recursive: true });
  }
}
const prepare = f => prepareSignedOutput({ ...f, purpose: 'baseline', now, signerRunId: '600', signerRunAttempt: '1' });
const verify = (f, extra = {}) => verifySignedOutput({ directory: path.join(f.workspace, '_signed-release'), policy: f.policy,
  now, sourceSha, sourceRunId, purpose: 'baseline', ...extra });

test('signed baseline carries exact attested Setup, real payload identities and public native sidecars', async () => fixture(async f => {
  await prepare(f);
  assert.equal((await verify(f)).payload.release.version, '5.9.2');
  for (const name of ['lnwjud-Setup-5.9.2.exe', 'lnwjud-Update-5.9.2-win32-x64.zip', 'INSTALL-LAYOUT.json'])
    assert.deepEqual(await readFile(path.join(f.workspace, '_signed-release/windows', name)), f.subjects.get(name));
  await assert.rejects(verify(f, { sourceSha: 'b'.repeat(40) }));
  await assert.rejects(verify(f, { sourceRunId: '501' }));
  await assert.rejects(verify(f, { now: now + 31536000n }));
}));

test('rewriting unsigned output inventory cannot authorize substituted payload or bundle bytes', async () => {
  for (const name of ['windows/lnwjud-Update-5.9.2-win32-x64.zip', 'public/ARTIFACT-win32-x64.bundle.json'])
    await fixture(async f => {
      await prepare(f);
      const root = path.join(f.workspace, '_signed-release');
      const replacement = Buffer.from('substituted untrusted bytes');
      await writeFile(path.join(root, name), replacement);
      const manifest = JSON.parse(await readFile(path.join(root, 'SIGNING-OUTPUT.json')));
      Object.assign(manifest.files.find(item => item.path === name), identity(undefined, replacement));
      await writeFile(path.join(root, 'SIGNING-OUTPUT.json'), JSON.stringify(manifest));
      await assert.rejects(verify(f));
    });
});

test('output refuses undeclared executable files, duplicate paths and expired or revoked roots', async () => fixture(async f => {
  await prepare(f);
  const root = path.join(f.workspace, '_signed-release');
  const filename = path.join(root, 'SIGNING-OUTPUT.json');
  const original = await readFile(filename);
  const manifest = JSON.parse(original); manifest.files.push(manifest.files[0]);
  await writeFile(filename, JSON.stringify(manifest)); await assert.rejects(verify(f));
  await writeFile(filename, original);
  f.policy.roots[0].revoked = true; await assert.rejects(verify(f)); f.policy.roots[0].revoked = false;
  await writeFile(path.join(root, 'windows/untrusted.cmd'), 'must never execute'); await assert.rejects(verify(f));
}));

test('published predecessor survives Actions artifact expiry and remains cryptographically authenticated', async () => fixture(async f => {
  const requests = [];
  const fetch = async url => {
    requests.push(url);
    const name = url.split('/').at(-1);
    const bytes = name === 'BASELINE-win32-x64.json' ? f.envelope
      : f.subjects.get(name === 'PROVENANCE-win32-x64.json' ? 'PROVENANCE.json' : name);
    assert.ok(bytes);
    return { ok: true, body: (async function* () { yield bytes; })() };
  };
  const digest = await fetchPublishedPredecessor({ tag: 'v5.9.2', directory: path.join(f.workspace, 'previous'),
    policy: f.policy, now: now + 10n, fetch });
  assert.equal(digest, hash(f.envelope));
  assert.deepEqual(requests, ['BASELINE-win32-x64.json', f.release.artifact.name, 'PROVENANCE-win32-x64.json']
    .map(name => `https://github.com/engasnm111/lnwjud/releases/download/v5.9.2/${name}`));
  await assert.rejects(fetchPublishedPredecessor({ tag: '../../attacker', directory: path.join(f.workspace, 'bad'), policy: f.policy, now, fetch }));
  assert.equal(requests.length, 3);
  f.policy.roots[0].revoked = true;
  await assert.rejects(fetchPublishedPredecessor({ tag: 'v5.9.2', directory: path.join(f.workspace, 'revoked'), policy: f.policy, now, fetch }));
  assert.equal(requests.length, 4, 'reject unauthenticated metadata before downloading installer');
}));

test('production TTL is one bounded year and public predecessor selection cannot mix artifact and tag inputs', () => {
  const policy = loadProductionPolicy();
  requireConfigured(policy); assert.equal(policy.limits.maximumValiditySeconds, '31536000');
  policy.limits.maximumValiditySeconds = '31536001'; assert.throws(() => requireConfigured(policy));
  assert.equal(signingPurposeSelection({ LNWJUD_SIGNING_PURPOSE: 'update', LNWJUD_PREDECESSOR_RELEASE_TAG: 'v5.9.2' }).previousTag, 'v5.9.2');
  assert.throws(() => signingPurposeSelection({ LNWJUD_SIGNING_PURPOSE: 'baseline', LNWJUD_PREDECESSOR_RELEASE_TAG: 'v5.9.2' }));
  assert.throws(() => signingPurposeSelection({ LNWJUD_SIGNING_PURPOSE: 'update', LNWJUD_PREDECESSOR_RELEASE_TAG: 'v5.9.2', LNWJUD_PREDECESSOR_RUN_ID: '1' }));
});

test('release selects only exact-source successful signer artifacts and requires a signed baseline', () => {
  const run = { id: 600, head_sha: sourceSha, head_branch: 'main', path: '.github/workflows/update-signing.yml', event: 'workflow_dispatch',
    status: 'completed', conclusion: 'success', run_attempt: 1, repository: { full_name: 'engasnm111/lnwjud' }, head_repository: { full_name: 'engasnm111/lnwjud' } };
  const listing = { total_count: 1, artifacts: [{ id: 700, name: 'update-signed-baseline-500-600-1', expired: false,
    workflow_run: { id: 600, head_sha: sourceSha }, digest: 'sha256:' + 'b'.repeat(64) }] };
  assert.equal(selectSignedArtifacts([run], [listing], sourceSha, sourceRunId).baseline.runId, '600');
  for (const change of [value => { value.head_sha = 'b'.repeat(40); }, value => { value.conclusion = 'failure'; },
    value => { value.run_attempt = 2; }, value => { value.repository.full_name = 'attacker/lnwjud'; }]) {
    const changed = structuredClone(run); change(changed);
    assert.throws(() => selectSignedArtifacts([changed], [listing], sourceSha, sourceRunId));
  }
  assert.throws(() => selectSignedArtifacts([run], [{ total_count: 0, artifacts: [] }], sourceSha, sourceRunId));
  const expired = structuredClone(listing); expired.artifacts[0].expired = true;
  assert.throws(() => selectSignedArtifacts([run], [expired], sourceSha, sourceRunId));
});
