import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(desktopRoot, '../..');
const stageDirectory = path.join(desktopRoot, 'build/update-worker');
const generatedPath = path.join(desktopRoot, 'src/main/update-worker-integrity.generated.ts');
const buildId = 'lnwjud-update-worker-bootstrap-v1';
const execute = promisify(execFile);

export async function prepareUpdateWorker() {
  if (process.platform !== 'win32') return { platform: process.platform, available: false };
  if (process.arch !== 'x64') throw new Error('Update worker preparation requires Windows x64');
  const sourceDirectory = path.join(repositoryRoot, 'native/update-worker');
  const outputDirectory = path.join(sourceDirectory, 'artifacts/win-x64');
  await execute('dotnet', ['publish', path.join(sourceDirectory, 'WindowsUpdateWorker.csproj'), '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', outputDirectory, '--disable-build-servers', '-p:UseSharedCompilation=false'], {
    windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, DOTNET_CLI_USE_MSBUILD_SERVER: '0', MSBUILDDISABLENODEREUSE: '1' },
  });
  const filename = 'lnwjud-update-worker.exe';
  const source = path.join(outputDirectory, filename);
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(source) !== source) {
    throw new Error('Update worker publish output is not an ordinary canonical file');
  }
  const sha256 = createHash('sha256').update(await readFile(source)).digest('hex');
  const pinSource = await readFile(path.join(repositoryRoot, 'packages/capabilities/src/containment-integrity.generated.ts'), 'utf8');
  const pinMatches = [...pinSource.matchAll(/CONTAINMENT_PIN_SHA256\s*=\s*'([a-f0-9]{64})'/g)];
  if (pinMatches.length !== 1 || /^0+$/.test(pinMatches[0][1])) throw new Error('Canonical native pin trust is unavailable');
  const pinSha256 = pinMatches[0][1];
  const pinPath = path.join(desktopRoot, 'build/native-containment/lnwjud-containment-pin.node');
  const pinInfo = await lstat(pinPath);
  if (!pinInfo.isFile() || pinInfo.isSymbolicLink() || pinInfo.nlink !== 1 || await realpath(pinPath) !== pinPath
    || createHash('sha256').update(await readFile(pinPath)).digest('hex') !== pinSha256) {
    throw new Error('Canonical native pin bytes differ from compiled trust');
  }
  await mkdir(stageDirectory, { recursive: true });
  await copyFile(source, path.join(stageDirectory, filename));
  await writeFile(path.join(stageDirectory, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, buildId, protocol: 1, platform: 'win32', architecture: 'x64', filename, sha256,
    pinFilename: 'lnwjud-containment-pin.node', pinSha256,
    installationEffects: false,
  }) + '\n');
  await writeFile(generatedPath, [
    `export const UPDATE_WORKER_SHA256 = '${sha256}' as const;`,
    `export const UPDATE_WORKER_PIN_SHA256 = '${pinSha256}' as const;`,
    `export const UPDATE_WORKER_BUILD_ID = '${buildId}' as const;`,
    'export const UPDATE_WORKER_PROTOCOL = 1 as const;',
    '',
  ].join('\n'));
  return { filename, sha256, buildId, protocol: 1, installationEffects: false };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(await prepareUpdateWorker()) + '\n');
}
