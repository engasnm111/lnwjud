import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeAssets } from './runtime-asset-manifest.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(desktopRoot, 'build');
const { target, node } = resolveRuntimeAssets();
const outputPath = path.join(buildDir, node.executableName);
const oppositePath = path.join(buildDir, process.platform === 'win32' ? 'lnwjud-node' : 'lnwjud-node.exe');
const scratch = path.join(os.tmpdir(), `lnwjud-node-runtime-${process.pid}-${Date.now()}`);

await mkdir(buildDir, { recursive: true });
await rm(oppositePath, { force: true });
await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });

try {
  const payload = await download(node.url);
  const archiveHash = sha256(payload);
  if (archiveHash !== node.sha256) throw new Error(`Node runtime SHA-256 mismatch for ${target}: expected ${node.sha256}, got ${archiveHash}`);

  if (node.archiveType === 'file') {
    await writeFile(outputPath, payload, { mode: 0o755 });
  } else {
    const archivePath = path.join(scratch, archiveName(node.url));
    const extractRoot = path.join(scratch, 'extract');
    await writeFile(archivePath, payload);
    await mkdir(extractRoot, { recursive: true });
    extractTar(archivePath, extractRoot);
    if (node.innerPath === null) throw new Error(`Node runtime inner path is missing for ${target}`);
    await copyFile(path.join(extractRoot, ...node.innerPath.split('/')), outputPath);
    await chmod(outputPath, 0o755);
  }

  const executableHash = sha256(await readFile(outputPath));
  await writeFile(path.join(buildDir, 'BUNDLED_NODE.txt'), [
    'source=verified-download',
    `target=${target}`,
    `version=${node.version}`,
    `url=${node.url}`,
    `archive_sha256=${node.sha256}`,
    `executable_sha256=${executableHash}`,
    '',
  ].join('\n'), 'utf8');
  process.stdout.write(`Prepared Node ${node.version} for ${target}: ${outputPath}\n`);
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
  return new URL(url).pathname.split('/').at(-1) ?? 'runtime-archive';
}

function extractTar(archivePath, destination) {
  const result = spawnSync('tar', ['-xf', archivePath, '-C', destination], { encoding: 'utf8' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`tar extraction failed: ${(result.stderr ?? '').trim()}`);
}
