import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Standalone Node packaging script.
import { prepareInstalledLayout, verifyPreparedInstalledLayout, verifyInstalledLayoutAsset } from '../../scripts/update-trust/prepare-installed-layout.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const desktopRoot = path.join(repositoryRoot, 'apps', 'desktop');
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function installedFixture(): Promise<{ rootDirectory: string; outputDirectory: string; platform: 'win32'; architecture: 'x64' }> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-layout-')));
  temporaryRoots.push(base);
  const rootDirectory = path.join(base, 'stage');
  const outputDirectory = path.join(base, 'release');
  await mkdir(path.join(rootDirectory, 'resources', 'native-containment'), { recursive: true });
  await mkdir(path.join(rootDirectory, 'slots', 'A', 'resources'), { recursive: true });
  await mkdir(outputDirectory);
  await writeFile(path.join(rootDirectory, 'lnwjud.exe'), 'stable launcher');
  await writeFile(path.join(rootDirectory, 'resources', 'native-containment', 'lnwjud-containment.exe'), 'stable service');
  await writeFile(path.join(rootDirectory, 'slots', 'A', 'lnwjud.exe'), 'candidate application');
  await writeFile(path.join(rootDirectory, 'slots', 'A', 'resources', 'app.asar'), 'application archive');
  await writeFile(path.join(rootDirectory, 'slots', 'A', 'empty.txt'), '');
  return { rootDirectory, outputDirectory, platform: 'win32', architecture: 'x64' };
}

