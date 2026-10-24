import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { verifyContainmentArtifacts, validateContainmentEvidence, type ContainmentPlatform } from '../../apps/desktop/scripts/verify-containment-artifacts.mjs';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ directory: string; compiledBundlePath: string; platform: ContainmentPlatform }> {
  // CI Windows TEMP may be an 8.3 alias; the verifier correctly requires a
  // canonical trusted directory, so prepare a canonical fixture identity.
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-containment-trust-')));
  roots.push(directory);
  const compiledBundlePath = path.join(directory, 'main.js');
  const helper = Buffer.from('first-party helper');
  const runtime = Buffer.from('export const protocol = 2;');
  const pin = Buffer.from('first-party pin module');
  const helperSha256 = createHash('sha256').update(helper).digest('hex');
  const runtimeSha256 = createHash('sha256').update(runtime).digest('hex');
  const pinSha256 = createHash('sha256').update(pin).digest('hex');
  await writeFile(path.join(directory, 'lnwjud-containment.exe'), helper);
  await writeFile(path.join(directory, 'process-runtime.mjs'), runtime);
  await writeFile(path.join(directory, 'lnwjud-containment-pin.node'), pin);
  await writeFile(compiledBundlePath, `var CONTAINMENT_HELPER_SHA256 = '${helperSha256}';\nvar CONTAINMENT_RUNTIME_SHA256 = '${runtimeSha256}';\nvar CONTAINMENT_PIN_SHA256 = '${pinSha256}';\n`);
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 2, buildId: 'lnwjud-containment-v2', platform: 'win32', architecture: 'x64', filename: 'lnwjud-containment.exe', sha256: helperSha256, pinFilename: 'lnwjud-containment-pin.node', pinSha256 }));
  return { directory, compiledBundlePath, platform: 'win32' };
}

it('excludes legacy profile-key export material from the production native helper compile', async () => {
  const production = await readFile(new URL('../../native/windows-containment-helper/WindowsContainmentHelper.csproj', import.meta.url), 'utf8');
  const nativeTests = await readFile(new URL('../../native/windows-containment-helper/tests/ContainmentNativeTests.csproj', import.meta.url), 'utf8');
  expect(production).toMatch(/<Compile Remove="[^"]*ProfileKey\.cs"/);
  expect(nativeTests).toContain('Include="../ProfileKey.cs"');
});

it.skipIf(process.platform !== 'win32')('rejects the legacy profile-key export in the actual production helper without creating a key', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-production-key-denial-'));
  roots.push(root);
  const uncreated = path.join(root, 'must-not-create');
  const helper = path.resolve('native/windows-containment-helper/artifacts/win-x64/lnwjud-containment.exe');
  const result = spawnSync(helper, ['profile-key', uncreated], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(125);
  expect(result.stdout).toBe('');
  await expect(stat(uncreated)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('requires the exact helper and worker bytes embedded in the host bundle', async () => {
  const input = await fixture();
  expect(await verifyContainmentArtifacts(input)).toMatchObject({ helper: { filename: 'lnwjud-containment.exe' }, runtime: { filename: 'process-runtime.mjs' } });
  await writeFile(path.join(input.directory, 'process-runtime.mjs'), 'changed runtime');
  await expect(verifyContainmentArtifacts(input)).rejects.toThrow('process-runtime.mjs');
});

it('rejects replaced helper bytes even when the adjacent manifest is replaced to match', async () => {
  const input = await fixture();
  const changed = Buffer.from('substituted helper');
  await writeFile(path.join(input.directory, 'lnwjud-containment.exe'), changed);
  const manifestPath = path.join(input.directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, sha256: createHash('sha256').update(changed).digest('hex') }));
  await expect(verifyContainmentArtifacts(input)).rejects.toThrow('compiled trust');
});

it('rejects placeholder or missing compiled trust', async () => {
  const input = await fixture();
  await writeFile(input.compiledBundlePath, `const CONTAINMENT_RUNTIME_SHA256 = '${'0'.repeat(64)}';`);
  await expect(verifyContainmentArtifacts(input)).rejects.toThrow('Compiled containment trust is unavailable');
});

it.each(['win32', 'darwin', 'linux'] as const)('binds %s release containment evidence to one exact runtime ledger entry', async (platform) => {
  const input = await fixture();
  const containment = await verifyContainmentArtifacts({ ...input, platform });
  const prefix = platform === 'darwin' ? 'Contents/Resources' : 'resources';
  const identities = [containment.runtime, ...(containment.helper === undefined ? [] : [containment.helper]), ...(containment.pin === undefined ? [] : [containment.pin])];
  const files = identities.map((entry) => {
    return { ...entry, relativePath: `${prefix}/native-containment/${entry.filename}` };
  });
  expect(validateContainmentEvidence(containment, files, platform)).toEqual(containment);
  expect(() => validateContainmentEvidence(undefined, files, platform)).toThrow('evidence is missing');
  expect(() => validateContainmentEvidence(containment, [], platform)).toThrow('runtime ledger');
  expect(() => validateContainmentEvidence(containment, [...files, ...files], platform)).toThrow('runtime ledger');
  expect(() => validateContainmentEvidence(containment, files.map(entry => ({ ...entry, sha256: 'f'.repeat(64) })), platform)).toThrow('runtime ledger');
});
