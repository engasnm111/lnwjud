import { readBoundedFile } from '../../../scripts/update-trust/verify-build-evidence.mjs';
import { parseStrictJson } from '../../../scripts/update-trust/release-envelope.mjs';

const MAX_RECEIPT_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const SHA1_PATTERN = /^[a-f0-9]{40}$/i;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export async function readUpdateAcceptanceReceipt(filePath) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('Updater acceptance receipt path is required');
  }
  let bytes;
  try {
    ({ bytes } = await readBoundedFile(filePath, BigInt(MAX_RECEIPT_BYTES)));
  } catch {
    throw new Error('Updater acceptance receipt is unavailable or unsafe');
  }
  if (bytes.length === 0) throw new Error('Updater acceptance receipt size is invalid');
  try {
    return parseStrictJson(bytes, MAX_RECEIPT_BYTES);
  } catch {
    throw new Error('Updater acceptance receipt is not valid JSON');
  }
}

export function verifyUpdateAcceptanceForRelease(receipt, context) {
  validateUpdateAcceptanceReceipt(receipt, context);
  throw new Error('Updater acceptance producer authentication is unavailable');
}

// Structural checks do not authenticate the source of an acceptance receipt.
export function validateUpdateAcceptanceReceipt(receipt, {
  provenance,
  expectedRunId,
  expectedRunAttempt,
  expectedCommit,
} = {}) {
  requireRecord(receipt, 'receipt', [
    'schemaVersion', 'product', 'platform', 'arch', 'fromVersion', 'toVersion',
    'sourceCommit', 'confirmation', 'workflow', 'feed', 'package', 'signing', 'install', 'rollback',
  ]);
  if (receipt.schemaVersion !== 1 || receipt.product !== 'lnwjud-auto-update-acceptance') {
    throw new Error('Updater acceptance receipt schema/product is invalid');
  }
  requireRecord(provenance, 'release provenance', [
    'version', 'platform', 'arch', 'source', 'build', 'artifacts',
  ], { exact: false });
  if (!['win32', 'darwin'].includes(receipt.platform)
    || receipt.platform !== provenance.platform
    || receipt.arch !== provenance.arch
    || receipt.platform === 'win32' && receipt.arch !== 'x64'
    || receipt.platform === 'darwin' && !['arm64', 'x64'].includes(receipt.arch)) {
    throw new Error('Updater acceptance receipt platform/architecture mismatch');
  }

  const fromVersion = parseStableVersion(receipt.fromVersion, 'fromVersion');
  const toVersion = parseStableVersion(receipt.toVersion, 'toVersion');
  if (compareVersions(toVersion, fromVersion) <= 0 || receipt.toVersion !== provenance.version) {
    throw new Error('Updater acceptance receipt version transition is invalid');
  }

  if (!COMMIT_PATTERN.test(receipt.sourceCommit ?? '')
    || receipt.sourceCommit.toLowerCase() !== provenance.source?.commit?.toLowerCase()
    || receipt.sourceCommit.toLowerCase() !== expectedCommit?.toLowerCase()) {
    throw new Error('Updater acceptance receipt source commit does not match the release');
  }

  requireRecord(receipt.workflow, 'workflow', ['runId', 'runAttempt']);
  requireRunIdentity(receipt.workflow.runId, 'workflow run ID');
  requireRunIdentity(receipt.workflow.runAttempt, 'workflow run attempt');
  requireRunIdentity(expectedRunId, 'expected workflow run ID');
  requireRunIdentity(expectedRunAttempt, 'expected workflow run attempt');
  if (receipt.workflow.runId !== expectedRunId
    || receipt.workflow.runAttempt !== expectedRunAttempt
    || receipt.workflow.runId !== provenance.build?.runId
    || receipt.workflow.runAttempt !== provenance.build?.runAttempt) {
    throw new Error('Updater acceptance receipt does not match the exact release CI run and attempt');
  }

  const packageName = expectedPackageName(receipt.platform, receipt.toVersion, receipt.arch);
  const feedName = receipt.platform === 'win32' ? 'latest.yml' : 'latest-mac.yml';
  validateArtifactReference(receipt.package, 'package', packageName, provenance.artifacts);
  validateArtifactReference(receipt.feed, 'feed', feedName, provenance.artifacts);
  validateSigning(receipt, provenance);

  requireRecord(receipt.confirmation, 'confirmation', ['version', 'accepted', 'promptCount']);
  if (receipt.confirmation.version !== receipt.toVersion
    || receipt.confirmation.accepted !== true
    || receipt.confirmation.promptCount !== 1) {
    throw new Error('Updater acceptance receipt does not prove one accepted confirmation for the exact update version');
  }

  requireRecord(receipt.install, 'install', [
    'installedVersion', 'packageSha256', 'processRestarted', 'health', 'tunnel', 'mode', 'interactivePrompts',
  ]);
  if (receipt.install.installedVersion !== receipt.toVersion
    || !sameDigest(receipt.install.packageSha256, receipt.package.sha256)
    || receipt.install.processRestarted !== true
    || receipt.install.health !== 'passed'
    || receipt.install.tunnel !== 'connected'
    || receipt.install.mode !== 'silent'
    || receipt.install.interactivePrompts !== 0) {
    throw new Error('Updater acceptance receipt does not prove silent installation, relaunch, health, and Tunnel restoration');
  }

  requireRecord(receipt.rollback, 'rollback', [
    'injectedFailure', 'restoredVersion', 'processRestarted', 'priorInstallSha256',
    'restoredInstallSha256', 'health', 'tunnel',
  ]);
  if (receipt.rollback.injectedFailure !== 'post-install-health-check'
    || receipt.rollback.restoredVersion !== receipt.fromVersion
    || receipt.rollback.processRestarted !== true
    || !SHA256_PATTERN.test(receipt.rollback.priorInstallSha256 ?? '')
    || !sameDigest(receipt.rollback.restoredInstallSha256, receipt.rollback.priorInstallSha256)
    || receipt.rollback.health !== 'passed'
    || receipt.rollback.tunnel !== 'connected') {
    throw new Error('Updater acceptance receipt does not prove a healthy rollback after the injected failure');
  }

  return {
    platform: receipt.platform,
    arch: receipt.arch,
    fromVersion: receipt.fromVersion,
    toVersion: receipt.toVersion,
    runId: receipt.workflow.runId,
    runAttempt: receipt.workflow.runAttempt,
  };
}

