import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(import.meta.dirname, '..', '..', 'apps', 'desktop');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');
const ponytailSkillNames = [
  'ponytail',
  'ponytail-review',
  'ponytail-audit',
  'ponytail-debt',
  'ponytail-gain',
  'ponytail-help',
] as const;

describe('cross-platform desktop packaging', () => {
  it('pins the product release to v4.61.0', async () => {
    const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as { version?: unknown };
    const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8')) as { version?: unknown };
    expect(rootPackage.version).toBe('4.61.0');
    expect(desktopPackage.version).toBe('4.61.0');
  });

  it('keeps every workspace package and runtime version aligned', async () => {
    const packageDirectories = [
      path.join(repositoryRoot, 'apps'),
      path.join(repositoryRoot, 'packages'),
    ];
    const packagePaths = [path.join(repositoryRoot, 'package.json')];
    for (const directory of packageDirectories) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const packagePath = path.join(directory, entry.name, 'package.json');
        try {
          await access(packagePath);
          packagePaths.push(packagePath);
        } catch {
          // Ignore stale build-only directories that are not pnpm workspace packages.
        }
      }
    }
    for (const packagePath of packagePaths) {
      const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as { version?: unknown };
      expect(packageJson.version, packagePath).toBe('4.61.0');
    }
    const ipcContracts = await readFile(path.join(repositoryRoot, 'packages', 'ipc-contracts', 'src', 'index.ts'), 'utf8');
    const shared = await readFile(path.join(repositoryRoot, 'packages', 'shared', 'src', 'index.ts'), 'utf8');
    expect(ipcContracts).toContain("APP_VERSION = '4.61.0'");
    expect(shared).toContain("APP_VERSION = '4.61.0'");
  });

  it('publishes complete desktop application metadata', async () => {
    const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8')) as {
      description?: unknown;
      author?: unknown;
      homepage?: unknown;
      repository?: { type?: unknown; url?: unknown };
    };

    expect(desktopPackage.description).toBe('Cross-platform local AI-agent runtime and MCP gateway with 233 total tool definitions.');
    expect(desktopPackage.author).toBe('Adisorn');
    expect(desktopPackage.homepage).toBe('https://github.com/engasnm111/lnwjud#readme');
    expect(desktopPackage.repository).toEqual({ type: 'git', url: 'https://github.com/engasnm111/lnwjud.git' });
  });

  it('declares lnwjud x64 NSIS and portable packaging with built runtime bundles', async () => {
    const configPath = path.join(desktopRoot, 'electron-builder.yml');
    const config = await readFile(configPath, 'utf8');
    const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };

    expect(config).toContain('productName: lnwjud');
    expect(config).toContain('output: dist/installers');
    expect(config).toContain('target: nsis');
    expect(config).toContain('target: portable');
    expect(config).toContain('- x64');
    expect(config).toContain('artifactName: lnwjud-Setup-${version}.${ext}');
    expect(config).toContain('portable:');
    expect(config).toContain('artifactName: lnwjud-Portable-${version}.${ext}');
    expect(desktopPackage.scripts?.['package:windows']).toContain('--win nsis portable --x64');
    expect(desktopPackage.scripts?.['package:windows']).toContain('write-portable-update-manifest.mjs');
    expect(config).toContain('icon: build/icon.ico');
    expect(config).toContain('signAndEditExecutable: true');
    expect(config).not.toContain('signAndEditExecutable: false');
    expect(config).toContain('createStartMenuShortcut: false');
    expect(config).not.toMatch(/[A-Z]:\\Users\\[^\r\n]+/i);
    const tunnelControllerSource = await readFile(path.join(desktopRoot, 'src', 'main', 'tunnel-controller.ts'), 'utf8');
    expect(tunnelControllerSource).not.toContain("'Downloads', 'tunnel', 'tunnel-client.exe'");
    const installerScript = await readFile(path.join(desktopRoot, 'build', 'installer.nsh'), 'utf8');
    expect(installerScript).toContain('CreateShortCut "$SMPROGRAMS\\lnwjud.lnk" "$INSTDIR\\lnwjud.exe"');
    expect(installerScript).toContain('SetOutPath "$INSTDIR"');
    expect(installerScript).not.toMatch(/[A-Z]:\\Users\\[^\r\n]+/i);
    expect(config).toContain('extraResources:');
    expect(config).toContain('from: build/capability-bridge/windows-capability-bridge.ps1');
    expect(config).toContain('from: build/capability-bridge/windows-capability-bridge.sha256');
    expect(config).toContain('from: build/capability-bridge/windows-capability-bridge.integrity.json');
    expect(config).not.toContain('from: ../../packages/capabilities/src/windows-capability-bridge.ps1');
    expect(config).not.toContain('build/lnwjud-node.exe');
    expect(config).not.toContain('lnwjud-mcp-stdio.cjs');
    expect(config).toContain('mac:');
    expect(config).toContain('linux:');
    // Linux otherwise derives @lnwjuddesktop from the scoped package name,
    // breaking the lnwjud executable expected by the launcher and evidence.
    expect(config).toMatch(/linux:\r?\n\s+executableName: lnwjud(?:\r?\n|$)/);
    expect(config).toContain('maintainer: Adisorn <engasnm111@users.noreply.github.com>');
    expect(config).toContain('artifactName: lnwjud-${version}-${env.LNWJUD_RUNTIME_ARCH}.${ext}');
    expect(config).toContain('target: dmg');
    expect(config).toContain('target: zip');
    expect(config).toContain('hardenedRuntime: true');
    expect(config).toContain('entitlements: build/entitlements.mac.plist');
    expect(config).toContain('entitlementsInherit: build/entitlements.mac.inherit.plist');
    expect(config).toContain('NSAccessibilityUsageDescription');
    expect(config).toContain('target: AppImage');
    expect(config).toContain('target: deb');
    expect(config).toMatch(/target: AppImage[\s\S]*?arch:\s*\n\s*- x64\s*\n\s*- arm64/);
    expect(config).toMatch(/target: deb[\s\S]*?arch:\s*\n\s*- x64\s*\n\s*- arm64/);
    expect(config).toContain('category: Development');
    expect(config).toContain('artifactName: lnwjud-${version}-${arch}.${ext}');
    expect(config).toContain('build/runtime-tools');
    expect(config).toContain('to: runtime-tools');
    expect(config).toContain('from: build/tunnel-client');
    expect(config).toContain('to: tunnel-client');
    expect(config).toContain('from: ../../.agents/skills/lnwjud-scheduled-continuation');
    expect(config).toContain('to: agent-skills/lnwjud-scheduled-continuation');
    for (const skillName of ponytailSkillNames) {
      expect(config).toContain(`from: ../../.agents/skills/${skillName}`);
      expect(config).toContain(`to: agent-skills/${skillName}`);
      const vendoredRoot = path.join(repositoryRoot, '.agents', 'skills', skillName);
      await access(path.join(vendoredRoot, 'SKILL.md'));
      await access(path.join(vendoredRoot, 'LICENSE'));
      await access(path.join(vendoredRoot, 'SOURCE.md'));
    }
    expect(config).toContain('from: build/native-host/macos');
    expect(config).toContain('to: native-host/macos');
    expect(config).toContain('from: build/native-host/linux');
    expect(config).toContain('to: native-host/linux');
    await access(path.join(repositoryRoot, '.agents', 'skills', 'lnwjud-scheduled-continuation', 'SKILL.md'));
    expect(desktopPackage.scripts?.['package:windows']).toContain('prepare-runtime-tools.mjs');
    expect(desktopPackage.scripts?.['package:macos']).toContain('package-native.mjs macos');
    expect(desktopPackage.scripts?.['package:linux']).toContain('package-native.mjs linux');
    const nativePackagingScript = await readFile(path.join(desktopRoot, 'scripts', 'package-native.mjs'), 'utf8');
    const linuxHostBuildScript = await readFile(path.join(desktopRoot, 'scripts', 'build-linux-host.mjs'), 'utf8');
    expect(nativePackagingScript).toContain('prepare-runtime-tools.mjs');
    expect(nativePackagingScript).toContain('build-macos-host.mjs');
    expect(nativePackagingScript).toContain('build-linux-host.mjs');
    expect(nativePackagingScript).toContain('LNWJUD_RUNTIME_ARCH');
    expect(nativePackagingScript).toContain('must be built on its target operating system');
    expect(nativePackagingScript).toContain('`--${architecture}`');
    expect(nativePackagingScript).toContain('write-release-evidence.mjs');
    expect(nativePackagingScript).toContain('verify-release-evidence.mjs');
    expect(linuxHostBuildScript).toContain('arch === process.arch');
    expect(linuxHostBuildScript).not.toContain("process.arch === 'x64' ? undefined");
    await access(path.join(desktopRoot, 'build', 'entitlements.mac.plist'));
    await access(path.join(desktopRoot, 'build', 'entitlements.mac.inherit.plist'));
    expect(desktopPackage.scripts?.['package:windows']).toContain('../../scripts/prepare-windows-ocr.ps1');
    const prepareOcr = await readFile(path.join(repositoryRoot, 'scripts', 'prepare-windows-ocr.ps1'), 'utf8');
    expect(prepareOcr).toContain('--list-sdks');
    expect(prepareOcr).toContain('Core installer/portable packaging will continue without OCR.');
    const registerOcr = await readFile(path.join(repositoryRoot, 'scripts', 'register-windows-ocr.ps1'), 'utf8');
    expect(registerOcr).toContain("GetEnvironmentVariable('ProgramFiles(x86)')");
    expect(registerOcr).not.toContain('C:\\Program Files (x86)\\Windows Kits');
    const stdioLauncher = await readFile(path.join(desktopRoot, 'build', 'lnwjud-mcp-stdio.cmd'), 'utf8');
    expect(stdioLauncher).toContain('set "APP=%BASE%lnwjud.exe"');
    expect(stdioLauncher).toContain('--mcp-stdio');
    expect(stdioLauncher).not.toContain('lnwjud-node.exe');
    const posixLauncher = await readFile(path.join(desktopRoot, 'build', 'lnwjud-mcp-stdio.sh'), 'utf8');
    expect(posixLauncher).toContain('exec "$APP" --mcp-stdio "$@"');
    expect(stdioLauncher).not.toContain(path.win32.join('%ProgramFiles%', 'nodejs'));
    expect(stdioLauncher).not.toContain(path.win32.join('%LOCALAPPDATA%', 'Programs', 'nodejs'));
    await access(path.join(desktopRoot, 'dist', 'main', 'main.js'));
    await access(path.join(desktopRoot, 'dist', 'preload', 'index.cjs'));
    await access(path.join(desktopRoot, 'dist', 'renderer', 'index.html'));

    const mainBundle = await readFile(path.join(desktopRoot, 'dist', 'main', 'main.js'), 'utf8');
    const windowBundle = await readFile(path.join(desktopRoot, 'dist', 'main', 'window.js'), 'utf8');
    const tunnelBundle = await readFile(path.join(desktopRoot, 'dist', 'main', 'tunnel-controller.js'), 'utf8');
    expect(windowBundle).toContain('webSecurity: true');
    expect(windowBundle).not.toContain('webSecurity: false');
    expect(mainBundle).toMatch(/setName\(["']lnwjud["']|setName\(APP_NAME\)/);
    expect(tunnelBundle).toContain('delete env.LNWJUD_DATA_PATH');
    expect(tunnelBundle).toContain('delete env.LNWJUD_UNRESTRICTED');
    expect(mainBundle).toMatch(/setPath\(["']userData["']/);
  });

  it('targets Windows 10 OCR through the .NET 8 Windows TFM without the legacy SDK contracts package', async () => {
    const ocrProject = await readFile(path.join(repositoryRoot, 'native', 'windows-ocr', 'lnwjud-windows-ocr.csproj'), 'utf8');
    expect(ocrProject).toContain('<TargetFramework>net8.0-windows10.0.19041.0</TargetFramework>');
    expect(ocrProject).not.toContain('Microsoft.Windows.SDK.Contracts');
    expect(ocrProject).not.toContain('10.0.28000');
  });

  it('pins and verifies the official Windows x64 runtime downloads used by packaging', async () => {
    const prepareRipgrep = await readFile(path.join(desktopRoot, 'scripts', 'prepare-ripgrep.ps1'), 'utf8');
    const prepareRuntimeTools = await readFile(path.join(desktopRoot, 'scripts', 'prepare-runtime-tools.mjs'), 'utf8');
    const prepareTunnel = await readFile(path.join(desktopRoot, 'scripts', 'prepare-tunnel-client.mjs'), 'utf8');
    const runtimeDependencies = JSON.parse(await readFile(path.join(desktopRoot, 'src', 'main', 'runtime-dependencies.json'), 'utf8'));
    const captureRuntimeEvidence = await readFile(path.join(desktopRoot, 'scripts', 'capture-packaged-runtime-evidence.mjs'), 'utf8');
    const verifyReleaseEvidence = await readFile(path.join(desktopRoot, 'scripts', 'verify-release-evidence.mjs'), 'utf8');
    const config = await readFile(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');
    const supportedTuples = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
    expect(runtimeDependencies.schemaVersion).toBe(1);
    expect(runtimeDependencies.tunnelClient.version).toBe('0.0.14');
    expect(runtimeDependencies.ripgrep.version).toBe('15.2.0');
    expect(runtimeDependencies.pdfProvider).toMatchObject({ version: '26.07.0-0', platform: 'win32', arch: 'x64' });
    expect(Object.keys(runtimeDependencies.tunnelClient.targets).sort()).toEqual(supportedTuples);
    expect(Object.keys(runtimeDependencies.ripgrep.targets).sort()).toEqual(supportedTuples);
    for (const target of Object.values(runtimeDependencies.tunnelClient.targets) as Array<{ archiveSha256: string }>) {
      expect(target.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const target of Object.values(runtimeDependencies.ripgrep.targets) as Array<{ sha256: string }>) {
      expect(target.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(prepareRipgrep).toContain('runtime-dependencies.json');
    expect(prepareRipgrep).toContain(".'win32-x64'");
    expect(prepareRuntimeTools).toContain('runtime-dependencies.json');
    expect(prepareRuntimeTools).toContain('targetKey = `${platform}-${rawArch}`');
    expect(prepareRuntimeTools).toContain('Runtime tools do not support ${platform}/${rawArch}');
    expect(prepareRuntimeTools).toContain('assetSha256');
    expect(prepareRuntimeTools).toContain("await chmod(destination, 0o755)");
    expect(prepareRuntimeTools).toContain('assertCanonicalFile');
    expect(prepareRuntimeTools).toContain("flag: 'wx'");
    expect(prepareTunnel).toContain('runtime-dependencies.json');
    expect(prepareTunnel).toContain('targetKey = `${platform}-${rawArch}`');
    expect(prepareTunnel).toContain('Official tunnel-client checksum changed');
    expect(prepareTunnel).toContain('https://github.com/openai/tunnel-client/releases/download');
    expect(prepareTunnel).toContain('SHA256SUMS.txt');
    expect(prepareTunnel).toContain('verifyVersion(executable)');
    expect(prepareTunnel).toContain('--version does not match');
    expect(prepareTunnel).toContain('verify-blob-attestation');
    expect(prepareTunnel).toContain('certificate-oidc-issuer');
    expect(prepareTunnel).toContain('token.actions.githubusercontent.com');
    expect(prepareTunnel).toContain('MINIMUM_COSIGN_VERSION');
    expect(prepareTunnel).not.toContain('--new-bundle-format=false');
    expect(prepareTunnel).toContain('assertCanonicalFile');
    expect(prepareTunnel).toContain("flag: 'wx'");
    expect(prepareTunnel).not.toContain('powershell');
    expect(prepareTunnel).not.toContain('Get-FileHash');
    expect(captureRuntimeEvidence).toContain('tunnel-client-license');
    expect(captureRuntimeEvidence).toContain('tunnel-client-provenance');
    expect(captureRuntimeEvidence).toContain('Packaged tunnel-client evidence identity mismatch');
    expect(verifyReleaseEvidence).toContain('BUNDLED_TUNNEL_CLIENT_VERSION');
    expect(await readFile(path.join(repositoryRoot, 'native', 'macos-host', 'Package.swift'), 'utf8')).toContain('LnwjudMacHost');
    expect(await readFile(path.join(repositoryRoot, 'native', 'linux-host', 'Cargo.toml'), 'utf8')).toContain('lnwjud-linux-host');
    expect(config).toContain('from: ../../native/windows-secret-migrator/bin/win-x64');
  });

  it('defines a dedicated Portable update manifest instead of reusing the Installer feed', async () => {
    const manifestScript = await readFile(path.join(desktopRoot, 'scripts', 'write-portable-update-manifest.mjs'), 'utf8');
    expect(manifestScript).toContain('lnwjud-Portable-${version}.exe');
    expect(manifestScript).toContain("createHash('sha512')");
    expect(manifestScript).toContain('size: ${metadata.size}');
    expect(manifestScript).toContain("'portable.yml'");
    expect(manifestScript).not.toContain('lnwjud-Setup-${version}.exe');
  });
});
