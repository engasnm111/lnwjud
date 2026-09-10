/* global AbortSignal, fetch, structuredClone -- Node.js 24 built-ins used by this maintenance script. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repositoryRoot, 'apps', 'desktop', 'src', 'main', 'runtime-dependencies.json');
const writeChanges = process.argv.includes('--write');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest?.schemaVersion !== 1) throw new Error('runtime-dependencies.json schema is unsupported');

const next = structuredClone(manifest);
await updateTunnelClient(next.tunnelClient);
await updateRipgrep(next.ripgrep);
await updatePdfProvider(next.pdfProvider);
validateManifest(next);

const before = `${JSON.stringify(manifest, null, 2)}\n`;
const after = `${JSON.stringify(next, null, 2)}\n`;
if (before === after) {
  process.stdout.write('Runtime dependency pins are already current.\n');
  process.exit(0);
}

const changes = [];
for (const key of ['tunnelClient', 'ripgrep', 'pdfProvider']) {
  if (JSON.stringify(manifest[key]) !== JSON.stringify(next[key])) changes.push(`${key}: ${manifest[key].version} -> ${next[key].version}`);
}
process.stdout.write(`Runtime dependency updates available: ${changes.join(', ')}\n`);
if (!writeChanges) process.exitCode = 2;
else {
  await writeFile(manifestPath, after, 'utf8');
  process.stdout.write(`Updated ${path.relative(repositoryRoot, manifestPath)}\n`);
}

async function updateTunnelClient(dependency) {
  const release = await latestRelease(dependency.repository);
  const version = stableVersion(release.tag_name, 'v');
  const assets = assetMap(release);
  const provenanceName = `tunnel-client-v${version}-provenance.sigstore.json`;
  requireAsset(assets, provenanceName);
  const sumsAsset = requireAsset(assets, 'SHA256SUMS.txt');
  const sums = parseChecksums(await fetchText(sumsAsset.browser_download_url, 'tunnel-client SHA256SUMS'));
  for (const [key, target] of Object.entries(dependency.targets)) {
    const archive = `tunnel-client-v${version}-${target.releaseTarget}-${target.releaseArch}.zip`;
    const license = `tunnel-client-v${version}-${target.releaseTarget}-${target.releaseArch}-licenses.txt`;
    const spdx = `tunnel-client-v${version}-${target.releaseTarget}-${target.releaseArch}.spdx.json`;
    const archiveAsset = requireAsset(assets, archive);
    requireAsset(assets, license);
    requireAsset(assets, spdx);
    const digest = sha256Digest(archiveAsset);
    if (sums.get(archive) !== digest) throw new Error(`tunnel-client upstream digest/checksum mismatch for ${archive}`);
    dependency.targets[key].archiveSha256 = digest;
  }
  dependency.version = version;
  dependency.provenanceAsset = provenanceName;
}

async function updateRipgrep(dependency) {
  const release = await latestRelease(dependency.repository);
  const version = stableVersion(release.tag_name);
  const assets = assetMap(release);
  for (const [key, target] of Object.entries(dependency.targets)) {
    const extension = target.kind === 'zip' ? 'zip' : target.kind === 'tar.gz' ? 'tar.gz' : null;
    if (extension === null) throw new Error(`Unsupported ripgrep archive kind for ${key}`);
    const archive = `ripgrep-${version}-${target.targetTriple}.${extension}`;
    const asset = requireAsset(assets, archive);
    dependency.targets[key].archive = archive;
    dependency.targets[key].sha256 = sha256Digest(asset);
  }
  dependency.version = version;
}

async function updatePdfProvider(dependency) {
  const release = await latestRelease(dependency.repository);
  const version = stableVersion(release.tag_name, 'v');
  const assetName = `Release-${version}.zip`;
  const asset = requireAsset(assetMap(release), assetName);
  const popplerVersion = /^([0-9]+\.[0-9]+\.[0-9]+)/u.exec(version)?.[1];
  if (!popplerVersion) throw new Error(`Unexpected Poppler release version: ${version}`);
  dependency.version = version;
  dependency.popplerVersion = popplerVersion;
  dependency.sourceUrl = asset.browser_download_url;
  dependency.archiveSha256 = sha256Digest(asset);
}

async function latestRelease(repository) {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'lnwjud-runtime-dependency-updater' },
  });
  if (!response.ok) throw new Error(`Could not query latest release for ${repository} (${response.status})`);
  const release = await response.json();
  if (release?.draft || release?.prerelease || typeof release?.tag_name !== 'string' || !Array.isArray(release?.assets)) {
    throw new Error(`Latest ${repository} release is not a stable asset release`);
  }
  return release;
}

function stableVersion(tag, prefix = '') {
  const value = prefix && tag.startsWith(prefix) ? tag.slice(prefix.length) : tag;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9]+)?$/u.test(value)) throw new Error(`Unexpected stable release tag: ${tag}`);
  return value;
}

function assetMap(release) {
  return new Map(release.assets.map((asset) => [asset.name, asset]));
}

function requireAsset(assets, name) {
  const asset = assets.get(name);
  if (!asset || typeof asset.browser_download_url !== 'string') throw new Error(`Required upstream release asset is missing: ${name}`);
  return asset;
}

function sha256Digest(asset) {
  const match = /^sha256:([0-9a-f]{64})$/iu.exec(asset.digest ?? '');
  if (!match) throw new Error(`GitHub SHA-256 digest is unavailable for ${asset.name}`);
  return match[1].toLowerCase();
}

async function fetchText(url, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'lnwjud-runtime-dependency-updater' } });
  if (!response.ok) throw new Error(`Could not download ${label} (${response.status})`);
  return response.text();
}

function parseChecksums(text) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([0-9a-f]{64})\s+[* ]?(.+?)\s*$/iu.exec(line);
    if (match?.[1] && match[2]) entries.set(match[2], match[1].toLowerCase());
  }
  return entries;
}

function validateManifest(value) {
  const tuples = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];
  for (const dependencyName of ['tunnelClient', 'ripgrep']) {
    const targets = value?.[dependencyName]?.targets;
    if (!targets || Object.keys(targets).sort().join('|') !== [...tuples].sort().join('|')) {
      throw new Error(`${dependencyName} must declare exactly the six supported OS/architecture tuples`);
    }
  }
  for (const target of Object.values(value.tunnelClient.targets)) {
    if (!/^[0-9a-f]{64}$/u.test(target.archiveSha256)) throw new Error('Invalid tunnel-client SHA-256 pin');
  }
  for (const target of Object.values(value.ripgrep.targets)) {
    if (!/^[0-9a-f]{64}$/u.test(target.sha256)) throw new Error('Invalid ripgrep SHA-256 pin');
  }
  if (value.pdfProvider.platform !== 'win32' || value.pdfProvider.arch !== 'x64' || !/^[0-9a-f]{64}$/u.test(value.pdfProvider.archiveSha256)) {
    throw new Error('PDF provider must remain explicitly pinned to win32/x64');
  }
}
