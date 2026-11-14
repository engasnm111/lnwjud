/* global process, URL */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { prepareInstalledLayout, verifyPreparedInstalledLayout } from '../../../scripts/update-trust/prepare-installed-layout.mjs';
import { readBoundedFile } from '../../../scripts/update-trust/verify-build-evidence.mjs';

const execute = promisify(execFile);
const maximumPayloadBytes = 2_147_483_648;
const stableLauncherName = 'lnwjud-update-launcher.exe';

function refuse() { throw new Error('WINDOWS_UPDATE_LAYOUT_REFUSED'); }

async function ordinary(filename, directory = false) {
  const info = await lstat(filename);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
    || await realpath(filename) !== path.resolve(filename)) refuse();
  return info;
}

async function exists(filename) {
  try { await lstat(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function hasWindowsSlotLayout(rootDirectory) {
  if (!await exists(path.join(rootDirectory, 'slots'))) return false;
  await ordinary(path.join(rootDirectory, 'slots'), true);
  await ordinary(path.join(rootDirectory, 'slots/A'), true);
  await ordinary(path.join(rootDirectory, 'slots/A/lnwjud.exe'));
  await ordinary(path.join(rootDirectory, 'lnwjud.exe'));
  await ordinary(path.join(rootDirectory, 'resources/native-containment/lnwjud-containment.exe'));
  return true;
}

export function windowsRuntimePath(relativePath) {
  if (relativePath === 'lnwjud-mcp-stdio.cmd' || relativePath.startsWith('resources/native-containment/')
    || relativePath.startsWith('resources/update-worker/')) return relativePath;
  return `slots/A/${relativePath}`;
}

export async function materializeWindowsSlotLayout(rootDirectory) {
  rootDirectory = path.resolve(rootDirectory);
  await ordinary(rootDirectory, true);
  if (await hasWindowsSlotLayout(rootDirectory)) {
    if (await exists(path.join(rootDirectory, stableLauncherName))) refuse();
    return;
  }
  await ordinary(path.join(rootDirectory, stableLauncherName));
  await ordinary(path.join(rootDirectory, 'lnwjud.exe'));
  await ordinary(path.join(rootDirectory, 'resources/native-containment'), true);
  await ordinary(path.join(rootDirectory, 'resources/update-worker'), true);
  let count = 0;
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 1_966_080) refuse();
      const filename = path.join(directory, entry.name);
      await ordinary(filename, entry.isDirectory());
      if (entry.isDirectory()) await inspect(filename);
    }
  }
  await inspect(rootDirectory);
  const entries = await readdir(rootDirectory);
  const slot = path.join(rootDirectory, 'slots/A');
  await mkdir(slot, { recursive: true });
  for (const name of entries) {
    if (name === stableLauncherName || name === 'lnwjud-mcp-stdio.cmd') continue;
    await rename(path.join(rootDirectory, name), path.join(slot, name));
  }
  await mkdir(path.join(rootDirectory, 'resources'));
  for (const name of ['native-containment', 'update-worker']) {
    await cp(path.join(slot, 'resources', name), path.join(rootDirectory, 'resources', name), {
      recursive: true, dereference: false, force: false, errorOnExist: true,
    });
  }
  await rename(path.join(rootDirectory, stableLauncherName), path.join(rootDirectory, 'lnwjud.exe'));
}

