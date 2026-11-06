import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { builderContext, inspectSubjectDirectory, validateProvenance, trustedWorkspace } from './builder-control.mjs';
import { canonicalBase64, hash, parseStrictJson, refuse } from './release-envelope.mjs';
import { parseSigningVerificationManifest } from './signing-verification-manifest.mjs';
import { readBoundedFile } from './verify-build-evidence.mjs';
import { authenticateAuthorizationV2, inspectAuthorizationPayloadV2 } from './release-authorization-v2.mjs';
import { authenticatePreviousMetadataV2, validatePreviousTimeV2 } from './produce-release-authorization-v2.mjs';
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

async function readSignedPredecessor(workspace, policy, observedTime) {
  const directory = path.join(workspace, '_predecessor');
  const envelope = await readBoundedFile(path.join(directory, 'RELEASE.json'), 49152n);
  const outer = parseStrictJson(envelope.bytes, 49152, 12);
  const unsigned = parseStrictJson(canonicalBase64(outer.payload, 32768), 32768, 12);
  if (!['baseline', 'update'].includes(unsigned.kind)
    || typeof unsigned.issuedAt !== 'string' || !/^[1-9][0-9]{0,11}$/.test(unsigned.issuedAt))
    refuse('UPDATE_SIGNING_PREDECESSOR_UNVERIFIED');
  const previous = authenticateAuthorizationV2(envelope.bytes, policy, BigInt(unsigned.issuedAt), unsigned.kind);
  validatePreviousTimeV2(previous, policy, BigInt(observedTime));
  const roles = {
    envelope: { name: 'RELEASE.json', sha256: envelope.sha256, sizeBytes: envelope.sizeBytes },
  };
  for (const role of ['artifact', 'provenance']) {
    const declared = previous.payload.release[role];
    const actual = await readBoundedFile(path.join(directory, declared.name), BigInt(declared.sizeBytes));
    if (actual.sha256 !== declared.sha256 || actual.sizeBytes !== declared.sizeBytes)
      refuse('UPDATE_SIGNING_PREDECESSOR_UNVERIFIED');
    roles[role] = { name: declared.name, sha256: actual.sha256, sizeBytes: actual.sizeBytes };
  }
  const names = (await readdir(directory)).sort();
  if (names.join('\0') !== Object.values(roles).map(item => item.name).sort().join('\0'))
    refuse('UPDATE_SIGNING_PREDECESSOR_UNVERIFIED');
  return Object.freeze({ previous, purpose: unsigned.kind, roles });
}

function releaseCandidate(provenance, ctx, identities, observedTime, predecessor) {
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
    protocol: 2, policyRevision: 1, kind: predecessor ? 'update' : 'baseline',
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
    ...(predecessor ? { recovery: { purpose: 'failed-candidate-only',
      previousReleaseIdentity: predecessor.previous.identitySha256, maximumAttempts: 1 } } : {}),
  };
  return Buffer.from(JSON.stringify(candidate), 'utf8');
}

/**
 * A credential-free source producer. It binds real immutable installer, provenance and
 * two attestation bundles into an unsigned baseline or verified-predecessor update candidate.
 * It DOES NOT authenticate the attestation signatures or grant signing/install admission.
 */
export async function prepareSigningBundle({ workspace, context, policyBytes, observedTime, purpose = 'baseline' }) {
  if (!['baseline', 'update'].includes(purpose)) refuse('UPDATE_SIGNING_CANDIDATE_UNVERIFIED');
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
  const predecessor = purpose === 'update' ? await readSignedPredecessor(workspace, policy, observedTime) : null;
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
  const candidate = releaseCandidate(provenance, context, observed, observedTime, predecessor);
  if (predecessor) {
    const candidateView = inspectAuthorizationPayloadV2(candidate, policy, BigInt(observedTime), 'update',
      predecessor.previous.keyId);
    authenticatePreviousMetadataV2(candidateView, await readBoundedFile(
      path.join(workspace, '_predecessor', 'RELEASE.json'), 49152n).then(file => file.bytes),
    predecessor.purpose, policy, BigInt(observedTime));
  }
  const entries = {
    candidate: { name: 'CANDIDATE.json', sizeBytes: String(candidate.length), sha256: hash(candidate) },
    ...observed,
  };
  const manifest = {
    schema: 'lnwjud.signing-verification/v1',
    verification: { repositoryId: '1329830515', runId: context.runId, runAttempt: Number(context.runAttempt) },
    policySha256: hash(policyBytes), purpose, candidate: entries,
    ...(predecessor ? { predecessor: predecessor.roles } : {}),
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
  if (predecessor) {
    await mkdir(path.join(destination, 'files', 'predecessor'), { recursive: true });
    for (const role of ['envelope', 'artifact', 'provenance']) {
      const entry = predecessor.roles[role];
      const target = path.join(destination, 'files', 'predecessor', entry.name);
      await copyFile(path.join(workspace, '_predecessor', entry.name), target, constants.COPYFILE_EXCL);
      const copied = await readBoundedFile(target, role === 'artifact' ? 2147483648n : 1048576n);
      if (copied.sha256 !== entry.sha256 || copied.sizeBytes !== entry.sizeBytes)
        refuse('UPDATE_SIGNING_PREDECESSOR_UNVERIFIED');
    }
  }
  await writeFile(path.join(destination, 'files/candidate/CANDIDATE.json'), candidate, { flag: 'wx' });
  await writeFile(path.join(destination, 'manifest.json'), manifestBytes, { flag: 'wx' });
  const inspectedCandidate = await readBoundedFile(path.join(destination, 'files/candidate/CANDIDATE.json'), 32768n);
  const inspectedManifest = await readBoundedFile(path.join(destination, 'manifest.json'), 32768n);
  if (inspectedCandidate.sha256 !== entries.candidate.sha256 || inspectedManifest.sha256 !== hash(manifestBytes))
    refuse('UPDATE_SIGNING_CANDIDATE_UNVERIFIED');
  return Object.freeze({ kind: purpose === 'baseline' ? 'unsigned-baseline-data-only' : 'unsigned-update-data-only', manifestSha256: hash(manifestBytes),
    candidateSha256: hash(candidate), releaseId: JSON.parse(candidate.toString('utf8')).release.releaseId });
}

export async function prepareBaselineSigningBundle(options) {
  return prepareSigningBundle({ ...options, purpose: 'baseline' });
}

export async function prepareUpdateSigningBundle(options) {
  return prepareSigningBundle({ ...options, purpose: 'update' });
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
    const previousRunId = process.env.LNWJUD_PREDECESSOR_RUN_ID || '';
    const previousArtifactId = process.env.LNWJUD_PREDECESSOR_ARTIFACT_ID || '';
    const decimal = value => /^[1-9][0-9]{0,14}$/.test(value) && Number.isSafeInteger(Number(value));
    if ((previousRunId === '') !== (previousArtifactId === '')
      || (previousRunId !== '' && (!decimal(previousRunId) || !decimal(previousArtifactId))))
      refuse('UPDATE_SIGNING_CANDIDATE_UNVERIFIED');
    const purpose = previousRunId === '' ? 'baseline' : 'update';
    const result = await prepareSigningBundle({ workspace, context: ctx, policyBytes,
      observedTime: Math.floor(Date.now() / 1000), purpose });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('UPDATE_SIGNING_CANDIDATE_UNVERIFIED\n');
    process.exitCode = 1;
  }
}
