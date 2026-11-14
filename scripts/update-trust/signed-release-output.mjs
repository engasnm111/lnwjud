import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadProductionPolicy, parseStrictJson } from './release-envelope.mjs';
import { authenticateAuthorizationV2 } from './release-authorization-v2.mjs';
import { produceReleaseAuthorizationV2 } from './produce-release-authorization-v2.mjs';
import { parseSigningVerificationManifest } from './signing-verification-manifest.mjs';
import { inspectSubjectDirectory } from './builder-control.mjs';
import { readBoundedFile } from './verify-build-evidence.mjs';

const refuse = () => { throw new Error('SIGNED_RELEASE_OUTPUT_REFUSED'); };
const envelopeName = purpose => purpose === 'baseline' ? 'BASELINE-win32-x64.json' : 'RELEASE-win32-x64.json';
const publicNames = purpose => [envelopeName(purpose), 'ARTIFACT-win32-x64.bundle.json',
  'PROVENANCE-win32-x64.bundle.json', 'INSTALL-LAYOUT-win32-x64.json'].sort();
function requireKeyFree() {
  if (Object.keys(process.env).some(name => name.toUpperCase() === 'LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM')) refuse();
}
async function regularDirectory(directory, names) {
  if (!path.isAbsolute(directory) || await realpath(directory) !== directory) refuse();
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile()) || entries.map(entry => entry.name).sort().join('\0') !== [...names].sort().join('\0')) refuse();
}
async function copyChecked(source, destination, identity, maximum = 2147483648n) {
  const actual = await readBoundedFile(source, maximum);
  if (actual.sha256 !== identity.sha256 || actual.sizeBytes !== String(identity.sizeBytes)) refuse();
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  const copied = await readBoundedFile(destination, maximum);
  if (copied.sha256 !== actual.sha256 || copied.sizeBytes !== actual.sizeBytes) refuse();
}

export async function signCandidate(workspace, purpose, keyId) {
  if (!['baseline', 'update'].includes(purpose) || !path.isAbsolute(workspace) || await realpath(workspace) !== workspace) refuse();
  const root = path.join(workspace, '_candidate');
  const manifestFile = await readBoundedFile(path.join(root, 'manifest.json'), 32768n);
  const manifest = parseSigningVerificationManifest(manifestFile.bytes);
  const receiptPath = path.join(workspace, '_verified-evidence/receipt.json');
  const receipt = parseStrictJson((await readBoundedFile(receiptPath, 4096n)).bytes, 4096);
  if (manifest.purpose !== purpose || receipt.manifestSha256 !== manifestFile.sha256) refuse();
  const candidateRoot = path.join(root, 'files/candidate');
  const output = path.join(workspace, '_signed-release/public');
  await mkdir(output, { recursive: true });
  const options = { purpose, keyId, payload: path.join(candidateRoot, manifest.candidate.candidate.name),
    artifact: path.join(candidateRoot, manifest.candidate.artifact.name), provenance: path.join(candidateRoot, manifest.candidate.provenance.name),
    artifactBundle: path.join(candidateRoot, manifest.candidate.artifactBundle.name),
    provenanceBundle: path.join(candidateRoot, manifest.candidate.provenanceBundle.name),
    output: path.join(output, envelopeName(purpose)), receipt: receiptPath,
    request: path.join(workspace, '_verified-evidence/signer-request.json'), proof: path.join(workspace, '_verified-evidence/signer-proof.jwt') };
  if (purpose === 'update') {
    if (!['baseline', 'update'].includes(receipt.previousPurpose)) refuse();
    const previous = path.join(root, 'files/predecessor');
    Object.assign(options, { previousPurpose: receipt.previousPurpose,
      previousEnvelope: path.join(previous, manifest.predecessor.envelope.name),
      previousArtifact: path.join(previous, manifest.predecessor.artifact.name),
      previousProvenance: path.join(previous, manifest.predecessor.provenance.name) });
  }
  return produceReleaseAuthorizationV2(options);
}

