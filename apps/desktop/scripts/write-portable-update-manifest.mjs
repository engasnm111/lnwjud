import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, '..');
const packageJson = JSON.parse(await readFile(path.join(desktopDirectory, 'package.json'), 'utf8'));
const version = String(packageJson.version ?? '').trim();
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid desktop package version: ${version}`);

const installerDirectory = path.join(desktopDirectory, 'dist', 'installers');
const fileName = `lnwjud-Portable-${version}.exe`;
const artifactPath = path.join(installerDirectory, fileName);
const metadata = await assertRegularCanonicalFile(artifactPath);
const content = await readFile(artifactPath);
const sha512 = createHash('sha512').update(content).digest('base64');
const releaseDate = new Date().toISOString();
const manifest = [
  `version: ${version}`,
  'files:',
  `  - url: ${fileName}`,
  `    sha512: ${sha512}`,
  `    size: ${metadata.size}`,
  `path: ${fileName}`,
  `sha512: ${sha512}`,
  `releaseDate: '${releaseDate}'`,
  '',
].join('\n');

await writeFile(path.join(installerDirectory, 'portable.yml'), manifest, 'utf8');
process.stdout.write(`Wrote portable update manifest for ${fileName}\n`);

async function assertRegularCanonicalFile(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Portable artifact is not a regular non-symlink file: ${path.basename(filePath)}`);
  if (await realpath(filePath) !== path.resolve(filePath)) throw new Error(`Portable artifact is not a canonical file: ${path.basename(filePath)}`);
  return metadata;
}
