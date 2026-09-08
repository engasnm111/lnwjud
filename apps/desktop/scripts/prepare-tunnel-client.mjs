/* global AbortSignal, Buffer, clearTimeout, fetch, setTimeout */

import { createHash } from 'node:crypto';
import { copyFile, chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const extractZip = require('@electron-internal/extract-zip');
const execFileAsync = promisify(execFile);
const VERSION = '0.0.13';
const RELEASE_BASE = `https://github.com/openai/tunnel-client/releases/download/v${VERSION}`;
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = path.join(desktopRoot, 'build');
const vendorRoot = path.join(buildRoot, 'vendor', `tunnel-client-v${VERSION}`);
const bundleRoot = path.join(buildRoot, 'tunnel-client');
const checksumsUrl = `${RELEASE_BASE}/SHA256SUMS.txt`;
const PROVENANCE_CERTIFICATE_IDENTITY = `https://github.com/openai/tunnel-client/.github/workflows/release.yml@refs/tags/v${VERSION}`;
const PROVENANCE_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const MINIMUM_COSIGN_VERSION = Object.freeze([3, 1, 3]);

// The release checksum file is fetched for independent verification, but the
// package still pins the exact archive bytes expected for every supported
// target. A changed or removed upstream checksum therefore fails closed.
const PINNED_ARCHIVE_SHA256 = Object.freeze({
  'tunnel-client-v0.0.13-darwin-amd64.zip': 'c683e15d84fb997f5af1cc7c4cb55008e19a555a9ed2ec0f89a5ff426d85f85c',
  'tunnel-client-v0.0.13-darwin-arm64.zip': '15abf165f06050af642c948ba6bd6c905191dc5420a9422dadde2b49d892e2c6',
  'tunnel-client-v0.0.13-linux-amd64.zip': 'e71f37b424126513173d5e3590687c0b5ccf6e8ef3fba900104d1f8c60dad906',
  'tunnel-client-v0.0.13-linux-arm64.zip': '9d214a805bec213a3a156dc2a4460a6dfe2f35b0c00ba20609d002bf5e6469f8',
  'tunnel-client-v0.0.13-windows-amd64.zip': '17113162b353906bbb884c3ed7620facba5cc72b5fdc94fd54fd7208c7166edb',
  'tunnel-client-v0.0.13-windows-arm64.zip': 'ec7c33cb06fabbbc04aa4803304b647f8542922b8b1489c961b3ebfc283ddcb0',
});

const TARGETS = Object.freeze({
  win32: { name: 'windows', executable: 'tunnel-client.exe', arch: { x64: 'amd64', arm64: 'arm64' } },
  darwin: { name: 'darwin', executable: 'tunnel-client', arch: { x64: 'amd64', arm64: 'arm64' } },
  linux: { name: 'linux', executable: 'tunnel-client', arch: { x64: 'amd64', arm64: 'arm64' } },
});

const platform = process.env.LNWJUD_TUNNEL_TARGET ?? process.platform;
const target = TARGETS[platform];
if (target === undefined) throw new Error(`Bundled tunnel-client does not support host platform ${platform}`);
const rawArch = process.env.LNWJUD_TUNNEL_ARCH ?? process.arch;
const arch = target.arch[rawArch];
if (arch === undefined) throw new Error(`Bundled tunnel-client does not support ${platform}/${rawArch}`);

const archiveName = `tunnel-client-v${VERSION}-${target.name}-${arch}.zip`;
const licenseName = `tunnel-client-v${VERSION}-${target.name}-${arch}-licenses.txt`;
const spdxName = `tunnel-client-v${VERSION}-${target.name}-${arch}.spdx.json`;
const archivePath = path.join(vendorRoot, archiveName);
const extractRoot = path.join(vendorRoot, `${target.name}-${arch}`);
const executableName = target.executable;

await mkdir(vendorRoot, { recursive: true });
await assertCanonicalDirectory(vendorRoot);
const checksumsText = await fetchText(checksumsUrl);
const checksums = parseChecksums(checksumsText);
await writeAtomic(path.join(vendorRoot, 'SHA256SUMS.txt'), checksumsText);
const pinnedArchiveSha256 = PINNED_ARCHIVE_SHA256[archiveName];
if (pinnedArchiveSha256 === undefined) throw new Error(`Official tunnel-client archive is not pinned for ${archiveName}`);
const expectedArchiveSha256 = checksums.get(archiveName);
if (expectedArchiveSha256 === undefined) throw new Error(`Official tunnel-client checksum is missing for ${archiveName}`);
if (expectedArchiveSha256 !== pinnedArchiveSha256) throw new Error(`Official tunnel-client checksum changed for ${archiveName}`);

await downloadIfNeeded(`${RELEASE_BASE}/${archiveName}`, archivePath, expectedArchiveSha256);
await rm(extractRoot, { recursive: true, force: true });
await mkdir(extractRoot, { recursive: true });
await assertCanonicalDirectory(extractRoot);
await extractArchive(archivePath, extractRoot);

const executable = await findUniqueFile(extractRoot, executableName);
const executableMetadata = await stat(executable);
if (!executableMetadata.isFile()) throw new Error('Official tunnel-client executable is not a regular file');
if (platform !== 'win32') await chmod(executable, 0o755);
await verifyVersion(executable);

await rm(bundleRoot, { recursive: true, force: true });
await mkdir(bundleRoot, { recursive: true });
await assertCanonicalDirectory(bundleRoot);
await copyFile(executable, path.join(bundleRoot, executableName));
if (platform !== 'win32') await chmod(path.join(bundleRoot, executableName), 0o755);

for (const assetName of [licenseName, spdxName]) {
  const expectedSha256 = checksums.get(assetName);
  if (expectedSha256 === undefined) throw new Error(`Official tunnel-client checksum is missing for ${assetName}`);
  const destination = path.join(bundleRoot, assetName);
  await downloadIfNeeded(`${RELEASE_BASE}/${assetName}`, destination, expectedSha256);
}

const provenanceName = `tunnel-client-v${VERSION}-provenance.sigstore.json`;
const provenancePath = path.join(bundleRoot, provenanceName);
await downloadText(`${RELEASE_BASE}/${provenanceName}`, provenancePath);
await assertCanonicalFile(provenancePath);
await verifyProvenance(provenancePath, archivePath, archiveName, expectedArchiveSha256);
await writeAtomic(path.join(bundleRoot, 'SHA256SUMS.txt'), checksumsText);
await writeAtomic(path.join(bundleRoot, 'BUNDLED_TUNNEL_CLIENT.json'), `${JSON.stringify({
  schemaVersion: 1,
  product: 'lnwjud',
  version: VERSION,
  platform,
  arch: rawArch,
  asset: archiveName,
  source: `${RELEASE_BASE}/${archiveName}`,
  assetSha256: expectedArchiveSha256,
  executable: executableName,
  executableSha256: await sha256(path.join(bundleRoot, executableName)),
  licenseAsset: licenseName,
  spdxAsset: spdxName,
  provenanceAsset: provenanceName,
  verified: { archiveSha256: true, executableVersion: true, executableBit: platform !== 'win32' },
}, null, 2)}\n`);
process.stdout.write(`Prepared official tunnel-client ${VERSION} for ${platform}/${rawArch}\n`);

async function downloadIfNeeded(url, destination, expectedSha256) {
  try {
    await assertCanonicalFile(destination);
    if ((await sha256(destination)) === expectedSha256) return;
  } catch {
    // Download the missing or invalid cache entry below.
  }
  await downloadText(url, destination);
  await assertCanonicalFile(destination);
  const actual = await sha256(destination);
  if (actual !== expectedSha256) throw new Error(`tunnel-client asset SHA-256 mismatch for ${path.basename(destination)}`);
}

async function downloadText(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Could not download official tunnel-client asset (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeAtomic(destination, bytes);
}

async function writeAtomic(destination, contents) {
  await assertCanonicalDirectory(path.dirname(destination));
  const temporary = `${destination}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let committed = false;
  try {
    await writeFile(temporary, contents, { flag: 'wx' });
    await rename(temporary, destination);
    committed = true;
  } finally {
    if (!committed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function assertCanonicalDirectory(directory) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Runtime staging directory is not a regular directory: ${directory}`);
  if (await realpath(directory) !== path.resolve(directory)) throw new Error(`Runtime staging directory is not canonical: ${directory}`);
}

async function assertCanonicalFile(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Runtime staging cache entry is not a regular file: ${filePath}`);
  if (await realpath(filePath) !== path.resolve(filePath)) throw new Error(`Runtime staging cache entry is not canonical: ${filePath}`);
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Could not download tunnel-client checksums (${response.status})`);
  return response.text();
}

