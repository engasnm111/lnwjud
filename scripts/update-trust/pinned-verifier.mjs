import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CONTAINMENT_PIN_SHA256 } from '../../packages/capabilities/src/containment-integrity.generated.ts';
import { refuse } from './release-envelope.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pinFilename = path.join(repositoryRoot, 'apps/desktop/build/native-containment/lnwjud-containment-pin.node');
const requireNative = createRequire(import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

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

function environment() {
  const allowed = new Set(['systemroot', 'windir', 'path', 'home', 'userprofile', 'temp', 'tmp', 'gh_token', 'github_token']);
  const result = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && allowed.has(name.toLowerCase())));
  result.GH_HOST = 'github.com'; result.GH_PROMPT_DISABLED = '1'; result.GH_PAGER = 'cat';
  return result;
}

function invoke(filename, args) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(filename, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment() }); }
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
  if (configured === null || typeof configured !== 'object' || configured.filename !== 'gh.exe'
    || !/^[a-f0-9]{64}$/.test(configured.sha256)) refuse('RELEASE_VERIFIER_UNTRUSTED');
  const addon = await loadVerifierPinModule();
  const filename = path.join(repositoryRoot, 'tools/update-attestation/gh.exe');
  let pin;
  try { pin = addon.pinExecutable(filename); } catch { refuse('RELEASE_VERIFIER_UNTRUSTED'); }
  if (pin === null || typeof pin !== 'object' || typeof pin.close !== 'function') refuse('RELEASE_VERIFIER_PIN_UNTRUSTED');
  try {
    await plainPath(filename);
    if ((await lstat(filename)).size > 256 * 1024 * 1024) refuse('RELEASE_VERIFIER_UNTRUSTED');
    if (sha256(await readFile(filename)) !== configured.sha256) refuse('RELEASE_VERIFIER_UNTRUSTED');
  } catch (error) { pin.close(); throw error; }
  const pending = new Set(); const inputs = []; let closed = false;
  return {
    async pinInputs(filenames) {
      if (closed || !Array.isArray(filenames) || filenames.length > 8 || inputs.length + filenames.length > 8) refuse('RELEASE_INPUT_INVALID');
      for (const input of filenames) {
        if (typeof input !== 'string' || input.includes('\0') || input.length > 4096) refuse('RELEASE_INPUT_INVALID');
        const filename = path.resolve(input);
        let inputPin;
        try { inputPin = addon.pinExecutable(filename); } catch { refuse('RELEASE_INPUT_INVALID'); }
        if (inputPin === null || typeof inputPin !== 'object' || typeof inputPin.close !== 'function') refuse('RELEASE_VERIFIER_PIN_UNTRUSTED');
        inputs.push(inputPin);
        await plainPath(filename);
      }
    },
    run(args) {
      if (closed || !Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) refuse('RELEASE_VERIFIER_ARGUMENTS_INVALID');
      const completion = invoke(filename, args);
      pending.add(completion);
      completion.then(() => pending.delete(completion), () => pending.delete(completion));
      return completion;
    },
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
      for (const inputPin of inputs) inputPin.close();
      pin.close();
    },
  };
}
