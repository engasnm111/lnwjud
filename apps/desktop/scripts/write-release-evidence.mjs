import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
const workingTreeDirtyAtEvidence = workingTreeStatusAtEvidence.length > 0;
const sourceDirtyAtStart = parseSourceDirtyAtStart(process.env.LNWJUD_SOURCE_DIRTY_AT_START);
const dirty = sourceDirtyAtStart ?? workingTreeDirtyAtEvidence;

const runtimeEvidence = JSON.parse(await readFile(runtimeEvidencePath, 'utf8'));
if (runtimeEvidence?.schemaVersion !== 1 || !Array.isArray(runtimeEvidence.files)) {
  throw new Error('Packaged runtime evidence is missing or invalid');
}

const artifactNames = [
  `lnwjud-Setup-${version}.exe`,
  `lnwjud-Setup-${version}.exe.blockmap`,
  `lnwjud-Portable-${version}.exe`,
  'latest.yml',
  'portable.yml',
];
const artifacts = [];
for (const name of artifactNames) {
  const filePath = path.join(installerDirectory, name);
  const metadata = await stat(filePath);
  if (!metadata.isFile()) throw new Error(`Required release artifact is missing: ${name}`);
  artifacts.push({ name, sizeBytes: metadata.size, sha256: await sha256File(filePath) });
}

const provenance = {
  schemaVersion: 1,
  product: 'lnwjud',
  version,
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
    signingCredentialConfigured: Boolean(process.env.CSC_LINK?.trim() || process.env.WIN_CSC_LINK?.trim()),
    workingTreeDirtyAtEvidence,
  },
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

process.stdout.write(`Release evidence written for lnwjud ${version} commit ${commit}${dirty ? ' (dirty)' : ''}\n`);

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

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}
