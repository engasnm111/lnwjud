import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installerDirectory = path.join(desktopRoot, 'dist', 'installers');
const packageJson = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8'));
const provenance = JSON.parse(await readFile(path.join(installerDirectory, 'PROVENANCE.json'), 'utf8'));
const sumsText = await readFile(path.join(installerDirectory, 'SHA256SUMS.txt'), 'utf8');
const sums = parseSums(sumsText);

if (provenance?.schemaVersion !== 1 || provenance.product !== 'lnwjud') throw new Error('PROVENANCE.json schema/product is invalid');
if (provenance.version !== packageJson.version) throw new Error(`Provenance version mismatch: ${String(provenance.version)} != ${String(packageJson.version)}`);
if (typeof provenance.source?.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(provenance.source.commit)) throw new Error('Provenance commit SHA is invalid');

const expectedCommit = process.env.LNWJUD_EXPECTED_COMMIT_SHA?.trim();
if (expectedCommit && provenance.source.commit.toLowerCase() !== expectedCommit.toLowerCase()) {
  throw new Error(`Provenance commit mismatch: ${provenance.source.commit} != ${expectedCommit}`);
}
if (process.env.LNWJUD_REQUIRE_CLEAN_PROVENANCE === '1' && provenance.source.dirty !== false) {
  throw new Error('Public release provenance must be built from a clean tracked source tree');
}

if (!Array.isArray(provenance.artifacts) || provenance.artifacts.length < 5) throw new Error('Provenance artifact list is incomplete');
for (const artifact of provenance.artifacts) {
  validateEntry(artifact, 'artifact');
  const expected = sums.get(artifact.name);
  if (expected !== artifact.sha256) throw new Error(`SHA256SUMS mismatch for ${artifact.name}`);
  const actual = await sha256File(path.join(installerDirectory, artifact.name));
  if (actual !== artifact.sha256) throw new Error(`Artifact SHA-256 mismatch for ${artifact.name}`);
}

const provenanceHash = await sha256File(path.join(installerDirectory, 'PROVENANCE.json'));
if (sums.get('PROVENANCE.json') !== provenanceHash) throw new Error('PROVENANCE.json SHA-256 mismatch');

const requiredRuntime = new Set([
  'lnwjud.exe',
  'lnwjud-mcp-stdio.cjs',
  'lnwjud-mcp-stdio.cmd',
  'lnwjud-node.exe',
  'resources/runtime-tools/ripgrep/rg.exe',
  'resources/tunnel-client/tunnel-client.exe',
]);
if (!Array.isArray(provenance.runtime)) throw new Error('Provenance runtime list is missing');
for (const runtime of provenance.runtime) {
  validateEntry(runtime, 'runtime');
  if (typeof runtime.relativePath !== 'string' || runtime.relativePath.length === 0) throw new Error('Runtime provenance path is invalid');
  requiredRuntime.delete(runtime.relativePath);
  const sumName = `installed/${runtime.relativePath}`;
  if (sums.get(sumName) !== runtime.sha256) throw new Error(`SHA256SUMS mismatch for ${sumName}`);
}
if (requiredRuntime.size > 0) throw new Error(`Runtime provenance is incomplete: ${[...requiredRuntime].join(', ')}`);

process.stdout.write(`Release evidence verified for lnwjud ${provenance.version} commit ${provenance.source.commit}\n`);

function validateEntry(entry, kind) {
  if (!entry || typeof entry !== 'object') throw new Error(`Invalid ${kind} provenance entry`);
  if (typeof entry.name !== 'string' || entry.name.length === 0) throw new Error(`Invalid ${kind} name`);
  if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256)) throw new Error(`Invalid ${kind} SHA-256 for ${String(entry.name)}`);
  if (!Number.isInteger(entry.sizeBytes) || entry.sizeBytes < 0) throw new Error(`Invalid ${kind} size for ${String(entry.name)}`);
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
