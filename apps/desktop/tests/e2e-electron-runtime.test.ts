import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { electronExecutablePath, terminateProcessTree } from '../e2e/electron-runtime.js';

describe('E2E Electron runtime', () => {
  it.each([
    ['win32', ['electron.exe']],
    ['linux', ['electron']],
    ['darwin', ['Electron.app', 'Contents', 'MacOS', 'Electron']],
  ] as const)('resolves the %s distribution under a checkout containing spaces', (platform, executable) => {
    const desktopRoot = path.resolve('checkout with spaces', 'apps', 'desktop');
    expect(electronExecutablePath(desktopRoot, platform)).toBe(
      path.join(desktopRoot, 'node_modules', 'electron', 'dist', ...executable),
    );
  });

  it('terminates an owned live process and permits repeated cleanup', async () => {
    const child = spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(() => {}, 1000);'], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Fixture did not start')), 5_000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('message', () => { clearTimeout(timer); resolve(); });
      });
      await terminateProcessTree(child);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      await terminateProcessTree(child);
    } finally {
      if (child.exitCode === null && child.signalCode === null) await terminateProcessTree(child);
    }
  });
});
