import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const version = '4.56.0';
const commit = '0123456789abcdef0123456789abcdef01234567';

describe('release asset collector', () => {
  it('validates all target evidence and creates architecture-aware public assets', async () => {
    // Windows hosted runners may expose TEMP through a DOS short-name alias;
    // the collector intentionally requires canonical staging paths.
    const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-release-collector-')));
    const stagingDirectory = path.join(temporaryRoot, 'staging');
    const assetsDirectory = path.join(temporaryRoot, 'assets');
    try {
      for (const target of [
        { key: 'win32-x64', platform: 'win32', arch: 'x64' },
        { key: 'darwin-arm64', platform: 'darwin', arch: 'arm64' },
        { key: 'darwin-x64', platform: 'darwin', arch: 'x64' },
        { key: 'linux-x64', platform: 'linux', arch: 'x64' },
        { key: 'linux-arm64', platform: 'linux', arch: 'arm64' },
      ]) {
        await writeTargetFixture(stagingDirectory, target);
      }

      await execFileAsync(process.execPath, [path.join(repositoryRoot, 'scripts', 'collect-release-assets.mjs')], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          LNWJUD_RELEASE_STAGING_DIRECTORY: stagingDirectory,
          LNWJUD_RELEASE_ASSETS_DIRECTORY: assetsDirectory,
          LNWJUD_RELEASE_COMMIT: commit,
        },
        windowsHide: true,
      });

      const assetNames = new Set(await readdir(assetsDirectory));
      for (const name of [
        'lnwjud-Setup-4.56.0.exe',
        'lnwjud-Portable-4.56.0.exe',
        'lnwjud-4.56.0-arm64.dmg',
        'lnwjud-4.56.0-arm64.zip',
        'lnwjud-4.56.0-x64.dmg',
        'lnwjud-4.56.0-x64.zip',
        'lnwjud-4.56.0-x64.AppImage',
        'lnwjud-4.56.0-arm64.AppImage',
        'latest-linux.yml',
        'latest-linux-arm64.yml',
        'latest-mac.yml',
        'RELEASE_MANIFEST.json',
        'SHA256SUMS.txt',
        'PROVENANCE-darwin-arm64.json',
        'SHA256SUMS-linux-arm64.txt',
      ]) {
        expect(assetNames.has(name), name).toBe(true);
      }
      const macManifest = await readFile(path.join(assetsDirectory, 'latest-mac.yml'), 'utf8');
      expect(macManifest).toContain('lnwjud-4.56.0-arm64.zip');
      expect(macManifest).toContain('lnwjud-4.56.0-x64.zip');
      const releaseManifest = JSON.parse(await readFile(path.join(assetsDirectory, 'RELEASE_MANIFEST.json'), 'utf8')) as {
        sourceCommit?: string;
        targets?: Array<{ platform?: string; arch?: string }>;
      };
      expect(releaseManifest.sourceCommit).toBe(commit);
      expect(releaseManifest.targets).toHaveLength(5);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

async function writeTargetFixture(
  stagingDirectory: string,
  target: { key: string; platform: string; arch: string },
): Promise<void> {
  const targetDirectory = path.join(stagingDirectory, target.key, 'apps', 'desktop', 'dist', 'installers');
  await mkdir(targetDirectory, { recursive: true });
  const artifactNames = target.platform === 'win32'
    ? [`lnwjud-Setup-${version}.exe`, `lnwjud-Setup-${version}.exe.blockmap`, `lnwjud-Portable-${version}.exe`, 'latest.yml', 'portable.yml']
    : target.platform === 'darwin'
      ? [`lnwjud-${version}-${target.arch}.dmg`, `lnwjud-${version}-${target.arch}.zip`, 'latest-mac.yml']
      : [`lnwjud-${version}-${target.arch}.AppImage`, `lnwjud-${version}-${target.arch}.deb`, target.arch === 'x64' ? 'latest-linux.yml' : 'latest-linux-arm64.yml'];
  const artifactEntries = [];
  for (const name of artifactNames) {
    const contents = name.endsWith('.yml') && target.platform === 'darwin'
      ? [
        `version: ${version}`,
        'files:',
        `  - url: lnwjud-${version}-${target.arch}.zip`,
        '    sha512: YmFzZTY0',
        "releaseDate: '2026-09-08T00:00:00.000Z'",
        '',
      ].join('\n')
      : `fixture ${target.key} ${name}\n`;
    await writeFile(path.join(targetDirectory, name), contents, 'utf8');
    artifactEntries.push({ name, sizeBytes: Buffer.byteLength(contents), sha256: sha256(contents) });
  }
  const provenance = {
    schemaVersion: 1,
    product: 'lnwjud',
    version,
    platform: target.platform,
    arch: target.arch,
    source: { repository: 'https://github.com/engasnm111/lnwjud', commit, dirty: false },
    build: { environment: 'github-actions', workingTreeDirtyAtEvidence: false },
    capabilityBridge: null,
    artifacts: artifactEntries,
    runtime: [{ name: 'runtime-fixture', relativePath: 'runtime-fixture', sizeBytes: 0, sha256: '0'.repeat(64) }],
  };
  const provenanceText = `${JSON.stringify(provenance, null, 2)}\n`;
  await writeFile(path.join(targetDirectory, 'PROVENANCE.json'), provenanceText, 'utf8');
  const sums = [
    ...artifactEntries.map((entry) => `${entry.sha256}  ${entry.name}`),
    `${sha256(provenanceText)}  PROVENANCE.json`,
    `${'0'.repeat(64)}  installed/runtime-fixture`,
    '',
  ].join('\n');
  await writeFile(path.join(targetDirectory, 'SHA256SUMS.txt'), sums, 'utf8');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
