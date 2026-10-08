import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundledRuntimeToolDirectories, prependBundledRuntimeToolsToPath } from '../src/main/runtime-tools.js';
import { resolveBundledTunnelClientPath } from '../src/main/desktop-services.js';

describe('bundled target-native runtime tools', () => {
  it('resolves ripgrep and tunnel-client directories under Windows Electron resources', () => {
    expect(bundledRuntimeToolDirectories('C:\\Program Files\\lnwjud\\resources', 'win32')).toEqual([
      path.win32.join('C:\\Program Files\\lnwjud\\resources', 'runtime-tools', 'ripgrep'),
      path.win32.join('C:\\Program Files\\lnwjud\\resources', 'tunnel-client'),
    ]);
  });

  it('prepends an existing bundled tool directory without dropping the system PATH', () => {
    const environment: NodeJS.ProcessEnv = { Path: ['C:\\Windows\\System32', 'C:\\Tools'].join(';') };
    const resources = 'C:\\Program Files\\lnwjud\\resources';
    const bundled = path.win32.join(resources, 'runtime-tools', 'ripgrep');

    expect(prependBundledRuntimeToolsToPath(environment, resources, (candidate) => candidate === bundled, 'win32')).toEqual([bundled]);
    expect(environment.Path?.split(';')).toEqual([bundled, 'C:\\Windows\\System32', 'C:\\Tools']);
  });

  it('uses POSIX separators and PATH when simulating a macOS package on Windows', () => {
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    const resources = '/Applications/lnwjud.app/Contents/Resources';
    const ripgrep = '/Applications/lnwjud.app/Contents/Resources/runtime-tools/ripgrep';
    const tunnel = '/Applications/lnwjud.app/Contents/Resources/tunnel-client';

    expect(prependBundledRuntimeToolsToPath(environment, resources, (candidate) => candidate === ripgrep || candidate === tunnel, 'darwin')).toEqual([ripgrep, tunnel]);
    expect(environment.PATH).toBe(`${ripgrep}:${tunnel}:/usr/bin:/bin`);
  });

  it('does not mutate PATH when the bundled tool directory is absent', () => {
    const environment: NodeJS.ProcessEnv = { Path: 'C:\\Windows\\System32' };
    expect(prependBundledRuntimeToolsToPath(environment, 'C:\\missing', () => false, 'win32')).toEqual([]);
    expect(environment.Path).toBe('C:\\Windows\\System32');
  });

  it('accepts only a manifest-matched bundled tunnel executable', async () => {
    const runtimeDependencies = JSON.parse(await readFile(
      new URL('../src/main/runtime-dependencies.json', import.meta.url), 'utf8',
    )) as { tunnelClient: { version: string; provenanceAsset: string } };
    const { version, provenanceAsset } = runtimeDependencies.tunnelClient;
    const prefix = `tunnel-client-v${version}-windows-amd64`;
    const asset = `${prefix}.zip`;
    const licenseAsset = `${prefix}-licenses.txt`;
    const spdxAsset = `${prefix}.spdx.json`;
    const resources = await mkdtemp(path.join(process.cwd(), '.lnwjud-bundled-tunnel-'));
    const directory = path.join(resources, 'tunnel-client');
    const executable = path.join(directory, 'tunnel-client.exe');
    try {
      await mkdir(directory, { recursive: true });
      const bytes = Buffer.from('fixture tunnel client');
      await writeFile(executable, bytes);
      for (const evidence of [asset, licenseAsset, spdxAsset, provenanceAsset]) {
        await writeFile(path.join(directory, evidence), 'evidence', 'utf8');
      }
      const manifest = {
        schemaVersion: 1,
        product: 'lnwjud',
        version,
        platform: 'win32',
        arch: 'x64',
        asset,
        licenseAsset,
        spdxAsset,
        provenanceAsset,
        executable: 'tunnel-client.exe',
        assetSha256: 'a'.repeat(64),
        executableSha256: createHash('sha256').update(bytes).digest('hex'),
        verified: { archiveSha256: true, executableVersion: true, executableBit: false },
      };
      await writeFile(path.join(directory, 'BUNDLED_TUNNEL_CLIENT.json'), JSON.stringify(manifest), 'utf8');
      expect(resolveBundledTunnelClientPath({ resourcesPath: resources, platform: 'win32', architecture: 'x64' })).toBe(executable);
      // The release ZIP is verified during staging and retained in the vendor
      // cache; it is not shipped inside the installed application. Runtime
      // integrity must therefore rely on the executable hash and bundled
      // license/SPDX/provenance evidence rather than requiring that archive.
      await rm(path.join(directory, asset));
      expect(resolveBundledTunnelClientPath({ resourcesPath: resources, platform: 'win32', architecture: 'x64' })).toBe(executable);
      await rm(path.join(directory, provenanceAsset));
      expect(resolveBundledTunnelClientPath({ resourcesPath: resources, platform: 'win32', architecture: 'x64' })).toBeNull();
      await writeFile(path.join(directory, provenanceAsset), 'evidence', 'utf8');
      await writeFile(path.join(directory, 'BUNDLED_TUNNEL_CLIENT.json'), JSON.stringify({
        ...manifest,
        version: '0.0.12',
      }), 'utf8');
      expect(resolveBundledTunnelClientPath({ resourcesPath: resources, platform: 'win32', architecture: 'x64' })).toBeNull();
      await writeFile(path.join(directory, 'BUNDLED_TUNNEL_CLIENT.json'), JSON.stringify(manifest), 'utf8');
      expect(resolveBundledTunnelClientPath({ resourcesPath: resources, platform: 'win32', architecture: 'x64' })).toBe(executable);
      await writeFile(executable, Buffer.from('tampered tunnel client'));
      expect(resolveBundledTunnelClientPath({ resourcesPath: resources, platform: 'win32', architecture: 'x64' })).toBeNull();
    } finally {
      await rm(resources, { recursive: true, force: true });
    }
    await expect(readFile(executable)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
