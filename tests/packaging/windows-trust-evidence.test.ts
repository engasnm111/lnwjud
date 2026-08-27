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
    for (const name of ['lnwjud-mcp-stdio.cjs', 'lnwjud-node.exe', 'rg.exe', 'tunnel-client.exe']) {
      expect(captureHook).toContain(name);
    }
  });

  it('uploads trust evidence from CI and verifies Authenticode when production signing is configured', async () => {
    const ci = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const release = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8');

    expect(ci).toContain('CSC_LINK: ${{ secrets.WINDOWS_CSC_LINK }}');
    expect(ci).toContain('CSC_KEY_PASSWORD: ${{ secrets.WINDOWS_CSC_KEY_PASSWORD }}');
    expect(ci).toContain('apps/desktop/dist/installers/SHA256SUMS.txt');
    expect(ci).toContain('apps/desktop/dist/installers/PROVENANCE.json');
    expect(release).toContain("'SHA256SUMS.txt'");
    expect(release).toContain("'PROVENANCE.json'");
    expect(release).toContain('Get-AuthenticodeSignature');
    expect(release).toContain('$hasCertificate -ne $hasPassword');
    expect(release).toContain("$signature.Status -ne 'Valid'");
    expect(release).toContain('Publishing unsigned Windows artifact');
    expect(release).toContain('LNWJUD_EXPECTED_COMMIT_SHA');
    expect(release).toContain('verify-release-evidence.mjs');
  });
});