function parseChecksums(text) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+[* ]?(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) entries.set(match[2], match[1]);
  }
  return entries;
}

async function findUniqueFile(root, name) {
  const matches = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name === name) matches.push(absolute);
    }
  }
  await visit(root);
  if (matches.length !== 1) throw new Error(`Expected exactly one ${name} in official tunnel-client archive; found ${matches.length}`);
  return matches[0];
}

async function extractArchive(archivePath, destination) {
  await extractZip.extract(archivePath, { dir: path.resolve(destination) });
}

function verifyVersion(executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--version'], { env: sanitizedEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let output = '';
    const append = (chunk) => { if (output.length < 512) output += chunk.toString('utf8').slice(0, 512 - output.length); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => { child.kill(); reject(new Error('Official tunnel-client --version timed out')); }, 10_000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Official tunnel-client --version could not run')); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 || output.trim().length === 0) reject(new Error('Official tunnel-client --version check failed'));
      else resolve();
    });
  });
}

async function sha256(filePath) {
  await assertCanonicalFile(filePath);
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

async function verifyProvenance(provenancePath, archivePath, expectedSubjectName, expectedSha256) {
  let document;
  try {
    document = JSON.parse(await readFile(provenancePath, 'utf8'));
  } catch {
    throw new Error('Official tunnel-client provenance is not valid JSON');
  }
  if (document?.mediaType !== 'application/vnd.dev.sigstore.bundle.v0.3+json'
    || document?.dsseEnvelope?.payloadType !== 'application/vnd.in-toto+json'
    || !Array.isArray(document?.dsseEnvelope?.signatures)
    || document.dsseEnvelope.signatures.length === 0
    || typeof document.dsseEnvelope.payload !== 'string') {
    throw new Error('Official tunnel-client provenance has an invalid Sigstore envelope');
  }
  await verifyProvenanceWithCosign(provenancePath, archivePath);
  let payload;
  try {
    payload = JSON.parse(Buffer.from(document.dsseEnvelope.payload, 'base64').toString('utf8'));
  } catch {
    throw new Error('Official tunnel-client provenance payload is invalid');
  }
  const subject = Array.isArray(payload?.subject)
    ? payload.subject.find((entry) => entry?.name === expectedSubjectName)
    : undefined;
  if (subject?.digest?.sha256?.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error('Official tunnel-client provenance does not match the release archive');
  }
}

async function verifyProvenanceWithCosign(provenancePath, archivePath) {
  const cosignPath = process.env.LNWJUD_COSIGN_PATH?.trim() || 'cosign';
  let versionOutput;
  try {
    const version = await execFileAsync(cosignPath, ['version'], { encoding: 'utf8', shell: false, env: sanitizedEnvironment(), windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 });
    versionOutput = `${version.stdout ?? ''}\n${version.stderr ?? ''}`;
  } catch (error) {
    throw new Error(`Sigstore provenance verification requires cosign >= ${MINIMUM_COSIGN_VERSION.join('.')}: ${error instanceof Error ? error.message.slice(0, 256) : 'cosign could not run'}`);
  }
  const match = /(?:^|\s)v(\d+)\.(\d+)\.(\d+)(?:\s|$)/m.exec(versionOutput);
  if (match === null || compareVersions([Number(match[1]), Number(match[2]), Number(match[3])], MINIMUM_COSIGN_VERSION) < 0) {
    throw new Error(`Sigstore provenance verification requires cosign >= ${MINIMUM_COSIGN_VERSION.join('.')}`);
  }
  try {
    await execFileAsync(cosignPath, [
      'verify-blob-attestation',
      '--bundle', provenancePath,
      '--certificate-identity', PROVENANCE_CERTIFICATE_IDENTITY,
      '--certificate-oidc-issuer', PROVENANCE_OIDC_ISSUER,
      '--type', 'https://slsa.dev/provenance/v1',
      archivePath,
    ], { encoding: 'utf8', shell: false, env: sanitizedEnvironment(), windowsHide: true, timeout: 120_000, maxBuffer: 256 * 1024 });
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 512) : 'cosign verification failed';
    throw new Error(`Official tunnel-client Sigstore provenance failed cryptographic verification: ${detail}`);
  }
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function sanitizedEnvironment(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([key]) => !/(?:^|[_-])(?:api[_-]?key|token|password|secret)(?:$|[_-])/iu.test(key)));
}
