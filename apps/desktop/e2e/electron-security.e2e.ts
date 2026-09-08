import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { electronExecutablePath } from './electron-runtime.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopRoot, 'dist', 'main', 'main.js');
const packagedExecutable = process.env.LNWJUD_PACKAGED_EXECUTABLE?.trim() || undefined;

test('renderer cannot access Node globals', async ({ browserName }, testInfo) => {
  void browserName;
  test.setTimeout(60_000);
  // Playwright automatically adds --no-sandbox for Linux root launches.
  if (process.platform === 'linux') expect(process.getuid?.()).not.toBe(0);
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-security-data-'));
  let app: ElectronApplication | undefined;
  let page: Page | undefined;
  const stderr: string[] = [];
  try {
    app = await _electron.launch({
      executablePath: packagedExecutable ?? electronExecutablePath(desktopRoot),
      args: packagedExecutable === undefined
        ? [`--user-data-dir=${dataRoot}`, mainEntry]
        : [`--user-data-dir=${dataRoot}`],
      cwd: desktopRoot,
      env: { ...process.env, LNWJUD_DATA_PATH: dataRoot, LNWJUD_E2E_FIXTURE: '1', LNWJUD_E2E_NODE_PATH: process.execPath },
    });
    app.process().stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    if (packagedExecutable !== undefined) {
      expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    }
    page = await app.firstWindow();
    await expect(page.getByRole('banner').getByText('lnwjud', { exact: true })).toBeVisible({ timeout: 30_000 });
    const renderer = page;
    await expect.poll(() => renderer.evaluate(() => ({
      process: typeof Reflect.get(window, 'process'),
      require: typeof Reflect.get(window, 'require'),
      api: typeof window.lnwjud?.listWorkspaces,
    }))).toEqual({ process: 'undefined', require: 'undefined', api: 'function' });
    const browserWindow = await app.browserWindow(page);
    expect(await browserWindow.evaluate((window) => window.webContents.getLastWebPreferences().sandbox)).toBe(true);
  } catch (error: unknown) {
    await testInfo.attach('electron-stderr', { body: stderr.join(''), contentType: 'text/plain' });
    if (page !== undefined && !page.isClosed()) {
      await testInfo.attach('failure-dom', { body: await page.content(), contentType: 'text/html' });
    }
    throw error;
  } finally {
    await app?.close();
    await expect.poll(async () => {
      try { await rm(dataRoot, { recursive: true, force: true }); return true; } catch { return false; }
    }, { timeout: 10_000, intervals: [50, 100, 250] }).toBe(true);
  }
});
