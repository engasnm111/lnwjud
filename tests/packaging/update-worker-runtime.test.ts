import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { verifyUpdateWorkerArtifacts, validateUpdateWorkerEvidence } from '../../apps/desktop/scripts/verify-update-worker-artifacts.mjs';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ directory: string; compiledBundlePath: string }> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-update-worker-trust-')));
  roots.push(directory);
  const compiledBundlePath = path.join(directory, 'main.js');
  const bytes = Buffer.from('exact update worker bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const pinSha256 = 'a'.repeat(64);
  await writeFile(path.join(directory, 'lnwjud-update-worker.exe'), bytes);
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, buildId: 'lnwjud-update-worker-bootstrap-v1', protocol: 1,
    platform: 'win32', architecture: 'x64', filename: 'lnwjud-update-worker.exe', sha256,
    pinFilename: 'lnwjud-containment-pin.node', pinSha256, installationEffects: false,
  }));
  await writeFile(compiledBundlePath, [
    `var UPDATE_WORKER_SHA256 = '${sha256}';`,
    `var UPDATE_WORKER_PIN_SHA256 = '${pinSha256}';`,
    `var CONTAINMENT_PIN_SHA256 = '${pinSha256}';`,
  ].join('\n'));
  return { directory, compiledBundlePath };
}

it('binds the packaged worker to compiled exact bytes and the existing trusted native pin', async () => {
  const input = await fixture();
  const identity = await verifyUpdateWorkerArtifacts(input);
  expect(identity.filename).toBe('lnwjud-update-worker.exe');
  const files = [{ ...identity, relativePath: `resources/update-worker/${identity.filename}` }];
  expect(validateUpdateWorkerEvidence(identity, files, 'win32')).toEqual(identity);
  expect(() => validateUpdateWorkerEvidence(identity, [], 'win32')).toThrow('runtime ledger');
  expect(() => validateUpdateWorkerEvidence(identity, [...files, ...files], 'win32')).toThrow('runtime ledger');
  expect(() => validateUpdateWorkerEvidence(identity, files.map(entry => ({ ...entry, sha256: 'f'.repeat(64) })), 'win32')).toThrow('runtime ledger');
  expect(validateUpdateWorkerEvidence(null, [], 'darwin')).toBeNull();
  expect(() => validateUpdateWorkerEvidence(identity, files, 'darwin')).toThrow('Non-Windows');
});

it('rejects changed worker bytes even if the adjacent manifest is replaced to match', async () => {
  const input = await fixture();
  const changed = Buffer.from('replacement worker bytes');
  await writeFile(path.join(input.directory, 'lnwjud-update-worker.exe'), changed);
  await expect(verifyUpdateWorkerArtifacts(input)).rejects.toThrow('bytes do not match');
  const manifestPath = path.join(input.directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, sha256: createHash('sha256').update(changed).digest('hex') }));
  await expect(verifyUpdateWorkerArtifacts(input)).rejects.toThrow('manifest does not match');
});

it.each(['missing', 'placeholder', 'wrong-pin'] as const)('rejects %s compiled trust', async (kind) => {
  const input = await fixture();
  const bundle = await readFile(input.compiledBundlePath, 'utf8');
  const replacement = kind === 'missing' ? '' : kind === 'placeholder'
    ? bundle.replace(/UPDATE_WORKER_SHA256 = '[a-f0-9]{64}'/, `UPDATE_WORKER_SHA256 = '${'0'.repeat(64)}'`)
    : bundle.replace(`UPDATE_WORKER_PIN_SHA256 = '${'a'.repeat(64)}'`, `UPDATE_WORKER_PIN_SHA256 = '${'b'.repeat(64)}'`);
  await writeFile(input.compiledBundlePath, replacement);
  await expect(verifyUpdateWorkerArtifacts(input)).rejects.toThrow('trust is unavailable');
});

it('refuses a manifest that claims installation effects for the bootstrap worker', async () => {
  const input = await fixture();
  const manifestPath = path.join(input.directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, installationEffects: true }));
  await expect(verifyUpdateWorkerArtifacts(input)).rejects.toThrow('manifest does not match');
});
