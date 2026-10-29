import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CONTAINMENT_PIN_SHA256 } from '../../packages/capabilities/src/containment-integrity.generated.ts';
import { refuse } from './release-envelope.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pinFilename = path.join(repositoryRoot, 'apps/desktop/build/native-containment/lnwjud-containment-pin.node');
const requireNative = createRequire(import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function snapshotStrings(values, maximum, code) {
  if (!Array.isArray(values)) refuse(code);
  const length = values.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) refuse(code);
  const result = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string'
      || descriptor.value.includes('\0') || descriptor.value.length > 4096) refuse(code);
    result.push(descriptor.value);
  }
  return result;
}

async function plainPath(filename) {
  let current = filename;
  let file = true;
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || (file ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) refuse('RELEASE_VERIFIER_UNTRUSTED');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent; file = false;
  }
}

export async function loadVerifierPinModule() {
  if (process.platform !== 'win32' || process.arch !== 'x64') refuse('RELEASE_VERIFIER_EXECUTION_UNAVAILABLE');
  await plainPath(pinFilename);
  if ((await lstat(pinFilename)).size > 16 * 1024 * 1024) refuse('RELEASE_VERIFIER_PIN_UNTRUSTED');
  if (sha256(await readFile(pinFilename)) !== CONTAINMENT_PIN_SHA256) refuse('RELEASE_VERIFIER_PIN_UNTRUSTED');
  const addon = requireNative(pinFilename);
  if (addon === null || typeof addon !== 'object' || typeof addon.pinExecutable !== 'function') refuse('RELEASE_VERIFIER_PIN_UNTRUSTED');
  return addon;
}

function environment(directory, token, windows) {
  return { SystemRoot: windows, WINDIR: windows, PATH: path.join(windows, 'System32'), GH_HOST: 'github.com', GH_TOKEN: token,
    GH_CONFIG_DIR: directory, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory, TEMP: directory, TMP: directory };
}

function invoke(filename, args, childEnvironment) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(filename, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment }); }
    catch { reject(new Error('RELEASE_ATTESTATION_REFUSED')); return; }
    let failed = false; let length = 0; const output = [];
    const timer = globalThis.setTimeout(() => { failed = true; child.kill(); }, 120000);
    child.on('error', () => { failed = true; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      length += chunk.length;
      if (length > 4 * 1024 * 1024) { failed = true; child.kill(); }
      if (!failed && stream === child.stdout) output.push(chunk);
    });
    child.on('close', code => {
      globalThis.clearTimeout(timer);
      if (failed || code !== 0) reject(new Error('RELEASE_ATTESTATION_REFUSED'));
      else resolve(Buffer.concat(output));
    });
  });
}

