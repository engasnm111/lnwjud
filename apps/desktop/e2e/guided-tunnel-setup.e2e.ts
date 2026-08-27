import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');
const mainEntry = path.join(desktopRoot, 'dist', 'main', 'main.js');
const electronExecutable = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const artifactParent = path.join(repositoryRoot, '.local-artifacts', 'e2e-guided-setup');

test('fresh user sees Thai Tips, enters Secure Tunnel guide, and switches language without losing the draft', async () => {
  test.setTimeout(90_000);
  await withFreshDesktop(async (page) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await ensureThaiLocale(page);
    await expect(page.getByRole('dialog', { name: 'ตั้งค่า ChatGPT ให้ใช้ lnwjud' })).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page);

    await page.getByRole('button', { name: 'เริ่มตั้งค่า' }).click();
    await expect(page.getByRole('heading', { name: 'Secure Tunnel' })).toBeVisible();
    await expect(page.getByText('1. สร้าง OpenAI Tunnel')).toBeVisible();
    await expect(page.getByRole('button', { name: 'เปิดหน้า Tunnel Settings' })).toBeVisible();

    const tunnelId = page.locator('#guided-tunnel-id');
    await tunnelId.fill('tunnel_abcdefgh12345678');
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await expect(page.getByText('1. Create an OpenAI Tunnel')).toBeVisible();
    await expect(tunnelId).toHaveValue('tunnel_abcdefgh12345678');
    await expectNoHorizontalOverflow(page);
  });
});

test('Set up later closes Tips and the Home recovery entry reopens Secure Tunnel', async () => {
  test.setTimeout(90_000);
  await withFreshDesktop(async (page) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await ensureThaiLocale(page);
    const dialog = page.getByRole('dialog', { name: 'ตั้งค่า ChatGPT ให้ใช้ lnwjud' });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'ไว้ทีหลัง' }).click();
    await expect(dialog).toBeHidden();

    const reopen = page.getByRole('button', { name: 'เปิดคู่มือตั้งค่า' }).first();
    await expect(reopen).toBeVisible();
    await reopen.click();
    await expect(page.getByRole('heading', { name: 'Secure Tunnel' })).toBeVisible();
    await expect(page.getByText('1. สร้าง OpenAI Tunnel')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

async function ensureThaiLocale(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.lnwjud.setLocale({ locale: 'th' });
  });
  await expect.poll(async () => page.evaluate(async () => (
    await window.lnwjud.getDashboard()
  ).locale), { timeout: 15_000, intervals: [100, 250, 500] }).toBe('th');
}

async function withFreshDesktop(run: (page: Page) => Promise<void>): Promise<void> {
  await mkdir(artifactParent, { recursive: true });
  const dataRoot = await mkdtemp(path.join(artifactParent, 'run-'));
  const workspaceRoot = path.join(dataRoot, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const devToolsPort = await findEphemeralPort();
  const electronProcess = spawn(
    electronExecutable,
    [`--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${dataRoot}`, mainEntry],
    {
      cwd: desktopRoot,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        APPDATA: dataRoot,
        LNWJUD_DATA_PATH: dataRoot,
        LNWJUD_WORKSPACE: workspaceRoot,
        LNWJUD_E2E_FIXTURE: '1',
        LNWJUD_E2E_NODE_PATH: process.execPath,
      },
    },
  );
  const stderr: string[] = [];
  electronProcess.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
  let browser: Browser | null = null;

  try {
    await waitForDevTools(devToolsPort, electronProcess, stderr);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${devToolsPort}`);
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error('Electron did not create a browser context');
    await expect.poll(() => context.pages().length).toBeGreaterThan(0);
    const page = context.pages()[0];
    if (page === undefined) throw new Error('Electron did not create a renderer page');
    await run(page);
  } finally {
    await browser?.close().catch(() => undefined);
    await terminateProcessTree(electronProcess);
    await removeVerifiedArtifactRoot(dataRoot);
  }
}

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
  }, { timeout: 30_000, intervals: [100, 250, 500] }).toBe(true);
}

async function terminateProcessTree(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.pid === undefined) return;
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { shell: false, windowsHide: true });
    killer.once('error', () => resolve());
    killer.once('close', () => resolve());
  });
}

async function removeVerifiedArtifactRoot(root: string): Promise<void> {
  const parent = path.resolve(artifactParent);
  const candidate = path.resolve(root);
  if (path.dirname(candidate) !== parent || !path.basename(candidate).startsWith('run-')) {
    throw new Error(`Refusing to remove unexpected E2E path: ${candidate}`);
  }
  await expect.poll(async () => {
    try {
      await rm(candidate, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }, { timeout: 10_000, intervals: [100, 250, 500] }).toBe(true);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(async () => page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
}
