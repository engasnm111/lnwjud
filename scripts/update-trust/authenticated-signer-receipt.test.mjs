import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign, createPublicKey } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL, URL } from 'node:url';
import { hash } from './release-envelope.mjs';
import { authenticateAuthorizationV2 } from './release-authorization-v2.mjs';
import { inspectSignerVerifierJob, signerBinding, signerBindingFromReceipt, signerHostContext, signerReceiptAudience,
  trustedSignerOidcKeys, verifySignerReceipt, withAuthenticatedSignerReceipt } from './authenticated-signer-receipt.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'receiver-fixture', alg: 'RS256', use: 'sig' };
const now = Math.floor(Date.now() / 1000);
const context = Object.freeze({ workflowSha: 'a'.repeat(40), runId: '600', runAttempt: '1', verifierCheckRunId: '701' });
const request = Object.freeze({ schema: 'lnwjud.signer-request/v1', purpose: 'baseline', sourceSha: context.workflowSha,
  sourceRunId: '500', sourceRunAttempt: '1', builderSha: 'b'.repeat(40), policySha256: '1'.repeat(64),
  candidateSha256: '2'.repeat(64), manifestSha256: '3'.repeat(64), recipientSpkiSha256: '4'.repeat(64), challenge: '5'.repeat(64),
  signerRunId: context.runId, signerRunAttempt: context.runAttempt, signerWorkflowSha: context.workflowSha, previousEnvelopeSha256: 'none' });
const receipt = Object.freeze({ schema: 'lnwjud.keyfree-evidence/v1', status: 'key-free-attestations-observed-only',
  sourceSha: request.sourceSha, sourceRunId: request.sourceRunId, builderSha: request.builderSha,
  policySha256: request.policySha256, candidateSha256: request.candidateSha256, manifestSha256: request.manifestSha256 });
const claims = () => ({ iss: 'https://token.actions.githubusercontent.com', aud: signerReceiptAudience(request),
  sub: 'repo:engasnm111@58149374/lnwjud@1329830515:ref:refs/heads/main', repository: 'engasnm111/lnwjud',
  repository_id: '1329830515', repository_owner: 'engasnm111', repository_owner_id: '58149374', repository_visibility: 'public',
  ref: 'refs/heads/main', ref_type: 'branch', ref_protected: 'true', event_name: 'workflow_dispatch', runner_environment: 'github-hosted',
  sha: context.workflowSha, workflow_sha: context.workflowSha,
  workflow_ref: 'engasnm111/lnwjud/.github/workflows/update-signing.yml@refs/heads/main',
  run_id: context.runId, run_attempt: context.runAttempt, check_run_id: context.verifierCheckRunId,
  jti: 'fixture-unique-token', nbf: now - 30, iat: now, exp: now + 300 });
function jwt(payload = claims(), header = { alg: 'RS256', typ: 'JWT', kid: jwk.kid }) {
  const bytes = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
  const prefix = `${bytes(header)}.${bytes(payload)}`;
  return `${prefix}.${sign('RSA-SHA256', Buffer.from(prefix, 'ascii'), privateKey).toString('base64url')}`;
}
const verify = (token, binding = request, expected = context, keys = [jwk], clock = now) => verifySignerReceipt(token, binding, expected, keys, clock);
const env = () => ({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'engasnm111/lnwjud', GITHUB_REPOSITORY_ID: '1329830515',
  GITHUB_REPOSITORY_OWNER_ID: '58149374', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
  GITHUB_REF_PROTECTED: 'true', GITHUB_WORKFLOW_REF: 'engasnm111/lnwjud/.github/workflows/update-signing.yml@refs/heads/main',
  GITHUB_WORKFLOW_SHA: context.workflowSha, GITHUB_SHA: context.workflowSha, GITHUB_RUN_ID: context.runId,
  GITHUB_RUN_ATTEMPT: context.runAttempt, GITHUB_JOB: 'receive-signing-evidence', RUNNER_ENVIRONMENT: 'github-hosted',
  LNWJUD_VERIFIER_CHECK_RUN_ID: context.verifierCheckRunId });
