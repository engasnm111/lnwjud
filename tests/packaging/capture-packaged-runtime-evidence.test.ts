import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ modes: new Map<string, number>(), outputs: [] as string[] }));
// Real fixture files, canonicalization and streamed hashes; simulate POSIX modes
// on Windows and intercept only the hook's shared build output.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (file: string): Promise<import('node:fs').Stats> => {
      const metadata = await actual.lstat(file);
      const mode = state.modes.get(file);
      if (mode !== undefined) metadata.mode = (metadata.mode & ~0o777) | (mode & 0o777);
      return metadata;
    },
    mkdir: async (directory: string, options: Parameters<typeof actual.mkdir>[1]): Promise<string | undefined> => {
      if (directory === path.resolve('apps/desktop/build')) return;
      return actual.mkdir(directory, options);
    },
    writeFile: async (file: string, data: string, options: Parameters<typeof actual.writeFile>[2]): Promise<void> => {
      if (file === path.resolve('apps/desktop/build/packaged-runtime-evidence.json')) {
        state.outputs.push(data);
        return;
      }
      return actual.writeFile(file, data, options);
    },
  };
});

// @ts-expect-error Packaging hook is a standalone JavaScript module.
import capture from '../../apps/desktop/scripts/capture-packaged-runtime-evidence.mjs';
// @ts-expect-error Packaging hook is a standalone JavaScript module.
import { signPackagedMacosRuntime } from '../../apps/desktop/scripts/sign-macos-runtime.mjs';

const temporaryRoots: string[] = [];
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  state.modes.clear();
  state.outputs.length = 0;
});

async function fixture(platform: 'linux' | 'darwin', arch = 'x64'): Promise<{
  root: string; bundle: string; appOutDir: string; binaries: string[];
  nativeManifest: string; resources: string;
  put: (relative: string, text: string, mode?: number) => Promise<void>;
  context: { appOutDir: string; electronPlatformName: string; arch: number };
}> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lnwjud-hook-')));
  temporaryRoots.push(root);
  const appOutDir = path.join(root, 'output');
  const bundle = platform === 'darwin' ? path.join(appOutDir, 'lnwjud.app') : appOutDir;
  const resources = platform === 'darwin' ? 'Contents/Resources' : 'resources';
  const executable = platform === 'darwin' ? 'Contents/MacOS/lnwjud' : 'lnwjud';
  const launcher = platform === 'darwin' ? 'Contents/Resources/lnwjud-mcp-stdio' : 'lnwjud-mcp-stdio';
  const nativeName = platform === 'darwin' ? 'lnwjud-macos-host' : 'lnwjud-linux-host';
  const nativeDir = `${resources}/native-host/${platform === 'darwin' ? 'macos' : 'linux'}/${arch}`;
  const binaries = [executable, launcher, `${resources}/runtime-tools/ripgrep/rg`, `${resources}/tunnel-client/tunnel-client`, `${nativeDir}/${nativeName}`];
  async function put(relative: string, text: string, mode = 0o100644): Promise<void> {
    const file = path.join(bundle, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, 'utf8');
    state.modes.set(file, mode);
  }
  for (const binary of binaries) await put(binary, 'binary fixture\n', 0o100755);
  const manifest = {
    schemaVersion: 1, product: 'lnwjud', platform, arch, version: '1.0.0',
    assetSha256: 'a'.repeat(64), executableSha256: digest('binary fixture\n'),
    verified: { archiveSha256: true, executableVersion: true, executableBit: true },
  };
  await put(`${resources}/runtime-tools/ripgrep/BUNDLED_RIPGREP.json`, JSON.stringify({ ...manifest, executable: 'rg' }));
  const prefix = `tunnel-client-v0.0.13-${platform}-${arch === 'x64' ? 'amd64' : 'arm64'}`;
  const evidence = [`${prefix}-licenses.txt`, `${prefix}.spdx.json`, 'tunnel-client-v0.0.13-provenance.sigstore.json'];
  await put(`${resources}/tunnel-client/BUNDLED_TUNNEL_CLIENT.json`, JSON.stringify({
    ...manifest, version: '0.0.13', executable: 'tunnel-client', asset: `${prefix}.zip`,
    licenseAsset: evidence[0], spdxAsset: evidence[1], provenanceAsset: evidence[2],
  }));
  for (const name of evidence) await put(`${resources}/tunnel-client/${name}`, '{}');
  const nativeManifest = `${nativeDir}/NATIVE_HOST.json`;
  await put(nativeManifest, JSON.stringify({ schemaVersion: 1, name: nativeName, platform, arch,
    verified: true, sha256: digest('binary fixture\n'), sizeBytes: Buffer.byteLength('binary fixture\n') }));
  return { root, bundle, appOutDir, binaries, nativeManifest, resources, put,
    context: { appOutDir, electronPlatformName: platform, arch: arch === 'x64' ? 1 : 3 } };
}

