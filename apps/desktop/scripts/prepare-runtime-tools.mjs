/* global AbortSignal, Buffer, clearTimeout, fetch, process, setTimeout */

import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const extractZip = require('@electron-internal/extract-zip');

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDependencies = JSON.parse(await readFile(path.join(desktopRoot, 'src', 'main', 'runtime-dependencies.json'), 'utf8'));
const ripgrepDependency = runtimeDependencies?.ripgrep;
if (runtimeDependencies?.schemaVersion !== 1 || typeof ripgrepDependency?.version !== 'string' || ripgrepDependency.version.length === 0) {
  throw new Error('Bundled ripgrep dependency manifest is invalid');
}
const RIPGREP_VERSION = ripgrepDependency.version;
const RIPGREP_RELEASE_BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}`;
const buildRoot = path.join(desktopRoot, 'build');
const vendorRoot = path.join(buildRoot, 'vendor', `runtime-tools-v${RIPGREP_VERSION}`);

// Exact release archives are declared in one manifest. Linux intentionally
// uses static musl builds. No platform or architecture fallback is allowed.
const platform = process.env.LNWJUD_RUNTIME_TARGET ?? process.platform;
const rawArch = process.env.LNWJUD_RUNTIME_ARCH ?? process.arch;
const targetKey = `${platform}-${rawArch}`;
const ripgrep = ripgrepDependency.targets?.[targetKey];
if (ripgrep === undefined) throw new Error(`Runtime tools do not support ${platform}/${rawArch}`);
if (!['win32', 'darwin', 'linux'].includes(platform)
  || !['x64', 'arm64'].includes(rawArch)
  || typeof ripgrep.archive !== 'string'
  || typeof ripgrep.executable !== 'string'
  || !['zip', 'tar.gz'].includes(ripgrep.kind)
  || typeof ripgrep.targetTriple !== 'string'
  || !/^[0-9a-f]{64}$/iu.test(ripgrep.sha256 ?? '')) {
  throw new Error(`Bundled ripgrep target declaration is invalid for ${targetKey}`);
}
const target = { name: platform === 'win32' ? 'windows' : platform };

await stageRipgrep({ platform, rawArch, target, ripgrep });
await runTunnelStager(platform, rawArch);
process.stdout.write(`Prepared target-native runtime tools for ${platform}/${rawArch}\n`);

async function stageRipgrep({ platform, rawArch, target, ripgrep }) {
  const archivePath = path.join(vendorRoot, ripgrep.archive);
  const extractRoot = path.join(vendorRoot, `${target.name}-${rawArch}-ripgrep`);
  const bundleRoot = path.join(buildRoot, 'runtime-tools', 'ripgrep');
  await mkdir(vendorRoot, { recursive: true });
  await assertCanonicalDirectory(vendorRoot);
  await downloadIfNeeded(`${RIPGREP_RELEASE_BASE}/${ripgrep.archive}`, archivePath, ripgrep.sha256, 'ripgrep');
  await rm(extractRoot, { recursive: true, force: true });
  await mkdir(extractRoot, { recursive: true });
  await assertCanonicalDirectory(extractRoot);
  if (ripgrep.kind === 'zip') await extractZip.extract(archivePath, { dir: path.resolve(extractRoot) });
  else await extractTarGz(archivePath, extractRoot);

  const executable = await findUniqueFile(extractRoot, ripgrep.executable);
  const metadata = await stat(executable);
  if (!metadata.isFile()) throw new Error(`Official ripgrep executable is not a regular file: ${ripgrep.executable}`);
  await rm(bundleRoot, { recursive: true, force: true });
  await mkdir(bundleRoot, { recursive: true });
  await assertCanonicalDirectory(bundleRoot);
  const destination = path.join(bundleRoot, ripgrep.executable);
  await copyFile(executable, destination);
  if (platform !== 'win32') await chmod(destination, 0o755);
  await verifyExecutableVersion(destination, 'ripgrep', RIPGREP_VERSION);

  for (const notice of await findNotices(extractRoot)) {
    const destinationNotice = path.join(bundleRoot, path.basename(notice));
    await copyFile(notice, destinationNotice);
  }
  const executableSha256 = await sha256(destination);
  const manifest = {
    schemaVersion: 1,
    product: 'lnwjud',
    tool: 'ripgrep',
    version: RIPGREP_VERSION,
    platform,
    arch: rawArch,
    target: ripgrep.targetTriple,
    asset: ripgrep.archive,
    source: `${RIPGREP_RELEASE_BASE}/${ripgrep.archive}`,
    assetSha256: ripgrep.sha256,
    executable: ripgrep.executable,
    executableSha256,
    verified: { archiveSha256: true, executableVersion: true, executableBit: platform !== 'win32' },
  };
  await writeAtomic(path.join(bundleRoot, 'BUNDLED_RIPGREP.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeAtomic(path.join(bundleRoot, 'BUNDLED_RIPGREP.txt'), [
    'ripgrep bundled by lnwjud',
    `version=${RIPGREP_VERSION}`,
    `asset=${ripgrep.archive}`,
    `source=${RIPGREP_RELEASE_BASE}/${ripgrep.archive}`,
    `asset_sha256=${ripgrep.sha256}`,
    `executable_sha256=${executableSha256}`,
  ].join('\n') + '\n');
}

async function runTunnelStager(platform, rawArch) {
  const scriptPath = path.join(desktopRoot, 'scripts', 'prepare-tunnel-client.mjs');
  await runProcess(process.execPath, [scriptPath], sanitizedEnvironment({
    ...process.env,
    LNWJUD_TUNNEL_TARGET: platform,
    LNWJUD_TUNNEL_ARCH: rawArch,
  }));
}

async function extractTarGz(archivePath, destination) {
  await runProcess('tar', ['-xzf', archivePath, '-C', destination], sanitizedEnvironment());
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
  if (matches.length !== 1) throw new Error(`Expected exactly one ${name} in official ripgrep archive; found ${matches.length}`);
  return matches[0];
}

async function findNotices(root) {
  const matches = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && /^(?:copying|license|unlicense|notice)(?:\.|$)/i.test(entry.name)) matches.push(absolute);
    }
  }
  await visit(root);
  return matches;
}

async function downloadIfNeeded(url, destination, expectedSha256, label) {
  try {
    await assertCanonicalFile(destination);
    if ((await sha256(destination)) === expectedSha256) return;
  } catch {
    // Missing or invalid cache entries are downloaded below.
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Could not download official ${label} asset (${response.status})`);
  await writeAtomic(destination, Buffer.from(await response.arrayBuffer()));
  await assertCanonicalFile(destination);
  const actual = await sha256(destination);
  if (actual !== expectedSha256) throw new Error(`${label} asset SHA-256 mismatch for ${path.basename(destination)}`);
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

async function sha256(filePath) {
  await assertCanonicalFile(filePath);
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

function runProcess(command, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { if (stderr.length < 2_048) stderr += chunk.toString('utf8').slice(0, 2_048 - stderr.length); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed (${code ?? 'unknown'}): ${stderr.trim()}`)));
  });
}

function verifyExecutableVersion(executable, label, expectedVersion) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--version'], { env: sanitizedEnvironment(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk) => { if (output.length < 512) output += chunk.toString('utf8').slice(0, 512 - output.length); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Official ${label} --version timed out`));
    }, 10_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      const escapedVersion = expectedVersion.replaceAll('.', '\\.');
      const exactVersion = new RegExp(`(?:^|[^0-9])v?${escapedVersion}(?:$|[^0-9])`).test(output);
      if (code !== 0 || !exactVersion) reject(new Error(`Official ${label} --version does not match ${expectedVersion}`));
      else resolve();
    });
  });
}

function sanitizedEnvironment(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([key]) => !/(?:^|[_-])(?:api[_-]?key|token|password|secret)(?:$|[_-])/iu.test(key)));
}
