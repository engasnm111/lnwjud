import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronExecutablePath, terminateProcessTree } from './electron-runtime.js';
import { chromium, expect, test, type Page } from '@playwright/test';
import { AuditService, redactActivityTargetDetail } from '@lnwjud/audit';
import { SqliteAuditRepository, SqliteDatabase } from '@lnwjud/storage';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopRoot, 'dist', 'main', 'main.js');
const electronExecutable = electronExecutablePath(desktopRoot);
const packagedExecutable = process.env.LNWJUD_PACKAGED_EXECUTABLE;

test('control center auto-starts MCP and supports project + doctor journey', async ({ browserName }, testInfo) => {
  void browserName;
  test.setTimeout(90_000);
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-dashboard-'));
  const fixtureRealRoot = await realpath(fixtureRoot);
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-dashboard-data-'));
  await seedExpandableWorkLog(dataRoot, fixtureRealRoot);
  const gitCeilingDirectories = [path.dirname(fixtureRoot), path.dirname(fixtureRealRoot)].filter((value, index, values) => values.indexOf(value) === index).join(path.delimiter);
  await writeFile(path.join(fixtureRoot, '.env'), 'SECRET_NOT_FOR_UI=do-not-display\n', 'utf8');
  const devToolsPort = await findEphemeralPort();
  const launchExecutable = packagedExecutable ?? electronExecutable;
  const launchArguments = packagedExecutable === undefined
    ? [`--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${dataRoot}`, mainEntry]
    : [`--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${dataRoot}`];
  const electronProcess = spawn(launchExecutable, launchArguments, {
    cwd: desktopRoot,
    detached: process.platform !== 'win32',
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
  let diagnosticPage: Page | undefined;

  try {
    await waitForDevTools(devToolsPort, electronProcess, stderr);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${devToolsPort}`);
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error('Electron did not create a browser context');
    await expect.poll(() => context.pages().length).toBeGreaterThan(0);
    const page = context.pages()[0];
    if (page === undefined) throw new Error('Electron did not create a renderer page');
    diagnosticPage = page;

    const firstRunDialog = page.getByRole('dialog', { name: /ตั้งค่า ChatGPT ให้ใช้ lnwjud|Set up ChatGPT to use lnwjud/ });
    await expect.poll(async () => {
      if (await firstRunDialog.isVisible()) return true;
      if (await page.getByRole('heading', { name: 'Doctor', exact: true }).isVisible()) {
        const failures = await page.evaluate(async () => {
          const coreIds = new Set(['os', 'database', 'executable_ripgrep', 'mcp-port']);
          const report = await window.lnwjud.runDoctor();
          return report.checks.filter((check) => coreIds.has(check.id) && (check.status === 'fail' || check.status === 'unknown'))
            .map(({ id, status, message }) => ({ id, status, message }));
        });
        if (failures.length > 0) throw new Error(`Startup prerequisites failed before onboarding: ${JSON.stringify(failures)}`);
      }
      return false;
    }, { timeout: 30_000, intervals: [100, 250, 500] }).toBe(true);
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
    await page.setViewportSize({ width: 1280, height: 800 });
    const showMore = page.locator('.log-detail-toggle').first();
    await expect(showMore).toHaveAccessibleName(/ดูเพิ่ม|Show more/);
    await expect(showMore).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText('hidden-seven.ts', { exact: true })).toBeHidden();
    await showMore.focus();
    await page.keyboard.press('Enter');
    await expect(showMore).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('hidden-seven.ts', { exact: true })).toBeVisible();
    const secondToggle = page.locator('.log-detail-toggle').nth(1);
    await secondToggle.focus();
    await page.keyboard.press('Enter');
    await expect(secondToggle).toHaveAttribute('aria-expanded', 'true');
    await page.screenshot({ path: testInfo.outputPath('work-log-expanded-1280x800.png'), fullPage: false });
    await showMore.focus();
    await page.keyboard.press('Space');
    await expect(showMore).toHaveAttribute('aria-expanded', 'false');
    await expect(secondToggle).toHaveAttribute('aria-expanded', 'true');
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
    await page.locator('details.doctor-passed > summary').click();
    await expect(page.getByTestId('doctor-check-os')).toBeVisible();
    await expect(page.getByTestId('doctor-check-database')).toBeVisible();
    await expect(page.getByTestId('doctor-check-registered_workspace')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('do-not-display');
    await browser.close();
  } catch (error: unknown) {
    const stderrPath = testInfo.outputPath('electron-stderr.txt');
    await writeFile(stderrPath, stderr.join(''), 'utf8');
    await testInfo.attach('electron-stderr', { path: stderrPath, contentType: 'text/plain' });
    if (diagnosticPage !== undefined && !diagnosticPage.isClosed()) {
      const domPath = testInfo.outputPath('failure-dom.html');
      await writeFile(domPath, await diagnosticPage.content(), 'utf8');
      await testInfo.attach('failure-dom', { path: domPath, contentType: 'text/html' });
      const uiPath = testInfo.outputPath('failure-ui.txt');
      await writeFile(uiPath, await diagnosticPage.locator('body').innerText(), 'utf8');
      await testInfo.attach('failure-ui', { path: uiPath, contentType: 'text/plain' });
    }
    throw error;
  } finally {
    await terminateProcessTree(electronProcess);
    await Promise.all([
      removeTemporaryRoot(fixtureRoot),
      removeTemporaryRoot(dataRoot),
    ]);
  }
});

async function seedExpandableWorkLog(dataRoot: string, workspaceId: string): Promise<void> {
  const database = new SqliteDatabase(path.join(dataRoot, 'lnwjud.sqlite'));
  try {
    const repository = new SqliteAuditRepository(database);
    const audit = new AuditService(repository);
    const items = ['one.ts', 'two.ts', 'three.ts', 'four.ts', 'five.ts', 'six.ts', 'hidden-seven.ts'];
    const detail = redactActivityTargetDetail({ kind: 'files', items });
    const targetDetail = { detailRef: 'e2e-expand-call', itemCount: items.length, preview: items.slice(0, 3), legacyIncomplete: false } as const;
    await audit.recordMcpTool({
      actorId: 'e2e', actorName: 'e2e', workspaceId, toolName: 'read_files', callId: 'e2e-expand-call', phase: 'started',
      targetSummary: 'one.ts, two.ts, three.ts (+4)', targetDetail, activityTargetDetail: detail,
      resultCode: 'STARTED', durationMs: 0, timestamp: '2026-08-30T00:00:00.000Z',
    });
    await audit.recordMcpTool({
      actorId: 'e2e', actorName: 'e2e', workspaceId, toolName: 'read_files', callId: 'e2e-expand-call', phase: 'completed',
      targetSummary: 'one.ts, two.ts, three.ts (+4)', targetDetail,
      resultCode: 'SUCCESS', durationMs: 7, timestamp: '2026-08-30T00:00:01.000Z',
    });
  } finally {
    database.close();
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
