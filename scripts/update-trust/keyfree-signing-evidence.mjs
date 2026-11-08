import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { expectedArtifactName, hash, parseStrictJson } from './release-envelope.mjs';
import { parseSigningVerificationManifest } from './signing-verification-manifest.mjs';
import { readBoundedFile, selectVerifiedAttestation } from './verify-build-evidence.mjs';

const exec = promisify(execFile);
const repository = 'https://github.com/engasnm111/lnwjud';
const builderSha = 'cd833d7df45a8ecf2e87bc89ffb9ee3c85d20406';
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

/**
 * Key-free protected-main diagnostic: validates a baseline candidate and real
 * hosted attestations. It neither authenticates a release-signing key nor
 * authorizes enrollment, installation, rollback, or a signer handoff.
 */
export async function inspectKeyFreeSigningCandidate({ root, policyBytes, source, now, verify }) {
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
  // Updates require independent authentication of a signed predecessor. This
  // key-free diagnostic intentionally accepts only baseline evidence.
  if (manifest.purpose !== 'baseline' || manifest.verification.repositoryId !== '1329830515'
    || manifest.verification.runId !== boundSource.runId || manifest.verification.runAttempt !== 1
    || manifest.policySha256 !== hash(boundPolicy)) refuse();
  // The top-level directory also contains 'files'; inspect it separately without
  // treating a directory as an ordinary file.
  const top = await readdir(root, { withFileTypes: true });
  if (top.length !== 2 || !top.some(e => e.name === 'manifest.json' && e.isFile())
    || !top.some(e => e.name === 'files' && e.isDirectory())) refuse();
  await directory(path.join(root, 'files'), ['candidate'], true);
  const candidateRoot = path.join(root, 'files', 'candidate');
  await directory(candidateRoot, Object.values(manifest.candidate).map(value => value.name));
  const candidate = await roleFile(candidateRoot, manifest.candidate.candidate, 32768n);
  const payload = parseStrictJson(candidate.bytes, 32768, 12);
  const release = payload.release, origin = release?.source;
  if (payload.protocol !== 2 || payload.kind !== 'baseline' || payload.policyRevision !== 1
    || !decimal(payload.issuedAt) || !decimal(payload.notBefore) || !decimal(payload.expiresAt)
    || payload.issuedAt !== payload.notBefore || BigInt(payload.issuedAt) > now + 300n
    || now >= BigInt(payload.expiresAt) || BigInt(payload.expiresAt) - BigInt(payload.issuedAt) > 86400n
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
  requireKeyFree();
  return Object.freeze({ status: 'key-free-attestations-observed-only', sourceSha: boundSource.commit,
    sourceRunId: boundSource.runId, candidateSha256: candidate.sha256, manifestSha256: manifestFile.sha256 });
}

async function main() {
  if (process.argv.length !== 2 || process.env.GITHUB_ACTIONS !== 'true'
    || process.env.GITHUB_REPOSITORY !== 'engasnm111/lnwjud'
    || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_REF_PROTECTED !== 'true'
    || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || process.env.GITHUB_RUN_ATTEMPT !== '1'
    || process.env.GITHUB_WORKFLOW_SHA !== process.env.GITHUB_SHA) refuse();
  const token = process.env.GH_TOKEN, workspace = process.env.GITHUB_WORKSPACE;
  if (typeof token !== 'string' || token.length < 10 || token.length > 4096
    || typeof workspace !== 'string' || !path.isAbsolute(workspace)) refuse();
  const cli = path.join(workspace, 'tools', 'update-attestation', 'gh.exe');
  const actualCli = await readBoundedFile(cli, 100n * 1024n * 1024n);
  if (actualCli.sha256 !== verifierSha256) refuse();
  const run = args => exec(cli, args, { cwd: workspace, windowsHide: true, timeout: 120000,
    maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_TOKEN: token, GH_HOST: 'github.com' } });
  const version = (await run(['--version'])).stdout.split(/\r?\n/)[0];
  if (!version.startsWith('gh version 2.103.3 ')) refuse();
  const policy = (await readBoundedFile(path.join(workspace, 'config', 'update-release-policy.json'), 65536n)).bytes;
  const result = await inspectKeyFreeSigningCandidate({
    root: path.join(workspace, '_candidate'), policyBytes: policy,
    source: { runId: process.env.LNWJUD_SOURCE_RUN_ID, commit: process.env.GITHUB_SHA, builderSha },
    now: BigInt(Math.floor(Date.now() / 1000)),
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
  process.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(() => { process.stderr.write('KEYFREE_SIGNING_EVIDENCE_REFUSED\n'); process.exitCode = 1; });
