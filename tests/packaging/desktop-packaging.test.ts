import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(import.meta.dirname, '..', '..', 'apps', 'desktop');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');

describe('Windows desktop packaging', () => {
  it('pins the product release to v4.12.0', async () => {
    const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as { version?: unknown };
    const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8')) as { version?: unknown };
    expect(rootPackage.version).toBe('4.12.0');
    expect(desktopPackage.version).toBe('4.12.0');
  });

  it('publishes complete desktop application metadata', async () => {
    const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8')) as {
      description?: unknown;
      author?: unknown;
      homepage?: unknown;
      repository?: { type?: unknown; url?: unknown };
    };

    expect(desktopPackage.description).toBe('Windows-first local AI-agent runtime and MCP gateway with 223 configurable tools.');
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
    expect(config).toContain('windows-capability-bridge.ps1');
    expect(config).toContain('build/lnwjud-node.exe');
    expect(config).toContain('to: lnwjud-node.exe');
    expect(config).toContain('build/runtime-tools');
    expect(config).toContain('to: runtime-tools');
    expect(desktopPackage.scripts?.['package:windows']).toContain('prepare-ripgrep.ps1');
    expect(desktopPackage.scripts?.['package:windows']).toContain('../../scripts/prepare-windows-ocr.ps1');
    const prepareOcr = await readFile(path.join(repositoryRoot, 'scripts', 'prepare-windows-ocr.ps1'), 'utf8');
    expect(prepareOcr).toContain('--list-sdks');
    expect(prepareOcr).toContain('Core installer/portable packaging will continue without OCR.');
    const registerOcr = await readFile(path.join(repositoryRoot, 'scripts', 'register-windows-ocr.ps1'), 'utf8');
    expect(registerOcr).toContain("GetEnvironmentVariable('ProgramFiles(x86)')");
    expect(registerOcr).not.toContain('C:\\Program Files (x86)\\Windows Kits');
    const bundledNodeName = process.platform === 'win32' ? 'lnwjud-node.exe' : 'lnwjud-node';
    await access(path.join(desktopRoot, 'build', bundledNodeName));
    await access(path.join(desktopRoot, 'build', 'lnwjud-mcp-stdio.cjs'));
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

  it('declares macOS DMG and ZIP packaging alongside the Windows targets', async () => {
    const configPath = path.join(desktopRoot, 'electron-builder.yml');
    const config = await readFile(configPath, 'utf8');
    const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };

    expect(desktopPackage.scripts?.['package:mac']).toContain('--mac --publish never');
    expect(config).toContain('mac:');
    expect(config).toContain('target: dmg');
    expect(config).toContain('target: zip');
    expect(config).toMatch(/- arm64/);
    expect(config).toContain('icon: build/icon.png');
    expect(config).toContain('category: public.app-category.developer-tools');
    expect(config).toContain('darkModeSupport: true');
    expect(config).toContain('artifactName: lnwjud-${version}-${arch}.${ext}');
    expect(config).toContain('dmg:');
    expect(config).toContain('artifactName: lnwjud-${version}-${arch}.dmg');

    // POSIX bundles ship an executable stdio launcher mirroring the Windows .cmd one.
    const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(rootPackage.scripts?.['package:macos']).toContain('@lnwjud/desktop package:mac');
    const launcherScript = await readFile(path.join(desktopRoot, 'scripts', 'write-stdio-launcher.mjs'), 'utf8');
    expect(launcherScript).toContain('#!/bin/sh');
    expect(launcherScript).toContain('lnwjud-mcp-stdio.cjs');
    expect(launcherScript).not.toContain("process.platform !== 'win32') throw");
  });

  it('bundles the pinned OpenAI tunnel-client v0.0.13 for Windows and universal macOS', async () => {
    const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const macPrepare = await readFile(path.join(desktopRoot, 'scripts', 'prepare-tunnel-client.mjs'), 'utf8');
    const windowsPrepare = await readFile(path.join(desktopRoot, 'scripts', 'prepare-tunnel-client.ps1'), 'utf8');

    expect(desktopPackage.scripts?.['package:mac']).toContain('node scripts/prepare-tunnel-client.mjs');
    expect(macPrepare).toContain("const version = '0.0.13'");
    expect(macPrepare).toContain('15abf165f06050af642c948ba6bd6c905191dc5420a9422dadde2b49d892e2c6');
    expect(macPrepare).toContain('c683e15d84fb997f5af1cc7c4cb55008e19a555a9ed2ec0f89a5ff426d85f85c');
    expect(macPrepare).toContain("BINARIES = ['tunnel-client', 'cloudflared']");
    expect(macPrepare).toContain("'lipo'");
    expect(macPrepare).toContain('BUNDLED_TUNNEL_CLIENT.txt');

    // Windows stays pinned to the same upstream release for parity.
    expect(windowsPrepare).toContain("$version = '0.0.13'");
    expect(windowsPrepare).toContain('17113162b353906bbb884c3ed7620facba5cc72b5fdc94fd54fd7208c7166edb');
  });

  it('bundles a pinned universal macOS ripgrep runtime for packaged search', async () => {
    const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const prepare = await readFile(path.join(desktopRoot, 'scripts', 'prepare-ripgrep.mjs'), 'utf8');

    expect(desktopPackage.scripts?.['package:mac']).toContain('node scripts/prepare-ripgrep.mjs');
    expect(prepare).toContain("$version = '15.2.0'".replace('$version', 'version'));
    expect(prepare).toContain('3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4');
    expect(prepare).toContain('af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1');
    expect(prepare).toContain("'lipo'");
    expect(prepare).toContain('BUNDLED_RIPGREP.txt');
    expect(prepare).toContain("'runtime-tools', 'ripgrep'");
  });

  it('targets Windows 10 OCR through the .NET 8 Windows TFM without the legacy SDK contracts package', async () => {
    const ocrProject = await readFile(path.join(repositoryRoot, 'native', 'windows-ocr', 'lnwjud-windows-ocr.csproj'), 'utf8');
    expect(ocrProject).toContain('<TargetFramework>net8.0-windows10.0.19041.0</TargetFramework>');
    expect(ocrProject).not.toContain('Microsoft.Windows.SDK.Contracts');
    expect(ocrProject).not.toContain('10.0.28000');
  });

  it('pins and verifies the official Windows x64 ripgrep runtime used by packaged search', async () => {
    const prepareRipgrep = await readFile(path.join(desktopRoot, 'scripts', 'prepare-ripgrep.ps1'), 'utf8');
    expect(prepareRipgrep).toContain("$version = '15.2.0'");
    expect(prepareRipgrep).toContain('ripgrep-$version-x86_64-pc-windows-msvc.zip');
    expect(prepareRipgrep).toContain("$expectedSha256 = '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5'");
    expect(prepareRipgrep).toContain("'runtime-tools\\ripgrep'");
    expect(prepareRipgrep).toContain("'BUNDLED_RIPGREP.txt'");
    expect(prepareRipgrep).toContain("-Filter 'rg.exe'");
  });

  it.skipIf(process.platform !== 'win32')('runs the stdio launcher with the bundled Node runtime even when PATH contains no system Node', async () => {
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

  it.runIf(process.platform !== 'win32')('runs the POSIX stdio launcher with the bundled Node runtime', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-packaged-stdio-'));
    const launcher = path.join(desktopRoot, 'build', 'lnwjud-mcp-stdio');
    const child = spawn(launcher, ['--workspace', repositoryRoot], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LNWJUD_DATA_PATH: dataPath,
      },
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
        child.kill('SIGTERM');
        if (child.exitCode === null) await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      await rm(dataPath, { recursive: true, force: true });
    }
  }, 30_000);
});