describe('Windows release trust evidence', () => {
  it('captures a clean exact-SHA checkout before dev packaging mutates tracked build outputs', async () => {
    const workflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'dev-installer.yml'), 'utf8');
    const checkoutStep = workflow.indexOf('- name: Checkout Code');
    const sourceStep = workflow.indexOf('- name: Capture clean source checkout provenance');
    const buildStep = workflow.indexOf('- name: Install dependencies');

    expect(checkoutStep).toBeGreaterThanOrEqual(0);
    expect(sourceStep).toBeGreaterThan(checkoutStep);
    expect(sourceStep).toBeLessThan(buildStep);
    expect(workflow).toContain('$checkoutSha -ne $env:GITHUB_SHA');
    expect(workflow).toContain('DEV_INSTALLER_SOURCE_CHECKOUT_DIRTY');
    expect(workflow).toContain("Add-Content -Path $env:GITHUB_ENV -Value 'LNWJUD_SOURCE_DIRTY_AT_START=0'");
  });

  it('renames the installed uninstaller to uninstall.exe and rewrites both uninstall registry commands', async () => {
    const installer = await readFile(path.join(desktopRoot, 'build', 'installer.nsh'), 'utf8');

    expect(installer).toContain('Rename "$INSTDIR\\Uninstall ${PRODUCT_FILENAME}.exe" "$INSTDIR\\uninstall.exe"');
    expect(installer).toContain('StrCpy $2 "$INSTDIR\\uninstall.exe"');
    expect(installer).toContain('WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString');
    expect(installer).toContain('WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString');
    expect(installer).toContain('/currentuser');
    expect(installer).toContain('/allusers');
  });

  it('generates verifiable SHA-256 and source provenance after Windows packaging', async () => {
    const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const packageScript = desktopPackage.scripts?.['package:windows'] ?? '';
    const evidenceWriter = await readFile(path.join(desktopRoot, 'scripts', 'write-release-evidence.mjs'), 'utf8');
    const evidenceVerifier = await readFile(path.join(desktopRoot, 'scripts', 'verify-release-evidence.mjs'), 'utf8');
    const bridgeVerifier = await readFile(path.join(desktopRoot, 'scripts', 'verify-capability-bridge-artifacts.mjs'), 'utf8');
    const captureHook = await readFile(path.join(desktopRoot, 'scripts', 'capture-packaged-runtime-evidence.mjs'), 'utf8');
    const builderConfig = await readFile(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');

    expect(packageScript).toContain('write-release-evidence.mjs');
    expect(packageScript).toContain('verify-release-evidence.mjs');
    expect(builderConfig).toContain('beforePack: scripts/prepare-windows-update-launcher.mjs');
    expect(builderConfig).toContain('afterPack: scripts/capture-before-signing.mjs');
    expect(builderConfig).toContain('afterSign: scripts/capture-packaged-runtime-evidence.mjs');
    expect(builderConfig).toContain('to: lnwjud-update-launcher.exe');
    expect(evidenceWriter).toContain('SHA256SUMS.txt');
    expect(evidenceWriter).toContain('PROVENANCE.json');
    expect(evidenceWriter).toContain('GITHUB_SHA');
    expect(evidenceWriter).toContain('LNWJUD_SOURCE_DIRTY_AT_START');
    expect(evidenceWriter).toContain('workingTreeDirtyAtEvidence');
    expect(evidenceWriter).toContain('LNWJUD_VALIDATION_INSTALLED_ROOT');
    expect(evidenceWriter).toContain('await verifyPreparedInstalledLayout');
    expect(evidenceVerifier).toContain('await verifyInstalledLayoutAsset');
    expect(evidenceWriter).toContain("git(['rev-parse', 'HEAD'])");
    expect(evidenceWriter).toContain('capabilityBridge');
    expect(evidenceVerifier).toContain('LNWJUD_RELEASE_ARTIFACT_ONLY');
    expect(evidenceVerifier).toMatch(/const packagedBridgePath = releaseArtifactOnly\s+\? undefined\s+: path\.join\(installerDirectory, 'win-unpacked'/);
    expect(evidenceVerifier).toContain('compiledBundlePath');
    expect(evidenceVerifier).toContain('const releaseArtifactOnly');
    expect(evidenceVerifier).toContain('verifyCapabilityBridgeArtifacts');
    // The pinned verifier must be present and hash-bound in both the captured
    // installed-runtime ledger and artifact-only release verification.
    const verifierPath = 'resources/native-containment/update-attestation/gh.exe';
    expect(captureHook).toContain(`['attestation-verifier', '${verifierPath}']`);
    expect(captureHook).toContain('sha256 !== VERIFIER_SHA256');
    expect(evidenceVerifier).toContain(`runtime.relativePath === '${verifierPath}'`);
    expect(evidenceVerifier).toContain('runtime.sha256.toLowerCase() !== VERIFIER_SHA256');
    expect(bridgeVerifier).toContain('packaged bridge bytes differ from staged package bytes');
    for (const name of ['lnwjud-mcp-stdio.cmd', 'windows-capability-bridge.ps1', 'windows-capability-bridge.sha256', 'windows-capability-bridge.integrity.json', 'windows-secret-migrator.exe', 'windows-secret-migrator.sha256', 'rg.exe', 'tunnel-client.exe']) {
      expect(captureHook).toContain(name);
    }
    expect(captureHook).not.toContain('lnwjud-mcp-stdio.cjs');
    expect(captureHook).not.toContain('lnwjud-node.exe');
    expect(evidenceWriter).toContain('runtimeEvidence.platform');
    expect(evidenceVerifier).toContain('expectedArtifactNames');
    expect(captureHook).toContain('lstat');
    expect(captureHook).toContain('realpath(filePath)');
    expect(evidenceWriter).toContain('lstat');
    expect(evidenceWriter).toContain('realpath(filePath)');
    const evidenceVerifierSource = await readFile(path.join(desktopRoot, 'scripts', 'verify-release-evidence.mjs'), 'utf8');
    const portableManifestSource = await readFile(path.join(desktopRoot, 'scripts', 'write-portable-update-manifest.mjs'), 'utf8');
    expect(evidenceVerifierSource).toContain('lstat');
    expect(evidenceVerifierSource).toContain('realpath(filePath)');
    expect(portableManifestSource).toContain('isSymbolicLink');
  });

  it('keeps the integrity-verified bridge bytes stable across Windows checkouts', async () => {
    const attributes = await readFile(path.join(repositoryRoot, '.gitattributes'), 'utf8');
    const bridge = await readFile(path.join(repositoryRoot, 'packages', 'capabilities', 'src', 'windows-capability-bridge.ps1'));

    expect(attributes).toContain('packages/capabilities/src/windows-capability-bridge.ps1 text eol=lf');
    expect(bridge.includes(0x0d)).toBe(false);
  });

  it('permits unsigned community releases while still validating configured Windows signing', async () => {
    const ci = (await readFile(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8')).replaceAll('\r\n', '\n');
    const release = (await readFile(path.join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8')).replaceAll('\r\n', '\n');
    const evidenceWriter = await readFile(path.join(desktopRoot, 'scripts', 'write-release-evidence.mjs'), 'utf8');
    const evidenceVerifier = await readFile(path.join(desktopRoot, 'scripts', 'verify-release-evidence.mjs'), 'utf8');

    expect(ci).toContain('CSC_LINK: ${{ secrets.WINDOWS_CSC_LINK }}');
    expect(ci).toContain('CSC_KEY_PASSWORD: ${{ secrets.WINDOWS_CSC_KEY_PASSWORD }}');
    expect(ci).not.toContain('Require Windows production signing credentials');
    expect(ci).not.toContain("LNWJUD_REQUIRE_WINDOWS_AUTHENTICODE: '1'");
    expect(ci).toContain('apps/desktop/dist/installers/SHA256SUMS.txt');
    expect(ci).toContain('apps/desktop/dist/installers/PROVENANCE.json');
    expect(evidenceWriter).toContain('Get-AuthenticodeSignature');
    expect(evidenceWriter).toContain('windowsAuthenticode');
    expect(evidenceVerifier).toContain('LNWJUD_REQUIRE_WINDOWS_AUTHENTICODE');
    expect(evidenceVerifier).toContain('options.required || options.signingCredentialConfigured');
    expect(evidenceVerifier).toContain('windowsAuthenticode');
    expect(release).not.toContain('native-darwin-arm64-$sha');
    expect(release).toContain('native-linux-arm64-$sha');
    expect(release).toContain('collect-release-assets.mjs');
    expect(release).not.toContain('LNWJUD_REQUIRE_WINDOWS_AUTHENTICODE');
    expect(release).toContain('LNWJUD_EXPECTED_COMMIT_SHA');
    expect(release).toContain('verify-release-evidence.mjs');
  });
});

describe('Windows installed layout producer', () => {
  it('runs before packaging and binds every immutable slot file without a hash cycle', async () => {
    const fixture = await installedFixture();
    const stdout = execFileSync(process.execPath, [path.join(repositoryRoot, 'scripts', 'update-trust', 'prepare-installed-layout.mjs'),
      fixture.rootDirectory, fixture.outputDirectory], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    const identity = JSON.parse(stdout);
    const layoutBytes = await readFile(path.join(fixture.outputDirectory, 'INSTALL-LAYOUT.json'));
    const layout = JSON.parse(layoutBytes.toString());
    const manifestBytes = await readFile(path.join(fixture.rootDirectory, 'slots', 'A', 'manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString());
    expect(identity).toEqual({ name: 'INSTALL-LAYOUT.json', sizeBytes: String(layoutBytes.length),
      sha256: createHash('sha256').update(layoutBytes).digest('hex') });
    expect(layout).toMatchObject({ schemaVersion: 1, product: 'lnwjud', platform: 'win32', architecture: 'x64', slot: 'A' });
    expect(layout.roles.slotManifest).toEqual({ path: 'slots/A/manifest.json', sizeBytes: String(manifestBytes.length),
      sha256: createHash('sha256').update(manifestBytes).digest('hex') });
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(['empty.txt', 'lnwjud.exe', 'resources/app.asar']);
    expect(manifest.files[0]).toMatchObject({ sizeBytes: '0', sha256: createHash('sha256').update('').digest('hex') });
    expect(layout.roles.slotApplication).toEqual({ ...manifest.files[1], path: 'slots/A/lnwjud.exe' });
    expect(layoutBytes.toString()).not.toContain('PROVENANCE');
    expect(layoutBytes.toString()).not.toContain('RELEASE.json');
    await expect(verifyPreparedInstalledLayout(fixture)).resolves.toEqual(identity);
    await expect(prepareInstalledLayout(fixture)).resolves.toEqual(identity);
    await expect(verifyInstalledLayoutAsset(fixture.outputDirectory, identity)).resolves.toBeUndefined();
  }, 30_000);

  it('refuses changed immutable bytes after layout production', async () => {
    const fixture = await installedFixture();
    await prepareInstalledLayout(fixture);
    await writeFile(path.join(fixture.rootDirectory, 'slots', 'A', 'resources', 'app.asar'), 'modified application archive');
    await expect(verifyPreparedInstalledLayout(fixture)).rejects.toThrow('INSTALLED_LAYOUT_REFUSED');
    await expect(prepareInstalledLayout(fixture)).rejects.toThrow();
  }, 30_000);

  it('refuses forged layout identity and manifest tampering', async () => {
    const fixture = await installedFixture();
    const identity = await prepareInstalledLayout(fixture);
    for (const invalid of [null, { ...identity, name: '../INSTALL-LAYOUT.json' }, { ...identity, sizeBytes: '01' },
      { ...identity, sha256: '0'.repeat(64) }, { ...identity, extra: true }]) {
      await expect(verifyInstalledLayoutAsset(fixture.outputDirectory, invalid)).rejects.toThrow();
    }
    const manifestPath = path.join(fixture.rootDirectory, 'slots', 'A', 'manifest.json');
    await writeFile(manifestPath, '{"schemaVersion":1,"files":[]}');
    await expect(verifyPreparedInstalledLayout(fixture)).rejects.toThrow('INSTALLED_LAYOUT_REFUSED');
  }, 30_000);

  it('refuses flat manual packages and unsupported targets before writing metadata', async () => {
    const fixture = await installedFixture();
    for (const override of [{ platform: 'linux' }, { architecture: 'arm64' }, { outputDirectory: fixture.rootDirectory }]) {
      await expect(prepareInstalledLayout({ ...fixture, ...override })).rejects.toThrow('INSTALLED_LAYOUT_REFUSED');
    }
    await rm(path.join(fixture.rootDirectory, 'slots'), { recursive: true });
    await expect(prepareInstalledLayout(fixture)).rejects.toThrow();
    await expect(readFile(path.join(fixture.outputDirectory, 'INSTALL-LAYOUT.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('refuses hard-linked payloads', async () => {
    const fixture = await installedFixture();
    const slot = path.join(fixture.rootDirectory, 'slots', 'A');
    await link(path.join(slot, 'lnwjud.exe'), path.join(slot, 'alias.exe'));
    await expect(prepareInstalledLayout(fixture)).rejects.toThrow('RELEASE_INPUT_INVALID');
  }, 30_000);

  it('refuses a junction or directory symlink instead of traversing it', async () => {
    const fixture = await installedFixture();
    await symlink(fixture.outputDirectory, path.join(fixture.rootDirectory, 'slots', 'A', 'linked'), 'junction');
    await expect(prepareInstalledLayout(fixture)).rejects.toThrow();
    await expect(readFile(path.join(fixture.outputDirectory, 'INSTALL-LAYOUT.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it.skipIf(process.platform === 'win32')('rejects Windows-unsafe names on POSIX build hosts', async () => {
    for (const name of ['CON.txt', 'CON .txt', 'data:stream', 'trailing.', 'trailing ', 'non-ascii-\u00e9', 'delete-\u007f']) {
      const fixture = await installedFixture();
      await writeFile(path.join(fixture.rootDirectory, 'slots', 'A', name), 'unsafe');
      await expect(prepareInstalledLayout(fixture)).rejects.toThrow('INSTALLED_LAYOUT_REFUSED');
    }
  }, 30_000);

  it('refuses distinct case aliases when the filesystem supports them', async ({ skip }) => {
    const fixture = await installedFixture();
    const slot = path.join(fixture.rootDirectory, 'slots', 'A');
    await writeFile(path.join(slot, 'Foo.txt'), 'one');
    try { await writeFile(path.join(slot, 'foo.txt'), 'two', { flag: 'wx' }); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return skip();
      throw error;
    }
    await expect(prepareInstalledLayout(fixture)).rejects.toThrow('INSTALLED_LAYOUT_REFUSED');
  }, 30_000);
});
