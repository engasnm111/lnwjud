import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { hash } from './release-envelope.mjs';
import { authenticateAuthorizationV2 } from './release-authorization-v2.mjs';
import { signingPurposeSelection } from './authenticated-signer-receipt.mjs';
import { inspectKeyFreeSigningCandidate, inspectKeyFreeWorkflowContext, keyFreeGhEnvironment, prepareKeyFreeUpdateCandidate, withIsolatedGhConfig } from './keyfree-signing-evidence.mjs';

const now = 1800000000n;
const repo = 'https://github.com/engasnm111/lnwjud';
const commit = 'a'.repeat(40);
const builderSha = '1ce343b41aa79f9b0f6c9ce10bf32c3201610c16';
const source = { runId: '500', commit, builderSha };
const bind = (name, bytes) => ({ name, sha256: hash(bytes), sizeBytes: String(bytes.length) });
const cert = () => ({
  issuer: 'https://token.actions.githubusercontent.com',
  subjectAlternativeName: `${repo}/.github/workflows/update-package-builder.yml@refs/heads/main`,
  sourceRepositoryURI: repo, sourceRepositoryDigest: commit, sourceRepositoryRef: 'refs/heads/main',
  buildSignerURI: `${repo}/.github/workflows/update-package-builder.yml@refs/heads/main`,
  buildSignerDigest: builderSha,
  buildConfigURI: `${repo}/.github/workflows/ci.yml@refs/heads/main`,
  buildConfigDigest: commit, runnerEnvironment: 'github-hosted',
  runInvocationURI: `${repo}/actions/runs/500/attempts/1`,
});
const verified = (identity, change = () => {}) => {
  const result = { verificationResult: {
    signature: { certificate: cert() },
    verifiedTimestamps: [{ type: 'Tlog', timestamp: new Date(Number(now) * 1000).toISOString(), uri: 'https://rekor.sigstore.dev/log/1' }],
    statement: { predicateType: 'https://slsa.dev/provenance/v1', subject: [{ name: identity.name, digest: { sha256: identity.sha256 } }] },
  } };
  change(result);
  return Buffer.from(JSON.stringify([result]));
};
async function fixture(root) {
  const policyBytes = Buffer.from(JSON.stringify({ protocol: 1, revision: 1, authorities: [], verifier: null }));
  const artifact = Buffer.from('not an installer - test fixture');
  const bundles = { artifactBundle: Buffer.from('test-only-artifact-bundle'), provenanceBundle: Buffer.from('test-only-provenance-bundle') };
  const compatibility = { migrationContractSha256: '1'.repeat(64), serviceContractSha256: '2'.repeat(64), workerContractSha256: '3'.repeat(64) };
  const release = {
    product: 'lnwjud', channel: 'stable', platform: 'win32', architecture: 'x64',
    releaseId: 'lnwjud-5.9.1-500', releaseSequence: '500', compatibility,
    distribution: 'windows-nsis', version: '5.9.1',
    source: { repository: repo, workflow: '.github/workflows/ci.yml', ref: 'refs/heads/main',
      commit, runId: '500', runAttempt: '1' },
    artifact: bind('lnwjud-Setup-5.9.1.exe', artifact),
    buildEvidence: { kind: 'github-artifact-attestation-v1',
      artifactAttestationSha256: hash(bundles.artifactBundle), provenanceAttestationSha256: hash(bundles.provenanceBundle) },
  };
  const provenance = Buffer.from(JSON.stringify({
    schemaVersion: 1, product: 'lnwjud', version: '5.9.1', platform: 'win32', arch: 'x64',
    recoveryCompatibility: compatibility,
    source: { repository: repo, commit, dirty: false },
    build: { environment: 'github-actions', signingCredentialConfigured: false, runId: '500', runAttempt: '1', ref: 'refs/heads/main' },
    artifacts: [{ name: release.artifact.name, sha256: release.artifact.sha256, sizeBytes: Number(release.artifact.sizeBytes) }],
  }));
  release.provenance = bind('PROVENANCE.json', provenance);
  const payload = Buffer.from(JSON.stringify({
    protocol: 2, policyRevision: 1, kind: 'baseline', release,
    issuedAt: String(now), notBefore: String(now), expiresAt: String(now + 3600n),
  }));
  const files = {
    candidate: ['CANDIDATE.json', payload],
    artifact: [release.artifact.name, artifact],
    provenance: ['PROVENANCE.json', provenance],
    artifactBundle: ['artifact.bundle.json', bundles.artifactBundle],
    provenanceBundle: ['provenance.bundle.json', bundles.provenanceBundle],
  };
  const manifest = Buffer.from(JSON.stringify({
    schema: 'lnwjud.signing-verification/v1',
    verification: { repositoryId: '1329830515', runId: '500', runAttempt: 1 },
    policySha256: hash(policyBytes), purpose: 'baseline',
    candidate: Object.fromEntries(Object.entries(files).map(([role, [name, bytes]]) => [role, bind(name, bytes)])),
  }));
  const candidateDir = path.join(root, 'files', 'candidate');
  await mkdir(candidateDir, { recursive: true });
  for (const [name, bytes] of Object.values(files)) await writeFile(path.join(candidateDir, name), bytes);
  await writeFile(path.join(root, 'manifest.json'), manifest);
  return { policyBytes, files, manifest, release, candidateDir };
}
async function withFixture(action) {
  const base = await realpath(tmpdir()), root = await mkdtemp(path.join(base, 'lnwjud-keyfree-'));
  try { await action(root, await fixture(root)); }
  finally {
    assert.equal(path.dirname(await realpath(root)), base, 'TEST_CLEANUP_REFUSED');
    assert.ok(path.basename(root).startsWith('lnwjud-keyfree-'), 'TEST_CLEANUP_REFUSED');
    await rm(root, { recursive: true });
  }
}
const inspect = (root, f, verify = ({ filename }) => {
  const kind = filename.endsWith('PROVENANCE.json') ? 'provenance' : 'artifact';
  return verified(f.release[kind]);
}) => inspectKeyFreeSigningCandidate({ root, policyBytes: f.policyBytes, source, now, verify });

