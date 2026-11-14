import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { expectedArtifactName, hash, parseStrictJson } from './release-envelope.mjs';
import { inspectManifestCandidate, parseSigningVerificationManifest } from './signing-verification-manifest.mjs';
import { readBoundedFile, selectVerifiedAttestation } from './verify-build-evidence.mjs';
import { readSignedPredecessor } from './build-signing-candidate.mjs';
import { authenticatePreviousMetadataV2 } from './produce-release-authorization-v2.mjs';
import { inspectAuthorizationPayloadV2 } from './release-authorization-v2.mjs';
import { signingPurposeSelection } from './authenticated-signer-receipt.mjs';

const exec = promisify(execFile);
const repository = 'https://github.com/engasnm111/lnwjud';
const builderSha = '1ce343b41aa79f9b0f6c9ce10bf32c3201610c16';
const verifierSha256 = 'd303d8ac3f5e9438bf7c977b64dd6425513eae46218f8881d30694f28c1d0dfd';
const sourceWorkflow = '.github/workflows/ci.yml';
const authority = Object.freeze({
  issuer: 'https://token.actions.githubusercontent.com',
  builderWorkflowUri: `${repository}/.github/workflows/update-package-builder.yml@refs/heads/main`,
  builderDigest: builderSha,
  buildConfigUri: `${repository}/${sourceWorkflow}@refs/heads/main`,
  buildConfigDigestRule: 'source-commit',
});
const refuse = () => { throw new Error('KEYFREE_SIGNING_EVIDENCE_REFUSED'); };
const requireKeyFree = () => {
  if (Object.keys(process.env).some(name => name.toUpperCase() === 'LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM')) refuse();
};

// Treat the hosted verifier's workflow identity as an exact trust boundary.
// A protected ref alone is insufficient: a different workflow or repository
// must not be able to reuse the key-free verifier as release evidence.
export function inspectKeyFreeWorkflowContext(environment) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)
    || environment.GITHUB_ACTIONS !== 'true'
    || environment.GITHUB_REPOSITORY !== 'engasnm111/lnwjud'
    || environment.GITHUB_REPOSITORY_ID !== '1329830515'
    || environment.GITHUB_REF !== 'refs/heads/main'
    || environment.GITHUB_REF_PROTECTED !== 'true'
    || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || environment.GITHUB_WORKFLOW_REF !== 'engasnm111/lnwjud/.github/workflows/update-signing.yml@refs/heads/main'
    || !/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA ?? '')
    || environment.GITHUB_WORKFLOW_SHA !== environment.GITHUB_SHA
    || environment.GITHUB_RUN_ATTEMPT !== '1'
    || Object.keys(environment).some(name => name.toUpperCase() === 'LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM')) refuse();
  return Object.freeze({ sourceSha: environment.GITHUB_SHA });
}

// A verifier subprocess must never inherit a signer secret, even if a future
// workflow mistakenly places the protected key in the key-free job context.
// Pass only the OS process essentials to the verifier. Inheriting PATH,
// PATHEXT, COMSPEC, GH_CONFIG_DIR, GIT_CONFIG_* or other caller-controlled
// settings could redirect helper execution or mutable CLI configuration despite
// fixed verifier arguments. The verifier executable itself is an absolute path.
const verifierEnvironmentNames = new Set([
  'SYSTEMROOT', 'WINDIR', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
]);
export function keyFreeGhEnvironment(environment, token, isolatedDirectory) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)
    || Object.keys(environment).some(name => name.toUpperCase() === 'LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM')
    || typeof token !== 'string' || token.length < 10 || token.length > 4096
    || typeof isolatedDirectory !== 'string' || !path.isAbsolute(isolatedDirectory)
    || isolatedDirectory.length > 4096 || isolatedDirectory.includes('\0')) refuse();
  const child = {};
  const seen = new Set();
  for (const [name, value] of Object.entries(environment)) {
    const canonicalName = name.toUpperCase();
    if (!verifierEnvironmentNames.has(canonicalName)) continue;
    // Windows environment variables are case-insensitive. Refuse ambiguous
    // duplicates rather than letting the child launcher choose a value.
    if (seen.has(canonicalName) || typeof value !== 'string') refuse();
    seen.add(canonicalName);
    child[name] = value;
  }
  return Object.freeze({ ...child, GH_TOKEN: token, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1',
    GH_CONFIG_DIR: isolatedDirectory, HOME: isolatedDirectory, USERPROFILE: isolatedDirectory,
    APPDATA: isolatedDirectory, LOCALAPPDATA: isolatedDirectory, TEMP: isolatedDirectory, TMP: isolatedDirectory,
    GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1' });
}
const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,14}$/.test(value)
  && Number.isSafeInteger(Number(value));
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (actual, expected) => actual?.length === expected.length
  && actual.every((value, i) => value === expected[i]);


