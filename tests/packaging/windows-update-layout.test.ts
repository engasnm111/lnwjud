import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Standalone Node packaging module.
import { hasWindowsSlotLayout, materializeWindowsSlotLayout, prepareWindowsUpdateLayout, verifyWindowsUpdatePayloadAsset, windowsRuntimePath } from '../../apps/desktop/scripts/windows-update-layout.mjs';
// @ts-expect-error Standalone Node trust module.
import { verifyPreparedInstalledLayout } from '../../scripts/update-trust/prepare-installed-layout.mjs';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ rootDirectory: string; outputDirectory: string; version: string }> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-slot-package-')));
  roots.push(base);
  const rootDirectory = path.join(base, 'win-unpacked');
  const outputDirectory = path.join(base, 'installers');
  for (const directory of ['resources/native-containment', 'resources/update-worker', 'resources/app.asar.unpacked']) {
    await mkdir(path.join(rootDirectory, directory), { recursive: true });
  }
  await mkdir(outputDirectory);
  for (const [relative, content] of Object.entries({
    'lnwjud.exe': 'signed Electron application',
    'lnwjud-update-launcher.exe': 'signed stable launcher',
    'lnwjud-mcp-stdio.cmd': '"%~dp0lnwjud.exe" --mcp-stdio %*',
    'resources/app.asar': 'application archive',
    'resources/app.asar.unpacked/native.node': 'native extension',
    'resources/native-containment/lnwjud-containment.exe': 'signed service',
    'resources/update-worker/lnwjud-update-worker.cjs': 'worker entrypoint',
    'LICENSE.electron.txt': 'license',
    'empty.txt': '',
  })) await writeFile(path.join(rootDirectory, relative), content);
  return { rootDirectory, outputDirectory, version: '5.9.1' };
}