async function predecessorFixture(root, f, change = () => {}) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
  const policy = JSON.parse(await readFile(new URL('../../config/update-release-policy.json', import.meta.url)));
  policy.roots = [{ keyId: 'keyfree-fixture', algorithm: 'ecdsa-p256-sha256-p1363',
    spkiBase64: spki.toString('base64'), spkiSha256: hash(spki), roles: ['release', 'recovery'],
    notBefore: String(now - 10000n), expiresAt: String(now + 86400n), revoked: false, allowHistoricalRecovery: true }];
  policy.authorities = [{ repository: repo, workflow: '.github/workflows/ci.yml', ref: 'refs/heads/main',
    issuer: 'https://token.actions.githubusercontent.com', builderWorkflowUri: `${repo}/.github/workflows/update-package-builder.yml@refs/heads/main`,
    builderDigest: builderSha, buildConfigUri: `${repo}/.github/workflows/ci.yml@refs/heads/main`, buildConfigDigestRule: 'source-commit',
    runnerEnvironment: 'github-hosted' }];
  f.release.buildEvidence.sourceTree = 'clean';
  const payload = JSON.parse(f.files.candidate[1]); payload.release = f.release;
  const oldArtifact = Buffer.from('older P256-authenticated installer fixture');
  const oldProvenance = Buffer.from('older P256-authenticated provenance fixture');
  const old = { ...JSON.parse(JSON.stringify(payload)), issuedAt: String(now - 2000n), notBefore: String(now - 2000n), expiresAt: String(now - 1000n) };
  old.release.version = '5.9.0'; old.release.releaseSequence = '100'; old.release.releaseId = 'lnwjud-5.9.0-100';
  old.release.source.runId = '100';
  old.release.artifact = bind('lnwjud-Setup-5.9.0.exe', oldArtifact);
  old.release.provenance = bind('PROVENANCE.json', oldProvenance);
  change({ old, policy });
  const oldBytes = Buffer.from(JSON.stringify(old));
  const envelope = Buffer.from(JSON.stringify({ protocol: 2, keyId: 'keyfree-fixture', payload: oldBytes.toString('base64'),
    signature: sign('sha256', Buffer.concat([Buffer.from('lnwjud-update-release-v2\0', 'ascii'), oldBytes]),
      { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') }));
  const directory = path.join(root, '_predecessor'); await mkdir(directory);
  for (const [name, bytes] of [['RELEASE.json', envelope], [old.release.artifact.name, oldArtifact], ['PROVENANCE.json', oldProvenance]])
    await writeFile(path.join(directory, name), bytes);
  f.policyBytes = Buffer.from(JSON.stringify(policy));
  const candidate = Buffer.from(JSON.stringify(payload));
  f.files.candidate[1] = candidate;
  await writeFile(path.join(f.candidateDir, 'CANDIDATE.json'), candidate);
  const manifest = JSON.parse(f.manifest); manifest.policySha256 = hash(f.policyBytes); manifest.candidate.candidate = bind('CANDIDATE.json', candidate);
  f.manifest = Buffer.from(JSON.stringify(manifest));
  await writeFile(path.join(root, 'manifest.json'), f.manifest);
  return { directory, envelope, policy, old };
}
const deriveUpdate = (root, f, previous, name = 'update') => prepareKeyFreeUpdateCandidate({ root,
  predecessorRoot: previous.directory, outputRoot: path.join(root, name), policyBytes: f.policyBytes,
  now, keyId: 'keyfree-fixture', previousEnvelopeSha256: hash(previous.envelope) });
const inspectUpdate = (root, f, previous, verify = ({ filename }) => verified(f.release[filename.endsWith('PROVENANCE.json') ? 'provenance' : 'artifact'])) =>
  inspectKeyFreeSigningCandidate({ root: path.join(root, 'update'), policyBytes: f.policyBytes, source, now, verify,
    keyId: 'keyfree-fixture', purpose: 'update', previousEnvelopeSha256: hash(previous.envelope) });

test('purpose selection preserves baseline and requires the complete immutable update selector', () => {
  assert.equal(signingPurposeSelection({}).purpose, 'baseline');
  const valid = { LNWJUD_SIGNING_PURPOSE: 'update', LNWJUD_PREDECESSOR_RUN_ID: '100',
    LNWJUD_PREDECESSOR_ARTIFACT_ID: '200', LNWJUD_PREDECESSOR_ENVELOPE_SHA256: 'a'.repeat(64) };
  assert.equal(signingPurposeSelection(valid).previousEnvelope, 'a'.repeat(64));
  for (const key of Object.keys(valid)) assert.throws(() => signingPurposeSelection({ ...valid, [key]: '' }));
  assert.throws(() => signingPurposeSelection({ ...valid, LNWJUD_SIGNING_PURPOSE: 'baseline' }));
  assert.throws(() => signingPurposeSelection({ ...valid, LNWJUD_PREDECESSOR_RUN_ID: '100\n' }));
});

test('update derivation authenticates P256 predecessor and preserves the attested candidate bytes', async () => {
  await withFixture(async (root, f) => {
    const previous = await predecessorFixture(root, f);
    const result = await deriveUpdate(root, f, previous);
    assert.equal(result.status, 'unsigned-update-derived-only');
    const candidate = JSON.parse(await readFile(path.join(root, 'update/files/candidate/CANDIDATE.json')));
    const authenticated = authenticateAuthorizationV2(previous.envelope, previous.policy, BigInt(previous.old.issuedAt), 'baseline');
    assert.deepEqual(candidate.release, f.release);
    assert.equal(candidate.kind, 'update');
    assert.equal(candidate.recovery.previousReleaseIdentity, authenticated.identitySha256);
    const receipt = await inspectUpdate(root, f, previous);
    assert.equal(receipt.schema, 'lnwjud.keyfree-update-evidence/v1');
    assert.equal(receipt.previousPurpose, 'baseline'); assert.equal(receipt.previousVersion, '5.9.0');
    assert.equal(receipt.previousEnvelopeSha256, hash(previous.envelope));
    assert.equal(receipt.previousReleaseIdentity, authenticated.identitySha256);
    assert.equal(receipt.candidateSha256, result.candidateSha256); assert.equal(receipt.manifestSha256, result.manifestSha256);
  });
});

test('update derivation refuses forged or mismatched predecessors before verification', async () => {
  for (const kind of ['signature', 'artifact', 'digest']) await withFixture(async (root, f) => {
    const previous = await predecessorFixture(root, f);
    if (kind === 'signature') {
      const envelope = JSON.parse(previous.envelope), bytes = Buffer.from(envelope.signature, 'base64'); bytes[0] ^= 1;
      envelope.signature = bytes.toString('base64'); await writeFile(path.join(previous.directory, 'RELEASE.json'), JSON.stringify(envelope));
    } else if (kind === 'artifact') await writeFile(path.join(previous.directory, previous.old.release.artifact.name), 'changed');
    else previous.envelope = Buffer.from('wrong requested digest');
    await assert.rejects(deriveUpdate(root, f, previous));
    await assert.rejects(lstat(path.join(root, 'update')), { code: 'ENOENT' });
  });
});

test('update evidence authenticates a previously signed update as the predecessor', async () => {
  await withFixture(async (root, f) => {
    const previous = await predecessorFixture(root, f, ({ old }) => {
      old.kind = 'update'; old.recovery = { purpose: 'failed-candidate-only', previousReleaseIdentity: 'd'.repeat(64), maximumAttempts: 1 };
    });
    await deriveUpdate(root, f, previous);
    const receipt = await inspectUpdate(root, f, previous);
    assert.equal(receipt.previousPurpose, 'update'); assert.equal(receipt.previousEnvelopeSha256, hash(previous.envelope));
  });
});

test('update derivation rejects unauthorized expiry, source, version and recovery contracts', async () => {
  for (const change of [({ policy }) => { policy.roots[0].allowHistoricalRecovery = false; },
    ({ old }) => { old.release.source.ref = 'refs/heads/untrusted'; },
    ({ policy }) => { policy.authorities[0].builderDigest = 'b'.repeat(40); },
    ({ policy }) => { policy.authorities[0].builderWorkflowUri = `${repo}/.github/workflows/other.yml@refs/heads/main`; },
    ({ old }) => { old.release.version = '5.9.2'; old.release.artifact.name = 'lnwjud-Setup-5.9.2.exe'; },
    ({ old }) => { old.release.compatibility.workerContractSha256 = 'f'.repeat(64); }])
    await withFixture(async (root, f) => { const previous = await predecessorFixture(root, f, change); await assert.rejects(deriveUpdate(root, f, previous)); });
});

test('update verifier refuses replaced predecessor and missing candidate bundle before any attestation callback', async () => {
  for (const kind of ['previous', 'bundle']) await withFixture(async (root, f) => {
    const previous = await predecessorFixture(root, f); await deriveUpdate(root, f, previous);
    if (kind === 'previous') await writeFile(path.join(root, 'update/files/predecessor/RELEASE.json'), 'changed');
    else await rm(path.join(root, 'update/files/candidate/artifact.bundle.json'));
    let called = false;
    await assert.rejects(inspectUpdate(root, f, previous, () => { called = true; return verified(f.release.artifact); }));
    assert.equal(called, false);
  });
});

test('update verifier rechecks exact predecessor bytes after an asynchronous verifier callback', async () => {
  await withFixture(async (root, f) => {
    const previous = await predecessorFixture(root, f); await deriveUpdate(root, f, previous);
    let calls = 0;
    await assert.rejects(inspectUpdate(root, f, previous, async ({ filename }) => {
      if (++calls === 2) await writeFile(path.join(root, 'update/files/predecessor/RELEASE.json'), 'replaced after verification');
      return verified(f.release[filename.endsWith('PROVENANCE.json') ? 'provenance' : 'artifact']);
    }));
    assert.equal(calls, 2);
  });
});

test('key-free verifier accepts only the exact protected workflow identity', () => {
  const environment = {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'engasnm111/lnwjud',
    GITHUB_REPOSITORY_ID: '1329830515', GITHUB_REF: 'refs/heads/main',
    GITHUB_REF_PROTECTED: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: 'engasnm111/lnwjud/.github/workflows/update-signing.yml@refs/heads/main',
    GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKFLOW_SHA: 'a'.repeat(40), GITHUB_RUN_ATTEMPT: '1',
  };
  assert.deepEqual(inspectKeyFreeWorkflowContext(environment), { sourceSha: 'a'.repeat(40) });
  for (const [name, value] of [
    ['GITHUB_REPOSITORY_ID', '123'], ['GITHUB_REPOSITORY', 'attacker/lnwjud'],
    ['GITHUB_WORKFLOW_REF', 'engasnm111/lnwjud/.github/workflows/ci.yml@refs/heads/main'],
    ['GITHUB_WORKFLOW_REF', 'engasnm111/lnwjud/.github/workflows/update-signing.yml@refs/heads/dev'],
    ['GITHUB_REF', 'refs/heads/dev'], ['GITHUB_REF_PROTECTED', 'false'],
    ['GITHUB_EVENT_NAME', 'pull_request'], ['GITHUB_RUN_ATTEMPT', '2'],
    ['GITHUB_WORKFLOW_SHA', 'b'.repeat(40)], ['GITHUB_SHA', 'not-a-commit'],
    ['LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM', ''],
    ['lnwjud_update_release_private_key_pem', 'fixture-secret'],
  ]) assert.throws(() => inspectKeyFreeWorkflowContext({ ...environment, [name]: value }),
    /KEYFREE_SIGNING_EVIDENCE_REFUSED/, name);
});

test('pinned GitHub verifier subprocess environment rejects signer keys before launch', () => {
  const environment = { PATH: 'fixture-path', PATHEXT: '.EXE;.CMD', COMSPEC: 'C:\\untrusted\\cmd.exe',
    SystemRoot: 'C:\\Windows', GH_HOST: 'untrusted.example', GH_TOKEN: 'old-token',
    GH_CONFIG_DIR: 'attacker-controlled', GIT_CONFIG_GLOBAL: 'attacker-config',
    NODE_OPTIONS: '--require=untrusted', GITHUB_TOKEN: 'unrelated-credential' };
  const isolated = path.resolve('fixture-keyfree-gh-config');
  const allowed = keyFreeGhEnvironment(environment, 'verified-fixture-token', isolated);
  assert.equal(allowed.GH_HOST, 'github.com');
  assert.equal(allowed.GH_TOKEN, 'verified-fixture-token');
  assert.equal(allowed.GH_PROMPT_DISABLED, '1');
  assert.equal(Reflect.get(allowed, 'SystemRoot'), 'C:\\Windows');
  for (const name of ['PATH', 'PATHEXT', 'COMSPEC'])
    assert.equal(Object.hasOwn(allowed, name), false, `${name} must not control verifier helper lookup`);
  for (const name of ['GH_CONFIG_DIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'])
    assert.equal(allowed[name], isolated, `${name} must use the fresh isolated directory`);
  for (const name of ['GIT_CONFIG_GLOBAL', 'NODE_OPTIONS', 'GITHUB_TOKEN'])
    assert.equal(Object.hasOwn(allowed, name), false, `${name} must not reach the verifier`);
  assert.equal(environment.GH_HOST, 'untrusted.example');
  // Windows treats environment names case-insensitively; Node may otherwise
  // choose a caller-controlled duplicate instead of the intended OS path.
  for (const entries of [
    [['SystemRoot', 'C:\\Windows'], ['SYSTEMROOT', 'C:\\untrusted']],
    [['SYSTEMROOT', 'C:\\untrusted'], ['SystemRoot', 'C:\\Windows']],
  ]) {
    assert.throws(() => keyFreeGhEnvironment(Object.fromEntries(entries), 'verified-fixture-token', isolated),
      /KEYFREE_SIGNING_EVIDENCE_REFUSED/);
  }
  for (const name of ['LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM', 'lnwjud_update_release_private_key_pem']) {
    for (const value of ['', 'fixture-secret']) {
      assert.throws(() => keyFreeGhEnvironment({ ...environment, [name]: value }, 'verified-fixture-token', isolated),
        /KEYFREE_SIGNING_EVIDENCE_REFUSED/);
    }
  }
  assert.throws(() => keyFreeGhEnvironment(environment, '', isolated), /KEYFREE_SIGNING_EVIDENCE_REFUSED/);
  assert.throws(() => keyFreeGhEnvironment(environment, 'verified-fixture-token', undefined), /KEYFREE_SIGNING_EVIDENCE_REFUSED/);
  assert.throws(() => keyFreeGhEnvironment(environment, 'verified-fixture-token', 'relative-dir'),
    /KEYFREE_SIGNING_EVIDENCE_REFUSED/);
});

test('key-free verifier creates fresh empty GitHub CLI configuration and removes it after success or failure', async () => {
  let directory;
  await withIsolatedGhConfig(async location => {
    directory = location;
    assert.equal(await readFile(path.join(location, 'config.yml'), 'utf8'), '{}\n');
    assert.equal(await readFile(path.join(location, 'hosts.yml'), 'utf8'), '{}\n');
  });
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
  await assert.rejects(withIsolatedGhConfig(async location => {
    directory = location;
    throw new Error('fixture-verifier-failure');
  }), /fixture-verifier-failure/);
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
});

test('key-free verifier refuses recursive deletion of unexpected verifier-controlled entries', async () => {
  let isolated;
  try {
    await assert.rejects(withIsolatedGhConfig(async location => {
      isolated = location;
      await writeFile(path.join(location, 'unexpected-verifier-output'), 'retain for inspection');
    }), /KEYFREE_SIGNING_EVIDENCE_REFUSED/);
    assert.equal(await readFile(path.join(isolated, 'unexpected-verifier-output'), 'utf8'),
      'retain for inspection');
  } finally {
    if (isolated) await rm(isolated, { recursive: true, force: true });
  }
});

test('key-free verifier checks both exact attestation subjects without authorizing signing', async () => {
  await withFixture(async (root, f) => {
    let calls = 0;
    const result = await inspect(root, f, args => {
      calls++;
      assert.equal(args.source.runId, '500');
      assert.equal(args.authority.builderDigest, builderSha);
      assert.equal(args.bundle, path.join(f.candidateDir, calls === 1 ? 'artifact.bundle.json' : 'provenance.bundle.json'));
      return verified(f.release[calls === 1 ? 'artifact' : 'provenance']);
    });
    assert.equal(calls, 2);
    assert.equal(result.schema, 'lnwjud.keyfree-evidence/v1');
    assert.equal(result.status, 'key-free-attestations-observed-only');
    assert.equal(result.sourceSha, source.commit);
    assert.equal(result.sourceRunId, source.runId);
    assert.equal(result.builderSha, builderSha);
    assert.equal(result.policySha256, hash(f.policyBytes));
    assert.equal(result.candidateSha256, hash(f.files.candidate[1]));
    assert.equal(result.manifestSha256, hash(f.manifest));
    assert.equal(Object.hasOwn(result, 'signed'), false);
  });
});

test('key-free verifier rejects changed package bytes, source substitution and unauthenticated update', async () => {
  await withFixture(async (root, f) => {
    await assert.rejects(inspectKeyFreeSigningCandidate({ root, policyBytes: f.policyBytes,
      source: { ...source, commit: 'b'.repeat(40) }, now, verify: () => verified(f.release.artifact) }));
    await writeFile(path.join(f.candidateDir, f.release.artifact.name), 'tampered');
    await assert.rejects(inspect(root, f));
  });
  await withFixture(async (root, f) => {
    const changed = JSON.parse(f.manifest);
    changed.purpose = 'update';
    changed.predecessor = { envelope: bind('RELEASE.json', Buffer.from('a')),
      artifact: bind('old.exe', Buffer.from('a')), provenance: bind('PROVENANCE.json', Buffer.from('a')) };
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify(changed));
    await assert.rejects(inspect(root, f));
  });
});

test('key-free verifier rejects a candidate whose expiry precedes its issue time', async () => {
  await withFixture(async (root, f) => {
    const candidatePath = path.join(f.candidateDir, 'CANDIDATE.json');
    const payload = JSON.parse(await readFile(candidatePath, 'utf8'));
    payload.issuedAt = String(now + 300n);
    payload.notBefore = payload.issuedAt;
    payload.expiresAt = String(now + 100n);
    const candidateBytes = Buffer.from(JSON.stringify(payload));
    await writeFile(candidatePath, candidateBytes);
    const manifest = JSON.parse(f.manifest);
    manifest.candidate.candidate = bind('CANDIDATE.json', candidateBytes);
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(inspect(root, f), /KEYFREE_SIGNING_EVIDENCE_REFUSED/);
  });
});

test('key-free verifier binds source identity before an asynchronous verifier callback', async () => {
  await withFixture(async (root, f) => {
    const mutableSource = { ...source };
    const result = await inspectKeyFreeSigningCandidate({ root, policyBytes: f.policyBytes,
      source: mutableSource, now, verify: ({ filename, source: verifiedSource }) => {
        mutableSource.commit = 'b'.repeat(40);
        assert.equal(verifiedSource.commit, commit);
        return verified(f.release[filename.endsWith('PROVENANCE.json') ? 'provenance' : 'artifact']);
      } });
    assert.equal(result.sourceSha, commit);
    assert.equal(result.sourceRunId, '500');
  });
});

test('key-free verifier refuses persistent candidate or manifest substitution during attestation', async () => {
  await withFixture(async (root, f) => {
    let calls = 0;
    await assert.rejects(inspect(root, f, ({ filename }) => {
      if (++calls === 1) writeFileSync(path.join(f.candidateDir, f.release.artifact.name), 'swapped during verification');
      return verified(f.release[filename.endsWith('PROVENANCE.json') ? 'provenance' : 'artifact']);
    }), /KEYFREE_SIGNING_EVIDENCE_REFUSED/);
  });
  await withFixture(async (root, f) => {
    let calls = 0;
    await assert.rejects(inspect(root, f, ({ filename }) => {
      if (++calls === 1) writeFileSync(path.join(f.candidateDir, 'CANDIDATE.json'), '{}');
      return verified(f.release[filename.endsWith('PROVENANCE.json') ? 'provenance' : 'artifact']);
    }), /KEYFREE_SIGNING_EVIDENCE_REFUSED/);
  });
  await withFixture(async (root, f) => {
    let calls = 0;
    await assert.rejects(inspect(root, f, ({ filename }) => {
      if (++calls === 1) writeFileSync(path.join(root, 'manifest.json'), '{}');
      return verified(f.release[filename.endsWith('PROVENANCE.json') ? 'provenance' : 'artifact']);
    }), /KEYFREE_SIGNING_EVIDENCE_REFUSED/);
  });
});

test('key-free diagnostic refuses a signing secret injected during asynchronous attestation', async () => {
  for (const secret of ['', 'fixture-secret']) {
    await withFixture(async (root, f) => {
      try {
        await assert.rejects(inspect(root, f, ({ filename }) => {
          process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM = secret;
          return verified(f.release[filename.endsWith('PROVENANCE.json') ? 'provenance' : 'artifact']);
        }), /KEYFREE_SIGNING_EVIDENCE_REFUSED/);
      } finally {
        delete process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM;
      }
    });
  }
});

test('key-free verifier refuses wrong attestation signer and subject', async () => {
  await withFixture(async (root, f) => {
    await assert.rejects(inspect(root, f, ({ filename }) => verified(
      f.release[filename.endsWith('PROVENANCE.json') ? 'provenance' : 'artifact'],
      value => { value.verificationResult.signature.certificate.buildSignerDigest = 'b'.repeat(40); })));
    await assert.rejects(inspect(root, f, ({ filename }) => verified(
      f.release[filename.endsWith('PROVENANCE.json') ? 'provenance' : 'artifact'],
      value => { value.verificationResult.statement.subject[0].digest.sha256 = 'b'.repeat(64); })));
  });
});
