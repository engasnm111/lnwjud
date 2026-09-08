import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  process.stdout.write('Skipping macOS native host build on a non-macOS host.\n');
  process.exit(0);
}

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeRoot = path.resolve(desktopRoot, '..', '..', 'native', 'macos-host');
const arch = process.env.LNWJUD_RUNTIME_ARCH ?? process.arch;
if (arch !== 'x64' && arch !== 'arm64') throw new Error(`Unsupported macOS native host architecture: ${arch}`);
execFileSync('swift', ['test', '--package-path', nativeRoot], { stdio: 'inherit' });
const swiftArch = arch === 'x64' ? 'x86_64' : 'arm64';
const buildArgs = ['build', '-c', 'release', '--package-path', nativeRoot, '--arch', swiftArch];
execFileSync('swift', buildArgs, { stdio: 'inherit' });
const binaryDirectory = execFileSync('swift', [...buildArgs, '--show-bin-path'], { encoding: 'utf8' }).trim();
const binary = path.join(binaryDirectory, 'lnwjud-macos-host');
if (!existsSync(binary)) throw new Error(`Swift did not produce the macOS native host for ${arch}`);
const output = path.join(desktopRoot, 'build', 'native-host', 'macos', arch);
mkdirSync(output, { recursive: true });
const staged = path.join(output, 'lnwjud-macos-host');
copyFileSync(binary, staged);
chmodSync(staged, 0o755);
const bytes = readFileSync(staged);
const manifest = { schemaVersion: 1, name: 'lnwjud-macos-host', platform: 'darwin', arch, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength, verified: true };
writeFileSync(path.join(output, 'NATIVE_HOST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
writeFileSync(path.join(output, 'LICENSE'), readFileSync(path.join(nativeRoot, 'README.md'), 'utf8'), 'utf8');
process.stdout.write(`Staged macOS native host for ${arch}: ${staged}\n`);
