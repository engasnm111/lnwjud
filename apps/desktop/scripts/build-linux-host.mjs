import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') {
  process.stdout.write('Skipping Linux native host build on a non-Linux host.\n');
  process.exit(0);
}

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeRoot = path.resolve(desktopRoot, '..', '..', 'native', 'linux-host');
const arch = process.env.LNWJUD_RUNTIME_ARCH ?? process.arch;
if (arch !== 'x64' && arch !== 'arm64') throw new Error(`Unsupported Linux native host architecture: ${arch}`);
// Resolve the output path from the requested artifact architecture, not the
// host Node architecture. This keeps an explicit x64 cross-build from
// accidentally writing an arm64 host binary (and vice versa).
const targetTriple = arch === process.arch
  ? undefined
  : arch === 'arm64'
    ? 'aarch64-unknown-linux-gnu'
    : 'x86_64-unknown-linux-gnu';
const cargoManifest = path.join(nativeRoot, 'Cargo.toml');
const cargoTargetArgs = targetTriple === undefined ? [] : ['--target', targetTriple];
execFileSync('cargo', ['test', '--manifest-path', cargoManifest, '--locked', ...cargoTargetArgs], { stdio: 'inherit' });
execFileSync('cargo', ['build', '--release', '--manifest-path', cargoManifest, '--locked', ...cargoTargetArgs], { stdio: 'inherit' });
const binary = path.join(nativeRoot, 'target', ...(targetTriple === undefined ? [] : [targetTriple]), 'release', 'lnwjud-linux-host');
if (!existsSync(binary)) throw new Error(`Cargo did not produce the Linux native host for ${arch}`);
const output = path.join(desktopRoot, 'build', 'native-host', 'linux', arch);
mkdirSync(output, { recursive: true });
const staged = path.join(output, 'lnwjud-linux-host');
copyFileSync(binary, staged);
chmodSync(staged, 0o755);
const bytes = readFileSync(staged);
const manifest = { schemaVersion: 1, name: 'lnwjud-linux-host', platform: 'linux', arch, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength, verified: true };
writeFileSync(path.join(output, 'NATIVE_HOST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
writeFileSync(path.join(output, 'LICENSE'), readFileSync(path.join(nativeRoot, 'README.md'), 'utf8'), 'utf8');
process.stdout.write(`Staged Linux native host for ${arch}: ${staged}\n`);
