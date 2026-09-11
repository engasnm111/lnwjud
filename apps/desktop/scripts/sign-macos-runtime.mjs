import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { collectPackagedRuntimeEvidence, invalidatePackagedRuntimeEvidence } from './capture-packaged-runtime-evidence.mjs';

const execFileAsync = promisify(execFile);

export default async function signMacosRuntime(configuration, packager) {
  if (process.platform !== 'darwin') throw new Error('macOS signing requires macOS');
  // Use the signer (and retry policy) belonging to our pinned electron-builder
  // 26.0.12, resolving through its own dependency tree under pnpm.
  const builderRequire = createRequire(createRequire(import.meta.url).resolve('electron-builder'));
  const { sign } = builderRequire('app-builder-lib/out/codeSign/macCodeSign.js');
  await signPackagedMacosRuntime(configuration, {
    run: (args) => execFileAsync('/usr/bin/codesign', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 }),
    signApp: sign,
    requireCertificate: packager?.forceCodeSigning === true || process.env.LNWJUD_REQUIRE_CODESIGN === '1'
      || process.env.LNWJUD_REQUIRE_NOTARIZATION === '1'
      || ['CSC_LINK', 'CSC_NAME', 'APPLE_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID'].some((key) => Boolean(process.env[key]?.trim()))
      || Boolean(packager?.platformSpecificBuildOptions?.identity && packager.platformSpecificBuildOptions.identity !== '-'),
  });
}