export async function prepareSignedOutput({ workspace, purpose, policy, now, signerRunId, signerRunAttempt }) {
  requireKeyFree();
  const output = path.join(workspace, '_signed-release');
  const publicRoot = path.join(output, 'public');
  const envelope = await readBoundedFile(path.join(publicRoot, envelopeName(purpose)), 49152n);
  const accepted = authenticateAuthorizationV2(envelope.bytes, policy, now, purpose);
  const release = accepted.payload.release;
  const subjectRoot = path.join(workspace, '_subjects');
  const subjects = await inspectSubjectDirectory(subjectRoot, { commit: release.source.commit, runId: release.source.runId,
    runAttempt: release.source.runAttempt, ref: release.source.ref }, ['artifact.bundle.json', 'provenance.bundle.json']);
  if (subjects.artifact.sha256 !== release.artifact.sha256 || subjects.artifact.sizeBytes !== release.artifact.sizeBytes
    || subjects.provenance.sha256 !== release.provenance.sha256 || subjects.provenance.sizeBytes !== release.provenance.sizeBytes
    || !subjects.additional.some(item => item.name === 'INSTALL-LAYOUT.json')
    || !subjects.additional.some(item => item.name === `lnwjud-Update-${release.version}-win32-x64.zip`)) refuse();
  const windows = path.join(output, 'windows'); await mkdir(windows);
  for (const subject of [subjects.artifact, { name: 'PROVENANCE.json', ...subjects.provenance }, ...subjects.additional])
    await copyChecked(path.join(subjectRoot, subject.name), path.join(windows, subject.name), subject);
  for (const [local, published, digest] of [
    ['artifact.bundle.json', 'ARTIFACT-win32-x64.bundle.json', release.buildEvidence.artifactAttestationSha256],
    ['provenance.bundle.json', 'PROVENANCE-win32-x64.bundle.json', release.buildEvidence.provenanceAttestationSha256],
    ['INSTALL-LAYOUT.json', 'INSTALL-LAYOUT-win32-x64.json', subjects.additional.find(item => item.name === 'INSTALL-LAYOUT.json').sha256],
  ]) {
    const identity = await readBoundedFile(path.join(subjectRoot, local), 16777216n);
    if (identity.sha256 !== digest) refuse();
    await copyChecked(path.join(subjectRoot, local), path.join(publicRoot, published), identity, 16777216n);
  }
  await regularDirectory(publicRoot, publicNames(purpose));
  const files = [];
  for (const [prefix, directory] of [['public', publicRoot], ['windows', windows]])
    for (const name of (await readdir(directory)).sort()) {
      const identity = await readBoundedFile(path.join(directory, name), 2147483648n);
      files.push({ path: `${prefix}/${name}`, sha256: identity.sha256, sizeBytes: identity.sizeBytes });
    }
  await writeFile(path.join(output, 'SIGNING-OUTPUT.json'), JSON.stringify({ schema: 'lnwjud.signed-update-output/v1', purpose,
    sourceSha: release.source.commit, sourceRunId: release.source.runId, signerRunId, signerRunAttempt,
    releaseIdentity: accepted.identitySha256, envelopeSha256: envelope.sha256, files }) + '\n', { flag: 'wx' });
  requireKeyFree();
}

