/* global process */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
const version = String(packageJson.version ?? '').trim();
const stagingDirectory = requiredDirectory('LNWJUD_RELEASE_STAGING_DIRECTORY');
const assetsDirectory = requiredDirectory('LNWJUD_RELEASE_ASSETS_DIRECTORY');
const expectedCommit = requiredValue('LNWJUD_RELEASE_COMMIT');

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid package version: ${version}`);
if (!/^[0-9a-f]{40}$/i.test(expectedCommit)) throw new Error(`Invalid release commit SHA: ${expectedCommit}`);
await assertRegularDirectory(stagingDirectory, 'Release staging directory');
await prepareEmptyAssetsDirectory(assetsDirectory);

const targets = [
  { key: 'win32-x64', platform: 'win32', arch: 'x64' },
  { key: 'darwin-arm64', platform: 'darwin', arch: 'arm64' },
  { key: 'darwin-x64', platform: 'darwin', arch: 'x64' },
  { key: 'linux-x64', platform: 'linux', arch: 'x64' },
  { key: 'linux-arm64', platform: 'linux', arch: 'arm64' },
];

const targetEvidence = [];
const macManifests = [];

for (const target of targets) {
  const targetDirectory = path.join(stagingDirectory, target.key);
  await assertRegularDirectory(targetDirectory, `Staged ${target.key} artifact`);
  const provenancePath = await findUniqueFile(targetDirectory, 'PROVENANCE.json');
  const sumsPath = await findUniqueFile(targetDirectory, 'SHA256SUMS.txt');
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  const sumsText = await readFile(sumsPath, 'utf8');
  const sums = parseSums(sumsText);
  validateProvenance(provenance, target);

  const artifactNames = expectedArtifactNames(target.platform, version, target.arch);
  const sourceArtifacts = [];
  for (const artifactName of artifactNames) {
    const artifactPath = await findUniqueFile(targetDirectory, artifactName);
    const provenanceEntry = provenance.artifacts?.find((entry) => entry?.name === artifactName);
    if (!provenanceEntry) throw new Error(`${target.key} provenance is missing ${artifactName}`);
    const actualHash = await sha256File(artifactPath);
    if (actualHash !== String(provenanceEntry.sha256).toLowerCase()) {
      throw new Error(`${target.key} artifact hash mismatch for ${artifactName}`);
    }
    if (sums.get(artifactName) !== actualHash) throw new Error(`${target.key} SHA256SUMS mismatch for ${artifactName}`);
    sourceArtifacts.push({ name: artifactName, path: artifactPath, sha256: actualHash });
  }

  const provenanceHash = await sha256File(provenancePath);
  if (sums.get('PROVENANCE.json') !== provenanceHash) throw new Error(`${target.key} provenance hash is not covered by SHA256SUMS.txt`);
  if (!Array.isArray(provenance.runtime) || provenance.runtime.length === 0) throw new Error(`${target.key} runtime provenance is missing`);

  const provenanceFile = `PROVENANCE-${target.key}.json`;
  const sumsFile = `SHA256SUMS-${target.key}.txt`;
  await copyFile(provenancePath, path.join(assetsDirectory, provenanceFile));
  const rewrittenSums = sumsText.replace(
    /^([0-9a-f]{64}) {2}PROVENANCE\.json$/im,
    `$1  ${provenanceFile}`,
  );
  if (rewrittenSums === sumsText) throw new Error(`${target.key} SHA256SUMS.txt does not contain its provenance entry`);
  await writeFile(path.join(assetsDirectory, sumsFile), rewrittenSums, 'utf8');

  const copiedArtifacts = [];
  for (const artifact of sourceArtifacts) {
    if (target.platform === 'darwin' && artifact.name === 'latest-mac.yml') {
      const manifest = parseMacUpdateManifest(await readFile(artifact.path, 'utf8'), artifact.name, target);
      macManifests.push({ target, manifest });
      continue;
    }
    const destination = path.join(assetsDirectory, artifact.name);
    await copyFile(artifact.path, destination);
    copiedArtifacts.push(artifact.name);
  }

  targetEvidence.push({
    target,
    provenance,
    provenanceFile,
    sumsFile,
    sourceProvenanceSha256: provenanceHash,
    sourceSumsSha256: await sha256File(sumsPath),
    sourceArtifactNames: artifactNames,
    copiedArtifacts,
  });
}

if (macManifests.length !== 2) throw new Error('Both macOS arm64 and x64 update manifests are required');
const mergedMacManifest = mergeMacUpdateManifests(macManifests, version);
await writeFile(path.join(assetsDirectory, 'latest-mac.yml'), mergedMacManifest, 'utf8');

const payloadFiles = (await listDirectRegularFiles(assetsDirectory))
  .filter((name) => name !== 'RELEASE_MANIFEST.json' && name !== 'SHA256SUMS.txt')
  .sort();
const payload = [];
for (const name of payloadFiles) {
  const filePath = path.join(assetsDirectory, name);
  payload.push({ name, sizeBytes: (await lstat(filePath)).size, sha256: await sha256File(filePath) });
}

const releaseManifest = {
  schemaVersion: 1,
  product: 'lnwjud',
  version,
  sourceCommit: expectedCommit.toLowerCase(),
  generatedBy: 'scripts/collect-release-assets.mjs',
  targets: targetEvidence.map(({ target, provenance, provenanceFile, sumsFile, sourceProvenanceSha256, sourceSumsSha256, sourceArtifactNames, copiedArtifacts }) => ({
    platform: target.platform,
    arch: target.arch,
    sourceArtifactNames,
    copiedArtifacts,
    updateMetadata: target.platform === 'darwin'
      ? 'latest-mac.yml'
      : target.platform === 'linux'
        ? linuxUpdateMetadataName(target.arch)
        : 'latest.yml',
    provenanceFile,
    sumsFile,
    sourceProvenanceSha256,
    sourceSumsSha256,
    sourceDirty: provenance.source.dirty,
  })),
  assets: payload,
};
await writeFile(path.join(assetsDirectory, 'RELEASE_MANIFEST.json'), `${JSON.stringify(releaseManifest, null, 2)}\n`, 'utf8');

const integrityFiles = (await listDirectRegularFiles(assetsDirectory)).filter((name) => name !== 'SHA256SUMS.txt').sort();
const aggregateSums = [];
for (const name of integrityFiles) {
  aggregateSums.push(`${await sha256File(path.join(assetsDirectory, name))}  ${name}`);
}
await writeFile(path.join(assetsDirectory, 'SHA256SUMS.txt'), `${aggregateSums.join('\n')}\n`, 'utf8');

process.stdout.write(`Collected ${integrityFiles.length} release assets for lnwjud ${version} from ${expectedCommit}\n`);

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredDirectory(name) {
  return path.resolve(requiredValue(name));
}

async function prepareEmptyAssetsDirectory(directory) {
  try {
    await assertRegularDirectory(directory, 'Release assets directory');
    const entries = await readdir(directory);
    if (entries.length > 0) throw new Error(`Release assets directory must be empty: ${directory}`);
  } catch (error) {
    if (error instanceof Error && /ENOENT|is missing/.test(error.message)) {
      await mkdir(directory, { recursive: true });
      return;
    }
    throw error;
  }
}

async function assertRegularDirectory(directory, label) {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing: ${directory}`);
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} is not a regular directory: ${directory}`);
  if (await realpath(directory) !== path.resolve(directory)) throw new Error(`${label} is not canonical: ${directory}`);
}

async function findUniqueFile(rootDirectory, fileName) {
  const matches = [];
  await walk(rootDirectory);
  if (matches.length !== 1) throw new Error(`Expected exactly one ${fileName} under ${rootDirectory}, found ${matches.length}`);
  await assertRegularFile(matches[0], fileName);
  return matches[0];

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (entry.name === fileName) throw new Error(`Refusing symlink release evidence: ${entryPath}`);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name === fileName) {
        matches.push(entryPath);
      }
    }
  }
}

async function assertRegularFile(filePath, label) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} is not a regular file: ${filePath}`);
  if (await realpath(filePath) !== path.resolve(filePath)) throw new Error(`${label} is not canonical: ${filePath}`);
}

