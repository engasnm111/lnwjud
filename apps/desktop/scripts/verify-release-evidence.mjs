import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { verifyCapabilityBridgeArtifacts } from './verify-capability-bridge-artifacts.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configuredInstallerDirectory = process.env.LNWJUD_RELEASE_INSTALLER_DIRECTORY?.trim();
const installerDirectory = configuredInstallerDirectory
  ? path.resolve(configuredInstallerDirectory)
  : path.join(desktopRoot, 'dist', 'installers');
const packageJson = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8'));
const provenancePath = path.join(installerDirectory, 'PROVENANCE.json');
const sumsPath = path.join(installerDirectory, 'SHA256SUMS.txt');
await assertRegularCanonicalFile(provenancePath, 'PROVENANCE.json');
await assertRegularCanonicalFile(sumsPath, 'SHA256SUMS.txt');
const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
const sumsText = await readFile(sumsPath, 'utf8');
const sums = parseSums(sumsText);

if (provenance?.schemaVersion !== 1 || provenance.product !== 'lnwjud') throw new Error('PROVENANCE.json schema/product is invalid');
if (provenance.version !== packageJson.version) throw new Error(`Provenance version mismatch: ${String(provenance.version)} != ${String(packageJson.version)}`);
if (!isPlatform(provenance.platform)) throw new Error('Provenance platform is invalid');
if (provenance.platform === 'darwin') {
  const signing = provenance.build?.macSigning ?? { mode: 'unsigned' };
  if (!['unsigned', 'ad-hoc', 'certificate'].includes(signing.mode)
    || signing.mode === 'certificate' && !/^[0-9a-f]{40}$/i.test(signing.certificateSha1 ?? '')
    || signing.mode !== 'certificate' && signing.certificateSha1 !== undefined) throw new Error('macOS signing evidence is invalid');
  if ((process.env.LNWJUD_REQUIRE_CODESIGN === '1' || process.env.LNWJUD_REQUIRE_NOTARIZATION === '1')
    && signing.mode !== 'certificate') throw new Error('Certificate-signed macOS release evidence is required');
  process.stdout.write(`macOS signing evidence: ${signing.mode} (artifact signature verification is a separate native gate)\n`);
}
if (typeof provenance.source?.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(provenance.source.commit)) throw new Error('Provenance commit SHA is invalid');

const expectedPlatform = process.env.LNWJUD_RELEASE_PLATFORM?.trim();
if (expectedPlatform && provenance.platform !== expectedPlatform) throw new Error(`Provenance platform mismatch: ${provenance.platform} != ${expectedPlatform}`);
const expectedCommit = process.env.LNWJUD_EXPECTED_COMMIT_SHA?.trim();
if (expectedCommit && provenance.source.commit.toLowerCase() !== expectedCommit.toLowerCase()) {
  throw new Error(`Provenance commit mismatch: ${provenance.source.commit} != ${expectedCommit}`);
}
if (process.env.LNWJUD_REQUIRE_CLEAN_PROVENANCE === '1' && provenance.source.dirty !== false) {
  throw new Error('Public release provenance must be built from a clean tracked source tree');
}

const releaseArtifactOnly = process.env.LNWJUD_RELEASE_ARTIFACT_ONLY === '1';
const packagedBridgePath = releaseArtifactOnly
  ? undefined
  : path.join(installerDirectory, 'win-unpacked', 'resources', 'windows-capability-bridge.ps1');
const compiledBundlePath = releaseArtifactOnly
  ? undefined
  : path.join(desktopRoot, 'dist', 'main', 'main.js');
const verifiedCapabilityBridge = provenance.platform === 'win32'
  ? await verifyCapabilityBridgeArtifacts({
    packagedBridgePath,
    compiledBundlePath,
  })
  : null;

