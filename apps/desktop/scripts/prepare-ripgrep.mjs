import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeAssets } from './runtime-asset-manifest.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(desktopRoot, 'build', 'runtime-tools', 'ripgrep');
const { target, ripgrep } = resolveRuntimeAssets();
const outputPath = path.join(outputDir, ripgrep.executableName);
const scratch = path.join(os.tmpdir(), `lnwjud-ripgrep-${process.pid}-${Date.now()}`);

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });

try {
  const payload = await download(ripgrep.url);
  const archiveHash = sha256(payload);
  if (archiveHash !== ripgrep.sha256) throw new Error(`ripgrep SHA-256 mismatch for ${target}: expected ${ripgrep.sha256}, got ${archiveHash}`);

  const archivePath = path.join(scratch, archiveName(ripgrep.url));
  const extractRoot = path.join(scratch, 'extract');
  await writeFile(archivePath, payload);
  await mkdir(extractRoot, { recursive: true });
  extractArchive(archivePath, extractRoot);

  await copyFile(path.join(extractRoot, ...ripgrep.innerPath.split('/')), outputPath);
  if (process.platform !== 'win32') await chmod(outputPath, 0o755);
  const executableHash = sha256(await readFile(outputPath));
  await writeFile(path.join(outputDir, 'BUNDLED_RIPGREP.txt'), [
    `target=${target}`,
    `version=${ripgrep.version}`,
    `url=${ripgrep.url}`,
    `archive_sha256=${ripgrep.sha256}`,
    `executable_sha256=${executableHash}`,
    '',
  ].join('\n'), 'utf8');
  process.stdout.write(`Prepared ripgrep ${ripgrep.version} for ${target}: ${outputPath}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Runtime download failed (${response.status}) for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function archiveName(url) {
  return new URL(url).pathname.split('/').at(-1) ?? 'ripgrep-archive';
}

function extractArchive(archivePath, destination) {
  const result = spawnSync('tar', ['-xf', archivePath, '-C', destination], { encoding: 'utf8' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`archive extraction failed: ${(result.stderr ?? '').trim()}`);
}
