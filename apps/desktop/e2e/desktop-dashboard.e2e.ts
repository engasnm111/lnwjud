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

test('control center auto-starts MCP and supports project + doctor journey', async () => {
  test.setTimeout(90_000);
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
    env: {
      ...process.env,
      LNWJUD_DATA_PATH: dataRoot,
      LNWJUD_WORKSPACE: fixtureRoot,
      LNWJUD_E2E_FIXTURE: '1',
      LNWJUD_E2E_NODE_PATH: process.execPath,
    },
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

    await expect(page.getByRole('heading', { name: 'ศูนย์ควบคุม Agent' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('mcp-status')).toHaveText(/Agent พร้อมทำงาน|Agent ready/, { timeout: 30_000 });
    await expect(page.getByTestId('mcp-endpoint')).toContainText('http://127.0.0.1:', { timeout: 30_000 });
    await expect(page.getByTestId('work-log')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'คัดลอก' }).first().click();
    await expect(page.getByTestId('mcp-copy-status')).toHaveText(/คัดลอกแล้ว|Copied/);

    await page.getByRole('button', { name: 'โปรเจกต์', exact: true }).click();
    await page.getByLabel('Workspace root').fill(path.join(fixtureRoot, 'missing-workspace'));
    await page.getByRole('button', { name: 'เพิ่มโปรเจกต์', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(/Workspace (could not be added|root was not found)/);

    await page.getByRole('button', { name: 'หน้าหลัก', exact: true }).click();
    await expect(page.getByTestId('workspace-real-root')).toContainText(fixtureRoot);

    await page.getByRole('button', { name: 'Git', exact: true }).click();
    await expect(page.getByTestId('git-summary')).toContainText('Not a Git repository');

    await page.getByRole('button', { name: 'ตั้งค่า', exact: true }).click();
    await page.getByLabel('Permission profile').selectOption('balanced');
    await expect(page.getByTestId('permission-profile')).toHaveText('full');

    await page.getByRole('button', { name: 'Doctor', exact: true }).click();
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
  if (address === null || typeof address === 'string') throw new Error('Could not allocate ephemeral port');
  return address.port;
}

async function waitForDevTools(port: number, child: ChildProcess, stderr: string[]): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited early: ${stderr.join('')}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Electron DevTools: ${stderr.join('')}`);
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
  }
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    setTimeout(() => resolve(), 5_000);
  });
}

async function removeTemporaryRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
