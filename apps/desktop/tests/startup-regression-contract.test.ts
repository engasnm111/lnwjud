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
    const secretBootstrap = section(
      'async function resolveDesktopRuntimeSecrets',
      'async function migrateV3SafeStorageSecrets',
    );
    const nativeRuntime = section('async function createNativeDesktopRuntime', 'function createElectronNativeCapabilityApi');
    expect(secretBootstrap).toContain('new CheckpointKeyStore');
    expect(secretBootstrap).toContain('.loadOrCreate()');
    expect(nativeRuntime).toContain('resolveDesktopRuntimeSecrets(dataPath)');
    expect(secretBootstrap).toContain('checkpointEncryptionKey');
  });

  it('routes migrated v3 tunnel secrets through safeStorage before legacy migration', () => {
    const resolver = section('async function resolveDesktopRuntimeSecrets', 'async function migrateV3SafeStorageSecrets');
    const migration = section('async function migrateV3SafeStorageSecrets', 'async function readTrustedSecretFile');
    expect(resolver).toContain('await migrateV3SafeStorageSecrets(dataPath, secretProtector);');
    expect(resolver.indexOf('migrateV3SafeStorageSecrets')).toBeLessThan(resolver.indexOf('migrateLegacyWindowsSecrets'));
    expect(migration).toContain('decryptV3WindowsSafeStorageSecretIfPresent(tunnelEnvelope, safeStorage)');
    expect(migration).toContain("secretProtector.encrypt('tunnel_api_key'");
    expect(migration).not.toContain('unprotectTunnelSecret');
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

  it('selects the configured user-data path before acquiring the instance lock', () => {
    const instances = section('const holdsSingleInstanceLock', 'if (!gotInstanceLock');
    expect(instances.indexOf('configureUserDataPath()')).toBeLessThan(instances.indexOf('app.requestSingleInstanceLock()'));
    expect(source).toContain('const dataPath = configuredDataPath ?? configureUserDataPath();');
  });

  it('fails stdio startup explicitly if checkpoint/runtime bootstrap rejects', () => {
    const stdio = section('function bootstrapMcpStdio', 'function applyDesktopUserSettings');
    expect(stdio).toContain('resolveDesktopRuntimeSecrets(dataPath)');
    expect(stdio).toContain('lnwjud MCP stdio startup failed:');
    expect(stdio).toContain('app.quit();');
  });
});
