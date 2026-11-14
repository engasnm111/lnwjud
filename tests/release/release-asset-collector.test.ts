import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone Node packaging module.
import { prepareInstalledLayout } from '../../scripts/update-trust/prepare-installed-layout.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const version = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')).version as string;
const commit = '0123456789abcdef0123456789abcdef01234567';
const signedSidecarNames = ['BASELINE-win32-x64.json', 'ARTIFACT-win32-x64.bundle.json',
  'PROVENANCE-win32-x64.bundle.json', 'INSTALL-LAYOUT-win32-x64.json'];

describe('release asset collector', () => {
  it('validates target evidence beside provenance without confusing bundled dependency checksums', async () => {
    // Windows hosted runners may expose TEMP through a DOS short-name alias;
    // the collector intentionally requires canonical staging paths.
    const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-release-collector-')));
    const stagingDirectory = path.join(temporaryRoot, 'staging');
    const assetsDirectory = path.join(temporaryRoot, 'assets');
    const sidecarsDirectory = path.join(temporaryRoot, 'signed-sidecars');
    try {
      await mkdir(sidecarsDirectory);
      for (const name of [...signedSidecarNames, 'RELEASE-win32-x64.json']) {
        await writeFile(path.join(sidecarsDirectory, name), JSON.stringify({ fixture: name }));
      }
      // Independent target fixtures can be staged concurrently on busy Windows runners.
      await Promise.all([
        { key: 'win32-x64', platform: 'win32', arch: 'x64' },
        { key: 'darwin-arm64', platform: 'darwin', arch: 'arm64' },
        { key: 'darwin-x64', platform: 'darwin', arch: 'x64' },
        { key: 'linux-x64', platform: 'linux', arch: 'x64' },
        { key: 'linux-arm64', platform: 'linux', arch: 'arm64' },
      ].map(async (target) => {
        await writeTargetFixture(stagingDirectory, target);
        const dependencyDirectory = path.join(stagingDirectory, target.key, 'apps', 'desktop', 'dist', 'installers', 'unpacked', 'dependency');
        await mkdir(dependencyDirectory, { recursive: true });
        await writeFile(path.join(dependencyDirectory, 'SHA256SUMS.txt'), 'unrelated dependency checksums\n');
      }));

      await execFileAsync(process.execPath, [path.join(repositoryRoot, 'scripts', 'collect-release-assets.mjs')], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          LNWJUD_RELEASE_STAGING_DIRECTORY: stagingDirectory,
          LNWJUD_RELEASE_ASSETS_DIRECTORY: assetsDirectory,
          LNWJUD_RELEASE_COMMIT: commit,
          LNWJUD_SIGNED_WINDOWS_SIDECARS: sidecarsDirectory,
        },
        windowsHide: true,
      });

      const assetNames = new Set(await readdir(assetsDirectory));
      for (const name of [
        `lnwjud-Setup-${version}.exe`,
        `lnwjud-Portable-${version}.exe`,
        `lnwjud-${version}-x64.AppImage`,
        `lnwjud-${version}-arm64.AppImage`,
        'latest-linux.yml',
        'latest-linux-arm64.yml',
        'RELEASE_MANIFEST.json',
        'SHA256SUMS.txt',
        'SHA256SUMS-linux-arm64.txt',
        'INSTALL-LAYOUT.json',
        `lnwjud-Update-${version}-win32-x64.zip`,
        ...signedSidecarNames,
        'RELEASE-win32-x64.json',
      ]) {
        expect(assetNames.has(name), name).toBe(true);
      }
      expect(assetNames.has('latest-mac.yml')).toBe(false);
      for (const name of assetNames) {
        if (!/^SHA256SUMS(?:-.+)?\.txt$/.test(name)) continue;
        const sums = await readFile(path.join(assetsDirectory, name), 'utf8');
        for (const line of sums.trim().split(/\r?\n/)) {
          const [digest, file] = line.split('  ');
          if (file?.startsWith('installed/')) continue; // Separate installed-runtime evidence.
          expect(file).toBeDefined();
          const bytes = await readFile(path.join(assetsDirectory, file ?? ''));
          expect(createHash('sha256').update(bytes).digest('hex'), `${name}: ${file}`).toBe(digest);
        }
      }
      const releaseManifest = JSON.parse(await readFile(path.join(assetsDirectory, 'RELEASE_MANIFEST.json'), 'utf8')) as {
        sourceCommit?: string;
        targets?: Array<{ platform?: string; arch?: string; sourceArtifactNames?: string[] }>;
        assets?: Array<{ name: string; sizeBytes: number; sha256: string }>;
      };
      expect(releaseManifest.sourceCommit).toBe(commit);
      expect(releaseManifest.targets).toHaveLength(3);
      expect(releaseManifest.targets?.every((target) => target.platform !== 'darwin')).toBe(true);
      expect(releaseManifest.targets?.find((target) => target.platform === 'win32')?.sourceArtifactNames)
        .toEqual(expect.arrayContaining(['INSTALL-LAYOUT.json', `lnwjud-Update-${version}-win32-x64.zip`]));
      for (const name of [...signedSidecarNames, 'RELEASE-win32-x64.json']) {
        const contents = await readFile(path.join(sidecarsDirectory, name), 'utf8');
        expect(await readFile(path.join(assetsDirectory, name), 'utf8')).toBe(contents);
        expect(releaseManifest.assets?.find(asset => asset.name === name))
          .toEqual({ name, sizeBytes: Buffer.byteLength(contents), sha256: sha256(contents) });
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it('rejects a missing sibling checksum instead of using a nested copy', async () => {
    const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-release-collector-')));
    const stagingDirectory = path.join(temporaryRoot, 'staging');
    try {
      await writeTargetFixture(stagingDirectory, { key: 'win32-x64', platform: 'win32', arch: 'x64' });
      const installerDirectory = path.join(stagingDirectory, 'win32-x64', 'apps', 'desktop', 'dist', 'installers');
      const sums = await readFile(path.join(installerDirectory, 'SHA256SUMS.txt'));
      await mkdir(path.join(installerDirectory, 'nested'));
      await writeFile(path.join(installerDirectory, 'nested', 'SHA256SUMS.txt'), sums);
      await rm(path.join(installerDirectory, 'SHA256SUMS.txt'));
      await expect(execFileAsync(process.execPath, [path.join(repositoryRoot, 'scripts', 'collect-release-assets.mjs')], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          LNWJUD_RELEASE_STAGING_DIRECTORY: stagingDirectory,
          LNWJUD_RELEASE_ASSETS_DIRECTORY: path.join(temporaryRoot, 'assets'),
          LNWJUD_RELEASE_COMMIT: commit,
        },
        windowsHide: true,
      })).rejects.toThrow(/ENOENT.*SHA256SUMS\.txt/s);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it.each(['missing', 'unknown', 'hardlink', 'symlink', 'oversized', 'invalid-json'] as const)('rejects %s signed sidecar input before publishing assets', async (failure) => {
    const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-sidecar-collector-')));
    const stagingDirectory = path.join(temporaryRoot, 'staging');
    const sidecarsDirectory = path.join(temporaryRoot, 'sidecars');
    const assetsDirectory = path.join(temporaryRoot, 'assets');
    try {
      await mkdir(stagingDirectory);
      await mkdir(sidecarsDirectory);
      for (const name of signedSidecarNames) await writeFile(path.join(sidecarsDirectory, name), '{}');
      const baselinePath = path.join(sidecarsDirectory, signedSidecarNames[0]);
      if (failure === 'missing') await rm(baselinePath);
      else if (failure === 'unknown') await writeFile(path.join(sidecarsDirectory, 'PROVENANCE-win32-x64.json'), '{}');
      else if (failure === 'oversized') await writeFile(path.join(sidecarsDirectory, 'INSTALL-LAYOUT-win32-x64.json'), ' '.repeat(65_537));
      else if (failure === 'invalid-json') await writeFile(baselinePath, '{');
      else {
        const source = path.join(temporaryRoot, 'linked-input.json');
        await rm(baselinePath);
        if (failure === 'hardlink') {
          await writeFile(source, '{}');
          await link(source, baselinePath);
        } else {
          await mkdir(source);
          await symlink(source, baselinePath, 'junction');
        }
      }
      await expect(execFileAsync(process.execPath, [path.join(repositoryRoot, 'scripts', 'collect-release-assets.mjs')], {
        cwd: repositoryRoot,
        env: { ...process.env, LNWJUD_RELEASE_STAGING_DIRECTORY: stagingDirectory, LNWJUD_RELEASE_ASSETS_DIRECTORY: assetsDirectory,
          LNWJUD_RELEASE_COMMIT: commit, LNWJUD_SIGNED_WINDOWS_SIDECARS: sidecarsDirectory },
        windowsHide: true,
      })).rejects.toThrow(/sidecar|non-regular|RELEASE_INPUT_INVALID|RELEASE_JSON_INVALID/i);
      expect(await readdir(assetsDirectory)).toEqual([]);
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
  const artifactEntries: Array<{ name: string; sizeBytes: number; sha256: string }> = [];
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
  let windowsUpdate: { installedLayout: unknown; updatePayload: { name: string; sizeBytes: string; sha256: string } } | undefined;
  if (target.platform === 'win32') {
    const rootDirectory = path.join(targetDirectory, 'win-unpacked');
    await mkdir(path.join(rootDirectory, 'resources/native-containment'), { recursive: true });
    await mkdir(path.join(rootDirectory, 'slots/A'), { recursive: true });
    await writeFile(path.join(rootDirectory, 'lnwjud.exe'), 'launcher');
    await writeFile(path.join(rootDirectory, 'resources/native-containment/lnwjud-containment.exe'), 'service');
    await writeFile(path.join(rootDirectory, 'slots/A/lnwjud.exe'), 'application');
    const installedLayout = await prepareInstalledLayout({ rootDirectory, outputDirectory: targetDirectory });
    const payload = 'fixture payload bytes';
    const updatePayload = { name: `lnwjud-Update-${version}-win32-x64.zip`, sizeBytes: String(Buffer.byteLength(payload)), sha256: sha256(payload) };
    await writeFile(path.join(targetDirectory, updatePayload.name), payload);
    windowsUpdate = { installedLayout, updatePayload };
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
    ...windowsUpdate,
  };
  const provenanceText = `${JSON.stringify(provenance, null, 2)}\n`;
  await writeFile(path.join(targetDirectory, 'PROVENANCE.json'), provenanceText, 'utf8');
  const sums = [
    ...artifactEntries.map((entry) => `${entry.sha256}  ${entry.name}`),
    ...(windowsUpdate ? [
      `${sha256(await readFile(path.join(targetDirectory, 'INSTALL-LAYOUT.json'), 'utf8'))}  INSTALL-LAYOUT.json`,
      `${windowsUpdate.updatePayload.sha256}  ${windowsUpdate.updatePayload.name}`,
    ] : []),
    `${sha256(provenanceText)}  PROVENANCE.json`,
    `${'0'.repeat(64)}  installed/runtime-fixture`,
    '',
  ].join('\n');
  await writeFile(path.join(targetDirectory, 'SHA256SUMS.txt'), sums, 'utf8');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
