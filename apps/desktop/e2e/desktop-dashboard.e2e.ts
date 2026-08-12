import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test } from '@playwright/test';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopRoot, 'dist', 'main', 'main.js');
const electronExecutable = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const packagedExecutable = process.env.LNWJUD_PACKAGED_EXECUTABLE;

test('dashboard supports workspace, permissions, fixture process, and doctor journey', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-dashboard-'));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-dashboard-data-'));
  await writeFile(path.join(fixtureRoot, '.env'), 'SECRET_NOT_FOR_UI=do-not-display\n', 'utf8');
  const devToolsPort = await findEphemeralPort();
  const launchExecutable = packagedExecutable ?? electronExecutable;
  const launchArguments = packagedExecutable === undefined
    ? [`--remote-debugging-port=${devToolsPort}`, mainEntry]
    : [`--remote-debugging-port=${devToolsPort}`];
  const electronProcess = spawn(launchExecutable, launchArguments, {
    cwd: desktopRoot,
    shell: false,
    windowsHide: true,
    env: { ...process.env, LNWJUD_DATA_PATH: dataRoot, LNWJUD_E2E_FIXTURE: '1', LNWJUD_E2E_NODE_PATH: process.execPath },
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

    await expect(page.getByRole('heading', { name: 'Gateway dashboard' })).toBeVisible();
    if (process.platform === 'win32') {
      await expect(page.getByText('AVAILABLE', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Launch managed Chrome' }).click();
      await expect(page.getByText('7/7 ready')).toBeVisible();
    }
    await page.getByLabel('Workspace root').fill(path.join(fixtureRoot, 'missing-workspace'));
    await page.getByRole('button', { name: 'Add workspace' }).click();
    await expect(page.getByRole('alert')).toHaveText('Workspace could not be added');
    await page.getByLabel('Workspace root').fill(fixtureRoot);
    await page.getByRole('button', { name: 'Add workspace' }).click();
    await expect(page.getByTestId('workspace-real-root')).toHaveText(fixtureRoot);
    await expect(page.getByTestId('git-summary')).toContainText('Not a Git repository');
    await expect(page.getByTestId('mcp-status')).toHaveText('Stopped');
    await page.getByRole('button', { name: 'Start Connection' }).click();
    await expect(page.getByTestId('mcp-status')).toHaveText('Running');
    await expect(page.getByTestId('mcp-endpoint')).toContainText('http://127.0.0.1:');
    await page.getByRole('button', { name: 'Copy MCP endpoint' }).click();
    await expect(page.getByTestId('mcp-copy-status')).toHaveText('Copied');
    await page.getByRole('button', { name: 'Stop Connection' }).click();
    await expect(page.getByTestId('mcp-status')).toHaveText('Stopped');
    await expect(page.getByTestId('mcp-endpoint')).toHaveText('No local endpoint active');

    await page.getByLabel('Permission profile').selectOption('balanced');
    await expect(page.getByTestId('permission-profile')).toHaveText('Balanced');
    await page.reload();
    await expect(page.getByLabel('Permission profile')).toHaveValue('balanced');

    await page.getByRole('button', { name: 'Start fixture process' }).click();
    await expect(page.getByTestId('process-status')).toHaveText('running');
    await expect(page.getByTestId('process-log')).toContainText('fixture-ready');
    await page.getByRole('button', { name: 'Stop process' }).click();
    await expect(page.getByTestId('process-status')).toHaveText('stopped');

    await page.getByRole('button', { name: 'Doctor' }).click();
    await page.getByRole('button', { name: 'Run doctor' }).click();
    await expect(page.getByTestId('doctor-check-os')).toBeVisible();
    await expect(page.getByTestId('doctor-check-database')).toBeVisible();
    await expect(page.getByTestId('doctor-check-workspaces')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('do-not-display');
    await browser.close();
  } finally {
    await terminateProcessTree(electronProcess);
    await Promise.all([
      removeTemporaryRoot(fixtureRoot),
      removeTemporaryRoot(dataRoot),
    ]);
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
  }, { timeout: 5_000, intervals: [50, 100, 250] }).toBe(true);
}