export async function acquirePinnedVerifier(configured) {
  if (configured === null || typeof configured !== 'object') refuse('RELEASE_VERIFIER_UNTRUSTED');
  const filenameField = Object.getOwnPropertyDescriptor(configured, 'filename');
  const digestField = Object.getOwnPropertyDescriptor(configured, 'sha256');
  if (!filenameField || !digestField || !Object.hasOwn(filenameField, 'value') || !Object.hasOwn(digestField, 'value')
    || filenameField.value !== 'gh.exe' || typeof digestField.value !== 'string' || !/^[a-f0-9]{64}$/.test(digestField.value))
    refuse('RELEASE_VERIFIER_UNTRUSTED');
  const expectedDigest = digestField.value;
  const addon = await loadVerifierPinModule();
  const filename = path.join(repositoryRoot, 'tools/update-attestation/gh.exe');
  let pin;
  try { pin = addon.pinExecutable(filename); } catch { refuse('RELEASE_VERIFIER_UNTRUSTED'); }
  if (pin === null || typeof pin !== 'object' || typeof pin.close !== 'function') refuse('RELEASE_VERIFIER_PIN_UNTRUSTED');
  try {
    await plainPath(filename);
    if ((await lstat(filename)).size > 256 * 1024 * 1024) refuse('RELEASE_VERIFIER_UNTRUSTED');
    if (sha256(await readFile(filename)) !== expectedDigest) refuse('RELEASE_VERIFIER_UNTRUSTED');
  } catch (error) { pin.close(); throw error; }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const windows = process.env.SystemRoot || process.env.SYSTEMROOT;
  if (!token || !windows || !path.isAbsolute(windows)) { pin.close(); refuse('RELEASE_VERIFIER_CREDENTIAL_UNAVAILABLE'); }
  let base;
  try { base = await realpath(os.tmpdir()); } catch { pin.close(); refuse('RELEASE_VERIFIER_CONFIG_UNTRUSTED'); }
  let directory;
  const configPins = [];
  const removeConfig = async () => {
    if (!directory) return;
    const resolved = await realpath(directory);
    if (resolved !== directory || path.dirname(resolved) !== base || !path.basename(resolved).startsWith('lnwjud-gh-verifier-'))
      refuse('RELEASE_VERIFIER_CLEANUP_FAILED');
    await rm(resolved, { recursive: true, force: true });
  };
  try {
    directory = await mkdtemp(path.join(base, 'lnwjud-gh-verifier-'));
    if (await realpath(directory) !== directory) refuse('RELEASE_VERIFIER_CONFIG_UNTRUSTED');
    for (const name of ['config.yml', 'hosts.yml']) {
      const file = path.join(directory, name);
      await writeFile(file, '{}\n', { flag: 'wx' });
      const configPin = addon.pinExecutable(file);
      if (configPin === null || typeof configPin !== 'object' || typeof configPin.close !== 'function') refuse('RELEASE_VERIFIER_PIN_UNTRUSTED');
      configPins.push(configPin);
      await plainPath(file);
      if (sha256(await readFile(file)) !== 'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356')
        refuse('RELEASE_VERIFIER_CONFIG_UNTRUSTED');
    }
  } catch (error) {
    for (const configPin of configPins.reverse()) configPin.close();
    try { await removeConfig(); } finally { pin.close(); }
    throw error;
  }
  const childEnvironment = environment(directory, token, windows);
  const pending = new Set(); const inputs = []; let reserved = 0; let pinning = 0; let running = false; let inspecting = false; let closed = false; let closing;
  return {
    async pinInputs(filenames) {
      if (closed || running || inspecting) refuse('RELEASE_INPUT_INVALID');
      let requested;
      inspecting = true;
      try {
        requested = snapshotStrings(filenames, 8, 'RELEASE_INPUT_INVALID');
        if (inputs.length + reserved + requested.length > 8) refuse('RELEASE_INPUT_INVALID');
        reserved += requested.length; pinning++;
      } finally { inspecting = false; }
      let remaining = requested.length;
      const operation = (async () => {
        try {
          for (const input of requested) {
            if (closed) refuse('RELEASE_INPUT_INVALID');
            const filename = path.resolve(input);
            let inputPin;
            try { inputPin = addon.pinExecutable(filename); } catch { refuse('RELEASE_INPUT_INVALID'); }
            if (inputPin === null || typeof inputPin !== 'object' || typeof inputPin.close !== 'function') refuse('RELEASE_VERIFIER_PIN_UNTRUSTED');
            inputs.push(inputPin); remaining--; reserved--;
            await plainPath(filename);
          }
        } finally { reserved -= remaining; }
      })();
      pending.add(operation);
      try { await operation; } finally { pending.delete(operation); pinning--; }
    },
    run(args) {
      if (closed || running || pinning !== 0 || inspecting) refuse('RELEASE_VERIFIER_ARGUMENTS_INVALID');
      let requested;
      inspecting = true;
      try { requested = snapshotStrings(args, 64, 'RELEASE_VERIFIER_ARGUMENTS_INVALID'); }
      finally { inspecting = false; }
      running = true;
      const completion = invoke(filename, requested, childEnvironment);
      pending.add(completion);
      completion.then(() => { pending.delete(completion); running = false; }, () => { pending.delete(completion); running = false; });
      return completion;
    },
    close() {
      if (inspecting) refuse('RELEASE_VERIFIER_ARGUMENTS_INVALID');
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await Promise.allSettled([...pending]);
        try {
          for (const inputPin of inputs) inputPin.close();
          for (const configPin of configPins.reverse()) configPin.close();
          await removeConfig();
        } finally { pin.close(); }
      })();
      return closing;
    },
  };
}