// Dependencies isolate native execution for behavioral fixtures; production
// always uses /usr/bin/codesign and electron-builder's installed signer above.
export async function signPackagedMacosRuntime(configuration, { run, signApp, requireCertificate = false }) {
  await invalidatePackagedRuntimeEvidence();
  const { app, keychain, optionsForFile } = configuration;
  const identity = configuration.identity ?? '-';
  const adHoc = identity === '-';
  // The installed builder passes the selected certificate's SHA-1, not merely
  // a display name. Without credentials community builds use ad-hoc signing;
  // explicitly requested certificate signing must never silently downgrade.
  if (adHoc && requireCertificate) throw new Error('Certificate signing was requested but no certificate identity was resolved');
  if (!adHoc && (typeof identity !== 'string' || !/^[0-9a-f]{40}$/i.test(identity))) throw new Error('macOS signing requires a resolved certificate fingerprint');
  if (configuration.platform !== 'darwin' || path.basename(app) !== 'lnwjud.app') throw new Error('Unsupported macOS signing bundle');
  const resources = path.join(app, 'Contents', 'Resources');
  const ripgrepManifest = JSON.parse(await readFile(path.join(resources, 'runtime-tools', 'ripgrep', 'BUNDLED_RIPGREP.json'), 'utf8'));
  const arch = ripgrepManifest.arch;
  if (arch !== 'x64' && arch !== 'arm64') throw new Error('Unsupported macOS runtime architecture');
  const context = { appOutDir: path.dirname(app), electronPlatformName: 'darwin', arch };
  const original = await collectPackagedRuntimeEvidence(context);
  const pairs = [
    ['rg', 'rg-manifest', 'executableSha256'],
    ['tunnel-client', 'tunnel-client-manifest', 'executableSha256'],
    ['native-host', 'native-host-manifest', 'sha256'],
  ];
  const runtimes = [];
  for (const [binaryName, manifestName, hashField] of pairs) {
    const binary = original.files.find((file) => file.name === binaryName);
    const manifestFile = original.files.find((file) => file.name === manifestName);
    const executable = path.join(app, binary.relativePath);
    const manifestPath = path.join(app, manifestFile.relativePath);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.packagedSigning !== undefined) throw new Error('Signing requires freshly packaged source manifests');
    runtimes.push({ executable, manifestPath, manifest, hashField, binary });
  }

  const previousIgnore = configuration.ignore;
  const previousRules = previousIgnore == null ? [] : Array.isArray(previousIgnore) ? previousIgnore : [previousIgnore];
  const runtimePaths = new Set(runtimes.map((runtime) => runtime.executable));
  const ignore = (file) => runtimePaths.has(file) || previousRules.some((rule) =>
    typeof rule === 'function' ? rule(file) : Boolean(file.match(rule)));
  const signOptions = { ...configuration, identity, identityValidation: false,
    ...(adHoc ? { preAutoEntitlements: false, preEmbedProvisioningProfile: false,
      optionsForFile: (file) => ({ ...optionsForFile(file), timestamp: 'none' }) } : {}),
    ignore };
  // Community builds start from Electron binaries that may already carry the
  // Electron project's certificate. Normalize those nested signatures to the
  // same ad-hoc identity before our runtime manifests are rewritten; macOS 26
  // rejects an ad-hoc outer app that maps a differently-signed framework.
  if (adHoc) await signApp(signOptions);

  for (const runtime of runtimes) {
    const options = await optionsForFile?.(runtime.executable);
    // Refuse options this standalone Mach-O signing path cannot safely mirror.
    if (options?.hardenedRuntime !== true || !options.entitlements
      || options.requirements || options.additionalArguments?.length) throw new Error('Unsupported runtime signing options');
    const args = ['--force', '--sign', identity, '--options', 'runtime',
      adHoc ? '--timestamp=none' : options.timestamp ? `--timestamp=${options.timestamp}` : '--timestamp', '--entitlements', options.entitlements];
    if (keychain) args.push('--keychain', keychain);
    await run([...args, runtime.executable]);
    await verifySignature(runtime.executable, identity, run);
  }

  // The source hashes were verified above. Preserve them separately from the
  // signed-byte hashes consumed by the unchanged runtime integrity checks.
  const { createHash } = await import('node:crypto');
  for (const runtime of runtimes) {
    const bytes = await readFile(runtime.executable);
    runtime.signedSha256 = createHash('sha256').update(bytes).digest('hex');
    runtime.manifest.packagedSigning = { schemaVersion: 1, mode: adHoc ? 'ad-hoc' : 'certificate',
      ...(adHoc ? {} : { certificateSha1: identity.toLowerCase() }),
      sourceSha256: runtime.binary.sha256, sourceSizeBytes: runtime.binary.sizeBytes };
    runtime.manifest[runtime.hashField] = runtime.signedSha256;
    if (runtime.hashField === 'sha256') runtime.manifest.sizeBytes = bytes.length;
    runtime.manifestText = `${JSON.stringify(runtime.manifest, null, 2)}\n`;
    await writeFile(runtime.manifestPath, runtime.manifestText, 'utf8');
  }
  await collectPackagedRuntimeEvidence(context);
  // osx-sign 1.3.1 drops an array in validateOptsIgnore. A single predicate
  // survives normalization and preserves the builder's existing exclusions.
  await signApp(signOptions);
  // No manifest writes after the outer app has been sealed. Detect signer
  // regressions even if somebody updates both a binary and its manifest.
  for (const runtime of runtimes) {
    await verifySignature(runtime.executable, identity, run);
    if (createHash('sha256').update(await readFile(runtime.executable)).digest('hex') !== runtime.signedSha256
      || await readFile(runtime.manifestPath, 'utf8') !== runtime.manifestText) throw new Error('Runtime changed while sealing the macOS app');
  }
  await run(['--verify', '--deep', '--strict', app]);
  await verifySignature(app, identity, run);
  if (adHoc) {
    await verifySignature(path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework'), identity, run);
  }
  await collectPackagedRuntimeEvidence(context);
  // electron-builder now notarizes and invokes afterSign to capture evidence.
}

async function verifySignature(file, identity, run) {
  const adHoc = identity === '-';
  await run(['--verify', '--strict', '--all-architectures',
    ...(adHoc ? [] : ['--test-requirement', `=anchor apple generic and certificate leaf = H"${identity}"`]), file]);
  const result = await run(['--display', '--verbose=4', file]);
  const details = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (!/flags=.*\bruntime\b/.test(details)
    || (adHoc ? !/^Signature=adhoc\s*$/m.test(details) : !/^Timestamp=.+$/m.test(details))) {
    throw new Error(`Runtime signature lacks hardened runtime or secure timestamp: ${file}`);
  }
}
