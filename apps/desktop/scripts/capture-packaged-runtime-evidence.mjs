import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { verifyCapabilityBridgeArtifacts } from './verify-capability-bridge-artifacts.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(desktopRoot, 'build', 'packaged-runtime-evidence.json');
const runtimeDependencies = JSON.parse(await readFile(path.join(desktopRoot, 'src', 'main', 'runtime-dependencies.json'), 'utf8'));
const BUNDLED_TUNNEL_CLIENT_VERSION = runtimeDependencies.tunnelClient.version;

const TARGETS = Object.freeze({
  win32: Object.freeze({
    required: Object.freeze([
      ['lnwjud.exe', 'lnwjud.exe'],
      ['lnwjud-mcp-stdio.cmd', 'lnwjud-mcp-stdio.cmd'],
      ['windows-capability-bridge.ps1', 'resources/windows-capability-bridge.ps1'],
      ['windows-capability-bridge.sha256', 'resources/windows-capability-bridge.sha256'],
      ['windows-capability-bridge.integrity.json', 'resources/windows-capability-bridge.integrity.json'],
      ['windows-secret-migrator.exe', 'resources/windows-secret-migrator/lnwjud-windows-secret-migrator.exe'],
      ['windows-secret-migrator.sha256', 'resources/windows-secret-migrator/lnwjud-windows-secret-migrator.sha256'],
      ['rg.exe', 'resources/runtime-tools/ripgrep/rg.exe'],
      ['rg-manifest', 'resources/runtime-tools/ripgrep/BUNDLED_RIPGREP.json'],
      ['tunnel-client.exe', 'resources/tunnel-client/tunnel-client.exe'],
    ]),
  }),
  darwin: Object.freeze({
    required: Object.freeze([
      ['lnwjud', 'Contents/MacOS/lnwjud'],
      ['lnwjud-mcp-stdio', 'Contents/Resources/lnwjud-mcp-stdio'],
      ['rg', 'Contents/Resources/runtime-tools/ripgrep/rg'],
      ['rg-manifest', 'Contents/Resources/runtime-tools/ripgrep/BUNDLED_RIPGREP.json'],
      ['tunnel-client', 'Contents/Resources/tunnel-client/tunnel-client'],
      ['tunnel-client-manifest', 'Contents/Resources/tunnel-client/BUNDLED_TUNNEL_CLIENT.json'],
      ['native-host', 'Contents/Resources/native-host/macos/{arch}/lnwjud-macos-host'],
      ['native-host-manifest', 'Contents/Resources/native-host/macos/{arch}/NATIVE_HOST.json'],
    ]),
  }),
  linux: Object.freeze({
    required: Object.freeze([
      ['lnwjud', 'lnwjud'],
      ['lnwjud-mcp-stdio', 'lnwjud-mcp-stdio'],
      ['rg', 'resources/runtime-tools/ripgrep/rg'],
      ['rg-manifest', 'resources/runtime-tools/ripgrep/BUNDLED_RIPGREP.json'],
      ['tunnel-client', 'resources/tunnel-client/tunnel-client'],
      ['tunnel-client-manifest', 'resources/tunnel-client/BUNDLED_TUNNEL_CLIENT.json'],
      ['native-host', 'resources/native-host/linux/{arch}/lnwjud-linux-host'],
      ['native-host-manifest', 'resources/native-host/linux/{arch}/NATIVE_HOST.json'],
    ]),
  }),
});

