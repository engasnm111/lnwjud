import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TunnelController } from '../src/main/tunnel-controller.js';
import {
  buildWindowsPowerShellChildEnv,
  resolveWindowsPowerShellExecutable,
  unprotectTunnelSecret,
} from '../src/main/tunnel-secret-dpapi.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function incompatibleSecurityModuleRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-issue-17-modules-'));
  temporaryRoots.push(root);
  const moduleDirectory = path.join(root, 'Microsoft.PowerShell.Security');
  await mkdir(moduleDirectory, { recursive: true });
  await writeFile(path.join(moduleDirectory, 'Microsoft.PowerShell.Security.psd1'), `@{
RootModule = 'Missing.Security.dll'
ModuleVersion = '7.0.0.0'
CompatiblePSEditions = @('Core')
PowerShellVersion = '3.0'
CmdletsToExport = @('ConvertTo-SecureString', 'ConvertFrom-SecureString')
}
`, 'utf8');
  return root;
}

describe.runIf(process.platform === 'win32')('Tunnel Runtime API key DPAPI', () => {
  it('saves a protected key when the parent exposes a Core-only Security module', async () => {
    const dataPath = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-issue-17-data-'));
    temporaryRoots.push(dataPath);
    vi.stubEnv('APPDATA', path.join(dataPath, 'appdata'));
    vi.stubEnv('PSModulePath', await incompatibleSecurityModuleRoot());
    const controller = new TunnelController({
      getClientPath: (): null => null,
      setClientPath: (): void => undefined,
      getDataPath: (): string => dataPath,
      isExternalTunnelRunning: async (): Promise<boolean> => false,
    });
    const plaintext = `lnwjud-issue-17-${Date.now()}`;

    await expect(controller.saveApiKey(plaintext)).resolves.toBeUndefined();
    const ciphertext = await readFile(controller.secretPath(), 'utf8');
    expect(ciphertext).not.toContain(plaintext);
    await expect(unprotectTunnelSecret(ciphertext)).resolves.toBe(plaintext);
  });
});

describe('Tunnel DPAPI PowerShell child construction', () => {
  it('resolves the inbox Windows PowerShell executable without PATH lookup', () => {
    expect(resolveWindowsPowerShellExecutable({ SystemRoot: 'C:\\Windows' }))
      .toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('falls back to WINDIR when SystemRoot is absent', () => {
    expect(resolveWindowsPowerShellExecutable({ WINDIR: 'D:\\Windows' }))
      .toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('removes PSModulePath case-insensitively without mutating the parent environment', () => {
    const parent: NodeJS.ProcessEnv = {
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\fixture',
      PsMoDuLePaTh: 'C:\\PowerShell\\7\\Modules',
    };

    expect(buildWindowsPowerShellChildEnv(parent)).toEqual({
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\fixture',
    });
    expect(parent.PsMoDuLePaTh).toBe('C:\\PowerShell\\7\\Modules');
  });
});