describe('Windows baseline and native update packaging', () => {
  it('keeps the signed launcher and STDIO entrypoint stable while moving the complete Electron tree into slot A', async () => {
    const { rootDirectory } = await fixture();
    expect(await hasWindowsSlotLayout(rootDirectory)).toBe(false);
    await materializeWindowsSlotLayout(rootDirectory);
    expect(await readFile(path.join(rootDirectory, 'lnwjud.exe'), 'utf8')).toBe('signed stable launcher');
    expect(await readFile(path.join(rootDirectory, 'slots/A/lnwjud.exe'), 'utf8')).toBe('signed Electron application');
    expect(await readFile(path.join(rootDirectory, 'lnwjud-mcp-stdio.cmd'), 'utf8')).toContain('--mcp-stdio');
    expect(await readFile(path.join(rootDirectory, 'slots/A/resources/app.asar.unpacked/native.node'), 'utf8')).toBe('native extension');
    expect((await readdir(rootDirectory)).sort()).toEqual(['lnwjud-mcp-stdio.cmd', 'lnwjud.exe', 'resources', 'slots']);
    expect((await readdir(path.join(rootDirectory, 'resources'))).sort()).toEqual(['native-containment', 'update-worker']);
    for (const name of ['native-containment/lnwjud-containment.exe', 'update-worker/lnwjud-update-worker.cjs']) {
      expect(await readFile(path.join(rootDirectory, 'resources', name))).toEqual(await readFile(path.join(rootDirectory, 'slots/A/resources', name)));
    }
    await materializeWindowsSlotLayout(rootDirectory);
    expect(await hasWindowsSlotLayout(rootDirectory)).toBe(true);
    expect(await readFile(path.join(rootDirectory, 'slots/A/lnwjud.exe'), 'utf8')).toBe('signed Electron application');
  });

  it('rejects partial slot layouts and linked inputs before moving application files', async () => {
    const first = await fixture();
    await mkdir(path.join(first.rootDirectory, 'slots'));
    await expect(materializeWindowsSlotLayout(first.rootDirectory)).rejects.toThrow();
    expect(await readFile(path.join(first.rootDirectory, 'lnwjud.exe'), 'utf8')).toBe('signed Electron application');
    const second = await fixture();
    await link(path.join(second.rootDirectory, 'resources/app.asar'), path.join(second.rootDirectory, 'alias'));
    await expect(materializeWindowsSlotLayout(second.rootDirectory)).rejects.toThrow('WINDOWS_UPDATE_LAYOUT_REFUSED');
    expect(await readFile(path.join(second.rootDirectory, 'lnwjud.exe'), 'utf8')).toBe('signed Electron application');
  });

  it('maps only application resources into slots while retaining native authority paths', () => {
    expect(windowsRuntimePath('lnwjud.exe')).toBe('slots/A/lnwjud.exe');
    expect(windowsRuntimePath('resources/windows-capability-bridge.ps1')).toBe('slots/A/resources/windows-capability-bridge.ps1');
    expect(windowsRuntimePath('lnwjud-mcp-stdio.cmd')).toBe('lnwjud-mcp-stdio.cmd');
    expect(windowsRuntimePath('resources/native-containment/update-attestation/gh.exe')).toBe('resources/native-containment/update-attestation/gh.exe');
    expect(windowsRuntimePath('resources/update-worker/lnwjud-update-worker.cjs')).toBe('resources/update-worker/lnwjud-update-worker.cjs');
  });

  it.skipIf(process.platform !== 'win32')('produces a reproducible exact-file ZIP and independently verifiable installed baseline', async () => {
    const f = await fixture();
    const first = await prepareWindowsUpdateLayout(f);
    const archive = await readFile(path.join(f.outputDirectory, first.updatePayload.name));
    expect(first.updatePayload).toEqual({
      name: 'lnwjud-Update-5.9.1-win32-x64.zip', sizeBytes: String(archive.length),
      sha256: createHash('sha256').update(archive).digest('hex'),
    });
    expect(await verifyPreparedInstalledLayout({ ...f, platform: 'win32', architecture: 'x64' })).toEqual(first.installedLayout);
    const { Open } = createRequire(path.resolve(import.meta.dirname, '../../apps/desktop/package.json'))('unzipper');
    const entries = (await Open.file(path.join(f.outputDirectory, first.updatePayload.name))).files;
    const expected = ['LICENSE.electron.txt', 'empty.txt', 'lnwjud.exe', 'manifest.json', 'resources/app.asar',
      'resources/app.asar.unpacked/native.node', 'resources/native-containment/lnwjud-containment.exe',
      'resources/update-worker/lnwjud-update-worker.cjs'];
    expect(entries.map((entry: { path: string }) => entry.path).sort()).toEqual(expected.sort());
    expect(entries.every((entry: { type: string }) => entry.type === 'File')).toBe(true);
    expect(await entries.find((entry: { path: string }) => entry.path === 'lnwjud.exe')!.buffer()).toEqual(Buffer.from('signed Electron application'));
    expect(await prepareWindowsUpdateLayout(f)).toEqual(first);
    await verifyWindowsUpdatePayloadAsset(f.outputDirectory, first.updatePayload, f.version);
    await writeFile(path.join(f.outputDirectory, first.updatePayload.name), 'tampered');
    await expect(verifyWindowsUpdatePayloadAsset(f.outputDirectory, first.updatePayload, f.version)).rejects.toThrow('WINDOWS_UPDATE_LAYOUT_REFUSED');
  }, 20_000);

  it('rejects output inside the application and identities for a different version', async () => {
    const f = await fixture();
    await expect(prepareWindowsUpdateLayout({ ...f, outputDirectory: f.rootDirectory })).rejects.toThrow('WINDOWS_UPDATE_LAYOUT_REFUSED');
    await expect(verifyWindowsUpdatePayloadAsset(f.outputDirectory, {
      name: 'lnwjud-Update-5.9.0-win32-x64.zip', sizeBytes: '1', sha256: 'a'.repeat(64),
    }, f.version)).rejects.toThrow('WINDOWS_UPDATE_LAYOUT_REFUSED');
  });
});
