import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const desktopRoot = path.join(repositoryRoot, 'apps', 'desktop');

function section(config: string, start: string, end: string): string {
  const startIndex = config.indexOf(`${start}:`);
  const endIndex = config.indexOf(`\n${end}:`, startIndex + start.length + 1);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return config.slice(startIndex, endIndex);
}

describe('Secure Tunnel packaged stdio layout', () => {
  it('ships one canonical target-native stdio runtime beside the packaged app content root instead of duplicating it under resources', async () => {
    const config = await readFile(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');
    const resources = section(config, 'extraResources', 'extraFiles');
    const files = section(config, 'extraFiles', 'win');

    for (const artifact of ['lnwjud-mcp-stdio.cjs', 'lnwjud-mcp-stdio.cmd', 'lnwjud-mcp-stdio', 'lnwjud-node.exe', 'lnwjud-node']) {
      expect(resources).not.toContain(artifact);
      expect(files).toContain(`- ${artifact}`);
    }
    expect(files).toContain('from: build');
    expect(files).toContain('to: .');
  });

  it('keeps the stdio launcher self-contained instead of depending on a developer machine path or system Node', async () => {
    const launcher = await readFile(path.join(desktopRoot, 'build', 'lnwjud-mcp-stdio.cmd'), 'utf8');
    expect(launcher).toContain('set "BASE=%~dp0"');
    expect(launcher).toContain('set "NODE_EXE=%BASE%lnwjud-node.exe"');
    expect(launcher).toContain('set "SCRIPT=%BASE%lnwjud-mcp-stdio.cjs"');
    expect(launcher).not.toContain('resources\\lnwjud-node.exe');
    expect(launcher).not.toContain('resources\\lnwjud-mcp-stdio.cjs');
    expect(launcher).not.toMatch(/[A-Z]:\\(?:Users|lnwjud|src|projects)\\/i);
    expect(launcher).not.toContain('set "NODE_EXE=node"');
  });

  it('generates a POSIX launcher that stays self-contained across Linux and macOS app-bundle resource layouts', async () => {
    const source = await readFile(path.join(desktopRoot, 'scripts', 'write-stdio-launcher.mjs'), 'utf8');
    expect(source).toContain('#!/bin/sh');
    expect(source).toContain('NODE_EXE="$BASE/lnwjud-node"');
    expect(source).toContain('$BASE/resources/runtime-tools/ripgrep');
    expect(source).toContain('$BASE/Resources/runtime-tools/ripgrep');
    expect(source).toContain('exec "$NODE_EXE" "$SCRIPT" "$@"');
    expect(source).toContain('chmodSync(posixLauncherPath, 0o755)');
    expect(source).toContain('rmSync(windowsLauncherPath, { force: true })');
    expect(source).toContain('rmSync(posixLauncherPath, { force: true })');
  });

  it('keeps the cross-platform launcher generator syntactically valid on the pinned Node runtime', () => {
    const script = path.join(desktopRoot, 'scripts', 'write-stdio-launcher.mjs');
    const result = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });
});
