import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nativeFixture } from '../test/native-fixture.js';

describe.skipIf(process.platform !== 'win32')('native Job lifetime', () => {
  it('preserves service-owned containment after watcher loss and cancels descendants with native proof', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native helper death '));
    const { authority, binding } = await nativeFixture(root); const directory = path.join(root, 'attempt');
    const marker = path.join(root, 'descendant-survived');
    const launch = await authority.prepare({ directory, binding, executable: process.execPath, cwd: root, timeoutMs: 10000,
      args: ['-e', `const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>require("fs").writeFileSync(process.argv[1],"unsafe"),1200);setInterval(()=>{},1000)',process.argv[1]],{detached:true,stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000);`, marker] });
    const helper = spawn(launch.executable, [...launch.args], { env: launch.environment }); const closed = once(helper, 'close');
    helper.stderr.resume();
    try {
      const descendant = new Promise<number>((resolve) => { let output = ''; helper.stdout.on('data', (data: Buffer) => { output += data.toString(); if (/^\d+\s*$/.test(output)) resolve(Number(output)); }); });
      expect(await launch.connect(helper)).toMatchObject({ state: 'running' });
      const descendantPid = await descendant;
      expect(helper.kill('SIGKILL')).toBe(true); await closed;
      expect((await authority.inspect({ directory, binding })).state).toBe('running');
      expect(await authority.cancel({ directory, binding })).toMatchObject({ state: 'terminal_verified', outcome: 'cancelled', activeProcesses: 0 });
      await expect.poll(() => { try { process.kill(descendantPid, 0); return true; } catch { return false; } }, { timeout: 5000 }).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 1300));
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await authority.inspect({ directory, binding })).state).toBe('terminal_verified');
      await expect(authority.prepare({ directory, binding, executable: process.execPath, cwd: root, timeoutMs: 10000, args: ['-e', 'process.exit(0)'] })).rejects.toThrow('ATTEMPT_ID_CONFLICT');
    } finally { if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL'); await closed; await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }, 30000);
});