async function fixture(action) {
  const base = await realpath(os.tmpdir()), directory = await realpath(await mkdtemp(path.join(base, 'lnwjud-signer-receiver-')));
  try {
    const control = path.join(directory, 'scripts/update-trust');
    await mkdir(control, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
    for (const name of ['release-envelope.mjs', 'release-identity.mjs', 'release-authorization-v2.mjs', 'produce-release-authorization-v2.mjs',
      'produce-release-envelope.mjs', 'authenticated-signer-receipt.mjs', 'verify-build-evidence.mjs', 'pinned-verifier.mjs'])
      await copyFile(new URL(`./${name}`, import.meta.url), path.join(control, name));
    await mkdir(path.join(directory, 'packages/capabilities/src'), { recursive: true });
    await copyFile(new URL('../../packages/capabilities/src/containment-integrity.generated.ts', import.meta.url),
      path.join(directory, 'packages/capabilities/src/containment-integrity.generated.ts'));
    await mkdir(path.join(directory, 'config'));
    for (const name of ['update-release-schema.json', 'update-release-identity-v1.json', 'update-release-authorization-v2.json'])
      await copyFile(new URL(`../../config/${name}`, import.meta.url), path.join(directory, 'config', name));
    await writeFile(path.join(control, 'github-oidc-pins.json'), JSON.stringify({ issuer: claims().iss,
      notBefore: now - 60, expiresAt: now + 86400, keys: [jwk] }));
    const receiver = await import(pathToFileURL(path.join(control, 'authenticated-signer-receipt.mjs')).href);
    return await action(directory, receiver);
  }
  finally {
    assert.equal(await realpath(directory), directory);
    assert.equal(path.dirname(directory), base);
    assert.ok(path.basename(directory).startsWith('lnwjud-signer-receiver-'));
    await rm(directory, { recursive: true });
  }
}

test('RS256 proof binds the exact recipient, request and independently selected verifier job', () => {
  const proof = verify(jwt());
  assert.equal(proof.runId, context.runId);
  assert.equal(proof.challenge, request.challenge);
  assert.equal(proof.expiresAt, now + 300);
  assert.equal(Object.isFrozen(proof), true);
  assert.deepEqual(signerBindingFromReceipt(receipt, context, request.challenge, request.recipientSpkiSha256, 'baseline', 'none'), request);
  assert.deepEqual(signerHostContext(env(), 'receive-signing-evidence'), context);
});

test('correctly signed cross-job, cross-run, cross-repository and unprotected proofs refuse', () => {
  for (const [name, value] of Object.entries({ iss: 'https://other.invalid', aud: 'other', sub: 'repo:engasnm111/lnwjud:ref:refs/heads/main',
    repository: 'other/lnwjud', repository_id: '12', repository_owner_id: '34', repository_owner: 'other', repository_visibility: 'private',
    ref: 'refs/heads/dev', ref_type: 'tag', ref_protected: false, event_name: 'pull_request', runner_environment: 'self-hosted',
    sha: 'c'.repeat(40), workflow_sha: 'c'.repeat(40), workflow_ref: 'other', run_id: '601', run_attempt: '2', check_run_id: '702',
    head_ref: 'branch', base_ref: 'main', environment: 'other', jti: '', iat: now + 31, nbf: now + 31, exp: now }))
    assert.throws(() => verify(jwt({ ...claims(), [name]: value })), /SIGNER_RECEIPT_REFUSED/, name);
  for (const altered of [{ ...claims(), exp: now + 601 }, { ...claims(), iat: now - 601, exp: now + 1 },
    { ...claims(), nbf: now - 601 }, { ...claims(), exp: String(now + 300) }])
    assert.throws(() => verify(jwt(altered)), /SIGNER_RECEIPT_REFUSED/);
});

test('input, policy, nonce, recipient and predecessor substitutions cannot reuse a valid proof', () => {
  const token = jwt();
  for (const field of ['candidateSha256', 'policySha256', 'manifestSha256', 'recipientSpkiSha256', 'challenge', 'builderSha', 'sourceRunId']) {
    const altered = { ...request, [field]: field === 'sourceRunId' ? '501' : field === 'builderSha' ? 'c'.repeat(40) : 'a'.repeat(64) };
    assert.throws(() => verify(token, altered), /SIGNER_RECEIPT_REFUSED/, field);
  }
  assert.throws(() => verify(token, { ...request, purpose: 'update', previousEnvelopeSha256: '6'.repeat(64) }), /SIGNER_RECEIPT_REFUSED/);
  for (const altered of [{ ...context, verifierCheckRunId: '702' }, { ...context, runAttempt: '2' }, { ...context, workflowSha: 'c'.repeat(40) }])
    assert.throws(() => verify(token, request, altered), /SIGNER_RECEIPT_REFUSED/);
});

test('algorithm, key, signature, duplicate JSON and noncanonical encodings refuse', () => {
  for (const header of [{ alg: 'none', typ: 'JWT', kid: jwk.kid }, { alg: 'HS256', typ: 'JWT', kid: jwk.kid },
    { alg: 'RS256', typ: 'JWT', kid: 'unknown' }, { alg: 'RS256', typ: 'JWT', kid: jwk.kid, jku: 'https://untrusted.invalid' }])
    assert.throws(() => verify(jwt(claims(), header)), /SIGNER_RECEIPT_REFUSED/);
  const token = jwt(), parts = token.split('.');
  const changed = Buffer.from(parts[2], 'base64url'); changed[0] ^= 1;
  assert.throws(() => verify(`${parts[0]}.${parts[1]}.${changed.toString('base64url')}`), /SIGNER_RECEIPT_REFUSED/);
  assert.throws(() => verify(`${parts[0]}=.${parts[1]}.${parts[2]}`), /SIGNER_RECEIPT_REFUSED/);
  assert.throws(() => verify(token, request, context, [jwk, jwk]), /SIGNER_RECEIPT_REFUSED/);
  assert.throws(() => verify(jwt('{"iss":"one","iss":"two"}')));
  assert.throws(() => verify(jwt(claims(), '{"alg":"RS256","alg":"none"}')));
  assert.throws(() => verify('x'.repeat(32769)), /SIGNER_RECEIPT_REFUSED/);
});

test('host expectations require the protected exact workflow and independent expected check-run', () => {
  for (const [name, value] of Object.entries({ GITHUB_ACTIONS: 'false', GITHUB_REPOSITORY_ID: '12', GITHUB_REPOSITORY_OWNER_ID: '34',
    GITHUB_REF: 'refs/heads/dev', GITHUB_REF_PROTECTED: 'false', GITHUB_WORKFLOW_SHA: 'c'.repeat(40), GITHUB_RUN_ID: '../x',
    GITHUB_RUN_ATTEMPT: '01', RUNNER_ENVIRONMENT: 'self-hosted', GITHUB_JOB: 'verify-candidate-evidence', LNWJUD_VERIFIER_CHECK_RUN_ID: '' }))
    assert.throws(() => signerHostContext({ ...env(), [name]: value }, 'receive-signing-evidence'), /SIGNER_RECEIPT_REFUSED/, name);
  let reads = 0; const getter = { ...request };
  Object.defineProperty(getter, 'candidateSha256', { enumerable: true, get() { reads++; return request.candidateSha256; } });
  assert.throws(() => signerBinding(getter), /SIGNER_RECEIPT_REFUSED/);
  assert.equal(reads, 0);
});

test('independent API observation selects exactly the successful protected verifier check-run', () => {
  const expected = { workflowSha: context.workflowSha, runId: context.runId, runAttempt: context.runAttempt };
  const run = { id: 600, run_attempt: 1, head_sha: context.workflowSha, path: '.github/workflows/update-signing.yml',
    event: 'workflow_dispatch', head_branch: 'main', status: 'in_progress', repository: { id: 1329830515 }, head_repository: { id: 1329830515 } };
  const job = { name: 'Verify signing evidence (key-free diagnostic)', run_id: 600, head_sha: context.workflowSha,
    status: 'completed', conclusion: 'success', runner_group_name: 'GitHub Actions', runner_name: 'GitHub Actions 1000013323',
    labels: ['windows-latest'], check_run_url: 'https://api.github.com/repos/engasnm111/lnwjud/check-runs/701' };
  const jobs = { total_count: 1, jobs: [job] };
  assert.equal(inspectSignerVerifierJob(run, jobs, expected), '701');
  for (const modified of [{ ...job, name: 'different job' }, { ...job, conclusion: 'failure' }, { ...job, labels: ['windows-latest', 'self-hosted'] },
    { ...job, runner_group_name: 'Default' }, { ...job, check_run_url: 'https://api.github.com/repos/other/repo/check-runs/701' },
    { ...job, head_sha: 'c'.repeat(40) }, { ...job, run_id: 601 }])
    assert.throws(() => inspectSignerVerifierJob(run, { total_count: 1, jobs: [modified] }, expected), /SIGNER_RECEIPT_REFUSED/);
  assert.throws(() => inspectSignerVerifierJob({ ...run, run_attempt: 2 }, jobs, expected), /SIGNER_RECEIPT_REFUSED/);
  assert.throws(() => inspectSignerVerifierJob(run, { total_count: 2, jobs: [job] }, expected), /SIGNER_RECEIPT_REFUSED/);
  assert.throws(() => inspectSignerVerifierJob(run, { total_count: 2, jobs: [job, job] }, expected), /SIGNER_RECEIPT_REFUSED/);
});

test('unauthenticated JSON never reaches the signer and one challenge is consumed before key use', async () => fixture(async (directory, receiver) => {
  let keyReads = 0;
  const action = () => { keyReads++; return 'signed fixture'; };
  await assert.rejects(receiver.withAuthenticatedSignerReceipt({ token: '', request, context, replayDirectory: directory }, action));
  assert.equal(keyReads, 0);
  assert.equal(await receiver.withAuthenticatedSignerReceipt({ token: jwt(), request, context, replayDirectory: directory }, action), 'signed fixture');
  assert.equal(keyReads, 1);
  await assert.rejects(receiver.withAuthenticatedSignerReceipt({ token: jwt({ ...claims(), jti: 'new-token-same-challenge' }), request, context,
    replayDirectory: directory }, action), /SIGNER_RECEIPT_REFUSED/);
  assert.equal(keyReads, 1);
}));

test('failed key use still consumes the nonce and expiry is rechecked after durable consumption', async t => fixture(async (directory, receiver) => {
  let keyReads = 0;
  const options = { token: jwt(), request, context, replayDirectory: directory };
  await assert.rejects(receiver.withAuthenticatedSignerReceipt(options, () => { keyReads++; throw new Error('signing fixture failure'); }), /signing fixture failure/);
  await assert.rejects(receiver.withAuthenticatedSignerReceipt(options, () => { keyReads++; }), /SIGNER_RECEIPT_REFUSED/);
  assert.equal(keyReads, 1);
  let clockReads = 0;
  t.mock.method(Date, 'now', () => (++clockReads === 1 ? now : now + 601) * 1000);
  const other = { ...request, challenge: '6'.repeat(64) };
  await assert.rejects(receiver.withAuthenticatedSignerReceipt({ ...options, request: other,
    token: jwt({ ...claims(), aud: signerReceiptAudience(other) }) }, () => { keyReads++; }), /SIGNER_RECEIPT_REFUSED/);
  assert.equal(keyReads, 1);
}));

test('receiver executes no child process or network request before authorized key use', async t => fixture(async (directory, receiver) => {
  let externalCalls = 0;
  const deny = () => { externalCalls++; throw new Error('external execution forbidden in receiver'); };
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) t.mock.method(childProcess, method, deny);
  syncBuiltinESMExports();
  t.mock.method(globalThis, 'fetch', deny);
  try {
    await receiver.withAuthenticatedSignerReceipt({ token: jwt(), request, context, replayDirectory: directory }, () => 'key loaded only now');
    assert.equal(externalCalls, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}));

test('reparse replay directory refuses before key use', async () => fixture(async (directory, receiver) => {
  const target = await realpath(await mkdtemp(path.join(directory, 'other-')));
  await symlink(target, path.join(directory, 'lnwjud-signer-receipts'), process.platform === 'win32' ? 'junction' : 'dir');
  let reads = 0;
  await assert.rejects(receiver.withAuthenticatedSignerReceipt({ token: jwt(), request, context, replayDirectory: directory }, () => { reads++; }));
  assert.equal(reads, 0);
}));

test('committed OIDC keys are public, time-bounded RSA pins with no rotation network fallback', async () => {
  const snapshot = JSON.parse(await readFile(new URL('./github-oidc-pins.json', import.meta.url), 'utf8'));
  const keys = trustedSignerOidcKeys(snapshot.notBefore);
  assert.ok(keys.length > 0 && keys.length <= 16);
  assert.equal(new Set(keys.map(key => key.kid)).size, keys.length);
  for (const key of keys) {
    assert.deepEqual(Object.keys(key).sort(), ['alg', 'e', 'kid', 'kty', 'n', 'use']);
    assert.equal(createPublicKey({ key, format: 'jwk' }).asymmetricKeyDetails.modulusLength, 2048);
  }
  assert.throws(() => trustedSignerOidcKeys(snapshot.notBefore - 1), /SIGNER_RECEIPT_REFUSED/);
  assert.throws(() => trustedSignerOidcKeys(snapshot.expiresAt), /SIGNER_RECEIPT_REFUSED/);
  assert.throws(() => verify(jwt(), request, context, keys), /SIGNER_RECEIPT_REFUSED/);
});

test('the authority wrapper refuses runtime replacement of issuer keys', async () => fixture(async directory => {
  let keyReads = 0;
  await assert.rejects(withAuthenticatedSignerReceipt({ token: jwt(), request, context, keys: [jwk], replayDirectory: directory },
    () => { keyReads++; }), /SIGNER_RECEIPT_REFUSED/);
  assert.equal(keyReads, 0);
}));

test('production CLI binds baseline and update bytes through signing and publication without external access', async () => fixture(async directory => {
  const control = path.join(directory, 'scripts/update-trust');
  const original = JSON.parse(await readFile(new URL('../../tests/fixtures/update-release/authorization-v2.json', import.meta.url), 'utf8'));
  const payload = JSON.parse(Buffer.from(JSON.parse(Buffer.from(original.baselineEnvelope, 'base64')).payload, 'base64'));
  const policy = original.policy;
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = ec.publicKey.export({ format: 'der', type: 'spki' });
  const keyId = 'receiver-fixture-release';
  policy.roots = [{ ...policy.roots[0], keyId, spkiBase64: spki.toString('base64'), spkiSha256: hash(spki),
    notBefore: String(now - 60), expiresAt: String(now + 86400) }];
  const release = payload.release;
  release.source.commit = context.workflowSha; release.source.runId = request.sourceRunId; release.source.runAttempt = '1';
  payload.issuedAt = String(now - 1); payload.notBefore = payload.issuedAt; payload.expiresAt = String(now + 300);
  const artifact = Buffer.from('authenticated signer integration fixture');
  release.artifact.sha256 = hash(artifact); release.artifact.sizeBytes = String(artifact.length);
  const provenance = Buffer.from(JSON.stringify({ schemaVersion: 1, product: 'lnwjud', version: release.version, platform: 'win32', arch: 'x64',
    source: { repository: release.source.repository, commit: context.workflowSha, dirty: false },
    build: { environment: 'github-actions', signingCredentialConfigured: false, runId: request.sourceRunId, runAttempt: '1', ref: 'refs/heads/main' },
    recoveryCompatibility: release.compatibility, artifacts: [{ ...release.artifact, sizeBytes: artifact.length }] }));
  release.provenance.sha256 = hash(provenance); release.provenance.sizeBytes = String(provenance.length);
  const artifactBundle = Buffer.from('fixture artifact attestation'), provenanceBundle = Buffer.from('fixture provenance attestation');
  release.buildEvidence.artifactAttestationSha256 = hash(artifactBundle);
  release.buildEvidence.provenanceAttestationSha256 = hash(provenanceBundle);
  const candidateBytes = Buffer.from(JSON.stringify(payload)), policyBytes = Buffer.from(JSON.stringify(policy));
  const authority = policy.authorities.find(item => item.repository === release.source.repository
    && item.workflow === release.source.workflow && item.ref === release.source.ref);
  assert.ok(authority);
  const fixtureReceipt = { ...receipt, candidateSha256: hash(candidateBytes), policySha256: hash(policyBytes), builderSha: authority.builderDigest };
  const binding = signerBindingFromReceipt(fixtureReceipt, context, request.challenge, hash(spki), 'baseline', 'none');
  const token = jwt({ ...claims(), aud: signerReceiptAudience(binding) });
  const proofPath = path.join(directory, 'proof.jwt'), output = path.join(directory, 'RELEASE.json');
  for (const [name, bytes] of [['config/update-release-policy.json', policyBytes], ['CANDIDATE.json', candidateBytes],
    [release.artifact.name, artifact], [release.provenance.name, provenance], ['artifact.bundle.json', artifactBundle],
    ['provenance.bundle.json', provenanceBundle], ['receipt.json', JSON.stringify(fixtureReceipt)], ['request.json', JSON.stringify(binding)],
    ['scripts/update-trust/github-oidc-pins.json', JSON.stringify({ issuer: claims().iss, notBefore: now - 60, expiresAt: now + 86400, keys: [jwk] })]])
    await writeFile(path.join(directory, name), bytes);
  const guard = path.join(directory, 'guard.mjs'), keyMarker = path.join(directory, 'key-read-events');
  await writeFile(guard, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
const deny = () => { throw Error('EXTERNAL_EXECUTION_FORBIDDEN'); };
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']) cp[name] = deny;
const originalOpen = fsp.open; let swapped = false;
fsp.open = async (filename, ...rest) => {
  const handle = await originalOpen(filename, ...rest);
  const point = process.env.LNWJUD_TEST_SWAP_POINT;
  if (!swapped && rest[0] === 'wx' &&
    ((point === 'before-key' && path.basename(path.dirname(filename)) === 'lnwjud-signer-receipts') ||
     (['before-publication', 'proof-expired-publication'].includes(point) && path.basename(filename).startsWith('.lnwjud-release-')))) {
    swapped = true;
    if (point === 'proof-expired-publication') Date.now = () => Number(process.env.LNWJUD_TEST_AFTER_EXPIRY_MS);
    else await fsp.copyFile(process.env.LNWJUD_TEST_RENEWAL_PATH, process.env.LNWJUD_TEST_PREVIOUS_PATH);
  }
  return handle;
};
syncBuiltinESMExports(); globalThis.fetch = deny;
process.env = new Proxy(process.env, { get(target, name) {
  if (name === 'LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM') appendFileSync(target.LNWJUD_TEST_KEY_READ_MARKER, 'key-read\\n');
  return Reflect.get(target, name);
} });
`);
  const args = ['--import', pathToFileURL(guard).href, path.join(control, 'produce-release-authorization-v2.mjs'),
    '--purpose', 'baseline', '--payload', path.join(directory, 'CANDIDATE.json'), '--artifact', path.join(directory, release.artifact.name),
    '--provenance', path.join(directory, release.provenance.name), '--artifactBundle', path.join(directory, 'artifact.bundle.json'),
    '--provenanceBundle', path.join(directory, 'provenance.bundle.json'), '--keyId', keyId, '--output', output,
    '--receipt', path.join(directory, 'receipt.json'), '--request', path.join(directory, 'request.json'), '--proof', proofPath];
  const environment = { ...env(), SystemRoot: process.env.SystemRoot || '', PATH: process.env.PATH || '', RUNNER_TEMP: directory,
    LNWJUD_SIGNER_CHALLENGE: request.challenge, LNWJUD_TEST_KEY_READ_MARKER: keyMarker,
    LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM: ec.privateKey.export({ format: 'pem', type: 'pkcs8' }) };
  const invoke = (argv, variables) => childProcess.spawnSync(process.execPath, argv,
    { cwd: directory, encoding: 'utf8', windowsHide: true, env: variables });
  const run = () => invoke(args, environment);
  const parts = token.split('.'), bad = Buffer.from(parts[2], 'base64url'); bad[0] ^= 1;
  await writeFile(proofPath, `${parts[0]}.${parts[1]}.${bad.toString('base64url')}`);
  const denied = run();
  assert.notEqual(denied.status, 0); assert.equal(denied.stdout, '');
  await assert.rejects(readFile(keyMarker), { code: 'ENOENT' });
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  await writeFile(proofPath, token);
  const signed = run();
  assert.equal(signed.status, 0, signed.stderr);
  const envelope = await readFile(output);
  const authenticated = authenticateAuthorizationV2(envelope, policy, BigInt(now), 'baseline');
  assert.equal(authenticated.payloadSha256, hash(candidateBytes));
  assert.equal(await readFile(keyMarker, 'utf8'), 'key-read\n');
  const replay = run();
  assert.notEqual(replay.status, 0); assert.equal(replay.stdout, '');
  assert.equal(await readFile(keyMarker, 'utf8'), 'key-read\n');
  assert.equal(hash(await readFile(output)), hash(envelope));
  const previousDirectory = path.join(directory, 'previous');
  await mkdir(previousDirectory);
  const previousPath = path.join(previousDirectory, 'RELEASE.json'), renewalPath = path.join(previousDirectory, 'RENEWAL.json');
  await writeFile(path.join(previousDirectory, release.artifact.name), artifact);
  await writeFile(path.join(previousDirectory, release.provenance.name), provenance);
  const renewedPayload = JSON.parse(candidateBytes);
  renewedPayload.issuedAt = String(now - 2); renewedPayload.notBefore = renewedPayload.issuedAt; renewedPayload.expiresAt = String(now + 299);
  const renewedBytes = Buffer.from(JSON.stringify(renewedPayload));
  const renewedEnvelope = Buffer.from(JSON.stringify({ protocol: 2, keyId, payload: renewedBytes.toString('base64'),
    signature: sign('sha256', Buffer.concat([Buffer.from('lnwjud-update-release-v2\0', 'ascii'), renewedBytes]),
      { key: ec.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') }));
  assert.equal(authenticateAuthorizationV2(renewedEnvelope, policy, BigInt(now), 'baseline').identitySha256, authenticated.identitySha256);
  assert.notEqual(hash(renewedEnvelope), hash(envelope));
  await writeFile(renewalPath, renewedEnvelope);
  const next = JSON.parse(Buffer.from(JSON.parse(Buffer.from(original.updateEnvelope, 'base64')).payload, 'base64'));
  next.release = JSON.parse(JSON.stringify(release));
  next.release.version = release.version.replace(/\d+$/, value => String(Number(value) + 1));
  next.release.releaseSequence = String(BigInt(release.releaseSequence) + 1n);
  const nextArtifact = Buffer.from('newer authenticated signer update fixture');
  next.release.artifact = { name: `lnwjud-Setup-${next.release.version}.exe`, sizeBytes: String(nextArtifact.length), sha256: hash(nextArtifact) };
  const nextProvenance = JSON.parse(provenance); nextProvenance.version = next.release.version;
  nextProvenance.artifacts = [{ ...next.release.artifact, sizeBytes: nextArtifact.length }];
  const nextProvenanceBytes = Buffer.from(JSON.stringify(nextProvenance));
  next.release.provenance.sha256 = hash(nextProvenanceBytes); next.release.provenance.sizeBytes = String(nextProvenanceBytes.length);
  next.issuedAt = String(now - 1); next.notBefore = next.issuedAt; next.expiresAt = String(now + 600);
  next.recovery.previousReleaseIdentity = authenticated.identitySha256;
  const nextBytes = Buffer.from(JSON.stringify(next));
  await writeFile(path.join(directory, 'CANDIDATE.json'), nextBytes);
  await writeFile(path.join(directory, next.release.artifact.name), nextArtifact);
  await writeFile(path.join(directory, next.release.provenance.name), nextProvenanceBytes);
  for (const [point, nonce] of [['before-key', '6'], ['before-publication', '7'], ['proof-expired-publication', '9'], ['', '8']]) {
    await rm(keyMarker, { force: true });
    await writeFile(previousPath, envelope);
    const updateReceipt = { ...fixtureReceipt, candidateSha256: hash(nextBytes) };
    const updateBinding = signerBindingFromReceipt(updateReceipt, context, nonce.repeat(64), hash(spki), 'update', hash(envelope));
    await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(updateReceipt));
    await writeFile(path.join(directory, 'request.json'), JSON.stringify(updateBinding));
    await writeFile(proofPath, jwt({ ...claims(), aud: signerReceiptAudience(updateBinding), jti: 'update-' + (point || 'valid') }));
    const updateOutput = path.join(directory, 'UPDATE-' + (point || 'valid') + '.json');
    const updateArgs = [...args]; updateArgs[updateArgs.indexOf('--purpose') + 1] = 'update';
    updateArgs[updateArgs.indexOf('--artifact') + 1] = path.join(directory, next.release.artifact.name);
    updateArgs[updateArgs.indexOf('--output') + 1] = updateOutput;
    updateArgs.push('--previousPurpose', 'baseline', '--previousEnvelope', previousPath,
      '--previousArtifact', path.join(previousDirectory, release.artifact.name), '--previousProvenance', path.join(previousDirectory, release.provenance.name));
    const attempt = invoke(updateArgs, { ...environment, LNWJUD_SIGNER_CHALLENGE: nonce.repeat(64), LNWJUD_TEST_SWAP_POINT: point,
      LNWJUD_TEST_PREVIOUS_PATH: previousPath, LNWJUD_TEST_RENEWAL_PATH: renewalPath,
      LNWJUD_TEST_AFTER_EXPIRY_MS: String((now + 301) * 1000) });
    if (point) {
      assert.notEqual(attempt.status, 0, point);
      assert.equal(attempt.stdout, '');
      await assert.rejects(readFile(updateOutput), { code: 'ENOENT' });
      assert.equal(hash(await readFile(previousPath)), hash(point === 'proof-expired-publication' ? envelope : renewedEnvelope), 'controlled publication boundary');
      if (point === 'before-key') await assert.rejects(readFile(keyMarker), { code: 'ENOENT' });
      else assert.equal(await readFile(keyMarker, 'utf8'), 'key-read\n');
    } else {
      assert.equal(attempt.status, 0, attempt.stderr);
      assert.equal(authenticateAuthorizationV2(await readFile(updateOutput), policy, BigInt(now), 'update').payloadSha256, hash(nextBytes));
      assert.equal(await readFile(keyMarker, 'utf8'), 'key-read\n');
    }
  }
}));

test('validation workflow grants OIDC only to verifier and keeps receiver key-free', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/update-signing.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^permissions: \{\}\r?$/m);
  assert.equal([...workflow.matchAll(/^ {6}id-token: write\r?$/gm)].length, 1);
  assert.equal([...workflow.matchAll(/\bid-token\b/g)].length, 1);
  assert.doesNotMatch(workflow, /^[ \t]+permissions:[ \t]*[^ \t\r\n]|^[ \t]*<<:/m);
  const jobs = workflow.split(/^jobs:\r?$/m)[1];
  for (const line of jobs.split(/\r?\n/).filter(line => /^ {2}[^ \t#]/.test(line)))
    assert.match(line, /^ {2}[a-z][a-z0-9-]*:$/);
  const verifier = workflow.split('  verify-candidate-evidence:')[1].split('\n  inspect-verifier-job:')[0];
  const receiver = workflow.split('  receive-signing-evidence:')[1];
  assert.match(verifier, / {6}id-token: write/);
  assert.doesNotMatch(receiver, /id-token:|secrets\./);
  assert.doesNotMatch(workflow, /LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM|produce-release-authorization-v2\.mjs/);
  assert.ok(verifier.indexOf('keyfree-signing-evidence.mjs') < verifier.indexOf('authenticated-signer-receipt.mjs mint-proof'));
  assert.match(receiver, /needs\.inspect-verifier-job\.outputs\.verifier_check_run_id/);
  assert.match(receiver, /runs-on: ubuntu-24.04/);
});