async function directory(location, names, directories = false) {
  const meta = await lstat(location);
  if (!meta.isDirectory() || meta.isSymbolicLink() || await realpath(location) !== location) refuse();
  const found = await readdir(location, { withFileTypes: true });
  if (found.some(item => directories ? !item.isDirectory() : !item.isFile())
    || !exact(found.map(item => item.name).sort(), [...names].sort())) refuse();
}

async function roleFile(root, spec, limit) {
  const result = await readBoundedFile(path.join(root, spec.name), limit);
  if (result.sha256 !== spec.sha256 || result.sizeBytes !== spec.sizeBytes) refuse();
  return result;
}

function requireCandidateAuthority(policy, release) {
  const selected = policy.authorities.filter(item => item.repository === release.source.repository
    && item.workflow === release.source.workflow && item.ref === release.source.ref);
  if (selected.length !== 1 || Object.entries(authority).some(([field, value]) => selected[0][field] !== value)) refuse();
}

/**
 * Key-free protected-main diagnostic: validates candidate/predecessor data and
 * hosted attestations. It neither authenticates a release-signing key nor
 * authorizes enrollment, installation, rollback, or a signer handoff.
 */
export async function inspectKeyFreeSigningCandidate({ root, policyBytes, source, now, verify, keyId, purpose = 'baseline', previousEnvelopeSha256 }) {
  requireKeyFree();
  if (typeof root !== 'string' || !path.isAbsolute(root) || !Buffer.isBuffer(policyBytes)
    || policyBytes.length < 1 || policyBytes.length > 65536 || !source || typeof source !== 'object'
    || !decimal(source.runId) || !/^[a-f0-9]{40}$/.test(source.commit ?? '')
    || source.builderSha !== builderSha || typeof now !== 'bigint' || now < 0n
    || now > 253402300799n || typeof verify !== 'function') refuse();
  // Bind mutable caller inputs before any asynchronous file or verifier operation.
  const boundSource = Object.freeze({ runId: source.runId, commit: source.commit, builderSha: source.builderSha });
  const boundPolicy = Buffer.from(policyBytes);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) refuse();
  const manifestFile = await readBoundedFile(path.join(root, 'manifest.json'), 32768n);
  const manifest = parseSigningVerificationManifest(manifestFile.bytes);
  if (!['baseline', 'update'].includes(purpose) || manifest.purpose !== purpose || manifest.verification.repositoryId !== '1329830515'
    || manifest.verification.runId !== boundSource.runId || manifest.verification.runAttempt !== 1
    || manifest.policySha256 !== hash(boundPolicy)) refuse();
  // The top-level directory also contains 'files'; inspect it separately without
  // treating a directory as an ordinary file.
  const top = await readdir(root, { withFileTypes: true });
  if (top.length !== 2 || !top.some(e => e.name === 'manifest.json' && e.isFile())
    || !top.some(e => e.name === 'files' && e.isDirectory())) refuse();
  await directory(path.join(root, 'files'), purpose === 'update' ? ['candidate', 'predecessor'] : ['candidate'], true);
  const candidateRoot = path.join(root, 'files', 'candidate');
  await directory(candidateRoot, Object.values(manifest.candidate).map(value => value.name));
  const candidate = await roleFile(candidateRoot, manifest.candidate.candidate, 32768n);
  const payload = parseStrictJson(candidate.bytes, 32768, 12);
  const release = payload.release, origin = release?.source;
  if (payload.protocol !== 2 || payload.kind !== purpose || payload.policyRevision !== 1
    || !decimal(payload.issuedAt) || !decimal(payload.notBefore) || !decimal(payload.expiresAt)
    || payload.issuedAt !== payload.notBefore || BigInt(payload.issuedAt) > now + 300n
    || BigInt(payload.expiresAt) <= BigInt(payload.issuedAt) || now >= BigInt(payload.expiresAt)
    || BigInt(payload.expiresAt) - BigInt(payload.issuedAt) > 31536000n
    || release?.product !== 'lnwjud' || release.channel !== 'stable'
    || release.platform !== 'win32' || release.architecture !== 'x64'
    || release.distribution !== 'windows-nsis'
    || release.releaseSequence !== boundSource.runId
    || release.releaseId !== `lnwjud-${release.version}-${boundSource.runId}`
    || release.artifact?.name !== expectedArtifactName('win32', 'x64', 'windows-nsis', release.version)
    || origin?.repository !== repository || origin.workflow !== sourceWorkflow
    || origin.ref !== 'refs/heads/main' || origin.commit !== boundSource.commit
    || origin.runId !== boundSource.runId || origin.runAttempt !== '1'
    || release.buildEvidence?.kind !== 'github-artifact-attestation-v1') refuse();
  let predecessor;
  if (purpose === 'update') {
    if (!digest(previousEnvelopeSha256) || manifest.predecessor.envelope.sha256 !== previousEnvelopeSha256) refuse();
    const predecessorRoot = path.join(root, 'files', 'predecessor');
    await directory(predecessorRoot, Object.values(manifest.predecessor).map(value => value.name));
    for (const [role, spec] of Object.entries(manifest.predecessor))
      await roleFile(predecessorRoot, spec, role === 'artifact' ? 2147483648n : role === 'envelope' ? 49152n : 1048576n);
    const policy = parseStrictJson(boundPolicy, 65536, 12);
    const inspected = inspectAuthorizationPayloadV2(candidate.bytes, policy, now, 'update', keyId);
    requireCandidateAuthority(policy, inspected.payload.release);
    const envelope = await roleFile(predecessorRoot, manifest.predecessor.envelope, 49152n);
    const authenticated = await readSignedPredecessor(predecessorRoot, policy, now);
    predecessor = authenticatePreviousMetadataV2(inspected, envelope.bytes, authenticated.purpose, policy, now);
    if (predecessor.envelopeSha256 !== previousEnvelopeSha256) refuse();
  }
  for (const kind of ['artifact', 'provenance']) {
    const declared = release[kind], spec = manifest.candidate[kind];
    if (!declared || declared.name !== spec.name || declared.sha256 !== spec.sha256
      || declared.sizeBytes !== spec.sizeBytes
      || release.buildEvidence[`${kind}AttestationSha256`] !== manifest.candidate[`${kind}Bundle`].sha256) refuse();
  }
  const observed = {};
  for (const kind of ['artifact', 'provenance', 'artifactBundle', 'provenanceBundle']) {
    observed[kind] = await roleFile(candidateRoot, manifest.candidate[kind],
      kind === 'artifact' ? 2147483648n : kind === 'provenance' ? 1048576n : 16777216n);
  }
  const provenance = parseStrictJson(observed.provenance.bytes, 1048576, 64);
  const subject = provenance.artifacts?.filter(item => item?.name === release.artifact.name);
  const recoveryKeys = ['migrationContractSha256', 'serviceContractSha256', 'workerContractSha256'];
  if (!release.compatibility || !provenance.recoveryCompatibility
    || recoveryKeys.some(key => !digest(release.compatibility[key])
      || release.compatibility[key] !== provenance.recoveryCompatibility[key])
    || Object.keys(release.compatibility).sort().join(',') !== recoveryKeys.join(',')
    || Object.keys(provenance.recoveryCompatibility).sort().join(',') !== recoveryKeys.join(',')) refuse();
  if (provenance.schemaVersion !== 1 || provenance.product !== 'lnwjud' || provenance.version !== release.version
    || provenance.platform !== 'win32' || provenance.arch !== 'x64'
    || provenance.source?.repository !== repository || provenance.source.commit !== boundSource.commit
    || provenance.source.dirty !== false || provenance.build?.environment !== 'github-actions'
    || provenance.build.signingCredentialConfigured !== false || provenance.build.runId !== boundSource.runId
    || provenance.build.runAttempt !== '1' || provenance.build.ref !== 'refs/heads/main'
    || !Array.isArray(subject) || subject.length !== 1 || subject[0].sha256 !== release.artifact.sha256
    || String(subject[0].sizeBytes) !== release.artifact.sizeBytes) refuse();
  for (const kind of ['artifact', 'provenance']) {
    requireKeyFree();
    const output = await verify({
      filename: path.join(candidateRoot, manifest.candidate[kind].name),
      bundle: path.join(candidateRoot, manifest.candidate[`${kind}Bundle`].name),
      source: boundSource, authority,
    });
    requireKeyFree();
    if (!Buffer.isBuffer(output)
      || selectVerifiedAttestation(output, { source: release.source, issuedAt: payload.issuedAt }, release[kind], authority) !== 1) refuse();
  }
  // A verifier callback must not leave different on-disk bytes behind after
  // successful attestations. This detects persistent substitution; it does not
  // replace native file-handle pinning or authorize a production signer.
  for (const kind of ['candidate', 'artifact', 'provenance', 'artifactBundle', 'provenanceBundle'])
    await roleFile(candidateRoot, manifest.candidate[kind],
      kind === 'candidate' ? 32768n : kind === 'artifact' ? 2147483648n
        : kind === 'provenance' ? 1048576n : 16777216n);
  const finalManifest = await readBoundedFile(path.join(root, 'manifest.json'), 32768n);
  if (finalManifest.sha256 !== manifestFile.sha256) refuse();
  if (predecessor) {
    for (const [role, spec] of Object.entries(manifest.predecessor))
      await roleFile(path.join(root, 'files', 'predecessor'), spec,
        role === 'artifact' ? 2147483648n : role === 'envelope' ? 49152n : 1048576n);
  }
  requireKeyFree();
  return Object.freeze({ schema: predecessor ? 'lnwjud.keyfree-update-evidence/v1' : 'lnwjud.keyfree-evidence/v1', status: 'key-free-attestations-observed-only',
    sourceSha: boundSource.commit, sourceRunId: boundSource.runId, builderSha: boundSource.builderSha,
    policySha256: hash(boundPolicy), candidateSha256: candidate.sha256, manifestSha256: manifestFile.sha256,
    ...(predecessor ? { previousPurpose: predecessor.payload.kind, previousVersion: predecessor.payload.release.version,
      previousReleaseIdentity: predecessor.identitySha256, previousEnvelopeSha256: predecessor.envelopeSha256 } : {}) });
}

