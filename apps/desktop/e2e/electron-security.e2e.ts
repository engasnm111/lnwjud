import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test } from '@playwright/test';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopRoot, 'dist', 'main', 'main.js');
const electronExecutable = process.platform === 'win32'
  ? path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : process.platform === 'darwin'
    ? path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron');

test('renderer cannot access Node globals', async () => {
  const devToolsPort = await findEphemeralPort();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-security-data-'));
  const electronProcess = spawn(electronExecutable, [`--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${dataRoot}`, mainEntry], {
    cwd: desktopRoot,
    shell: false,
    windowsHide: true,
  });
  const stderr: string[] = [];
  electronProcess.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));

  try {
    await waitForDevTools(devToolsPort, electronProcess, stderr);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${devToolsPort}`);
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error('Electron did not create a browser context');
    await expect.poll(() => context.pages().length).toBeGreaterThan(0);
    const page = context.pages()[0];
    if (page === undefined) throw new Error('Electron did not create a renderer page');
    await expect(page.getByRole('banner').getByText('lnwjud', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => page.evaluate(() => ({
      process: typeof Reflect.get(window, 'process'),
      require: typeof Reflect.get(window, 'require'),
      api: typeof window.lnwjud?.listWorkspaces,
    }))).toEqual({ process: 'undefined', require: 'undefined', api: 'function' });
    await browser.close();
  } finally {
    await terminateProcessTree(electronProcess);
    await removeTemporaryRoot(dataRoot);
  }
});

async function findEphemeralPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  if (address === null || typeof address === 'string') throw new Error('Could not allocate an ephemeral port');
  return address.port;
}

async function waitForDevTools(port: number, electronProcess: ChildProcess, stderr: readonly string[]): Promise<void> {
  await expect.poll(async () => {
    if (electronProcess.exitCode !== null) throw new Error(`Electron exited with ${electronProcess.exitCode}: ${stderr.join('')}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      return response.ok;
    } catch {
      return false;
    }
  }, { timeout: 10_000, intervals: [50, 100, 250] }).toBe(true);
}

async function terminateProcessTree(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.pid === undefined) return;
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { shell: false, windowsHide: true });
    killer.once('error', () => resolve());
    killer.once('close', () => resolve());
  });
}

async function removeTemporaryRoot(root: string): Promise<void> {
  await expect.poll(async () => {
    try {
      await rm(root, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }, { timeout: 10_000, intervals: [50, 100, 250] }).toBe(true);
}
