import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(import.meta.dirname, '..', '..', 'apps', 'desktop');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');

describe('Windows desktop packaging', () => {
  it('pins the product release to v4.9.1', async () => {
    const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as { version?: unknown };
    const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8')) as { version?: unknown };
    expect(rootPackage.version).toBe('4.9.1');
    expect(desktopPackage.version).toBe('4.9.1');
  });

  it('publishes complete desktop application metadata', async () => {
    const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8')) as {
      description?: unknown;
      author?: unknown;
      homepage?: unknown;
      repository?: { type?: unknown; url?: unknown };
    };

    expect(desktopPackage.description).toBe('Windows-first local AI-agent runtime and MCP gateway with 214 configurable tools.');
    expect(desktopPackage.author).toBe('Adisorn');
    expect(desktopPackage.homepage).toBe('https://github.com/engasnm111/lnwjud#readme');
    expect(desktopPackage.repository).toEqual({ type: 'git', url: 'https://github.com/engasnm111/lnwjud.git' });
  });

  it('declares lnwjud x64 NSIS packaging and built runtime bundles', async () => {
    const configPath = path.join(desktopRoot, 'electron-builder.yml');
    const config = await readFile(configPath, 'utf8');

    expect(config).toContain('productName: lnwjud');
    expect(config).toContain('output: dist/installers');
    expect(config).toContain('target: nsis');
    expect(config).toContain('- x64');
    expect(config).toContain('icon: build/icon.ico');
    expect(config).toContain('signAndEditExecutable: true');
    expect(config).not.toContain('signAndEditExecutable: false');
    expect(config).toContain('createStartMenuShortcut: false');
    expect(config).not.toMatch(/[A-Z]:\\Users\\[^\r\n]+/i);
    const installerScript = await readFile(path.join(desktopRoot, 'build', 'installer.nsh'), 'utf8');
    expect(installerScript).toContain('CreateShortCut "$SMPROGRAMS\\lnwjud.lnk" "$INSTDIR\\lnwjud.exe"');
    expect(installerScript).toContain('SetOutPath "$INSTDIR"');
    expect(installerScript).not.toMatch(/[A-Z]:\\Users\\[^\r\n]+/i);
    expect(config).toContain('extraResources:');
    expect(config).toContain('windows-capability-bridge.ps1');
    expect(config).toContain('build/lnwjud-node.exe');
    expect(config).toContain('to: lnwjud-node.exe');
    if (process.platform === 'win32') {
      await access(path.join(desktopRoot, 'build', 'lnwjud-node.exe'));
    } else {
      await access(path.join(desktopRoot, 'build', 'lnwjud-node'));
    }
    const stdioLauncher = await readFile(path.join(desktopRoot, 'build', 'lnwjud-mcp-stdio.cmd'), 'utf8');
    expect(stdioLauncher).toContain('lnwjud-node.exe');
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
    expect(tunnelBundle).toContain('LNWJUD_DATA_PATH');
    expect(tunnelBundle).toContain('LNWJUD_UNRESTRICTED');
    expect(mainBundle).toMatch(/setPath\(["']userData["']/);
  });

  it.runIf(process.platform === 'win32')('runs the stdio launcher with the bundled Node runtime even when PATH contains no system Node', async () => {
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
