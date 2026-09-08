import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const desktopRoot = path.join(repositoryRoot, 'apps', 'desktop');

describe('Windows release trust evidence', () => {
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
    expect(builderConfig).toContain('afterPack: scripts/capture-packaged-runtime-evidence.mjs');
    expect(builderConfig).toContain('afterSign: scripts/capture-packaged-runtime-evidence.mjs');
    expect(evidenceWriter).toContain('SHA256SUMS.txt');
    expect(evidenceWriter).toContain('PROVENANCE.json');
    expect(evidenceWriter).toContain('GITHUB_SHA');
    expect(evidenceWriter).toContain('LNWJUD_SOURCE_DIRTY_AT_START');
    expect(evidenceWriter).toContain('workingTreeDirtyAtEvidence');
    expect(evidenceWriter).toContain("git(['rev-parse', 'HEAD'])");
    expect(evidenceWriter).toContain('capabilityBridge');
    expect(evidenceVerifier).toContain('LNWJUD_RELEASE_ARTIFACT_ONLY');
    expect(evidenceVerifier).toMatch(/const packagedBridgePath = releaseArtifactOnly\s+\? undefined\s+: path\.join\(installerDirectory, 'win-unpacked'/);
    expect(evidenceVerifier).toContain('compiledBundlePath');
    expect(evidenceVerifier).toContain('const releaseArtifactOnly');
    expect(evidenceVerifier).toContain('verifyCapabilityBridgeArtifacts');
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

  it('uploads trust evidence from CI and verifies Authenticode when production signing is configured', async () => {
    const ci = (await readFile(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8')).replaceAll('\r\n', '\n');
    const release = (await readFile(path.join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8')).replaceAll('\r\n', '\n');

    expect(ci).toContain('CSC_LINK: ${{ secrets.WINDOWS_CSC_LINK }}');
    expect(ci).toContain('CSC_KEY_PASSWORD: ${{ secrets.WINDOWS_CSC_KEY_PASSWORD }}');
    expect(ci).toContain('apps/desktop/dist/installers/SHA256SUMS.txt');
    expect(ci).toContain('apps/desktop/dist/installers/PROVENANCE.json');
    expect(ci).toContain('WINDOWS_CSC_LINK');
    expect(ci).toContain('WINDOWS_CSC_KEY_PASSWORD');
    expect(release).toContain('native-darwin-arm64-$sha');
    expect(release).toContain('native-linux-arm64-$sha');
    expect(release).toContain('RELEASE_MANIFEST.json');
    expect(release).not.toContain('Get-AuthenticodeSignature');
    expect(release).toContain('LNWJUD_EXPECTED_COMMIT_SHA');
    expect(release).toContain('verify-release-evidence.mjs');
  });
});