export async function verifySignedOutput({ directory, policy, now, sourceSha, sourceRunId, purpose }) {
  requireKeyFree();
  if (!['baseline', 'update'].includes(purpose) || !/^[a-f0-9]{40}$/.test(sourceSha) || !/^[1-9][0-9]{0,19}$/.test(sourceRunId)) refuse();
  const manifest = parseStrictJson((await readBoundedFile(path.join(directory, 'SIGNING-OUTPUT.json'), 65536n)).bytes, 65536, 8);
  if (manifest.schema !== 'lnwjud.signed-update-output/v1' || manifest.purpose !== purpose || manifest.sourceSha !== sourceSha
    || manifest.sourceRunId !== sourceRunId || !/^[1-9][0-9]{0,19}$/.test(manifest.signerRunId ?? '')
    || manifest.signerRunAttempt !== '1' || !Array.isArray(manifest.files) || manifest.files.length < 7 || manifest.files.length > 32) refuse();
  const envelope = await readBoundedFile(path.join(directory, 'public', envelopeName(purpose)), 49152n);
  const accepted = authenticateAuthorizationV2(envelope.bytes, policy, now, purpose);
  const release = accepted.payload.release;
  if (release.source.commit !== sourceSha || release.source.runId !== sourceRunId || release.source.runAttempt !== '1'
    || envelope.sha256 !== manifest.envelopeSha256 || accepted.identitySha256 !== manifest.releaseIdentity) refuse();
  await regularDirectory(path.join(directory, 'public'), publicNames(purpose));
  const seen = new Set();
  for (const item of manifest.files) {
    if (typeof item?.path !== 'string' || !/^(public|windows)\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(item.path)
      || seen.has(item.path) || typeof item.sizeBytes !== 'string' || !/^[1-9][0-9]{0,9}$/.test(item.sizeBytes)
      || BigInt(item.sizeBytes) > 2147483648n || !/^[a-f0-9]{64}$/.test(item.sha256)) refuse();
    seen.add(item.path);
    const actual = await readBoundedFile(path.join(directory, item.path), BigInt(item.sizeBytes));
    if (actual.sha256 !== item.sha256 || actual.sizeBytes !== item.sizeBytes) refuse();
  }
  for (const prefix of ['windows', 'public'])
    await regularDirectory(path.join(directory, prefix), manifest.files.filter(item => item.path.startsWith(prefix + '/')).map(item => item.path.slice(prefix.length + 1)));
  const provenanceFile = await readBoundedFile(path.join(directory, 'windows/PROVENANCE.json'), 1048576n);
  if (provenanceFile.sha256 !== release.provenance.sha256 || provenanceFile.sizeBytes !== release.provenance.sizeBytes) refuse();
  const metadata = parseStrictJson(provenanceFile.bytes, 1048576, 64);
  for (const declared of [release.artifact, ...metadata.artifacts.filter(item => item.name !== release.artifact.name), metadata.installedLayout, metadata.updatePayload]) {
    if (!declared || !seen.has(`windows/${declared.name}`)) refuse();
    const actual = await readBoundedFile(path.join(directory, 'windows', declared.name), BigInt(declared.sizeBytes));
    if (actual.sha256 !== declared.sha256 || actual.sizeBytes !== String(declared.sizeBytes)) refuse();
  }
  for (const [name, digest] of [['ARTIFACT-win32-x64.bundle.json', release.buildEvidence.artifactAttestationSha256],
    ['PROVENANCE-win32-x64.bundle.json', release.buildEvidence.provenanceAttestationSha256],
    ['INSTALL-LAYOUT-win32-x64.json', metadata.installedLayout.sha256]])
    if ((await readBoundedFile(path.join(directory, 'public', name), 16777216n)).sha256 !== digest) refuse();
  requireKeyFree();
  return accepted;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const operation = process.argv[2], purpose = process.env.LNWJUD_SIGNING_PURPOSE;
    if (operation === 'sign' && process.argv.length === 3) {
      const result = await signCandidate(process.env.GITHUB_WORKSPACE, purpose, process.env.LNWJUD_SIGNING_KEY_ID);
      process.stdout.write(JSON.stringify(result) + '\n');
    } else if (operation === 'prepare' && process.argv.length === 3) {
      await prepareSignedOutput({ workspace: process.env.GITHUB_WORKSPACE, purpose, policy: loadProductionPolicy(),
        now: BigInt(Math.floor(Date.now() / 1000)), signerRunId: process.env.GITHUB_RUN_ID, signerRunAttempt: process.env.GITHUB_RUN_ATTEMPT });
      process.stdout.write('SIGNED_RELEASE_OUTPUT_PREPARED\n');
    } else if (operation === 'verify' && process.argv.length === 4) {
      await verifySignedOutput({ directory: path.resolve(process.argv[3]), purpose, policy: loadProductionPolicy(),
        now: BigInt(Math.floor(Date.now() / 1000)), sourceSha: process.env.GITHUB_SHA, sourceRunId: process.env.LNWJUD_RELEASE_CI_RUN_ID });
      process.stdout.write('SIGNED_RELEASE_OUTPUT_VERIFIED\n');
    } else refuse();
  } catch {
    delete process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM;
    process.stderr.write('SIGNED_RELEASE_OUTPUT_REFUSED\n'); process.exitCode = 1;
  }
}
