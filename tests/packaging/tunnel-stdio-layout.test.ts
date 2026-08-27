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
  it('ships one canonical stdio runtime beside the app binary per platform, never duplicated under resources', async () => {
    const config = await readFile(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');
    const sharedResources = section(config, 'extraResources', 'extraFiles');
    const sharedFiles = section(config, 'extraFiles', 'win');
    const windowsBlock = section(config, 'win', 'nsis');
    const macBlock = section(config, 'mac', 'dmg');

    // The MCP bundle itself is platform-neutral and ships beside the binary.
    expect(sharedResources).not.toContain('to: lnwjud-mcp-stdio.cjs');
    expect(sharedFiles).toContain('to: lnwjud-mcp-stdio.cjs');

    // Windows launchers live only in the win block; macOS launchers only in mac.
    for (const artifact of ['lnwjud-mcp-stdio.cmd', 'lnwjud-node.exe']) {
      expect(sharedResources).not.toContain(`to: ${artifact}`);
      expect(sharedFiles).not.toContain(`to: ${artifact}`);
      expect(windowsBlock).toContain(`to: ${artifact}`);
      expect(macBlock).not.toContain(`to: ${artifact}`);
    }
    for (const artifact of ['lnwjud-mcp-stdio', 'lnwjud-node']) {
      expect(macBlock).toContain(`to: ${artifact}`);
      expect(windowsBlock).not.toContain(`to: ${artifact}\n`);
    }

    // Every launcher artifact is staged exactly once from the build folder.
    for (const artifact of ['lnwjud-mcp-stdio.cmd', 'lnwjud-mcp-stdio', 'lnwjud-mcp-stdio.cjs', 'lnwjud-node.exe', 'lnwjud-node']) {
      expect(config.match(new RegExp(`from: build/${artifact.replaceAll('.', '\\.')}$`, 'gm')) ?? []).toHaveLength(1);
    }
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
});