if (provenance.platform === 'win32') {
  if (!isCapabilityBridgeIdentity(provenance.capabilityBridge)
    || provenance.capabilityBridge.sha256 !== verifiedCapabilityBridge.sha256
    || provenance.capabilityBridge.sizeBytes !== verifiedCapabilityBridge.sizeBytes) {
    throw new Error('Provenance capability bridge identity does not match verified bridge bytes');
  }
} else if (provenance.capabilityBridge !== null) {
  throw new Error('Non-Windows provenance must not contain Windows capability bridge evidence');
}

const artifactNames = expectedArtifactNames(provenance.platform, provenance.version, provenance.arch);
if (!Array.isArray(provenance.artifacts) || provenance.artifacts.length !== artifactNames.length) throw new Error('Provenance artifact list is incomplete');
for (const name of artifactNames) {
  const artifact = provenance.artifacts.find((entry) => entry?.name === name);
  if (!artifact) throw new Error(`Provenance artifact list is missing ${name}`);
  validateEntry(artifact, 'artifact');
  const expected = sums.get(artifact.name);
  if (expected !== artifact.sha256.toLowerCase()) throw new Error(`SHA256SUMS mismatch for ${artifact.name}`);
  const artifactPath = path.join(installerDirectory, artifact.name);
  await assertRegularCanonicalFile(artifactPath, `Release artifact ${artifact.name}`);
  const actual = await sha256File(artifactPath);
  if (actual !== artifact.sha256.toLowerCase()) throw new Error(`Artifact SHA-256 mismatch for ${artifact.name}`);
}

const provenanceHash = await sha256File(provenancePath);
if (sums.get('PROVENANCE.json') !== provenanceHash) throw new Error('PROVENANCE.json SHA-256 mismatch');

const requiredRuntime = requiredRuntimePaths(provenance.platform, provenance.arch);
if (!Array.isArray(provenance.runtime)) throw new Error('Provenance runtime list is missing');
for (const runtime of provenance.runtime) {
  validateEntry(runtime, 'runtime');
  if (typeof runtime.relativePath !== 'string' || runtime.relativePath.length === 0) throw new Error('Runtime provenance path is invalid');
  requiredRuntime.delete(runtime.relativePath);
  const sumName = `installed/${runtime.relativePath}`;
  if (sums.get(sumName) !== runtime.sha256.toLowerCase()) throw new Error(`SHA256SUMS mismatch for ${sumName}`);
  if (provenance.platform === 'win32' && runtime.relativePath === 'resources/windows-capability-bridge.ps1'
    && (runtime.sha256 !== verifiedCapabilityBridge.sha256 || runtime.sizeBytes !== verifiedCapabilityBridge.sizeBytes)) {
    throw new Error('Runtime provenance capability bridge entry does not match verified packaged bytes');
  }
}
if (requiredRuntime.size > 0) throw new Error(`Runtime provenance is incomplete: ${[...requiredRuntime].join(', ')}`);

process.stdout.write(`Release evidence verified for lnwjud ${provenance.version} ${provenance.platform}/${String(provenance.arch)} commit ${provenance.source.commit}\n`);

function isPlatform(value) {
  return value === 'win32' || value === 'darwin' || value === 'linux';
}

function expectedArtifactNames(platform, version, arch) {
  if (platform === 'win32') return [
    `lnwjud-Setup-${version}.exe`,
    `lnwjud-Setup-${version}.exe.blockmap`,
    `lnwjud-Portable-${version}.exe`,
    'latest.yml',
    'portable.yml',
  ];
  if (platform === 'darwin') return [`lnwjud-${version}-${normalizeArtifactArch(arch)}.dmg`, `lnwjud-${version}-${normalizeArtifactArch(arch)}.zip`, 'latest-mac.yml'];
  return [`lnwjud-${version}-${normalizeArtifactArch(arch)}.AppImage`, `lnwjud-${version}-${normalizeArtifactArch(arch)}.deb`, linuxUpdateMetadataName(arch)];
}

function linuxUpdateMetadataName(arch) {
  return arch === 'x64' ? 'latest-linux.yml' : `latest-linux-${normalizeArtifactArch(arch)}.yml`;
}

function normalizeArtifactArch(value) {
  if (value === 'x64' || value === 'arm64') return value;
  throw new Error(`Unsupported packaged artifact architecture: ${String(value)}`);
}

