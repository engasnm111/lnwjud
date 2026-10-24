import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateMacosSigningPolicyEvidence } from './inspect-macos-signing-policy.mjs';
import { validateContainmentEvidence } from './verify-containment-artifacts.mjs';
import { validateUpdateWorkerEvidence } from './verify-update-worker-artifacts.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');
const installerDirectory = path.join(desktopRoot, 'dist', 'installers');
const runtimeEvidencePath = path.join(desktopRoot, 'build', 'packaged-runtime-evidence.json');
const packageJson = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8'));
const version = packageJson.version;
if (typeof version !== 'string' || version.length === 0) throw new Error('Desktop package version is unavailable');

const commit = git(['rev-parse', 'HEAD']).trim();
const githubSha = process.env.GITHUB_SHA?.trim();
if (githubSha && githubSha.toLowerCase() !== commit.toLowerCase()) {
  throw new Error(`GITHUB_SHA does not match checked-out commit: github=${githubSha} git=${commit}`);
}
const workingTreeStatusAtEvidence = git(['status', '--porcelain=v1', '--untracked-files=normal']).trim();
const sourceDirtyAtStart = parseSourceDirtyAtStart(process.env.LNWJUD_SOURCE_DIRTY_AT_START);
const workingTreeDirtyAtEvidence = workingTreeStatusAtEvidence.length > 0;
const dirty = sourceDirtyAtStart ?? workingTreeDirtyAtEvidence;

const runtimeEvidence = JSON.parse(await readFile(runtimeEvidencePath, 'utf8'));
if (runtimeEvidence?.schemaVersion !== 1 || !Array.isArray(runtimeEvidence.files)) {
  throw new Error('Packaged runtime evidence is missing or invalid');
}
const platform = normalizePlatform(process.env.LNWJUD_RELEASE_PLATFORM ?? runtimeEvidence.platform);
if (runtimeEvidence.platform !== platform) throw new Error(`Runtime evidence platform mismatch: ${String(runtimeEvidence.platform)} != ${platform}`);
const capabilityBridge = platform === 'win32' ? validateCapabilityBridge(runtimeEvidence) : null;
const macSigning = platform === 'darwin' ? validateMacSigning(runtimeEvidence) : null;
const containment = validateContainmentEvidence(runtimeEvidence.containment, runtimeEvidence.files, platform);
const updateWorker = validateUpdateWorkerEvidence(runtimeEvidence.updateWorker, runtimeEvidence.files, platform);

const artifactNames = expectedArtifactNames(platform, version, runtimeEvidence.arch);
const artifacts = [];
for (const name of artifactNames) {
  const filePath = path.join(installerDirectory, name);
  const metadata = await assertRegularCanonicalFile(filePath, `Required ${platform} release artifact: ${name}`);
  artifacts.push({ name, sizeBytes: metadata.size, sha256: await sha256File(filePath) });
}
const windowsAuthenticode = platform === 'win32' ? inspectWindowsAuthenticode(artifacts) : null;

const provenance = {
  schemaVersion: 1,
  product: 'lnwjud',
  version,
  platform,
  arch: runtimeEvidence.arch,
  source: {
    repository: 'https://github.com/engasnm111/lnwjud',
    commit,
    dirty,
  },
  build: {
    environment: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
    workflow: optionalEnv('GITHUB_WORKFLOW'),
    runId: optionalEnv('GITHUB_RUN_ID'),
    runAttempt: optionalEnv('GITHUB_RUN_ATTEMPT'),
    ref: optionalEnv('GITHUB_REF'),
    signingCredentialConfigured: signingConfigured(platform),
    ...(windowsAuthenticode ? { windowsAuthenticode } : {}),
    ...(macSigning ? { macSigning } : {}),
    workingTreeDirtyAtEvidence,
  },
  capabilityBridge,
  containment,
  updateWorker,
  artifacts,
  runtime: runtimeEvidence.files,
};

const provenancePath = path.join(installerDirectory, 'PROVENANCE.json');
await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
const provenanceHash = await sha256File(provenancePath);

