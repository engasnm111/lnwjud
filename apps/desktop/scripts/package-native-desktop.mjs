import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageTarget = process.argv[2];

const targetMatrix = {
  macos: [
    { platform: 'darwin', arch: 'arm64', builderArgs: ['--mac', 'dmg', 'zip', '--arm64'] },
    { platform: 'darwin', arch: 'x64', builderArgs: ['--mac', 'dmg', 'zip', '--x64'] },
  ],
  linux: [
    { platform: 'linux', arch: 'x64', builderArgs: ['--linux', 'AppImage', 'deb', '--x64'] },
  ],
};

const targets = targetMatrix[packageTarget];
if (targets === undefined) {
  throw new Error(`Usage: node scripts/package-native-desktop.mjs <macos|linux>; received ${packageTarget ?? 'nothing'}`);
}

runCorepack(['pnpm@10.15.0', 'build']);

for (const target of targets) {
  const targetEnvironment = {
    ...process.env,
    LNWJUD_PACKAGE_TARGET_PLATFORM: target.platform,
    LNWJUD_PACKAGE_TARGET_ARCH: target.arch,
  };
  process.stdout.write(`Preparing native runtime assets for ${target.platform}-${target.arch}\n`);
  runCorepack(['pnpm@10.15.0', 'prepare:runtime-assets'], targetEnvironment);
  process.stdout.write(`Packaging lnwjud for ${target.platform}-${target.arch}\n`);
  runCorepack([
    'pnpm@10.15.0',
    'exec',
    'electron-builder',
    '--config',
    'electron-builder.yml',
    ...target.builderArgs,
    '--publish',
    'never',
  ], targetEnvironment);
}

function runCorepack(args, environment = process.env) {
  const executable = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
  const result = spawnSync(executable, args, {
    cwd: desktopRoot,
    env: environment,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(' ')} failed with exit code ${String(result.status)}`);
  }
}