async function fileHash(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyArchive(filename, manifestBytes, manifest) {
  const { Open } = await import('unzipper');
  const expected = new Map(manifest.files.map(file => [file.path, file]));
  expected.set('manifest.json', { sizeBytes: String(manifestBytes.length), sha256: createHash('sha256').update(manifestBytes).digest('hex') });
  const archive = await Open.file(filename);
  if (archive.files.length !== expected.size) refuse();
  for (const entry of archive.files) {
    const identity = expected.get(entry.path);
    if (!identity || entry.type !== 'File') refuse();
    expected.delete(entry.path);
    let bytes = 0n;
    const hash = createHash('sha256');
    const stream = entry.stream();
    for await (const chunk of stream) {
      bytes += BigInt(chunk.length);
      if (bytes > BigInt(identity.sizeBytes)) { stream.destroy(); refuse(); }
      hash.update(chunk);
    }
    if (String(bytes) !== identity.sizeBytes || hash.digest('hex') !== identity.sha256) refuse();
  }
  if (expected.size !== 0) refuse();
}

async function writePayload(rootDirectory, outputDirectory, version, installedLayout) {
  if (process.platform !== 'win32') throw new Error('Windows update payload creation requires a native Windows build host');
  const layout = await readBoundedFile(path.join(outputDirectory, 'INSTALL-LAYOUT.json'), 65_536n);
  if (layout.sha256 !== installedLayout.sha256) refuse();
  const slot = path.join(rootDirectory, 'slots/A');
  const manifest = await readBoundedFile(path.join(slot, 'manifest.json'), 8n * 1024n * 1024n);
  if (manifest.sha256 !== JSON.parse(layout.bytes).roles.slotManifest.sha256) refuse();
  const name = `lnwjud-Update-${version}-win32-x64.zip`;
  const temporary = path.join(outputDirectory, `.${name}.${randomUUID()}.tmp`);
  try {
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    await execute(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./write-update-payload.ps1', import.meta.url)),
      '-SlotDirectory', slot, '-OutputPath', temporary], { windowsHide: true, timeout: 600_000, maxBuffer: 4096 });
    await ordinary(temporary);
    const info = await lstat(temporary);
    if (info.size < 1 || info.size > maximumPayloadBytes) refuse();
    await verifyArchive(temporary, manifest.bytes, JSON.parse(manifest.bytes));
    const sha256 = await fileHash(temporary);
    const destination = path.join(outputDirectory, name);
    if (await exists(destination)) await ordinary(destination);
    await rename(temporary, destination);
    return { name, sizeBytes: String(info.size), sha256 };
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function prepareWindowsUpdateLayout({ rootDirectory, outputDirectory, version }) {
  if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(version)) refuse();
  rootDirectory = path.resolve(rootDirectory);
  outputDirectory = path.resolve(outputDirectory);
  await ordinary(outputDirectory, true);
  const relativeOutput = path.relative(rootDirectory, outputDirectory);
  if (!relativeOutput || !path.isAbsolute(relativeOutput) && relativeOutput !== '..' && !relativeOutput.startsWith(`..${path.sep}`)) refuse();
  await materializeWindowsSlotLayout(rootDirectory);
  const temporary = await mkdtemp(path.join(outputDirectory, '.windows-layout-'));
  try {
    const installedLayout = await prepareInstalledLayout({ rootDirectory, outputDirectory: temporary });
    const destination = path.join(outputDirectory, 'INSTALL-LAYOUT.json');
    if (await exists(destination)) await ordinary(destination);
    await copyFile(path.join(temporary, 'INSTALL-LAYOUT.json'), destination);
    const updatePayload = await writePayload(rootDirectory, outputDirectory, version, installedLayout);
    await verifyPreparedInstalledLayout({ rootDirectory, outputDirectory, platform: 'win32', architecture: 'x64' });
    return { installedLayout, updatePayload };
  } finally {
    if (path.dirname(temporary) !== outputDirectory || !path.basename(temporary).startsWith('.windows-layout-')) refuse();
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyWindowsUpdatePayloadAsset(outputDirectory, identity, version) {
  if (!identity || Object.keys(identity).sort().join(',') !== 'name,sha256,sizeBytes'
    || identity.name !== `lnwjud-Update-${version}-win32-x64.zip` || !/^[1-9][0-9]{0,9}$/.test(identity.sizeBytes)
    || BigInt(identity.sizeBytes) > BigInt(maximumPayloadBytes) || !/^[a-f0-9]{64}$/.test(identity.sha256)) refuse();
  const filename = path.join(outputDirectory, identity.name);
  const info = await ordinary(filename);
  if (String(info.size) !== identity.sizeBytes || await fileHash(filename) !== identity.sha256) refuse();
}