function requiredRuntimePaths(platform, arch) {
  const releaseTarget = platform === 'win32' ? 'windows' : platform;
  const releaseArch = normalizeTunnelArch(arch);
  const tunnelPrefix = `tunnel-client-v0.0.13-${releaseTarget}-${releaseArch}`;
  const paths = platform === 'win32'
    ? [
      'lnwjud.exe',
      'lnwjud-mcp-stdio.cmd',
      'resources/windows-capability-bridge.ps1',
      'resources/windows-capability-bridge.sha256',
      'resources/windows-capability-bridge.integrity.json',
      'resources/windows-secret-migrator/lnwjud-windows-secret-migrator.exe',
      'resources/windows-secret-migrator/lnwjud-windows-secret-migrator.sha256',
      'resources/runtime-tools/ripgrep/rg.exe',
      'resources/runtime-tools/ripgrep/BUNDLED_RIPGREP.json',
      'resources/tunnel-client/tunnel-client.exe',
      'resources/tunnel-client/BUNDLED_TUNNEL_CLIENT.json',
      `resources/tunnel-client/${tunnelPrefix}-licenses.txt`,
      `resources/tunnel-client/${tunnelPrefix}.spdx.json`,
      'resources/tunnel-client/tunnel-client-v0.0.13-provenance.sigstore.json',
    ]
    : platform === 'darwin'
      ? ['Contents/MacOS/lnwjud', 'Contents/Resources/lnwjud-mcp-stdio', 'Contents/Resources/runtime-tools/ripgrep/rg', 'Contents/Resources/runtime-tools/ripgrep/BUNDLED_RIPGREP.json', 'Contents/Resources/tunnel-client/tunnel-client', 'Contents/Resources/tunnel-client/BUNDLED_TUNNEL_CLIENT.json', `Contents/Resources/tunnel-client/${tunnelPrefix}-licenses.txt`, `Contents/Resources/tunnel-client/${tunnelPrefix}.spdx.json`, 'Contents/Resources/tunnel-client/tunnel-client-v0.0.13-provenance.sigstore.json', `Contents/Resources/native-host/macos/${provenance.arch}/lnwjud-macos-host`, `Contents/Resources/native-host/macos/${provenance.arch}/NATIVE_HOST.json`]
      : ['lnwjud', 'lnwjud-mcp-stdio', 'resources/runtime-tools/ripgrep/rg', 'resources/runtime-tools/ripgrep/BUNDLED_RIPGREP.json', 'resources/tunnel-client/tunnel-client', 'resources/tunnel-client/BUNDLED_TUNNEL_CLIENT.json', `resources/tunnel-client/${tunnelPrefix}-licenses.txt`, `resources/tunnel-client/${tunnelPrefix}.spdx.json`, 'resources/tunnel-client/tunnel-client-v0.0.13-provenance.sigstore.json', `resources/native-host/linux/${provenance.arch}/lnwjud-linux-host`, `resources/native-host/linux/${provenance.arch}/NATIVE_HOST.json`];
  return new Set(paths);
}

function normalizeTunnelArch(value) {
  if (value === 'x64') return 'amd64';
  if (value === 'arm64') return 'arm64';
  throw new Error(`Unsupported bundled tunnel-client architecture: ${String(value)}`);
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

function validateEntry(entry, kind) {
  if (!entry || typeof entry !== 'object') throw new Error(`Invalid ${kind} provenance entry`);
  if (typeof entry.name !== 'string' || entry.name.length === 0) throw new Error(`Invalid ${kind} name`);
  if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256)) throw new Error(`Invalid ${kind} SHA-256 for ${String(entry.name)}`);
  if (!Number.isInteger(entry.sizeBytes) || entry.sizeBytes < 0) throw new Error(`Invalid ${kind} size for ${String(entry.name)}`);
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
}

function parseSums(text) {
  const result = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/i.exec(line);
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
    result.set(match[2], match[1].toLowerCase());
  }
  return result;
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
