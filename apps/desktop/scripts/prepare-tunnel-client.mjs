import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTunnelClientAsset } from './tunnel-client-asset-manifest.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = path.join(desktopRoot, 'build');
const vendorRoot = path.join(buildRoot, 'vendor');
const bundleRoot = path.join(buildRoot, 'tunnel-client');
const asset = resolveTunnelClientAsset();
const archivePath = path.join(vendorRoot, asset.assetName);
const scratch = path.join(os.tmpdir(), `lnwjud-tunnel-client-${process.pid}-${Date.now()}`);
const extractRoot = path.join(scratch, 'extract');

await mkdir(vendorRoot, { recursive: true });
await rm(scratch, { recursive: true, force: true });
await mkdir(extractRoot, { recursive: true });

try {
  let payload = await readFile(archivePath).catch(() => null);
  if (payload === null || sha256(payload) !== asset.sha256) {
    await rm(archivePath, { force: true });
    payload = await download(asset.url);
    const actualHash = sha256(payload);
    if (actualHash !== asset.sha256) {
      throw new Error(`tunnel-client SHA-256 mismatch for ${asset.target}: expected ${asset.sha256}, got ${actualHash}`);
    }
    await writeFile(archivePath, payload);
  }

  extractArchive(archivePath, extractRoot);
  const archiveEntries = await readdir(extractRoot, { withFileTypes: true });
  const fileNames = archiveEntries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const unexpectedDirectories = archiveEntries.filter((entry) => !entry.isFile()).map((entry) => entry.name);
  const expectedFileNames = [...asset.requiredFileNames].sort();
  if (unexpectedDirectories.length > 0 || JSON.stringify(fileNames) !== JSON.stringify(expectedFileNames)) {
    throw new Error(`Unexpected archive layout for ${asset.assetName}: expected root files ${expectedFileNames.join(', ')}, got files ${fileNames.join(', ')}${unexpectedDirectories.length > 0 ? `; non-files ${unexpectedDirectories.join(', ')}` : ''}`);
  }

  await rm(bundleRoot, { recursive: true, force: true });
  await mkdir(bundleRoot, { recursive: true });
  for (const fileName of asset.requiredFileNames) {
    await copyFile(path.join(extractRoot, fileName), path.join(bundleRoot, fileName));
  }
  if (process.platform !== 'win32') {
    await chmod(path.join(bundleRoot, asset.executableName), 0o755);
    await chmod(path.join(bundleRoot, asset.cloudflaredName), 0o755);
  }

  const tunnelClientHash = sha256(await readFile(path.join(bundleRoot, asset.executableName)));
  const cloudflaredHash = sha256(await readFile(path.join(bundleRoot, asset.cloudflaredName)));
  const cloudflaredManifestBuffer = await readFile(path.join(bundleRoot, 'cloudflared-manifest.json'));
  const cloudflaredManifestHash = sha256(cloudflaredManifestBuffer);
  const cloudflaredManifest = JSON.parse(cloudflaredManifestBuffer.toString('utf8'));
  const cloudflaredVersion = typeof cloudflaredManifest.version === 'string' ? cloudflaredManifest.version.trim() : '';
  if (cloudflaredVersion.length === 0) throw new Error('cloudflared-manifest.json is missing version');

  await writeFile(path.join(bundleRoot, 'BUNDLED_TUNNEL_CLIENT.txt'), [
    'OpenAI tunnel-client bundled by lnwjud',
    `target=${asset.target}`,
    `version=${asset.version}`,
    `asset=${asset.assetName}`,
    `source=${asset.url}`,
    `asset_sha256=${asset.sha256}`,
    `tunnel_client_sha256=${tunnelClientHash}`,
    `cloudflared_version=${cloudflaredVersion}`,
    `cloudflared_sha256=${cloudflaredHash}`,
    `cloudflared_manifest_sha256=${cloudflaredManifestHash}`,
    `archive_files=${asset.requiredFileNames.join(';')}`,
    `prepared_at_utc=${new Date().toISOString()}`,
    '',
  ].join('\n'), 'utf8');

  process.stdout.write(`Bundled tunnel-client ${asset.version} for ${asset.target}: ${bundleRoot}\n`);
  process.stdout.write(`Archive SHA-256: ${asset.sha256}\n`);
  process.stdout.write(`${asset.executableName} SHA-256: ${tunnelClientHash}\n`);
  process.stdout.write(`${asset.cloudflaredName} v${cloudflaredVersion} SHA-256: ${cloudflaredHash}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}

function extractArchive(archivePath, destination) {
  const invocation = process.platform === 'win32'
    ? { command: 'tar', args: ['-xf', archivePath, '-C', destination] }
    : process.platform === 'darwin'
      ? { command: '/usr/bin/ditto', args: ['-x', '-k', archivePath, destination] }
      : { command: 'unzip', args: ['-q', archivePath, '-d', destination] };
  const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8' });
  if (result.error !== undefined) throw new Error(`ZIP extractor unavailable for ${asset.target}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`ZIP extraction failed for ${asset.target}: ${(result.stderr ?? '').trim()}`);
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`tunnel-client download failed (${response.status}) for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
