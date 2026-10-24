import { mkdtemp, mkdir, writeFile, rm, readFile, copyFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect } from 'vitest';
import { readWindowsContainmentReceipt } from './windows-contained-launch.js';
import { WindowsNativeAuthority } from './windows-native-authority.js';
import { nativeFixture } from '../test/native-fixture.js';

describe('native receipt issuer boundary', () => {
  it('does not release a writer for a fabricated shape-compatible legacy receipt', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'native-proof-regression-'));
    try {
      const filename = path.join(directory, 'containment.receipt.json');
      await writeFile(filename, JSON.stringify({ kind: 'windows_job_v1', outcome: 'completed', exitCode: 0, activeProcesses: 0 }));
      expect(await readWindowsContainmentReceipt(filename)).toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe.skipIf(process.platform !== 'win32')('authenticated native authority', () => {
  it('attests cancellation received before dispatch without publishing a started acknowledgement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native pending cancel '));
    try {
      const { authority, binding } = await nativeFixture(root);
      const directory = path.join(root, 'attempt');
      const marker = path.join(root, 'target-wrote');
      const launch = await authority.prepare({ directory, binding, executable: process.execPath, args: ['-e', 'require("fs").writeFileSync(process.argv[1],"ran")', marker], cwd: root, timeoutMs: 10000 });
      expect(await launch.cancel()).toMatchObject({ state: 'launch_not_started' });
      const child = spawn(launch.executable, [...launch.args], { env: launch.environment });
      child.stdout.resume(); child.stderr.resume(); const closed = once(child, 'close');
      await launch.connect(child); await closed;
      // An attempt cancelled before dispatch is proven never-started, not terminal.
      expect(await launch.inspect()).toMatchObject({ state: 'launch_not_started' });
      await expect(readFile(path.join(directory, 'containment.started.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('pins the executable and ancestors before hashing until authenticated start, refusing overwrite, delete and swap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native pinned image '));
    try {
      const fixture = await nativeFixture(root); const executable = path.join(root, 'helper.exe');
      await copyFile(fixture.authority.configuration.helper.executable, executable);
      const authority = new WindowsNativeAuthority({ ...fixture.authority.configuration, helper: { ...fixture.authority.configuration.helper, executable } });
      const launch = await authority.prepare({ directory: path.join(root, 'attempt'), binding: fixture.binding, executable: process.execPath, args: ['-e', 'console.log("original-helper-ran")'], cwd: root, timeoutMs: 10000 });
      await expect(writeFile(executable, 'tampered')).rejects.toBeDefined();
      await expect(rm(executable)).rejects.toBeDefined();
      await expect(rename(executable, path.join(root, 'moved.exe'))).rejects.toBeDefined();
      await expect(rename(root, root + '-moved')).rejects.toBeDefined();
      const child = spawn(launch.executable, [...launch.args], { env: launch.environment }); const closed = once(child, 'close');
      let stdout = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); }); child.stderr.resume();
      await launch.connect(child); await closed;
      expect(stdout.trim()).toBe('original-helper-ran');
      expect(await launch.inspect()).toMatchObject({ state: 'terminal_verified', exitCode: 0 });
      await writeFile(executable, 'now-unpinned');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);
  it('preserves Unicode, empty and quoted argv while withholding private control bytes from target stdin', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native argv '));
    try {
      const { authority, binding } = await nativeFixture(root);
      const args = ['', 'ภาษาไทย 😀', 'quoted "word"', 'slash\\', 'x'.repeat(12000)];
      const launch = await authority.prepare({ directory: path.join(root, 'attempt'), binding, executable: process.execPath, cwd: root, timeoutMs: 10000,
        args: ['-e', 'console.log(JSON.stringify({args:process.argv.slice(1),stdin:require("fs").readFileSync(0,"utf8")}))', '--', ...args] });
      const child = spawn(launch.executable, [...launch.args], { env: launch.environment }); const closed = once(child, 'close');
      let output = ''; child.stdout.on('data', (data: Buffer) => { output += data.toString('utf8'); }); child.stderr.resume();
      await launch.connect(child); await closed;
      expect(JSON.parse(output)).toEqual({ args, stdin: '' });
      expect(await launch.inspect()).toMatchObject({ state: 'terminal_verified', outcome: 'completed', exitCode: 0 });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  it('verifies restart identity and ignores forged caller-file receipts instead of trusting legacy JSON', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native restart '));
    try {
      const { authority, binding } = await nativeFixture(root); const directory = path.join(root, 'attempt');
      const launch = await authority.prepare({ directory, binding, executable: process.execPath, args: ['-e', 'process.exit(7)'], cwd: root, timeoutMs: 10000 });
      const child = spawn(launch.executable, [...launch.args], { env: launch.environment }); child.stdout.resume(); child.stderr.resume(); const closed = once(child, 'close');
      await launch.connect(child); await closed;
      const restarted = new WindowsNativeAuthority(authority.configuration);
      expect(await restarted.inspect({ directory, binding })).toMatchObject({ state: 'terminal_verified', outcome: 'completed', exitCode: 7 });
      expect((await restarted.inspect({ directory, binding: { ...binding, generation: 2 } })).state).toBe('termination_unknown');
      expect((await restarted.inspect({ directory, binding: { ...binding, ownerSessionId: 'other' } })).state).toBe('termination_unknown');
      // Protocol 3 terminal authority is the protected SCM ledger, not caller-writable
      // v1 receipt/attempt files. Forged legacy files cannot alter service proof.
      const receiptPath = path.join(directory, 'containment.receipt.json');
      await expect(readFile(receiptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await mkdir(directory, { recursive: true });
      await writeFile(receiptPath, JSON.stringify({ kind: 'windows_job_v1', mac: '0'.repeat(64), outcome: 'completed', exitCode: 0, activeProcesses: 0 }));
      const journalPath = path.join(directory, 'containment.attempt.json');
      await writeFile(journalPath, JSON.stringify({ payload: Buffer.from(JSON.stringify({ operationDigest: 'a'.repeat(64) })).toString('base64') }));
      expect(await restarted.inspect({ directory, binding })).toMatchObject({ state: 'terminal_verified', outcome: 'completed', exitCode: 7 });
      expect((await restarted.inspect({ directory, binding: { ...binding, requestDigest: 'f'.repeat(64) } })).state).toBe('termination_unknown');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  it('an authenticated prelaunch abort wins permanently over later connect and cannot replay', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native abort '));
    try {
      const { authority, binding } = await nativeFixture(root); const directory = path.join(root, 'attempt'); const marker = path.join(root, 'side-effect');
      const request = { directory, binding, executable: process.execPath, args: ['-e', 'require("fs").writeFileSync(process.argv[1],"ran")', marker], cwd: root, timeoutMs: 10000 };
      const launch = await authority.prepare(request);
      expect(await launch.abortBeforeLaunch()).toMatchObject({ state: 'launch_not_started' });
      const child = spawn(launch.executable, [...launch.args], { env: launch.environment }); child.stdout.resume(); child.stderr.resume(); const closed = once(child, 'close');
      await launch.connect(child); await closed;
      expect(await authority.inspect({ directory, binding })).toMatchObject({ state: 'launch_not_started' });
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(authority.prepare(request)).rejects.toThrow('NATIVE_SERVICE_PREPARE_UNVERIFIED');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('records abort before preparation, while an already dispatched target never becomes launch_not_started', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native dispatch '));
    try {
      const { authority, binding } = await nativeFixture(root);
      const neverPreparedDirectory = path.join(root, 'never-prepared');
      expect(await authority.abortBeforeLaunch({ directory: neverPreparedDirectory, binding })).toMatchObject({ state: 'launch_not_started' });
      const replayMarker = path.join(root, 'replay-side-effect');
      await expect(authority.prepare({ directory: neverPreparedDirectory, binding, executable: process.execPath, args: ['-e', 'require("fs").writeFileSync(process.argv[1],"ran")', replayMarker], cwd: root, timeoutMs: 10000 }))
        .rejects.toThrow('ATTEMPT_ID_CONFLICT');
      await expect(readFile(replayMarker)).rejects.toMatchObject({ code: 'ENOENT' });

      const { binding: dispatchedBinding } = await nativeFixture(root);
      const directory = path.join(root, 'dispatched');
      const launch = await authority.prepare({ directory, binding: dispatchedBinding, executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: root, timeoutMs: 10000 });
      const child = spawn(launch.executable, [...launch.args], { env: launch.environment }); child.stdout.resume(); child.stderr.resume(); const closed = once(child, 'close');
      expect(await launch.connect(child)).toMatchObject({ state: 'running' });
      expect((await launch.abortBeforeLaunch()).state).toBe('running');
      expect(await launch.cancel()).toMatchObject({ state: 'terminal_verified', outcome: 'cancelled', activeProcesses: 0 });
      await closed;
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});
