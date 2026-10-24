import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { acquirePinnedVerifier, loadVerifierPinModule } from './pinned-verifier.mjs';

const windows = process.platform === 'win32' && process.arch === 'x64';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('verifier executable path is fixed and rejects caller paths', async () => {
  await assert.rejects(acquirePinnedVerifier({ filename: process.execPath, sha256: '0'.repeat(64) }), /RELEASE_VERIFIER_UNTRUSTED/);
});

test('actual native addon pins file and ancestors, rejecting writes/renames until release', { skip: !windows }, async () => {
  const addon = await loadVerifierPinModule();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-verifier-pin-'));
  const executable = path.join(directory, 'owned-copy.exe');
  await copyFile(process.execPath, executable);
  let pin;
  try {
    pin = addon.pinExecutable(executable);
    await assert.rejects(writeFile(executable, 'changed'));
    await assert.rejects(rename(executable, `${executable}.moved`));
    await assert.rejects(rename(directory, `${directory}.moved`));
    pin.close(); pin = undefined;
    await rename(executable, `${executable}.moved`);
    await writeFile(`${executable}.moved`, 'released');
  } finally { pin?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('real pinned executor retains executable and exact input through child close, strips signer environment', { skip: !windows }, async () => {
  const directory = path.join(root, 'tools/update-attestation'); const filename = path.join(directory, 'gh.exe');
  let directoryExisted = true;
  try { await lstat(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; directoryExisted = false; }
  await mkdir(directory, { recursive: true });
  let copied = false; let session;
  const previous = process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM;
  const inputDirectory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-verifier-input-'));
  const input = path.join(inputDirectory, 'bundle.json');
  try {
    await copyFile(process.execPath, filename, 1); copied = true;
    const sha256 = createHash('sha256').update(await readFile(filename)).digest('hex');
    await assert.rejects(acquirePinnedVerifier({ filename: 'gh.exe', sha256: '0'.repeat(64) }), /RELEASE_VERIFIER_UNTRUSTED/);
    session = await acquirePinnedVerifier({ filename: 'gh.exe', sha256 });
    await writeFile(input, '{"bundle":"bound"}'); await session.pinInputs([input]);
    process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM = 'sentinel-test-only';
    const completion = session.run(['-e', 'setTimeout(() => process.stdout.write("SIGNER=" + String(process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM)), 150)']);
    const closing = session.close();
    await assert.rejects(writeFile(filename, 'changed')); await assert.rejects(rename(filename, `${filename}.moved`));
    await assert.rejects(writeFile(input, 'swapped')); await assert.rejects(rename(input, `${input}.moved`));
    assert.equal((await completion).toString(), 'SIGNER=undefined'); await closing;
    await writeFile(input, 'released');
    await rename(filename, `${filename}.moved`); await rename(`${filename}.moved`, filename);
    assert.throws(() => session.run(['version']), /RELEASE_VERIFIER_ARGUMENTS_INVALID/);
    session = await acquirePinnedVerifier({ filename: 'gh.exe', sha256 });
    await assert.rejects(session.run(['-e', 'process.stdout.write("x".repeat(5000000))']), /RELEASE_ATTESTATION_REFUSED/);
    await session.close(); session = undefined;
    await writeFile(filename, 'released');
  } finally {
    await session?.close();
    if (previous === undefined) delete process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM; else process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM = previous;
    if (copied) await rm(filename);
    if (!directoryExisted) await rmdir(directory);
    await rm(inputDirectory, { recursive: true, force: true });
  }
});
