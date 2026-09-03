import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(import.meta.dirname, '..', '..', 'apps', 'desktop');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');

describe('Windows desktop packaging', () => {
  it('pins the product release to v4.52.1', async () => {
    const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as { version?: unknown };
    const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8')) as { version?: unknown };
    expect(rootPackage.version).toBe('4.52.1');
    expect(desktopPackage.version).toBe('4.52.1');
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
      expect(packageJson.version, packagePath).toBe('4.52.1');
    }
    const ipcContracts = await readFile(path.join(repositoryRoot, 'packages', 'ipc-contracts', 'src', 'index.ts'), 'utf8');
    const shared = await readFile(path.join(repositoryRoot, 'packages', 'shared', 'src', 'index.ts'), 'utf8');
    expect(ipcContracts).toContain("APP_VERSION = '4.52.1'");
    expect(shared).toContain("APP_VERSION = '4.52.1'");
  });

  it('publishes complete desktop application metadata', async () => {
    const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8')) as {
      description?: unknown;
      author?: unknown;
      homepage?: unknown;
      repository?: { type?: unknown; url?: unknown };
    };

    expect(desktopPackage.description).toBe('Windows-first local AI-agent runtime and MCP gateway with 231 total tool definitions.');
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
    expect(config).toContain('build/lnwjud-node.exe');
    expect(config).toContain('to: lnwjud-node.exe');
    expect(config).toContain('build/runtime-tools');
    expect(config).toContain('to: runtime-tools');
    expect(config).toContain('from: build/tunnel-client');
    expect(config).toContain('to: tunnel-client');
    expect(config).toContain('from: ../../.agents/skills/lnwjud-scheduled-continuation');
    expect(config).toContain('to: agent-skills/lnwjud-scheduled-continuation');
    await access(path.join(repositoryRoot, '.agents', 'skills', 'lnwjud-scheduled-continuation', 'SKILL.md'));
    expect(desktopPackage.scripts?.['package:windows']).toContain('prepare-ripgrep.ps1');
    expect(desktopPackage.scripts?.['package:windows']).toContain('../../scripts/prepare-windows-ocr.ps1');
    const prepareOcr = await readFile(path.join(repositoryRoot, 'scripts', 'prepare-windows-ocr.ps1'), 'utf8');
    expect(prepareOcr).toContain('--list-sdks');
    expect(prepareOcr).toContain('Core installer/portable packaging will continue without OCR.');
    const registerOcr = await readFile(path.join(repositoryRoot, 'scripts', 'register-windows-ocr.ps1'), 'utf8');
    expect(registerOcr).toContain("GetEnvironmentVariable('ProgramFiles(x86)')");
    expect(registerOcr).not.toContain('C:\\Program Files (x86)\\Windows Kits');
    await access(path.join(desktopRoot, 'build', 'lnwjud-node.exe'));
    const stdioLauncher = await readFile(path.join(desktopRoot, 'build', 'lnwjud-mcp-stdio.cmd'), 'utf8');
    expect(stdioLauncher).toContain('lnwjud-node.exe');
    expect(stdioLauncher).toContain('RIPGREP_DIR');
    expect(stdioLauncher).toContain('runtime-tools\\ripgrep');
    expect(stdioLauncher).toContain('set "PATH=%RIPGREP_DIR%;%PATH%"');
    expect(stdioLauncher).toContain('no system Node.js is required');
    expect(stdioLauncher).not.toContain(path.win32.join('%ProgramFiles%', 'nodejs'));
    expect(stdioLauncher).not.toContain(path.win32.join('%LOCALAPPDATA%', 'Programs', 'nodejs'));
    expect(stdioLauncher).not.toContain('set "NODE_EXE=node"');
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
    const prepareTunnel = await readFile(path.join(desktopRoot, 'scripts', 'prepare-tunnel-client.ps1'), 'utf8');
    expect(prepareRipgrep).toContain("$version = '15.2.0'");
    expect(prepareRipgrep).toContain('ripgrep-$version-x86_64-pc-windows-msvc.zip');
    expect(prepareRipgrep).toContain("$expectedSha256 = '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5'");
    expect(prepareRipgrep).toContain("'runtime-tools\\ripgrep'");
    expect(prepareRipgrep).toContain("'BUNDLED_RIPGREP.txt'");
    expect(prepareRipgrep).toContain("-Filter 'rg.exe'");

    expect(prepareTunnel).toContain("$version = '0.0.13'");
    expect(prepareTunnel).toContain('tunnel-client-v$version-windows-amd64.zip');
    expect(prepareTunnel).toContain("$expectedSha256 = '17113162b353906bbb884c3ed7620facba5cc72b5fdc94fd54fd7208c7166edb'");
    for (const required of ['tunnel-client.exe', 'cloudflared.exe', 'cloudflared-manifest.json', 'LICENSE', 'NOTICE', 'windows-amd64-licenses.txt', 'windows-amd64.spdx.json', 'BUNDLED_TUNNEL_CLIENT.txt']) {
      expect(prepareTunnel).toContain(required);
    }
    expect(prepareTunnel).toContain('Remove-Item -LiteralPath $zipPath -Force');
    expect(prepareTunnel).toContain('archive_files=');
    expect(prepareTunnel).toContain('cloudflared_manifest_sha256=');

    for (const script of [prepareRipgrep, prepareTunnel]) {
      expect(script).toContain('[System.Security.Cryptography.SHA256]::Create()');
      expect(script).not.toContain('Get-FileHash');
    }
  });

  it('runs the stdio launcher with the bundled Node runtime even when PATH contains no system Node', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-packaged-stdio-'));
    const launcher = path.join(desktopRoot, 'build', 'lnwjud-mcp-stdio.cmd');
    const systemRoot = process.env.SystemRoot ?? path.win32.join(`C:${path.win32.sep}`, 'Windows');
    const commandProcessor = process.env.ComSpec ?? path.join(systemRoot, 'System32', 'cmd.exe');
    const child = spawn(commandProcessor, ['/d', '/c', 'call', launcher, '--workspace', repositoryRoot], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        PATH: [path.join(systemRoot, 'System32'), path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'), path.join(systemRoot, 'System32', 'Wbem')].join(path.delimiter),
        LNWJUD_DATA_PATH: dataPath,
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`stdio launcher did not become ready: ${stderr}`)), 20_000);
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
          stderr += chunk;
          if (!stderr.includes('lnwjud MCP stdio ready ')) return;
          clearTimeout(timer);
          resolve();
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code) => {
          if (stderr.includes('lnwjud MCP stdio ready ')) return;
          clearTimeout(timer);
          reject(new Error(`stdio launcher exited early with ${String(code)}: ${stderr}`));
        });
      });
      expect(stderr).toContain('lnwjud MCP stdio ready ');
    } finally {
      if (child.exitCode === null && child.pid !== undefined) {
        const taskkill = spawn(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        await new Promise<void>((resolve) => taskkill.once('exit', () => resolve()));
        if (child.exitCode === null) await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      await rm(dataPath, { recursive: true, force: true });
    }
  }, 30_000);

  it('defines a dedicated Portable update manifest instead of reusing the Installer feed', async () => {
    const manifestScript = await readFile(path.join(desktopRoot, 'scripts', 'write-portable-update-manifest.mjs'), 'utf8');
    expect(manifestScript).toContain('lnwjud-Portable-${version}.exe');
    expect(manifestScript).toContain("createHash('sha512')");
    expect(manifestScript).toContain('size: ${metadata.size}');
    expect(manifestScript).toContain("'portable.yml'");
    expect(manifestScript).not.toContain('lnwjud-Setup-${version}.exe');
  });
});
