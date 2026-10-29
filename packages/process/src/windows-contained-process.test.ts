import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nativeFixture } from '../test/native-fixture.js';

describe.skipIf(process.platform !== 'win32')('native Job lifetime', () => {
  it('preserves service-owned containment after watcher loss and cancels descendants with native proof', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native helper death '));
    const { authority, binding } = await nativeFixture(root); const directory = path.join(root, 'attempt');
    const gate = path.join(root, 'release-descendant');
    const ready = path.join(root, 'descendant-ready');
    const marker = path.join(root, 'descendant-survived');
    const launch = await authority.prepare({ directory, binding, executable: process.execPath, cwd: root, timeoutMs: 10000,
      args: ['-e', `const c=require('child_process').spawn(process.execPath,['-e','const fs=require("fs");const gate=process.argv[1],ready=process.argv[2],marker=process.argv[3];const t=setInterval(()=>{if(fs.existsSync(gate)){fs.writeFileSync(marker,String(Date.now()));clearInterval(t)}},10);fs.writeFileSync(ready,"ready");setInterval(()=>{},1000)',process.argv[1],process.argv[2],process.argv[3]],{detached:true,stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000);`, gate, ready, marker] });
    const helper = spawn(launch.executable, [...launch.args], { env: launch.environment }); const closed = once(helper, 'close');
    helper.stderr.resume();
    try {
      const descendant = new Promise<number>((resolve) => { let output = ''; helper.stdout.on('data', (data: Buffer) => { output += data.toString(); if (/^\d+\s*$/.test(output)) { resolve(Number(output)); } }); });
      expect(await launch.connect(helper)).toMatchObject({ state: 'running' });
      const descendantPid = await descendant;
      await expect.poll(async () => {
        try { return await readFile(ready, 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      }, { timeout: 5000, interval: 20 }).toBe('ready');
      expect(helper.kill('SIGKILL')).toBe(true); await closed;
      expect((await authority.inspect({ directory, binding })).state).toBe('running');
      const cancellation = await authority.cancel({ directory, binding });
      expect(cancellation).toMatchObject({ state: 'terminal_verified', outcome: 'cancelled', activeProcesses: 0 });
      await writeFile(gate, 'release');
      await expect.poll(async () => {
        const markerValue = await readFile(marker, 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (markerValue !== null) return { markerValue };
        try { process.kill(descendantPid, 0); return { alive: true }; } catch { return { alive: false }; }
      }, { timeout: 5000, interval: 20 }).toEqual({ alive: false });
      expect((await authority.inspect({ directory, binding })).state).toBe('terminal_verified');
      await expect(authority.prepare({ directory, binding, executable: process.execPath, cwd: root, timeoutMs: 10000, args: ['-e', 'process.exit(0)'] })).rejects.toThrow('ATTEMPT_ID_CONFLICT');
    } finally { if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL'); await closed; await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }, 30000);
});