export async function prepareKeyFreeUpdateCandidate({ root, predecessorRoot, outputRoot, policyBytes, now, keyId, previousEnvelopeSha256 }) {
  requireKeyFree();
  if (![root, predecessorRoot, outputRoot].every(value => typeof value === 'string' && path.isAbsolute(value))
    || !Buffer.isBuffer(policyBytes) || !digest(previousEnvelopeSha256)) refuse();
  const policySnapshot = Buffer.from(policyBytes);
  const manifestFile = await readBoundedFile(path.join(root, 'manifest.json'), 32768n);
  const manifest = parseSigningVerificationManifest(manifestFile.bytes);
  if (manifest.purpose !== 'baseline' || manifest.policySha256 !== hash(policySnapshot)) refuse();
  await directory(path.join(root, 'files'), ['candidate'], true);
  const candidateRoot = path.join(root, 'files', 'candidate');
  await directory(candidateRoot, Object.values(manifest.candidate).map(value => value.name));
  const candidate = await roleFile(candidateRoot, manifest.candidate.candidate, 32768n);
  const baseline = inspectManifestCandidate(manifestFile.bytes, candidate.bytes, policySnapshot, now, keyId);
  const policy = parseStrictJson(policySnapshot, 65536, 12);
  requireCandidateAuthority(policy, baseline.payload.release);
  const predecessor = await readSignedPredecessor(predecessorRoot, policy, now);
  if (predecessor.roles.envelope.sha256 !== previousEnvelopeSha256) refuse();
  const payloadBytes = Buffer.from(JSON.stringify({ ...baseline.payload, kind: 'update', recovery: {
    purpose: 'failed-candidate-only', previousReleaseIdentity: predecessor.previous.identitySha256, maximumAttempts: 1,
  } }));
  const inspected = inspectAuthorizationPayloadV2(payloadBytes, policy, now, 'update', keyId);
  const envelope = await roleFile(predecessorRoot, predecessor.roles.envelope, 49152n);
  authenticatePreviousMetadataV2(inspected, envelope.bytes, predecessor.purpose, policy, now);
  const manifestBytes = Buffer.from(JSON.stringify({ ...manifest, purpose: 'update',
    candidate: { ...manifest.candidate, candidate: { name: 'CANDIDATE.json', sizeBytes: String(payloadBytes.length), sha256: hash(payloadBytes) } },
    predecessor: predecessor.roles }));
  parseSigningVerificationManifest(manifestBytes);
  const parent = path.dirname(outputRoot);
  if (await realpath(parent) !== parent || !(await lstat(parent)).isDirectory()) refuse();
  await mkdir(outputRoot);
  for (const [role, sourceRoot, entries] of [['candidate', candidateRoot, manifest.candidate], ['predecessor', predecessorRoot, predecessor.roles]]) {
    const destination = path.join(outputRoot, 'files', role);
    await mkdir(destination, { recursive: true });
    for (const [name, spec] of Object.entries(entries)) {
      if (role === 'candidate' && name === 'candidate') continue;
      const maximum = name === 'artifact' ? 2147483648n : name === 'envelope' ? 49152n
        : name === 'provenance' ? 1048576n : 16777216n;
      await roleFile(sourceRoot, spec, maximum);
      await copyFile(path.join(sourceRoot, spec.name), path.join(destination, spec.name), constants.COPYFILE_EXCL);
      await roleFile(destination, spec, maximum);
    }
  }
  if ((await readBoundedFile(path.join(root, 'manifest.json'), 32768n)).sha256 !== manifestFile.sha256) refuse();
  await writeFile(path.join(outputRoot, 'files', 'candidate', 'CANDIDATE.json'), payloadBytes, { flag: 'wx' });
  await writeFile(path.join(outputRoot, 'manifest.json'), manifestBytes, { flag: 'wx' });
  requireKeyFree();
  return Object.freeze({ status: 'unsigned-update-derived-only', candidateSha256: hash(payloadBytes), manifestSha256: hash(manifestBytes), previousEnvelopeSha256 });
}

