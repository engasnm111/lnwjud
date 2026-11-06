import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { builderContext, inspectSubjectDirectory, validateProvenance, trustedWorkspace } from './builder-control.mjs';
import { hash, parseStrictJson, refuse } from './release-envelope.mjs';
import { parseSigningVerificationManifest } from './signing-verification-manifest.mjs';
import { readBoundedFile } from './verify-build-evidence.mjs';
import { sourceRecoveryContracts, assertSourceRecoveryContracts } from './source-recovery-contracts.mjs';

const roleFiles = Object.freeze({
  artifactBundle: 'artifact.bundle.json',
  provenanceBundle: 'provenance.bundle.json',
});
const recoveryNames = Object.freeze(['migrationContractSha256', 'workerContractSha256', 'serviceContractSha256']);
const safeDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function compatibility(provenance) {
  const value = provenance?.recoveryCompatibility;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...recoveryNames].sort().join(',')
    || recoveryNames.some(name => !safeDigest(value[name]))) refuse('UPDATE_SIGNING_CANDIDATE_UNVERIFIED');
  return Object.freeze(Object.fromEntries(recoveryNames.map(name => [name, value[name]])));
}

function releaseCandidate(provenance, ctx, identities, observedTime) {
  if (!Number.isSafeInteger(observedTime) || observedTime <= 0 || observedTime + 86400 > 253402300799
    || !/^[1-9][0-9]{0,14}$/.test(ctx.runId) || !/^[1-9][0-9]{0,14}$/.test(ctx.runAttempt)
    || ctx.runAttempt !== '1') refuse('UPDATE_SIGNING_CANDIDATE_UNVERIFIED');
  const installer = validateProvenance(provenance, ctx);
  if (provenance.platform !== 'win32' || provenance.arch !== 'x64' || provenance.version.length > 32
    || identities.artifact.name !== installer.name || identities.artifact.sha256 !== installer.sha256
    || identities.artifact.sizeBytes !== String(installer.sizeBytes)
    || provenance.build?.windowsAuthenticode?.some(item => item?.status === 'Valid'))
    refuse('UPDATE_SIGNING_CANDIDATE_UNVERIFIED');
  const candidate = {
    protocol: 2, policyRevision: 1, kind: 'baseline',
    release: {
      product: 'lnwjud', releaseId: `lnwjud-${provenance.version}-${ctx.runId}`,
      channel: 'stable', platform: 'win32', architecture: 'x64', distribution: 'windows-nsis',
      version: provenance.version, releaseSequence: ctx.runId,
      source: { repository: 'https://github.com/engasnm111/lnwjud', commit: ctx.commit,
        workflow: '.github/workflows/ci.yml', ref: 'refs/heads/main',
        runId: ctx.runId, runAttempt: ctx.runAttempt },
      buildEvidence: { kind: 'github-artifact-attestation-v1',
        artifactAttestationSha256: identities.artifactBundle.sha256,
        provenanceAttestationSha256: identities.provenanceBundle.sha256, sourceTree: 'clean' },
      artifact: identities.artifact, provenance: identities.provenance,
      compatibility: compatibility(provenance),
    },
    issuedAt: String(observedTime), notBefore: String(observedTime),
    expiresAt: String(observedTime + 86400),
  };
  return Buffer.from(JSON.stringify(candidate), 'utf8');
}

/**
 * A credential-free source producer. It binds real immutable installer, provenance and
 * two attestation bundles into an unsigned baseline candidate and a nested ZIP profile.
 * It DOES NOT authenticate the attestation signatures or grant signing/install admission.
 */
