import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, opendir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { readBoundedFile } from './verify-build-evidence.mjs';

const maximumSlotBytes = 4n * 1024n * 1024n * 1024n;
const maximumManifestBytes = 8n * 1024n * 1024n;
const maximumFiles = 16_384;
const layoutName = 'INSTALL-LAYOUT.json';
const manifestPath = 'slots/A/manifest.json';

function refuse() { throw new Error('INSTALLED_LAYOUT_REFUSED'); }
function bytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function identity(name, value) { return { name, sizeBytes: String(value.length), sha256: digest(value) }; }

function ordinaryComponent(value) {
  const stem = value.split('.')[0].replace(/[ .]+$/u, '').toUpperCase();
  // ASCII keeps Windows and JavaScript case-collision checks identical.
  return value.length <= 128 && /^[\x20-\x7e]+$/u.test(value) && !/[. ]$/u.test(value)
    && !/[\\:*?"<>|]/u.test(value)
    && !/^(?:CON|NUL|AUX|PRN|CONIN\$|CONOUT\$|(?:COM|LPT)[0-9])$/u.test(stem);
}

async function ordinaryDirectory(directory) {
  if (!path.isAbsolute(directory) || await realpath(directory) !== directory) refuse();
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) refuse();
}

function inspectWindowsAttributes(root, outputDirectory) {
  if (process.platform !== 'win32') return;
  const command = [
    "$ErrorActionPreference = 'Stop'",
    'foreach ($directory in @($env:LNWJUD_LAYOUT_ATTRIBUTE_ROOT, $env:LNWJUD_LAYOUT_ATTRIBUTE_OUTPUT)) {',
    '  $current = Get-Item -Force -LiteralPath $directory',
    '  while ($null -ne $current) {',
    '    if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "INSTALLED_LAYOUT_REPARSE_POINT" }',
    '    $current = $current.Parent',
    '  }',
    '}',
    '$pending = [Collections.Generic.Stack[string]]::new()',
    '$pending.Push($env:LNWJUD_LAYOUT_ATTRIBUTE_ROOT)',
    '$layout = Join-Path $env:LNWJUD_LAYOUT_ATTRIBUTE_OUTPUT "INSTALL-LAYOUT.json"',
    'if (Test-Path -LiteralPath $layout) { $pending.Push($layout) }',
    '$count = 0',
    'while ($pending.Count -gt 0) {',
    '  $entry = Get-Item -Force -LiteralPath $pending.Pop()',
    '  if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "INSTALLED_LAYOUT_REPARSE_POINT" }',
    '  if (++$count -gt 1966080) { throw "INSTALLED_LAYOUT_ENTRY_LIMIT" }',
    '  if ($entry.PSIsContainer) {',
    '    foreach ($child in Get-ChildItem -Force -LiteralPath $entry.FullName) { $pending.Push($child.FullName) }',
    '  }',
    '}',
  ].join('\n');
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, timeout: 60_000, maxBuffer: 4096,
    env: { ...process.env, LNWJUD_LAYOUT_ATTRIBUTE_ROOT: root, LNWJUD_LAYOUT_ATTRIBUTE_OUTPUT: outputDirectory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function inspectInstalledLayout(rootDirectory, outputDirectory, platform, architecture) {
  if (platform !== 'win32' || architecture !== 'x64') refuse();
  await ordinaryDirectory(rootDirectory);
  await ordinaryDirectory(outputDirectory);
  const relativeOutput = path.relative(rootDirectory, outputDirectory);
  if (!relativeOutput || relativeOutput !== '..' && !relativeOutput.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeOutput)) refuse();
  inspectWindowsAttributes(rootDirectory, outputDirectory);
  const slot = path.join(rootDirectory, 'slots', 'A');
  await ordinaryDirectory(slot);
  const files = [], names = new Set();
  let total = 0n;
  async function visit(directory, prefix = '') {
    for await (const entry of await opendir(directory)) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!ordinaryComponent(entry.name) || relative.length > 240 || names.has(relative.toUpperCase()) || names.size >= maximumFiles * 120) refuse();
      names.add(relative.toUpperCase());
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || await realpath(absolute) !== absolute) refuse();
      if (info.isDirectory()) await visit(absolute, relative);
      else if (info.isFile()) {
        if (relative === 'manifest.json') {
          await readBoundedFile(absolute, maximumManifestBytes);
          continue;
        }
        if (relative.toUpperCase() === 'MANIFEST.JSON' || files.length === maximumFiles) refuse();
        const file = await readBoundedFile(absolute, maximumSlotBytes - total);
        total += BigInt(file.sizeBytes);
        files.push({ path: relative, sizeBytes: file.sizeBytes, sha256: file.sha256 });
      } else refuse();
    }
  }
  await visit(slot);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const application = files.find(file => file.path === 'lnwjud.exe');
  if (!application || application.sizeBytes === '0') refuse();
  const manifest = bytes({ schemaVersion: 1, files });
  if (BigInt(manifest.length) > maximumManifestBytes) refuse();
  async function role(relative) {
    const file = await readBoundedFile(path.join(rootDirectory, ...relative.split('/')), maximumSlotBytes);
    if (file.sizeBytes === '0') refuse();
    return { path: relative, sizeBytes: file.sizeBytes, sha256: file.sha256 };
  }
  const layout = bytes({
    schemaVersion: 1, product: 'lnwjud', platform, architecture, slot: 'A',
    roles: {
      stableLauncher: await role('lnwjud.exe'),
      stableService: await role('resources/native-containment/lnwjud-containment.exe'),
      slotApplication: { ...application, path: 'slots/A/lnwjud.exe' },
      slotManifest: { path: manifestPath, sizeBytes: String(manifest.length), sha256: digest(manifest) },
    },
  });
  if (layout.length > 65_536) refuse();
  inspectWindowsAttributes(rootDirectory, outputDirectory);
  return { manifest, layout, installedLayout: identity(layoutName, layout) };
}

