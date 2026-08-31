import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Downloads the official BurntSushi/ripgrep releases for both macOS
// architectures, verifies the pinned SHA-256 of each archive, and merges the
// two rg binaries into one universal (fat) binary staged at
// build/runtime-tools/ripgrep/rg so packaged DMG/ZIP bundles of either arch
// carry their own native search runtime. Mirrors prepare-ripgrep.ps1 (Windows).
const version = '15.2.0';
const ASSETS = {
  arm64: {
    assetName: `ripgrep-${version}-aarch64-apple-darwin.tar.gz`,
    expectedSha256: '3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4',
  },
  x64: {
    assetName: `ripgrep-${version}-x86_64-apple-darwin.tar.gz`,
    expectedSha256: 'af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1',
  },
};

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = path.join(desktopRoot, 'build');
const vendorRoot = path.join(buildRoot, 'vendor');
const bundleRoot = path.join(buildRoot, 'runtime-tools', 'ripgrep');

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
    process.stdout.write(`Downloading official ripgrep v${version} for darwin-${arch}...\n`);
    const downloaded = spawnSync('curl', ['-fsSL', `https://github.com/BurntSushi/ripgrep/releases/download/${version}/${asset.assetName}`, '-o', archivePath]);
    if (downloaded.status !== 0) throw new Error(`ripgrep download failed (curl exited ${downloaded.status})`);
  }
  const actualSha = sha256(archivePath);
  if (actualSha !== asset.expectedSha256) {
    throw new Error(`ripgrep SHA-256 mismatch. expected=${asset.expectedSha256} actual=${actualSha}`);
  }

  const extractRoot = path.join(vendorRoot, `ripgrep-${version}-darwin-${arch}`);
  rmSync(extractRoot, { recursive: true, force: true });
  mkdirSync(extractRoot, { recursive: true });
  const extracted = spawnSync('tar', ['-xzf', archivePath, '-C', extractRoot], { stdio: 'ignore' });
  if (extracted.status !== 0) throw new Error(`ripgrep archive could not be extracted (tar exited ${extracted.status})`);
  const binaries = walk(extractRoot).filter((file) => path.basename(file) === 'rg' && statSync(file).isFile());
  if (binaries.length !== 1) throw new Error(`Expected exactly one rg binary in ${asset.assetName}, found ${binaries.length}`);
  return copyToVendor(binaries[0], arch);
}

function copyToVendor(source, arch) {
  const staged = path.join(vendorRoot, `rg-${version}-darwin-${arch}`);
  copyFileSync(source, staged);
  return staged;
}

const arm64Binary = await stageArchive('arm64');
const x64Binary = await stageArchive('x64');

// Start clean so a prior Windows build on this checkout can never leak a
// stale rg.exe into the macOS bundle that electron-builder copies from here.
rmSync(bundleRoot, { recursive: true, force: true });
mkdirSync(bundleRoot, { recursive: true });
const universal = path.join(bundleRoot, 'rg');
const merged = spawnSync('lipo', ['-create', arm64Binary, x64Binary, '-output', universal]);
if (merged.status !== 0) throw new Error(`lipo could not merge ripgrep architectures (exited ${merged.status})`);
chmodSync(universal, 0o755);

const inspected = spawnSync('lipo', ['-archs', universal], { encoding: 'utf8' });
const architectures = (inspected.stdout ?? '').trim();
if (!architectures.includes('x86_64') || !architectures.includes('arm64')) {
  throw new Error(`Universal ripgrep is missing an architecture: ${architectures || 'unknown'}`);
}

writeFileSync(
  path.join(bundleRoot, 'BUNDLED_RIPGREP.txt'),
  `ripgrep ${version} darwin-universal (${architectures})\narm64 sha256=${ASSETS.arm64.expectedSha256}\nx64 sha256=${ASSETS.x64.expectedSha256}\n`,
  'utf8',
);

process.stdout.write(`Bundled ripgrep ${version} darwin-universal (${architectures}) -> ${universal}\n`);
