import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);

export async function prepareWindowsUpdateLauncher() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows update launcher requires a native Windows x64 build host');
  const sourceRoot = path.resolve(desktopRoot, '../../native/windows-update-launcher');
  const output = path.join(sourceRoot, 'artifacts/win-x64');
  await execute('dotnet', ['publish', path.join(sourceRoot, 'WindowsUpdateLauncher.csproj'), '-c', 'Release', '-r', 'win-x64',
    '--self-contained', 'true', '-o', output, '--disable-build-servers', '-p:UseSharedCompilation=false'], {
    windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, DOTNET_CLI_USE_MSBUILD_SERVER: '0', MSBUILDDISABLENODEREUSE: '1' },
  });
  const source = path.join(output, 'lnwjud-update-launcher.exe');
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(source) !== source) throw new Error('Windows update launcher output is not an ordinary canonical file');
  const destination = path.join(desktopRoot, 'build/update-launcher');
  await mkdir(destination, { recursive: true });
  await copyFile(source, path.join(destination, 'lnwjud.exe'));
}

export default async function beforePack(context) {
  if (context?.electronPlatformName !== 'win32') return;
  if (context.arch !== 1 && context.arch !== 'x64') throw new Error('Windows slot-aware package requires x64');
  await prepareWindowsUpdateLauncher();
}
