import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type Page } from '@playwright/test';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopRoot, 'dist', 'main', 'main.js');
const electronExecutable = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const packagedExecutable = process.env.LNWJUD_PACKAGED_EXECUTABLE;

test('control center auto-starts MCP and supports project + doctor journey', async () => {
  test.setTimeout(90_000);
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-dashboard-'));
  const fixtureRealRoot = await realpath(fixtureRoot);
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-dashboard-data-'));
  const gitCeilingDirectories = [path.dirname(fixtureRoot), path.dirname(fixtureRealRoot)].filter((value, index, values) => values.indexOf(value) === index).join(path.delimiter);
  await writeFile(path.join(fixtureRoot, '.env'), 'SECRET_NOT_FOR_UI=do-not-display\n', 'utf8');
  const devToolsPort = await findEphemeralPort();
  const launchExecutable = packagedExecutable ?? electronExecutable;
  const launchArguments = packagedExecutable === undefined
    ? [`--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${dataRoot}`, mainEntry]
    : [`--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${dataRoot}`];
  const electronProcess = spawn(launchExecutable, launchArguments, {
    cwd: desktopRoot,
    shell: false,
    windowsHide: true,
    env: {
      ...process.env,
      APPDATA: dataRoot,
      LNWJUD_DATA_PATH: dataRoot,
      LNWJUD_WORKSPACE: fixtureRoot,
      LNWJUD_UNRESTRICTED: '1',
      LNWJUD_E2E_FIXTURE: '1',
      LNWJUD_E2E_NODE_PATH: process.execPath,
      GIT_CEILING_DIRECTORIES: gitCeilingDirectories,
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

    const firstRunDialog = page.getByRole('dialog', { name: /ตั้งค่า ChatGPT ให้ใช้ lnwjud|Set up ChatGPT to use lnwjud/ });
    await page.getByRole('button', { name: /ไว้ทีหลัง|Set up later/ }).click({ timeout: 30_000 });
    await expect(firstRunDialog).toBeHidden();

    await expect(page.getByRole('heading', { name: 'ศูนย์ควบคุม Agent' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('mcp-status')).toHaveText(/Agent พร้อมทำงาน|Agent ready/, { timeout: 30_000 });
    await expect(page.getByTestId('mcp-endpoint')).toContainText('http://127.0.0.1:', { timeout: 30_000 });
     await page.setViewportSize({ width: 800, height: 600 });
     await expectNoHorizontalOverflow(page);
     for (const width of [640, 320]) {
       await page.setViewportSize({ width, height: 600 });
       await expectNoHorizontalOverflow(page);
     }
     await page.setViewportSize({ width: 800, height: 600 });

    await page.getByRole('button', { name: 'คัดลอก' }).first().click();
    await expect(page.getByTestId('mcp-copy-status')).toHaveText(/คัดลอกแล้ว|Copied/);

    await page.getByRole('button', { name: 'บันทึกการทำงาน', exact: true }).click();
    await expect(page.getByTestId('work-log')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByRole('button', { name: 'หน้าหลัก', exact: true }).click();

    await page.getByRole('button', { name: 'โปรเจกต์', exact: true }).click();
    await page.getByLabel('Workspace root').fill(path.join(fixtureRoot, 'missing-workspace'));
    await page.getByRole('button', { name: 'เพิ่มโปรเจกต์', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(/Workspace (could not be added|root was not found)/, { timeout: 15_000 });

    await page.getByRole('button', { name: 'หน้าหลัก', exact: true }).click();
    await expect(page.getByTestId('workspace-real-root')).toHaveText(fixtureRealRoot, { timeout: 30_000 });

    await page.getByRole('button', { name: 'Git', exact: true }).click();
    await expect(page.getByTestId('git-summary')).toContainText('Not a Git repository');

    await page.getByRole('button', { name: 'ตั้งค่า', exact: true }).click();
    await expectNoHorizontalOverflow(page);
    await page.getByRole('button', { name: /ความปลอดภัย|Security/ }).click();
    await page.getByLabel('Permission profile', { exact: true }).selectOption('balanced');
    await expect(page.getByLabel('Permission profile', { exact: true })).toHaveValue('balanced');
    await page.getByRole('button', { name: /^Tools/ }).click();
    const codexSwitch = page.getByRole('switch', { name: /codex_\*/ });
    await expect(codexSwitch).toHaveAttribute('aria-checked', 'false');
    await codexSwitch.click();
    await expect(codexSwitch).toHaveAttribute('aria-checked', 'true');
    await expectNoHorizontalOverflow(page);

    await page.getByRole('button', { name: 'Doctor', exact: true }).click();
    await page.getByRole('button', { name: /รัน Doctor|Run doctor/ }).click();
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
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
    await new Promise<void>((resolve) => {
      killer.once('error', () => resolve());
      killer.once('close', () => resolve());
    });
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
  await expect.poll(async () => {
    try {
      await rm(root, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }, { timeout: 10_000, intervals: [50, 100, 250] }).toBe(true);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(async () => page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
}