async function listDirectRegularFiles(directory) {
  const names = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Release assets directory contains a non-regular entry: ${entry.name}`);
    names.push(entry.name);
  }
  return names;
}

function validateProvenance(provenance, target) {
  if (provenance?.schemaVersion !== 1 || provenance.product !== 'lnwjud') throw new Error(`${target.key} provenance schema/product is invalid`);
  if (provenance.version !== version) throw new Error(`${target.key} provenance version mismatch`);
  if (provenance.platform !== target.platform || provenance.arch !== target.arch) throw new Error(`${target.key} provenance target mismatch`);
  if (provenance.source?.commit?.toLowerCase() !== expectedCommit.toLowerCase()) throw new Error(`${target.key} provenance commit mismatch`);
  if (provenance.source?.dirty !== false) throw new Error(`${target.key} provenance is not clean`);
}

function expectedArtifactNames(platform, releaseVersion, arch) {
  if (platform === 'win32') return [
    `lnwjud-Setup-${releaseVersion}.exe`,
    `lnwjud-Setup-${releaseVersion}.exe.blockmap`,
    `lnwjud-Portable-${releaseVersion}.exe`,
    'latest.yml',
    'portable.yml',
  ];
  if (platform === 'darwin') return [`lnwjud-${releaseVersion}-${arch}.dmg`, `lnwjud-${releaseVersion}-${arch}.zip`, 'latest-mac.yml'];
  return [`lnwjud-${releaseVersion}-${arch}.AppImage`, `lnwjud-${releaseVersion}-${arch}.deb`, linuxUpdateMetadataName(arch)];
}

function linuxUpdateMetadataName(arch) {
  return arch === 'x64' ? 'latest-linux.yml' : `latest-linux-${arch}.yml`;
}

function parseSums(text) {
  const result = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/i.exec(line);
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
    result.set(match[2], match[1].toLowerCase());
  }
  return result;
}

function parseMacUpdateManifest(text, fileName, target) {
  const versionMatch = /^version:\s*(.+)$/m.exec(text);
  if (versionMatch === null || unquoteYamlScalar(versionMatch[1]) !== version) throw new Error(`${target.key} ${fileName} version is invalid`);
  const files = [];
  let pending = null;
  for (const line of text.split(/\r?\n/)) {
    const urlMatch = /^\s*-\s+url:\s*(.+)\s*$/.exec(line);
    if (urlMatch !== null) {
      if (pending !== null) files.push(pending);
      pending = { url: unquoteYamlScalar(urlMatch[1]), sha512: null };
      continue;
    }
    const hashMatch = /^\s+sha512:\s*(.+)\s*$/.exec(line);
    if (hashMatch !== null && pending !== null) pending.sha512 = unquoteYamlScalar(hashMatch[1]);
  }
  if (pending !== null) files.push(pending);
  const expectedZip = `lnwjud-${version}-${target.arch}.zip`;
  const file = files.find((entry) => entry.url === expectedZip);
  if (files.length === 0 || file === undefined || typeof file.sha512 !== 'string' || !/^[0-9a-z+/=]+$/i.test(file.sha512)) {
    throw new Error(`${target.key} ${fileName} does not contain a valid ${expectedZip} entry`);
  }
  const releaseDateMatch = /^releaseDate:\s*(.+)$/m.exec(text);
  return { files, releaseDate: releaseDateMatch ? unquoteYamlScalar(releaseDateMatch[1]) : new Date(0).toISOString() };
}

function mergeMacUpdateManifests(manifests, releaseVersion) {
  const files = manifests
    .flatMap(({ manifest }) => manifest.files)
    .sort((left, right) => left.url.localeCompare(right.url));
  const releaseDate = manifests.map(({ manifest }) => manifest.releaseDate).sort().at(-1) ?? new Date(0).toISOString();
  return [
    `version: ${releaseVersion}`,
    'files:',
    ...files.flatMap((file) => [`  - url: ${file.url}`, `    sha512: ${file.sha512}`]),
    `releaseDate: '${escapeYamlSingleQuote(releaseDate)}'`,
    '',
  ].join('\n');
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

function escapeYamlSingleQuote(value) {
  return String(value).replaceAll("'", "''");
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