export async function withIsolatedGhConfig(action) {
  const base = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(base, 'lnwjud-keyfree-gh-'));
  try {
    if (await realpath(directory) !== directory) refuse();
    for (const name of ['config.yml', 'hosts.yml'])
      await writeFile(path.join(directory, name), '{}\n', { flag: 'wx' });
    return await action(directory);
  } finally {
    if (await realpath(directory) !== directory || path.dirname(directory) !== base
      || !path.basename(directory).startsWith('lnwjud-keyfree-gh-')) refuse();
    // The verifier may write into this directory. Never recursively delete
    // entries it controls: remove only our known regular config files, then
    // require the directory to be empty. Unexpected content is quarantined.
    for (const name of ['config.yml', 'hosts.yml']) {
      const entry = path.join(directory, name);
      const metadata = await lstat(entry);
      if (!metadata.isFile() || metadata.isSymbolicLink()) refuse();
      await unlink(entry);
    }
    try {
      await rmdir(directory);
    } catch {
      refuse();
    }
  }
}

async function main() {
  if (process.argv.length > 3) refuse();
  inspectKeyFreeWorkflowContext(process.env);
  requireKeyFree();
  const selection = signingPurposeSelection(process.env);
  const workspace = process.env.GITHUB_WORKSPACE;
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) refuse();
  const previousEnvelopeSha256 = selection.purpose === 'update' && selection.previousTag
    ? (await readBoundedFile(path.join(workspace, '_predecessor', 'RELEASE.json'), 49152n)).sha256 : selection.previousEnvelope;
  if (process.argv[2] === 'prepare-update') {
    if (selection.purpose !== 'update') refuse();
    const result = await prepareKeyFreeUpdateCandidate({ root: path.join(workspace, '_candidate'),
      predecessorRoot: path.join(workspace, '_predecessor'), outputRoot: path.join(workspace, '_update-candidate'),
      policyBytes: (await readBoundedFile(path.join(workspace, 'config/update-release-policy.json'), 65536n)).bytes,
      now: BigInt(Math.floor(Date.now() / 1000)), keyId: process.env.LNWJUD_SIGNING_KEY_ID,
      previousEnvelopeSha256 });
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  if (process.argv.length !== 2) refuse();
  const token = process.env.GH_TOKEN;
  if (typeof token !== 'string' || token.length < 10 || token.length > 4096
    || typeof workspace !== 'string' || !path.isAbsolute(workspace)) refuse();
  const cli = path.join(workspace, 'tools', 'update-attestation', 'gh.exe');
  const actualCli = await readBoundedFile(cli, 100n * 1024n * 1024n);
  if (actualCli.sha256 !== verifierSha256) refuse();
  const result = await withIsolatedGhConfig(async isolatedDirectory => {
    const run = args => exec(cli, args, { cwd: workspace, windowsHide: true, timeout: 120000,
      maxBuffer: 4 * 1024 * 1024, env: keyFreeGhEnvironment(process.env, token, isolatedDirectory) });
    const version = (await run(['--version'])).stdout.split(/\r?\n/)[0];
    if (!version.startsWith('gh version 2.103.3 ')) refuse();
    const policy = (await readBoundedFile(path.join(workspace, 'config', 'update-release-policy.json'), 65536n)).bytes;
    return inspectKeyFreeSigningCandidate({
      root: path.join(workspace, selection.purpose === 'update' ? '_update-candidate' : '_candidate'), policyBytes: policy,
      source: { runId: process.env.LNWJUD_SOURCE_RUN_ID, commit: process.env.GITHUB_SHA, builderSha },
      now: BigInt(Math.floor(Date.now() / 1000)), purpose: selection.purpose,
      keyId: process.env.LNWJUD_SIGNING_KEY_ID, previousEnvelopeSha256,
      verify: async ({ filename, bundle, source, authority }) => {
        const args = ['attestation', 'verify', filename, '--repo', 'engasnm111/lnwjud', '--bundle', bundle,
          '--cert-oidc-issuer', authority.issuer,
          '--signer-workflow', authority.builderWorkflowUri.replace('https://github.com/', '').split('@')[0],
          '--signer-digest', authority.builderDigest, '--source-digest', source.commit,
          '--source-ref', 'refs/heads/main', '--deny-self-hosted-runners',
          '--predicate-type', 'https://slsa.dev/provenance/v1', '--format', 'json'];
        return Buffer.from((await run(args)).stdout);
      },
    });
  });
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(() => { process.stderr.write('KEYFREE_SIGNING_EVIDENCE_REFUSED\n'); process.exitCode = 1; });
