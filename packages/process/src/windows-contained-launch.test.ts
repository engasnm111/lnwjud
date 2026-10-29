import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareWindowsContainedLaunch, readWindowsContainmentReceipt } from './windows-contained-launch.js';
import { nativeFixture } from '../test/native-fixture.js';

describe.skipIf(process.platform !== 'win32')('contained launch receipt', () => {
  it.each(['completed', 'cancelled', 'timed_out'] as const)('publishes verified %s receipt and forwards child output under Restricted', async (outcome) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud job receipt '));
    try {
      const trusted = await nativeFixture(root);
      const directory = path.join(root, 'attempt');
      const environment = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psexecutionpolicypreference')),
        PSExecutionPolicyPreference: 'Restricted',
      };
      const invocation = await prepareWindowsContainedLaunch({
        ...trusted, directory, executable: process.execPath, cwd: root, timeoutMs: outcome === 'timed_out' ? 200 : 10000,
        environment,
        args: ['-e', outcome === 'completed' ? 'console.log("CHILD_OUTPUT");console.log("POLICY="+process.env.PSExecutionPolicyPreference)' : 'console.log("CHILD_OUTPUT");setInterval(()=>{},1000)'],
      });
      const child = spawn(invocation.executable, [...invocation.args], { windowsHide: true, env: { ...invocation.environment, PSExecutionPolicyPreference: 'Restricted' } });
      const closed = once(child, 'close');
      let stdout = '';
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      expect((await invocation.connect(child)).state).not.toBe('termination_unknown');
      if (outcome === 'cancelled') expect((await invocation.cancel()).state).toBe('terminal_verified');
      await closed;
      expect(await readWindowsContainmentReceipt(path.join(directory, 'containment.receipt.json'), { ...trusted, directory })).toMatchObject({ kind: 'windows_job_v2', outcome, activeProcesses: 0 });
      if (outcome === 'completed') {
        expect(stdout).toContain('CHILD_OUTPUT');
        expect(stdout).toContain('POLICY=Restricted');
      }
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }, 20000);
});