const sumLines = [
  ...artifacts.map((entry) => `${entry.sha256}  ${entry.name}`),
  `${provenanceHash}  PROVENANCE.json`,
  ...runtimeEvidence.files.map((entry) => `${entry.sha256}  installed/${entry.relativePath}`),
];
await writeFile(path.join(installerDirectory, 'SHA256SUMS.txt'), `${sumLines.join('\n')}\n`, 'utf8');

process.stdout.write(`Release evidence written for lnwjud ${version} ${platform}/${String(runtimeEvidence.arch)} commit ${commit}${dirty ? ' (dirty)' : ''}\n`);

function normalizePlatform(value) {
  if (value === 'win32' || value === 'darwin' || value === 'linux') return value;
  throw new Error(`Unsupported release evidence platform: ${String(value)}`);
}

function expectedArtifactNames(platformName, releaseVersion, releaseArch) {
  if (platformName === 'win32') return [
    `lnwjud-Setup-${releaseVersion}.exe`,
    `lnwjud-Setup-${releaseVersion}.exe.blockmap`,
    `lnwjud-Portable-${releaseVersion}.exe`,
    'latest.yml',
    'portable.yml',
  ];
  if (platformName === 'darwin') return [
    `lnwjud-${releaseVersion}-${normalizeArtifactArch(releaseArch)}.dmg`,
    `lnwjud-${releaseVersion}-${normalizeArtifactArch(releaseArch)}.zip`,
    'latest-mac.yml',
  ];
  return [
    `lnwjud-${releaseVersion}-${normalizeArtifactArch(releaseArch)}.AppImage`,
    `lnwjud-${releaseVersion}-${normalizeArtifactArch(releaseArch)}.deb`,
    releaseArch === 'x64' ? 'latest-linux.yml' : `latest-linux-${normalizeArtifactArch(releaseArch)}.yml`,
  ];
}

function normalizeArtifactArch(value) {
  if (value === 'x64' || value === 'arm64') return value;
  throw new Error(`Unsupported packaged artifact architecture: ${String(value)}`);
}

function inspectWindowsAuthenticode(artifacts) {
  const executableArtifacts = artifacts.filter((entry) => entry.name.toLowerCase().endsWith('.exe'));
  if (executableArtifacts.length !== 2) throw new Error(`Expected exactly two Windows executable artifacts, found ${executableArtifacts.length}`);
  const targets = executableArtifacts.map((entry) => path.join(installerDirectory, entry.name));
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$targets = ConvertFrom-Json -InputObject $env:LNWJUD_AUTHENTICODE_TARGETS',
    '$results = @($targets | ForEach-Object {',
    '  $signature = Get-AuthenticodeSignature -LiteralPath $_',
    '  $thumbprint = $null',
    '  $subject = $null',
    '  if ($null -ne $signature.SignerCertificate) {',
    '    $thumbprint = $signature.SignerCertificate.Thumbprint',
    '    $subject = $signature.SignerCertificate.Subject',
    '  }',
    '  [PSCustomObject]@{',
    '    name = [System.IO.Path]::GetFileName($_)',
    '    status = [string]$signature.Status',
    '    signerCertificateSha1 = $thumbprint',
    '    signerSubject = $subject',
    '  }',
    '})',
    '$results | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const windowsPowerShellModulePath = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  const raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      PSModulePath: windowsPowerShellModulePath,
      LNWJUD_AUTHENTICODE_TARGETS: JSON.stringify(targets),
    },
  }).trim();
  const parsed = JSON.parse(raw);
  const observed = Array.isArray(parsed) ? parsed : [parsed];
  if (observed.length !== executableArtifacts.length) throw new Error('Windows Authenticode inspection returned an unexpected artifact count');
  return executableArtifacts.map((artifact) => {
    const signature = observed.find((entry) => entry?.name === artifact.name);
    if (!signature || typeof signature.status !== 'string' || signature.status.length === 0 || signature.status.length > 64) {
      throw new Error(`Windows Authenticode evidence is missing or invalid for ${artifact.name}`);
    }
    const certificateSha1 = typeof signature.signerCertificateSha1 === 'string' && signature.signerCertificateSha1.length > 0
      ? signature.signerCertificateSha1
      : undefined;
    const signerSubject = typeof signature.signerSubject === 'string' && signature.signerSubject.length > 0
      ? signature.signerSubject
      : undefined;
    if (signature.status === 'Valid' && !/^[0-9a-f]{40}$/i.test(certificateSha1 ?? '')) {
      throw new Error(`Valid Authenticode evidence is missing a signer certificate thumbprint for ${artifact.name}`);
    }
    return {
      name: artifact.name,
      sha256: artifact.sha256,
      status: signature.status,
      ...(certificateSha1 === undefined ? {} : { signerCertificateSha1: certificateSha1 }),
      ...(signerSubject === undefined ? {} : { signerSubject }),
    };
  });
}

