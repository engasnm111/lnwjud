import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');

function section(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('desktop packaged startup regression contract', () => {
  it('loads v3 safeStorage checkpoint keys before constructing native runtimes', () => {
    const nativeRuntime = section(
      'function createNativeDesktopRuntime',
      'function bootstrapDesktop',
    );
    expect(nativeRuntime).toContain('loadV3CheckpointKeyIfPresent(dataPath, safeStorage)');
    expect(nativeRuntime).toContain('checkpointEncryptionKey');
  });

  it('creates the desktop window before background MCP auto-start', () => {
    const desktop = section('function bootstrapDesktop', 'function bootstrapLogViewerOnly');
    const windowIndex = desktop.indexOf('createDesktopWindow();');
    const mcpIndex = desktop.indexOf('void runtime.autoStartMcp().catch');
    expect(windowIndex).toBeGreaterThanOrEqual(0);
    expect(mcpIndex).toBeGreaterThan(windowIndex);
  });

  it('turns startup rejection into a reported quit instead of a ghost process', () => {
    const desktop = section('function bootstrapDesktop', 'function bootstrapLogViewerOnly');
    expect(desktop).toContain(".catch((error: unknown) => handleDesktopStartupFailure('desktop', error))");
    expect(source).toContain("dialog.showErrorBox('lnwjud failed to start'");
    expect(source).toContain('app.quit();');
  });

  it('reveals the existing main window for a second instance', () => {
    const instances = section('const gotInstanceLock', 'if (wantsMcpStdio');
    expect(instances).toContain("app.on('second-instance'");
    expect(instances).toContain('revealMainWindow();');
  });

  it('fails stdio startup explicitly if checkpoint/runtime bootstrap rejects', () => {
    const stdio = section('function bootstrapMcpStdio', 'function applyDesktopUserSettings');
    expect(stdio).toContain('loadV3CheckpointKeyIfPresent(dataPath, safeStorage)');
    expect(stdio).toContain('lnwjud MCP stdio startup failed:');
    expect(stdio).toContain('app.quit();');
  });
});
