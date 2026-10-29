import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-verifier-executor-'));
  const directory = await realpath(temporaryRoot);
  try {
    const files = [
      'config/update-release-schema.json',
      'scripts/update-trust/pinned-verifier.mjs',
      'scripts/update-trust/release-envelope.mjs',
      'packages/capabilities/src/containment-integrity.generated.ts',
      'apps/desktop/build/native-containment/lnwjud-containment-pin.node',
    ];
    for (const relative of files) {
      const destination = path.join(directory, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(root, relative), destination);
    }
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
    const runner = path.join(directory, 'run-fixture.mjs');
    await writeFile(runner, `
      import assert from 'node:assert/strict';
      import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
      import { createHash } from 'node:crypto';
      import os from 'node:os';
      import path from 'node:path';
      import process from 'node:process';
      import { acquirePinnedVerifier } from './scripts/update-trust/pinned-verifier.mjs';
      const directory = path.join(process.cwd(), 'tools/update-attestation');
      const filename = path.join(directory, 'gh.exe');
      const inputDirectory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-verifier-input-'));
      const input = path.join(inputDirectory, 'bundle.json');
      let session;
      try {
        await (await import('node:fs/promises')).mkdir(directory, { recursive: true });
        await copyFile(process.execPath, filename, 1);
        const sha256 = createHash('sha256').update(await readFile(filename)).digest('hex');
        await assert.rejects(acquirePinnedVerifier({ filename: 'gh.exe', sha256: '0'.repeat(64) }), /RELEASE_VERIFIER_UNTRUSTED/);
        const changingVerifier = { filename: 'gh.exe', sha256: '0'.repeat(64) };
        const checkedVerifier = acquirePinnedVerifier(changingVerifier); changingVerifier.sha256 = sha256;
        await assert.rejects(checkedVerifier, /RELEASE_VERIFIER_UNTRUSTED/);
        process.env.GH_TOKEN = 'disposable-test-token';
        process.env.GH_CONFIG_DIR = inputDirectory;
        process.env.HOME = inputDirectory;
        session = await acquirePinnedVerifier({ filename: 'gh.exe', sha256 });
        const observed = JSON.parse((await session.run(['-e', 'const fs=require("fs"),p=require("path");process.stdout.write(JSON.stringify({config:process.env.GH_CONFIG_DIR,home:process.env.HOME,host:process.env.GH_HOST,tokenPresent:!!process.env.GH_TOKEN,configText:fs.readFileSync(p.join(process.env.GH_CONFIG_DIR,"config.yml"),"utf8"),hostsText:fs.readFileSync(p.join(process.env.GH_CONFIG_DIR,"hosts.yml"),"utf8")}))'])).toString());
        assert.notEqual(observed.config, inputDirectory); assert.equal(observed.home, observed.config);
        assert.equal(observed.host, 'github.com'); assert.equal(observed.tokenPresent, true);
        assert.equal(observed.configText, '{}\\n'); assert.equal(observed.hostsText, '{}\\n');
        await assert.rejects(writeFile(path.join(observed.config, 'hosts.yml'), 'redirect'));
        await writeFile(input, '{"bundle":"bound"}'); await session.pinInputs([input]);
        process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM = 'sentinel-test-only';
        const completion = session.run(['-e', 'setTimeout(() => process.stdout.write("SIGNER=" + String(process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM)), 150)']);
        const closing = session.close();
        await assert.rejects(writeFile(filename, 'changed')); await assert.rejects(rename(filename, filename + '.moved'));
        await assert.rejects(writeFile(input, 'swapped')); await assert.rejects(rename(input, input + '.moved'));
        assert.equal((await completion).toString(), 'SIGNER=undefined'); await closing;
        await writeFile(input, 'released');
        await rename(filename, filename + '.moved'); await rename(filename + '.moved', filename);
        assert.throws(() => session.run(['version']), /RELEASE_VERIFIER_ARGUMENTS_INVALID/);
        session = await acquirePinnedVerifier({ filename: 'gh.exe', sha256 });
        await assert.rejects(session.run(['-e', 'process.stdout.write("x".repeat(5000000))']), /RELEASE_ATTESTATION_REFUSED/);
        await session.close(); session = undefined;
        const secondInput = path.join(inputDirectory, 'bundle-two.json');
        await writeFile(secondInput, '{"bundle":"two"}');
        session = await acquirePinnedVerifier({ filename: 'gh.exe', sha256 });
        const firstPins = session.pinInputs(Array(5).fill(input));
        await assert.rejects(session.pinInputs(Array(4).fill(secondInput)), /RELEASE_INPUT_INVALID/);
        await firstPins;
        await session.close(); session = undefined;
        session = await acquirePinnedVerifier({ filename: 'gh.exe', sha256 });
        const pinning = session.pinInputs([input, secondInput]);
        const closingPins = session.close();
        await Promise.allSettled([pinning, closingPins]);
        await writeFile(input, 'released'); await writeFile(secondInput, 'released');
        session = undefined;
        session = await acquirePinnedVerifier({ filename: 'gh.exe', sha256 });
        const changingInputs = [input];
        const pinnedSnapshot = session.pinInputs(changingInputs); changingInputs.push(...Array(8).fill(secondInput));
        assert.throws(() => session.run(['-e', '']), /RELEASE_VERIFIER_ARGUMENTS_INVALID/);
        await pinnedSnapshot;
        await session.pinInputs(Array(7).fill(secondInput));
        await assert.rejects(session.pinInputs([input]), /RELEASE_INPUT_INVALID/);
        let reads = 0; const accessor = [];
        Object.defineProperty(accessor, '0', { get() { reads++; return input; }, enumerable: true });
        await assert.rejects(session.pinInputs(accessor), /RELEASE_INPUT_INVALID/); assert.equal(reads, 0);
        const accessorArgs = [];
        Object.defineProperty(accessorArgs, '0', { get() { reads++; return '-e'; }, enumerable: true });
        assert.throws(() => session.run(accessorArgs), /RELEASE_VERIFIER_ARGUMENTS_INVALID/); assert.equal(reads, 0);
        const active = session.run(['-e', 'setTimeout(()=>process.stdout.write("done"),150)']);
        assert.throws(() => session.run(['-e', '']), /RELEASE_VERIFIER_ARGUMENTS_INVALID/);
        await assert.rejects(session.pinInputs([input]), /RELEASE_INPUT_INVALID/);
        assert.equal((await active).toString(), 'done');
        await session.close(); session = undefined;
        session = await acquirePinnedVerifier({ filename: 'gh.exe', sha256 });
        let reentrantRefusals = 0; let nestedPin;
        const reentrantArgs = new Proxy(['-e', 'process.stdout.write("outer")'], {
          get(target, key, receiver) {
            if (key === 'length') {
              try { session.run(['-e', '']); } catch { reentrantRefusals++; }
              try { session.close(); } catch { reentrantRefusals++; }
              nestedPin = session.pinInputs([input]).then(() => false, () => true);
            }
            return Reflect.get(target, key, receiver);
          },
        });
        assert.equal((await session.run(reentrantArgs)).toString(), 'outer'); assert.equal(reentrantRefusals, 2); assert.equal(await nestedPin, true);
        const reentrantInputs = new Proxy([input], {
          get(target, key, receiver) {
            if (key === 'length') {
              try { session.run(['-e', '']); } catch { reentrantRefusals++; }
              try { session.close(); } catch { reentrantRefusals++; }
              nestedPin = session.pinInputs([input]).then(() => false, () => true);
            }
            return Reflect.get(target, key, receiver);
          },
        });
        await session.pinInputs(reentrantInputs); assert.equal(reentrantRefusals, 4); assert.equal(await nestedPin, true);
        await session.close(); session = undefined;
        delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN;
        await assert.rejects(acquirePinnedVerifier({ filename: 'gh.exe', sha256 }), /RELEASE_VERIFIER_CREDENTIAL_UNAVAILABLE/);
        await writeFile(filename, 'released');
      } finally {
        await session?.close();
        delete process.env.LNWJUD_UPDATE_RELEASE_PRIVATE_KEY_PEM;
        delete process.env.GH_TOKEN;
        await rm(inputDirectory, { recursive: true, force: true });
      }
    `);
    const allowedEnvironment = new Set(['systemroot', 'windir', 'path', 'home', 'userprofile', 'temp', 'tmp']);
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowedEnvironment.has(name.toLowerCase())));
    const result = spawnSync(process.execPath, [runner], { cwd: directory, encoding: 'utf8', env: environment, windowsHide: true, timeout: 30000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