async function publishIdentical(filename, content) {
  try { await writeFile(filename, content, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const actual = await readBoundedFile(filename, BigInt(content.length));
  if (actual.sizeBytes !== String(content.length) || actual.sha256 !== digest(content)) refuse();
}

export async function prepareInstalledLayout({ rootDirectory, outputDirectory, platform = 'win32', architecture = 'x64' }) {
  const prepared = await inspectInstalledLayout(rootDirectory, outputDirectory, platform, architecture);
  await publishIdentical(path.join(rootDirectory, ...manifestPath.split('/')), prepared.manifest);
  await publishIdentical(path.join(outputDirectory, layoutName), prepared.layout);
  return prepared.installedLayout;
}

export async function verifyPreparedInstalledLayout({ rootDirectory, outputDirectory, platform, architecture }) {
  const prepared = await inspectInstalledLayout(rootDirectory, outputDirectory, platform, architecture);
  const manifest = await readBoundedFile(path.join(rootDirectory, ...manifestPath.split('/')), maximumManifestBytes);
  if (manifest.sha256 !== digest(prepared.manifest) || manifest.sizeBytes !== String(prepared.manifest.length)) refuse();
  await verifyInstalledLayoutAsset(outputDirectory, prepared.installedLayout);
  return prepared.installedLayout;
}

export async function verifyInstalledLayoutAsset(outputDirectory, expected) {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)
    || Object.keys(expected).sort().join(',') !== 'name,sha256,sizeBytes' || expected.name !== layoutName
    || typeof expected.sizeBytes !== 'string' || !/^[1-9][0-9]{0,4}$/u.test(expected.sizeBytes)
    || BigInt(expected.sizeBytes) > 65_536n || typeof expected.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(expected.sha256)) refuse();
  const actual = await readBoundedFile(path.join(outputDirectory, layoutName), 65_536n);
  if (actual.sizeBytes !== expected.sizeBytes || actual.sha256 !== expected.sha256) refuse();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('Usage: node prepare-installed-layout.mjs <A/B-staging-root> <release-output-directory>');
  const result = await prepareInstalledLayout({ rootDirectory: process.argv[2], outputDirectory: process.argv[3] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
