/* global process */

import { spawn } from 'node:child_process';

const target = process.argv[2];
if (target !== 'macos' && target !== 'linux') throw new Error('Usage: node scripts/package-native.mjs <macos|linux>');
if ((target === 'macos' && process.platform !== 'darwin') || (target === 'linux' && process.platform !== 'linux')) {
  throw new Error(`The ${target} package must be built on its target operating system`);
}

const architecture = process.env.LNWJUD_RUNTIME_ARCH ?? process.arch;
if (architecture !== 'x64' && architecture !== 'arm64') throw new Error(`Unsupported ${target} architecture: ${architecture}`);
const environment = {
  ...process.env,
  LNWJUD_RUNTIME_TARGET: target === 'macos' ? 'darwin' : 'linux',
  LNWJUD_RUNTIME_ARCH: architecture,
};
const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';

await run('node', ['scripts/prepare-runtime-tools.mjs'], environment);
await run('node', [target === 'macos' ? 'scripts/build-macos-host.mjs' : 'scripts/build-linux-host.mjs'], environment);
await run(corepack, ['pnpm@10.15.0', 'build'], environment);
await run('electron-builder', [target === 'macos' ? '--mac' : '--linux', ...(target === 'macos' ? ['dmg', 'zip'] : ['AppImage', 'deb']), `--${architecture}`, '--publish', 'never'], environment);
await run('node', ['scripts/write-release-evidence.mjs'], environment);
await run('node', ['scripts/verify-release-evidence.mjs'], environment);

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env, shell: false, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? 'unknown'}`)));
  });
}