function signingConfigured(platformName) {
  if (platformName === 'win32') {
    const certificateConfigured = Boolean(process.env.CSC_LINK?.trim() || process.env.WIN_CSC_LINK?.trim());
    const passwordConfigured = Boolean(process.env.CSC_KEY_PASSWORD?.trim());
    if (certificateConfigured !== passwordConfigured) {
      throw new Error('Windows production signing requires both CSC_LINK and CSC_KEY_PASSWORD, or neither for a local unsigned build');
    }
    return certificateConfigured && passwordConfigured;
  }
  if (platformName === 'darwin') return Boolean(process.env.CSC_LINK?.trim() || process.env.APPLE_ID?.trim() || process.env.APPLE_API_KEY?.trim());
  return false;
}

function validateCapabilityBridge(evidence) {
  if (!isCapabilityBridgeIdentity(evidence.capabilityBridge)) throw new Error('Packaged capability bridge identity is missing or invalid');
  const runtime = evidence.files.find((entry) => entry?.relativePath === 'resources/windows-capability-bridge.ps1');
  if (!runtime || runtime.sha256 !== evidence.capabilityBridge.sha256 || runtime.sizeBytes !== evidence.capabilityBridge.sizeBytes) {
    throw new Error('Packaged capability bridge runtime evidence does not match the verified bridge identity');
  }
  return evidence.capabilityBridge;
}

function validateMacSigning(evidence) {
  const signing = evidence.signing;
  if (!signing || !['ad-hoc', 'certificate'].includes(signing.mode)
    || signing.mode === 'certificate' && !/^[0-9a-f]{40}$/i.test(signing.certificateSha1 ?? '')
    || signing.mode !== 'certificate' && signing.certificateSha1 !== undefined) {
    throw new Error('Packaged macOS signing evidence is missing or invalid');
  }
  const rootExecutable = evidence.files.find((entry) => entry?.relativePath === 'Contents/MacOS/lnwjud');
  validateMacosSigningPolicyEvidence(signing.policy, {
    mode: signing.mode,
    arch: evidence.arch,
    rootExecutableSha256: rootExecutable?.sha256,
  });
  return signing;
}

function isCapabilityBridgeIdentity(value) {
  return value !== null
    && typeof value === 'object'
    && value.fileName === 'windows-capability-bridge.ps1'
    && Number.isSafeInteger(value.sizeBytes)
    && value.sizeBytes > 0
    && typeof value.sha256 === 'string'
    && /^[0-9a-f]{64}$/.test(value.sha256);
}

function git(args) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true });
}

function parseSourceDirtyAtStart(value) {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (normalized === '0') return false;
  if (normalized === '1') return true;
  throw new Error(`LNWJUD_SOURCE_DIRTY_AT_START must be 0 or 1, received: ${normalized}`);
}

function optionalEnv(name) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

async function assertRegularCanonicalFile(filePath, label) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch {
    throw new Error(`${label} is missing`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} is not a regular non-symlink file`);
  let canonicalPath;
  try {
    canonicalPath = await realpath(filePath);
  } catch {
    throw new Error(`${label} cannot be canonicalized`);
  }
  if (canonicalPath !== path.resolve(filePath)) throw new Error(`${label} is not a canonical file`);
  return metadata;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}
