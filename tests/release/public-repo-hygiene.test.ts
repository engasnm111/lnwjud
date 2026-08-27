import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

async function trackedFiles(): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.split('\0').filter(Boolean).map((entry) => entry.replaceAll('\\', '/'));
}

describe('public repository hygiene', () => {
  it('ignores exported lnwjud diagnostic text logs at the repository root', async () => {
    const ignore = await readFile(path.join(repositoryRoot, '.gitignore'), 'utf8');
    expect(ignore).toContain('lnwjud-*-logs.txt');
  });

  it('does not track generated stdio bundles', async () => {
    const tracked = await trackedFiles();
    const generated = [
      'apps/desktop/build/lnwjud-mcp-stdio.cjs',
      'apps/desktop/build/lnwjud-mcp-stdio.cmd',
      'apps/desktop/build/lnwjud-mcp-stdio.mjs',
      'apps/desktop/build/lnwjud-node.exe',
    ];

    for (const file of generated) {
      expect(tracked, `${file} must be generated during build, not committed`).not.toContain(file);
    }
  });

  it('does not publish developer-specific paths or private project names', async () => {
    const tracked = await trackedFiles();
    const textExtensions = new Set([
      '.cjs', '.cmd', '.css', '.html', '.js', '.json', '.md', '.mjs', '.ps1', '.py', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml',
    ]);
    const forbidden = [
      new RegExp(['Zenith', ' sphere'].join(''), 'i'),
      new RegExp(['rsn-ayb-', 'pc-planning'].join(''), 'i'),
      new RegExp(['C:', '\\\\', 'Users', '\\\\', 'developer'].join(''), 'i'),
      new RegExp(['\\.gemini', '\\\\', 'antigravity'].join(''), 'i'),
    ];
    const leaks: string[] = [];

    for (const relativePath of tracked) {
      if (!textExtensions.has(path.extname(relativePath).toLowerCase())) continue;
      const content = await readFile(path.join(repositoryRoot, relativePath), 'utf8');
      if (forbidden.some((pattern) => pattern.test(content))) leaks.push(relativePath);
    }

    expect(leaks, `developer-specific content found in: ${leaks.join(', ')}`).toEqual([]);
  });

  it('documents the package version as the current v4 runtime rather than a stale release', async () => {
    const readme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
    const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as { version?: unknown };
    expect(typeof rootPackage.version).toBe('string');
    const version = rootPackage.version as string;

    expect(readme).toContain(`## Current version: v${version}`);
    expect(readme).toContain(`The v${version} release target and runtime contract`);
    expect(readme).toContain(`Current Windows 10/11 x64 artifacts are \`lnwjud-Setup-${version}.exe\` (recommended installer) and \`lnwjud-Portable-${version}.exe\``);
    expect(readme).toContain(`apps/desktop/dist/installers/lnwjud-Setup-${version}.exe`);
    expect(readme).toContain(`apps/desktop/dist/installers/lnwjud-Portable-${version}.exe`);
    expect(readme).not.toContain('current source/release candidate is');
    expect(readme).not.toContain('pending publication');
    expect(readme).toContain('223 configurable tools');
    expect(readme).toContain('217 advertised by default');
    expect(readme).not.toContain(['Verify the ', '184-tool catalog'].join(''));
    expect(readme).not.toContain(['current v3.0.0 catalog contains ', '184 tools'].join(''));
    expect(readme).not.toContain('packaged v3.0.0 build');
    expect(readme).not.toContain('127.0.0.1:39200/mcp');
  });

  it('does not link README readers to ignored local documentation', async () => {
    const readme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
    const tracked = new Set(await trackedFiles());
    const localDocLinks = Array.from(readme.matchAll(/\[[^\]]+\]\((docs\/[^)#]+)(?:#[^)]+)?\)/g), (match) => match[1]);
    const missing = localDocLinks.filter((link): link is string => link !== undefined && !tracked.has(link));

    expect(missing, `README links to untracked docs: ${missing.join(', ')}`).toEqual([]);
  });

  it('documents the real desktop MCP port and bundled OpenAI tunnel client', async () => {
    const envExample = await readFile(path.join(repositoryRoot, '.env.example'), 'utf8');
    const settings = await readFile(
      path.join(repositoryRoot, 'apps', 'desktop', 'src', 'renderer', 'i18n', 'messages.ts'),
      'utf8',
    );

    expect(envExample).toContain('LNWJUD_MCP_PORT=18765');
    expect(envExample).not.toContain('LNWJUD_PORT=3000');
    expect(settings).toContain('OpenAI Secure MCP Tunnel');
    expect(settings).not.toContain('Cloudflare Remote Tunnel');

    const settingsPage = await readFile(
      path.join(repositoryRoot, 'apps', 'desktop', 'src', 'renderer', 'features', 'settings', 'SettingsPage.tsx'),
      'utf8',
    );
    expect(settingsPage).toContain('Bundled v0.0.12 is used automatically');
    expect(settingsPage).toContain('Use bundled');
    expect(settingsPage).not.toContain('placeholder="C:\\tools\\tunnel-client.exe"');
  });

  it('does not retain stale permission examples in the detailed README guide', async () => {
    const readme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
    expect(readme).not.toContain('| workspace_list | DANGEROUS |');
    expect(readme).toContain('| workspace_list | EXECUTE |');
  });
});