export async function prepareBaselineSigningBundle({ workspace, context, policyBytes, observedTime }) {
  if (Object.keys(process.env).some(name => name.toUpperCase() === 'LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM')
    || typeof workspace !== 'string' || !path.isAbsolute(workspace) || !Buffer.isBuffer(policyBytes)
    || policyBytes.length < 1 || policyBytes.length > 65536) refuse('UPDATE_SIGNING_CANDIDATE_UNVERIFIED');
  const policy = parseStrictJson(policyBytes, 65536, 12);
  if (policy?.protocol !== 1 || policy.revision !== 1 || !Array.isArray(policy.roots)) refuse('UPDATE_SIGNING_CANDIDATE_UNVERIFIED');
  const incoming = path.join(workspace, '_incoming'), destination = path.join(workspace, '_signing-bundle');
  const provenanceData = await readBoundedFile(path.join(incoming, 'PROVENANCE.json'), 1048576n);
  const provenance = parseStrictJson(provenanceData.bytes, 1048576, 64);
  const sourceContracts = await sourceRecoveryContracts(path.join(workspace, '_source'));
  assertSourceRecoveryContracts(provenance.recoveryCompatibility, sourceContracts);
  const installer = validateProvenance(provenance, context);
  const selected = await inspectSubjectDirectory(incoming, context, Object.values(roleFiles));
  const observed = {};
  for (const [role, filename] of [
    ['artifact', installer.name], ['provenance', 'PROVENANCE.json'],
    ...Object.entries(roleFiles),
  ]) {
    const file = await readBoundedFile(path.join(incoming, filename), role === 'artifact' ? 2147483648n
      : role === 'provenance' ? 1048576n : 16777216n);
    observed[role] = { name: filename, sizeBytes: file.sizeBytes, sha256: file.sha256 };
  }
  if (observed.artifact.sha256 !== selected.artifact.sha256 || observed.provenance.sha256 !== selected.provenance.sha256)
    refuse('UPDATE_SIGNING_CANDIDATE_UNVERIFIED');
  const candidate = releaseCandidate(provenance, context, observed, observedTime);
  const entries = {
    candidate: { name: 'CANDIDATE.json', sizeBytes: String(candidate.length), sha256: hash(candidate) },
    ...observed,
  };
  const manifest = {
    schema: 'lnwjud.signing-verification/v1',
    verification: { repositoryId: '1329830515', runId: context.runId, runAttempt: Number(context.runAttempt) },
    policySha256: hash(policyBytes), purpose: 'baseline', candidate: entries,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  parseSigningVerificationManifest(manifestBytes);
  await mkdir(path.join(destination, 'files', 'candidate'), { recursive: true });
  for (const role of ['artifact', 'provenance', ...Object.keys(roleFiles)]) {
    const entry = observed[role];
    await copyFile(path.join(incoming, entry.name), path.join(destination, 'files', 'candidate', entry.name), constants.COPYFILE_EXCL);
    const copied = await readBoundedFile(path.join(destination, 'files', 'candidate', entry.name),
      role === 'artifact' ? 2147483648n : role === 'provenance' ? 1048576n : 16777216n);
    if (copied.sha256 !== entry.sha256 || copied.sizeBytes !== entry.sizeBytes)
      refuse('UPDATE_SIGNING_CANDIDATE_UNVERIFIED');
  }
  await writeFile(path.join(destination, 'files/candidate/CANDIDATE.json'), candidate, { flag: 'wx' });
  await writeFile(path.join(destination, 'manifest.json'), manifestBytes, { flag: 'wx' });
  const inspectedCandidate = await readBoundedFile(path.join(destination, 'files/candidate/CANDIDATE.json'), 32768n);
  const inspectedManifest = await readBoundedFile(path.join(destination, 'manifest.json'), 32768n);
  if (inspectedCandidate.sha256 !== entries.candidate.sha256 || inspectedManifest.sha256 !== hash(manifestBytes))
    refuse('UPDATE_SIGNING_CANDIDATE_UNVERIFIED');
  return Object.freeze({ kind: 'unsigned-baseline-data-only', manifestSha256: hash(manifestBytes),
    candidateSha256: hash(candidate), releaseId: JSON.parse(candidate.toString('utf8')).release.releaseId });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2 || process.env.GITHUB_ACTIONS !== 'true') refuse('UPDATE_SIGNING_CANDIDATE_UNVERIFIED');
    const ctx = builderContext(process.env);
    const workspace = await trustedWorkspace(process.env, ctx);
    if (process.env.LNWJUD_BUILDER_SHA !== ctx.builderSha) refuse('UPDATE_SIGNING_CANDIDATE_UNVERIFIED');
    const sourceRoot = path.join(workspace, '_source');
    const git = args => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).trim();
    if (git(['rev-parse', 'HEAD']) !== ctx.commit || git(['status', '--porcelain=v1']) !== '')
      refuse('UPDATE_SIGNING_CANDIDATE_UNVERIFIED');
    const policyBytes = await readFile(path.join(workspace, '_trusted-builder/config/update-release-policy.json'));
    const result = await prepareBaselineSigningBundle({ workspace, context: ctx, policyBytes,
      observedTime: Math.floor(Date.now() / 1000) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('UPDATE_SIGNING_CANDIDATE_UNVERIFIED\n');
    process.exitCode = 1;
  }
}
