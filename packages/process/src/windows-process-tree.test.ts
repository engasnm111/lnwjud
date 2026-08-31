import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WindowsProcessTree } from './windows-process-tree.js';

describe('WindowsProcessTree', () => {
  it('does not resolve a successful stop until the target child has exited', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-process-tree-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: root,
      windowsHide: true,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    try {
      if (child.pid === undefined) throw new Error('fixture process has no PID');
      await new WindowsProcessTree().stop(child, child.pid);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      await expect(rm(root, { recursive: true, force: true })).resolves.toBeUndefined();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reuses accepted taskkill proof after a late root close without targeting the PID twice', async () => {
    const child = fakeChild();
    let taskkillCalls = 0;
    let waitCalls = 0;
    const tree = new WindowsProcessTree({
      platform: 'win32',
      taskkill: async (): Promise<number> => { taskkillCalls += 1; return 0; },
      waitForExit: async (): Promise<void> => {
        waitCalls += 1;
        if (waitCalls === 1) throw new Error('close event was late');
      },
    });

    await expect(tree.stop(child, 4_242)).rejects.toThrow('close event was late');
    Object.assign(child, { exitCode: 1 });
    await expect(tree.stop(child, 4_242)).resolves.toBeUndefined();
    expect(taskkillCalls).toBe(1);
  });

  it('never retries taskkill against a terminal root when no tree-stop proof exists', async () => {
    const child = fakeChild();
    let taskkillCalls = 0;
    const tree = new WindowsProcessTree({
      platform: 'win32',
      taskkill: async (): Promise<number> => { taskkillCalls += 1; return 128; },
      waitForExit: async (): Promise<void> => undefined,
    });

    await expect(tree.stop(child, 4_242)).rejects.toThrow('exited with code 128');
    Object.assign(child, { exitCode: 1 });
    await expect(tree.stop(child, 4_242)).rejects.toThrow('root exited before tree termination could be verified');
    expect(taskkillCalls).toBe(1);
  });

  it('escalates to SIGKILL only after SIGTERM fails to verify the exit', async () => {
    const signals: string[] = [];
    const child = fakeChild();
    (child as unknown as { kill: (signal?: string) => boolean }).kill = (signal?: string): boolean => {
      signals.push(signal ?? 'SIGTERM');
      return true;
    };
    let waitCalls = 0;
    const tree = new WindowsProcessTree({
      platform: 'linux',
      waitForExit: async (): Promise<void> => {
        waitCalls += 1;
        if (waitCalls === 1) throw new Error('Process tree exit could not be verified');
      },
    });

    await expect(tree.stop(child, 4_242)).resolves.toBeUndefined();
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(waitCalls).toBe(2);
  });

  it('gives a SIGTERM-handling child enough grace to flush before any escalation', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-process-grace-'));
    const marker = path.join(root, 'graceful.txt');
    const ready = path.join(root, 'ready.txt');
    const child = spawn(process.execPath, ['-e', [
      `const marker = ${JSON.stringify(marker)};`,
      `const ready = ${JSON.stringify(ready)};`,
      'process.on("SIGTERM", () => {',
      '  setTimeout(() => { require("node:fs").writeFileSync(marker, "graceful"); process.exit(0); }, 3000);',
      '});',
      'require("node:fs").writeFileSync(ready, "1");',
      'setInterval(() => {}, 100);',
    ].join('\n')], { windowsHide: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    // Wait for the handler to be installed: a SIGTERM racing script evaluation
    // would hit the default disposition and kill the child before its grace.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await access(ready).then(() => true, () => false)) break;
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }

    try {
      if (child.pid === undefined) throw new Error('fixture process has no PID');
      await new WindowsProcessTree().stop(child, child.pid);
      expect(child.exitCode).toBe(0);
      expect(child.signalCode).toBeNull();
      await expect(readFile(marker, 'utf8')).resolves.toBe('graceful');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});

function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: 4_242,
    exitCode: null,
    signalCode: null,
    kill: (): boolean => true,
  }) as unknown as ChildProcess;
}