function validateSigning(receipt, provenance) {
  if (receipt.platform === 'win32') {
    requireRecord(receipt.signing, 'Windows signing', [
      'kind', 'status', 'certificateSha1', 'subject',
    ]);
    if (receipt.signing.kind !== 'authenticode'
      || receipt.signing.status !== 'Valid'
      || !SHA1_PATTERN.test(receipt.signing.certificateSha1 ?? '')
      || typeof receipt.signing.subject !== 'string'
      || receipt.signing.subject.trim().length === 0
      || provenance.build?.signingCredentialConfigured !== true) {
      throw new Error('Windows updater acceptance requires a valid Authenticode publisher identity');
    }
    const signatures = provenance.build?.windowsAuthenticode;
    if (!Array.isArray(signatures)) throw new Error('Windows updater Authenticode provenance is missing');
    const matches = signatures.filter((entry) => entry?.name === receipt.package.name);
    if (matches.length !== 1
      || matches[0].status !== 'Valid'
      || !sameDigest(matches[0].sha256, receipt.package.sha256)
      || matches[0].signerCertificateSha1?.toLowerCase() !== receipt.signing.certificateSha1.toLowerCase()
      || matches[0].signerSubject !== receipt.signing.subject) {
      throw new Error('Windows updater publisher identity does not match the signed release package');
    }
    return;
  }

  requireRecord(receipt.signing, 'macOS signing', [
    'kind', 'mode', 'certificateSha1', 'teamId',
  ]);
  const macSigning = provenance.build?.macSigning;
  if (receipt.signing.kind !== 'developer-id'
    || receipt.signing.mode !== 'certificate'
    || !SHA1_PATTERN.test(receipt.signing.certificateSha1 ?? '')
    || macSigning?.mode !== 'certificate'
    || receipt.signing.certificateSha1.toLowerCase() !== macSigning.certificateSha1?.toLowerCase()
    || typeof receipt.signing.teamId !== 'string'
    || receipt.signing.teamId.length === 0
    || receipt.signing.teamId !== macSigning.policy?.teamId) {
    throw new Error('macOS updater acceptance requires matching Developer ID and Team ID evidence');
  }
}

function validateArtifactReference(reference, label, expectedName, artifacts) {
  requireRecord(reference, label, ['name', 'sha256']);
  if (reference.name !== expectedName || !SHA256_PATTERN.test(reference.sha256 ?? '')) {
    throw new Error(`Updater acceptance ${label} identity is invalid`);
  }
  if (!Array.isArray(artifacts)) throw new Error('Release provenance artifact list is missing');
  const matches = artifacts.filter((entry) => entry?.name === expectedName);
  if (matches.length !== 1 || !sameDigest(matches[0].sha256, reference.sha256)) {
    throw new Error(`Updater acceptance ${label} does not match release artifact provenance`);
  }
}

function expectedPackageName(platform, version, arch) {
  if (platform === 'win32') return `lnwjud-Setup-${version}.exe`;
  return `lnwjud-${version}-${arch}.zip`;
}

function parseStableVersion(value, label) {
  if (typeof value !== 'string') throw new Error(`Updater acceptance ${label} is invalid`);
  const match = VERSION_PATTERN.exec(value);
  if (!match) throw new Error(`Updater acceptance ${label} must be a stable semantic version`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function requireRunIdentity(value, label) {
  if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) {
    throw new Error(`Updater acceptance ${label} is invalid`);
  }
}

function requireRecord(value, label, expectedKeys, { exact = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`Updater acceptance ${label} is invalid`);
  }
  const actualKeys = Object.keys(value);
  if (expectedKeys.some((key) => !Object.hasOwn(value, key))
    || exact && actualKeys.length !== expectedKeys.length) {
    throw new Error(`Updater acceptance ${label} fields are incomplete or unexpected`);
  }
}

function sameDigest(left, right) {
  return typeof left === 'string'
    && typeof right === 'string'
    && SHA256_PATTERN.test(left)
    && SHA256_PATTERN.test(right)
    && left.toLowerCase() === right.toLowerCase();
}