describe.each(['linux', 'darwin'] as const)('%s packaged runtime hook', (platform) => {
  it.each(['x64', 'arm64'])('captures exact paths, sizes and hashes with 0644 manifests (%s)', async (arch) => {
    const f = await fixture(platform, arch);
    await capture(f.context);
    expect(state.outputs).toHaveLength(1);
    const result = JSON.parse(state.outputs[0]);
    expect(result).toMatchObject({ schemaVersion: 1, platform, arch, capabilityBridge: null });
    expect(result.files).toHaveLength(11);
    for (const file of result.files) {
      const bytes = await fs.readFile(path.join(f.bundle, file.relativePath));
      expect(file.sizeBytes).toBe(bytes.length);
      expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    expect(result.files.find((file: { name: string }) => file.name === 'native-host-manifest').relativePath).toBe(f.nativeManifest);
  });

  it.each([0, 1, 2, 3, 4])('rejects non-executable runtime binary %i', async (index) => {
    const f = await fixture(platform);
    state.modes.set(path.join(f.bundle, f.binaries[index]), 0o100644);
    await expect(capture(f.context)).rejects.toThrow(`not executable: ${f.binaries[index]}`);
    expect(state.outputs).toHaveLength(0);
  });

  it('rejects missing required files', async () => {
    const f = await fixture(platform);
    await fs.unlink(path.join(f.bundle, f.binaries[1]));
    await expect(capture(f.context)).rejects.toThrow(`Required packaged runtime file: ${f.binaries[1]} is unavailable`);
    expect(state.outputs).toHaveLength(0);
  });

  it('rejects a directory in place of an executable', async () => {
    const f = await fixture(platform);
    const file = path.join(f.bundle, f.binaries[0]);
    await fs.unlink(file);
    await fs.mkdir(file);
    await expect(capture(f.context)).rejects.toThrow('not a regular non-symlink file');
    expect(state.outputs).toHaveLength(0);
  });

  it('rejects malformed native manifests', async () => {
    const f = await fixture(platform);
    await f.put(f.nativeManifest, '{');
    await expect(capture(f.context)).rejects.toThrow('native-host manifest is not valid JSON');
    expect(state.outputs).toHaveLength(0);
  });

  it('rejects changed native-host bytes even with the same size', async () => {
    const f = await fixture(platform);
    await f.put(f.binaries[4], 'Binary fixture\n', 0o100755);
    await expect(capture(f.context)).rejects.toThrow('native-host hash mismatch');
    expect(state.outputs).toHaveLength(0);
  });

  it('rejects changed runtime bytes', async () => {
    const f = await fixture(platform);
    await f.put(f.binaries[2], 'changed', 0o100755);
    await expect(capture(f.context)).rejects.toThrow('runtime manifest executable hash mismatch');
    expect(state.outputs).toHaveLength(0);
  });
});

it.each(['output-root', 'output-parent'])('does not accept macOS decoys in %s', async (location) => {
  const f = await fixture('darwin');
  const contents = path.join(f.bundle, 'Contents');
  await fs.rename(contents, path.join(location === 'output-root' ? f.appOutDir : f.root, 'Contents'));
  await expect(capture(f.context)).rejects.toThrow('Contents/MacOS/lnwjud is unavailable');
  expect(state.outputs).toHaveLength(0);
});

it('rejects unsupported architecture before writing evidence', async () => {
  const f = await fixture('darwin');
  await expect(capture({ ...f.context, arch: 4 })).rejects.toThrow('architecture is unsupported: universal');
  expect(state.outputs).toHaveLength(0);
});

it('fails afterSign when signing changes bytes recorded in the source manifest', async () => {
  const f = await fixture('darwin');
  await capture(f.context); // afterPack
  await f.put(f.binaries[2], 'binary fixture\nwith signature', 0o100755);
  await expect(capture(f.context)).rejects.toThrow('runtime manifest executable hash mismatch');
  // The earlier evidence is still present: it must not be treated as signed proof.
  expect(state.outputs).toHaveLength(1);
});

const identity = 'a'.repeat(40);
type SignConfiguration = {
  app: string; identity: string; platform: string; keychain: string;
  optionsForFile: () => { hardenedRuntime: boolean; entitlements: string };
  ignore: Array<(file: string) => boolean>;
};
function signingConfiguration(app: string): SignConfiguration {
  return { app, identity, platform: 'darwin', keychain: '/private/build.keychain',
    optionsForFile: () => ({ hardenedRuntime: true, entitlements: '/build/inherit.plist' }),
    ignore: [(file: string): boolean => file.endsWith('.kext')] };
}
async function fakeCodesign(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const file = args.at(-1)!;
  if (args.includes('--force')) {
    expect(args).toContain(identity);
    expect(args).toContain('/private/build.keychain');
    expect(args).toContain('--timestamp');
    expect(args).toContain('runtime');
    await fs.appendFile(file, 'signed bytes');
  }
  if (args.includes('--test-requirement')) {
    expect(args).toContain(`=anchor apple generic and certificate leaf = H"${identity}"`);
  }
  return { stdout: '', stderr: 'flags=0x10000(runtime)\nTimestamp=Sep 8, 2026\n' };
}

describe('macOS signing transaction', () => {
  it.each(['x64', 'arm64'])('preserves source provenance and seals final runtime hashes (%s)', async (arch) => {
    const f = await fixture('darwin', arch);
    const run = vi.fn(fakeCodesign);
    const signApp = vi.fn(async (options: Omit<SignConfiguration, 'ignore'> & { ignore: (file: string) => boolean }): Promise<void> => {
      const ignored = await installedIgnorePredicate(options);
      for (const binary of f.binaries.slice(2)) expect(ignored(path.join(f.bundle, binary))).toBe(true);
      expect(ignored(path.join(f.bundle, f.binaries[0]))).toBe(false);
      expect(ignored(f.bundle)).toBe(false);
      expect(ignored(path.join(f.bundle, f.nativeManifest))).toBe(false);
      expect(ignored(path.join(f.bundle, 'other.kext'))).toBe(true);
      expect(ignored(path.join(f.bundle, f.binaries[2]) + '.other')).toBe(false);
      // Manifest integrity must already pass before the outer app is sealed.
      const native = JSON.parse(await fs.readFile(path.join(f.bundle, f.nativeManifest), 'utf8'));
      expect(native.sha256).toBe(digest('binary fixture\nsigned bytes'));
      expect(native.sizeBytes).toBe(Buffer.byteLength('binary fixture\nsigned bytes'));
    });
    await capture(f.context);
    await signPackagedMacosRuntime(signingConfiguration(f.bundle), { run, signApp });
    expect(signApp).toHaveBeenCalledTimes(1);
    expect(run.mock.calls.filter(([args]) => args.includes('--force'))).toHaveLength(3);
    // Until notarization finishes and afterSign runs, evidence remains invalid.
    expect(JSON.parse(state.outputs.at(-1)!)).toEqual({ schemaVersion: 0, signing: 'incomplete' });
    await capture(f.context);
    expect(JSON.parse(state.outputs.at(-1)!).schemaVersion).toBe(1);
    for (const relative of [`${f.resources}/runtime-tools/ripgrep/BUNDLED_RIPGREP.json`,
      `${f.resources}/tunnel-client/BUNDLED_TUNNEL_CLIENT.json`, f.nativeManifest]) {
      const manifest = JSON.parse(await fs.readFile(path.join(f.bundle, relative), 'utf8'));
      expect(manifest.packagedSigning).toEqual({ schemaVersion: 1, mode: 'certificate', certificateSha1: identity,
        sourceSha256: digest('binary fixture\n'), sourceSizeBytes: Buffer.byteLength('binary fixture\n') });
      expect(manifest.executableSha256 ?? manifest.sha256).toBe(digest('binary fixture\nsigned bytes'));
      if (manifest.assetSha256) expect(manifest.assetSha256).toBe('a'.repeat(64));
    }
  });

  it.each(['', 'Developer ID Application: Somebody'])('rejects unresolved identity %s', async (value) => {
    const f = await fixture('darwin');
    const run = vi.fn(fakeCodesign);
    const signApp = vi.fn();
    await expect(signPackagedMacosRuntime({ ...signingConfiguration(f.bundle), identity: value }, { run, signApp }))
      .rejects.toThrow('resolved certificate fingerprint');
    expect(run).not.toHaveBeenCalled();
    expect(signApp).not.toHaveBeenCalled();
    expect(JSON.parse(state.outputs.at(-1)!).schemaVersion).toBe(0);
  });

  it.each([undefined, '-'])('supports community ad-hoc signing with identity %s', async (value) => {
    const f = await fixture('darwin', 'arm64');
    const run = vi.fn(async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
      if (args.includes('--force')) {
        expect(args).toContain('-');
        expect(args).toContain('--timestamp=none');
        await fs.appendFile(args.at(-1)!, 'ad-hoc bytes');
      }
      expect(args).not.toContain('--test-requirement');
      return { stdout: '', stderr: 'flags=0x10002(adhoc,runtime)\nSignature=adhoc\n' };
    });
    const signApp = vi.fn(async (options: SignConfiguration & { identityValidation: boolean; preAutoEntitlements: boolean }): Promise<void> => {
      expect(options.identity).toBe('-');
      expect(options.identityValidation).toBe(false);
      expect(options.preAutoEntitlements).toBe(false);
      expect(options.optionsForFile()).toMatchObject({ timestamp: 'none' });
    });
    await signPackagedMacosRuntime({ ...signingConfiguration(f.bundle), identity: value }, { run, signApp });
    await capture(f.context);
    expect(JSON.parse(state.outputs.at(-1)!).signing).toEqual({ mode: 'ad-hoc' });
    const native = JSON.parse(await fs.readFile(path.join(f.bundle, f.nativeManifest), 'utf8'));
    expect(native.sha256).toBe(digest('binary fixture\nad-hoc bytes'));
    expect(native.packagedSigning.mode).toBe('ad-hoc');
    expect(native.packagedSigning.certificateSha1).toBeUndefined();
  });

  it('never downgrades required certificate signing to ad-hoc', async () => {
    const f = await fixture('darwin');
    const run = vi.fn();
    await expect(signPackagedMacosRuntime({ ...signingConfiguration(f.bundle), identity: undefined },
      { run, signApp: vi.fn(), requireCertificate: true })).rejects.toThrow('no certificate identity');
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects tampered source bytes before signing', async () => {
    const f = await fixture('darwin');
    await f.put(f.binaries[2], 'tampered', 0o100755);
    const run = vi.fn(fakeCodesign);
    await expect(signPackagedMacosRuntime(signingConfiguration(f.bundle), { run, signApp: vi.fn() }))
      .rejects.toThrow('hash mismatch');
    expect(run).not.toHaveBeenCalled();
  });

  it.each(['wrong-certificate', 'missing-timestamp', 'missing-runtime'])('aborts for %s', async (failure) => {
    const f = await fixture('darwin');
    const before = await fs.readFile(path.join(f.bundle, f.nativeManifest), 'utf8');
    const signApp = vi.fn();
    const run = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
      if (failure === 'wrong-certificate' && args.includes('--verify')) throw new Error('certificate requirement failed');
      const result = await fakeCodesign(args);
      if (args.includes('--display')) result.stderr = failure === 'missing-timestamp' ? 'flags=0x10000(runtime)' : 'Timestamp=today';
      return result;
    };
    await expect(signPackagedMacosRuntime(signingConfiguration(f.bundle), { run, signApp })).rejects.toThrow();
    expect(signApp).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(f.bundle, f.nativeManifest), 'utf8')).toBe(before);
    expect(JSON.parse(state.outputs.at(-1)!).schemaVersion).toBe(0);
  });

  it.each(['binary', 'manifest', 'signer-failure'])('fails closed on outer signing %s', async (failure) => {
    const f = await fixture('darwin');
    const signApp = async (): Promise<void> => {
      if (failure === 'signer-failure') throw new Error('signer failed');
      await fs.appendFile(path.join(f.bundle, failure === 'binary' ? f.binaries[2] : f.nativeManifest), ' ');
    };
    await expect(signPackagedMacosRuntime(signingConfiguration(f.bundle), { run: fakeCodesign, signApp })).rejects.toThrow();
    expect(JSON.parse(state.outputs.at(-1)!).schemaVersion).toBe(0);
  });
});

async function installedIgnorePredicate(options: { app: string; ignore: unknown }): Promise<(file: string) => boolean> {
  const builderRequire = createRequire(createRequire(path.resolve('apps/desktop/package.json')).resolve('electron-builder'));
  const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'));
  const signPath = libraryRequire.resolve('@electron/osx-sign/dist/cjs/sign.js');
  const source = await fs.readFile(signPath, 'utf8');
  const module = { exports: {} as { validateSignOpts: (options: unknown) => Promise<{ ignore: Array<(file: string) => boolean> }> } };
  // Execute the installed module unchanged, exposing its private sanitizer only
  // to this fixture. Array shares our realm so its instanceof check is faithful.
  runInNewContext(`${source}\nmodule.exports.validateSignOpts = validateSignOpts;`, {
    require: createRequire(signPath), module, exports: module.exports, Array,
  });
  const normalized = await module.exports.validateSignOpts({ ...options, platform: 'darwin' });
  expect(normalized.ignore).toHaveLength(1);
  return (file: string): boolean => normalized.ignore.some((rule) => rule(file));
}
