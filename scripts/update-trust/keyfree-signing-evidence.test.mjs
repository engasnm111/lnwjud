import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { hash } from './release-envelope.mjs';
import { inspectKeyFreeSigningCandidate, keyFreeGhEnvironment, withIsolatedGhConfig } from './keyfree-signing-evidence.mjs';

const now = 1800000000n;
const repo = 'https://github.com/engasnm111/lnwjud';
const commit = 'a'.repeat(40);
const builderSha = 'cd833d7df45a8ecf2e87bc89ffb9ee3c85d20406';
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
    assert.equal(result.status, 'key-free-attestations-observed-only');
    assert.equal(result.manifestSha256, hash(f.manifest));
    assert.equal(Object.hasOwn(result, 'signed'), false);
  });
});

test('key-free verifier rejects changed package bytes, source substitution and unsupported update', async () => {
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
