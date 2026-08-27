import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Downloads the official OpenAI tunnel-client release for both macOS
// architectures, verifies the pinned SHA-256 of each archive, lipo-merges the
// binaries (tunnel-client and the bundled cloudflared runtime) into universal
// Mach-O files, and stages them under build/tunnel-client so DMG/ZIP bundles
// of either arch carry the tunnel runtime. Mirrors prepare-tunnel-client.ps1.
const version = '0.0.13';
const ASSETS = {
  arm64: {
    assetName: `tunnel-client-v${version}-darwin-arm64.zip`,
    expectedSha256: '15abf165f06050af642c948ba6bd6c905191dc5420a9422dadde2b49d892e2c6',
  },
  x64: {
    assetName: `tunnel-client-v${version}-darwin-amd64.zip`,
    expectedSha256: 'c683e15d84fb997f5af1cc7c4cb55008e19a555a9ed2ec0f89a5ff426d85f85c',
  },
};
const BINARIES = ['tunnel-client', 'cloudflared'];

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = path.join(desktopRoot, 'build');
const vendorRoot = path.join(buildRoot, 'vendor');
const bundleRoot = path.join(buildRoot, 'tunnel-client');

mkdirSync(vendorRoot, { recursive: true });

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function walk(root) {
  const entries = [];
  for (const name of readdirSync(root)) {
    const current = path.join(root, name);
    if (statSync(current).isDirectory()) entries.push(...walk(current));
    else entries.push(current);
  }
  return entries;
}

async function stageArchive(arch) {
  const asset = ASSETS[arch];
  const archivePath = path.join(vendorRoot, asset.assetName);
  if (!existsSync(archivePath) || sha256(archivePath) !== asset.expectedSha256) {
    process.stdout.write(`Downloading official OpenAI tunnel-client v${version} for darwin-${arch}...\n`);
    const downloaded = spawnSync('curl', ['-fsSL', `https://github.com/openai/tunnel-client/releases/download/v${version}/${asset.assetName}`, '-o', archivePath]);
    if (downloaded.status !== 0) throw new Error(`tunnel-client download failed (curl exited ${downloaded.status})`);
  }
  const actualSha = sha256(archivePath);
  if (actualSha !== asset.expectedSha256) {
    throw new Error(`tunnel-client SHA-256 mismatch. expected=${asset.expectedSha256} actual=${actualSha}`);
  }

  const extractRoot = path.join(vendorRoot, `tunnel-client-v${version}-darwin-${arch}`);
  rmSync(extractRoot, { recursive: true, force: true });
  mkdirSync(extractRoot, { recursive: true });
  const extracted = spawnSync('unzip', ['-oq', archivePath, '-d', extractRoot]);
  if (extracted.status !== 0) throw new Error(`tunnel-client archive could not be extracted (unzip exited ${extracted.status})`);
  return extractRoot;
}

const armRoot = await stageArchive('arm64');
const x64Root = await stageArchive('x64');

rmSync(bundleRoot, { recursive: true, force: true });
mkdirSync(bundleRoot, { recursive: true });

for (const binaryName of BINARIES) {
  const armBinary = walk(armRoot).find((file) => path.basename(file) === binaryName);
  const x64Binary = walk(x64Root).find((file) => path.basename(file) === binaryName);
  if (armBinary === undefined || x64Binary === undefined) {
    throw new Error(`Expected ${binaryName} in both darwin archives`);
  }
  const universal = path.join(bundleRoot, binaryName);
  const merged = spawnSync('lipo', ['-create', armBinary, x64Binary, '-output', universal]);
  if (merged.status !== 0) throw new Error(`lipo could not merge ${binaryName} (exited ${merged.status})`);
  chmodSync(universal, 0o755);
}

const notices = [...walk(armRoot)].filter((file) => /(license|notice|spdx)/i.test(path.basename(file)));
for (const notice of notices) copyFileSync(notice, path.join(bundleRoot, path.basename(notice)));

const manifest = [
  'OpenAI tunnel-client bundled by lnwjud',
  `version=${version}`,
  `asset_arm64=${ASSETS.arm64.assetName}`,
  `asset_x64=${ASSETS.x64.assetName}`,
  `asset_sha256_arm64=${ASSETS.arm64.expectedSha256}`,
  `asset_sha256_x64=${ASSETS.x64.expectedSha256}`,
  `format=darwin-universal (lipo)`,
  `prepared_at_utc=${new Date().toISOString()}`,
].join('\n');
writeFileSync(path.join(bundleRoot, 'BUNDLED_TUNNEL_CLIENT.txt'), manifest + '\n', 'utf8');

const clientHash = sha256(path.join(bundleRoot, 'tunnel-client'));
process.stdout.write(`Bundled tunnel-client v${version} darwin-universal -> ${path.join(bundleRoot, 'tunnel-client')}\n`);
process.stdout.write(`Universal executable SHA-256: ${clientHash}\n`);