export default async function capturePackagedRuntimeEvidence(context) {
  const evidence = await collectPackagedRuntimeEvidence(context);
  if (evidence === undefined) return;
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

// A signing or notarization failure must not leave pre-sign evidence usable by
// write-release-evidence. Only the successful afterSign hook replaces this marker.
export async function invalidatePackagedRuntimeEvidence() {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ schemaVersion: 0, signing: 'incomplete' })}\n`, 'utf8');
}

export async function collectPackagedRuntimeEvidence(context) {
  const platform = context?.electronPlatformName;
  const target = TARGETS[platform];
  if (target === undefined) return;
  const appOutDir = context.appOutDir;
  if (typeof appOutDir !== 'string' || appOutDir.length === 0) throw new Error(`Packaged ${platform} app directory is unavailable`);

  const arch = normalizeArch(context?.arch);
  if (arch !== 'x64' && arch !== 'arm64') throw new Error(`Packaged ${platform} architecture is unsupported: ${arch}`);
  const capabilityBridge = platform === 'win32'
    ? await verifyCapabilityBridgeArtifacts({
      packagedBridgePath: path.join(appOutDir, 'resources', 'windows-capability-bridge.ps1'),
      compiledBundlePath: path.join(desktopRoot, 'dist', 'main', 'main.js'),
    })
    : null;

  const files = [];
  const signingReceipts = [];
  const required = [...target.required];
  for (const entry of tunnelEvidenceEntries(platform, arch)) {
    if (!required.some((candidate) => candidate[1] === entry[1])) required.push(entry);
  }
  for (const [name, relativePath] of required) {
    const resolvedRelativePath = relativePath.replaceAll('{arch}', arch);
    const absolutePath = resolvePackagedPath(appOutDir, platform, resolvedRelativePath);
    const metadata = await assertRegularCanonicalFile(absolutePath, `Required packaged runtime file: ${resolvedRelativePath}`);
    if (platform !== 'win32' && isExecutablePath(resolvedRelativePath) && (metadata.mode & 0o111) === 0) {
      throw new Error(`Required packaged POSIX runtime file is not executable: ${resolvedRelativePath}`);
    }
    if (isNativeHostManifestPath(resolvedRelativePath)) await verifyNativeHostManifest(absolutePath, platform, arch, resolvedRelativePath);
    else if (isRuntimeManifestPath(resolvedRelativePath)) await verifyRuntimeManifest(absolutePath, platform, arch, resolvedRelativePath);
    if (platform === 'darwin' && (isNativeHostManifestPath(resolvedRelativePath) || isRuntimeManifestPath(resolvedRelativePath))) {
      signingReceipts.push(JSON.parse(await readFile(absolutePath, 'utf8')).packagedSigning);
    }
    files.push({ name, relativePath: resolvedRelativePath, sizeBytes: metadata.size, sha256: await sha256File(absolutePath) });
  }

  let signing;
  if (platform === 'darwin') {
    const mode = signingReceipts[0]?.mode ?? 'unsigned';
    const certificateSha1 = signingReceipts[0]?.certificateSha1;
    if (!['unsigned', 'ad-hoc', 'certificate'].includes(mode)
      || signingReceipts.some((receipt) => (receipt?.mode ?? 'unsigned') !== mode || receipt?.certificateSha1 !== certificateSha1)
      || mode === 'certificate' && !/^[0-9a-f]{40}$/i.test(certificateSha1 ?? '')
      || mode !== 'certificate' && certificateSha1 !== undefined) throw new Error('Inconsistent macOS signing receipts');
    signing = { mode, ...(certificateSha1 ? { certificateSha1 } : {}) };
  }
  return { schemaVersion: 1, platform, arch, capabilityBridge, files, ...(signing ? { signing } : {}) };
}

async function assertRegularCanonicalFile(filePath, label) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch {
    throw new Error(`${label} is unavailable`);
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

function resolvePackagedPath(appOutDir, platform, relativePath) {
  // electron-builder 26 passes the output directory to both afterPack and
  // afterSign. productName is lnwjud; mac extraFiles live in its Contents.
  return platform === 'darwin'
    ? path.join(appOutDir, 'lnwjud.app', relativePath)
    : path.join(appOutDir, relativePath);
}

function isExecutablePath(relativePath) {
  return ['lnwjud', 'lnwjud-mcp-stdio', 'rg', 'tunnel-client', 'lnwjud-macos-host', 'lnwjud-linux-host']
    .includes(path.posix.basename(relativePath));
}

function isNativeHostManifestPath(relativePath) {
  return relativePath.endsWith('/NATIVE_HOST.json');
}

function isRuntimeManifestPath(relativePath) {
  return relativePath.endsWith('/BUNDLED_RIPGREP.json') || relativePath.endsWith('/BUNDLED_TUNNEL_CLIENT.json');
}

async function verifyRuntimeManifest(filePath, platform, arch, relativePath) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new Error(`Packaged runtime manifest is not valid JSON: ${relativePath}`);
  }
  if (manifest?.schemaVersion !== 1 || manifest.product !== 'lnwjud' || manifest.platform !== platform || manifest.arch !== arch) {
    throw new Error(`Packaged runtime manifest identity mismatch: ${relativePath}`);
  }
  if (typeof manifest.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)
    || typeof manifest.assetSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(manifest.assetSha256)
    || typeof manifest.executableSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(manifest.executableSha256)
    || manifest.verified?.archiveSha256 !== true || manifest.verified?.executableVersion !== true) {
    throw new Error(`Packaged runtime manifest verification is incomplete: ${relativePath}`);
  }
  if (typeof manifest.executable !== 'string' || manifest.executable.includes('/') || manifest.executable.includes('\\')) {
    throw new Error(`Packaged runtime manifest executable is invalid: ${relativePath}`);
  }
  const expectedExecutable = relativePath.endsWith('/BUNDLED_RIPGREP.json') ? (platform === 'win32' ? 'rg.exe' : 'rg') : (platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client');
  if (manifest.executable !== expectedExecutable) throw new Error(`Packaged runtime manifest executable identity mismatch: ${relativePath}`);
  const executablePath = path.join(path.dirname(filePath), manifest.executable);
  const executableMetadata = await assertRegularCanonicalFile(executablePath, `Packaged runtime manifest executable: ${relativePath}`);
  if (platform !== 'win32' && (executableMetadata.mode & 0o111) === 0) throw new Error(`Packaged runtime manifest executable is not executable: ${relativePath}`);
  const actualExecutableSha256 = await sha256File(executablePath);
  if (actualExecutableSha256 !== manifest.executableSha256.toLowerCase()) {
    throw new Error(`Packaged runtime manifest executable hash mismatch: ${relativePath}`);
  }
  if (relativePath.endsWith('/BUNDLED_TUNNEL_CLIENT.json')) {
    const releaseTarget = platform === 'win32' ? 'windows' : platform;
    const releaseArch = arch === 'x64' ? 'amd64' : 'arm64';
    const releasePrefix = `tunnel-client-v${BUNDLED_TUNNEL_CLIENT_VERSION}-${releaseTarget}-${releaseArch}`;
    if (manifest.version !== BUNDLED_TUNNEL_CLIENT_VERSION
      || manifest.asset !== `${releasePrefix}.zip`
      || manifest.licenseAsset !== `${releasePrefix}-licenses.txt`
      || manifest.spdxAsset !== `${releasePrefix}.spdx.json`
      || manifest.provenanceAsset !== `tunnel-client-v${BUNDLED_TUNNEL_CLIENT_VERSION}-provenance.sigstore.json`) {
      throw new Error(`Packaged tunnel-client evidence identity mismatch: ${relativePath}`);
    }
    const bundleDirectory = path.dirname(filePath);
    for (const evidenceName of [manifest.licenseAsset, manifest.spdxAsset, manifest.provenanceAsset]) {
      await assertRegularCanonicalFile(path.join(bundleDirectory, evidenceName), `Packaged tunnel-client evidence: ${evidenceName}`);
    }
  }
}

function tunnelEvidenceEntries(platform, arch) {
  const releaseTarget = platform === 'win32' ? 'windows' : platform;
  const releaseArch = arch === 'x64' ? 'amd64' : 'arm64';
  const prefix = platform === 'darwin' ? 'Contents/Resources/tunnel-client' : 'resources/tunnel-client';
  const releasePrefix = `tunnel-client-v${BUNDLED_TUNNEL_CLIENT_VERSION}-${releaseTarget}-${releaseArch}`;
  return [
    ['tunnel-client-manifest', `${prefix}/BUNDLED_TUNNEL_CLIENT.json`],
    ['tunnel-client-license', `${prefix}/${releasePrefix}-licenses.txt`],
    ['tunnel-client-spdx', `${prefix}/${releasePrefix}.spdx.json`],
    ['tunnel-client-provenance', `${prefix}/tunnel-client-v${BUNDLED_TUNNEL_CLIENT_VERSION}-provenance.sigstore.json`],
  ];
}

async function verifyNativeHostManifest(filePath, platform, arch, relativePath) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new Error(`Packaged native-host manifest is not valid JSON: ${relativePath}`);
  }
  const expectedName = platform === 'darwin' ? 'lnwjud-macos-host' : 'lnwjud-linux-host';
  if (manifest?.schemaVersion !== 1 || manifest?.name !== expectedName || manifest.platform !== platform || manifest.arch !== arch || manifest.verified !== true
    || typeof manifest.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(manifest.sha256)
    || !Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes < 1) {
    throw new Error(`Packaged native-host manifest verification is incomplete: ${relativePath}`);
  }
  const executablePath = path.join(path.dirname(filePath), manifest.name);
  const metadata = await assertRegularCanonicalFile(executablePath, `Packaged native-host executable: ${relativePath}`);
  if ((metadata.mode & 0o111) === 0 || metadata.size !== manifest.sizeBytes) throw new Error(`Packaged native-host executable metadata is invalid: ${relativePath}`);
  const actualSha256 = await sha256File(executablePath);
  if (actualSha256 !== manifest.sha256.toLowerCase()) throw new Error(`Packaged native-host hash mismatch: ${relativePath}`);
}

function normalizeArch(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value === 0) return 'ia32';
  if (value === 1) return 'x64';
  if (value === 2) return 'armv7l';
  if (value === 3) return 'arm64';
  if (value === 4) return 'universal';
  return process.arch;
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
