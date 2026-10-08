import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { electronExecutablePath, terminateProcessTree } from './electron-runtime.js';
import { settleFirstRunAndOpenHome } from './first-run-helpers.js';
import { chromium, expect, test, type Page } from '@playwright/test';
import { AuditService, redactActivityTargetDetail } from '@lnwjud/audit';
import { SqliteAuditRepository, SqliteDatabase } from '@lnwjud/storage';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopRoot, 'dist', 'main', 'main.js');
const electronExecutable = electronExecutablePath(desktopRoot);
const execFileAsync = promisify(execFile);
const packagedExecutable = process.env.LNWJUD_PACKAGED_EXECUTABLE;

test('control center auto-starts MCP and supports project + doctor journey', async ({ browserName }, testInfo) => {
  void browserName;
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
    await expect.poll(() => context.pages().length, { timeout: 30_000 }).toBeGreaterThan(0);
    const page = context.pages()[0];
    if (page === undefined) throw new Error('Electron did not create a renderer page');
    diagnosticPage = page;

    await settleFirstRunAndOpenHome(page);
    await seedExpandableWorkLog(dataRoot, fixtureRealRoot);

    await expect(page.getByRole('heading', { name: /^(ศูนย์ควบคุม Agent|Agent Control Center)$/ })).toBeVisible({ timeout: 30_000 });
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
    await page.getByLabel(/^(โฟลเดอร์โปรเจกต์|Workspace root)$/).fill(path.join(fixtureRoot, 'missing-workspace'));
    await page.getByRole('button', { name: 'เพิ่มโปรเจกต์', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(/Workspace (could not be added|root was not found)/, { timeout: 15_000 });

    await page.getByRole('button', { name: 'หน้าหลัก', exact: true }).click();
    await expect(page.getByTestId('workspace-real-root')).toHaveText(fixtureRealRoot, { timeout: 30_000 });

    await page.getByRole('button', { name: 'Git', exact: true }).click();
    await expect(page.getByTestId('git-summary')).toContainText('Not a Git repository');

    await page.getByRole('button', { name: 'ตั้งค่า', exact: true }).click();
    await expectNoHorizontalOverflow(page);
    await expect(page.getByRole('button', { name: 'ล้างข้อมูลทั้งหมดและเริ่มใหม่' })).toBeVisible();
    await page.getByRole('button', { name: /^MCP & Extensions/ }).click();
    await page.getByRole('button', { name: /^\+ (เพิ่ม MCP Server|Add MCP Server)$/ }).click();
    const customMcpNameInput = page.locator('.mcp-server-settings-item input').first();
    await customMcpNameInput.fill('');
    await customMcpNameInput.pressSequentially('focus-stable', { delay: 5 });
    await expect(customMcpNameInput).toHaveValue('focus-stable');
    await expect(customMcpNameInput).toBeFocused();
    await page.getByRole('button', { name: /^(เชื่อมต่อ ChatGPT|Connect ChatGPT)/ }).click();
    const tunnelAuthCard = page.locator('[aria-label="การยืนยันตัวตนของ Tunnel"], [aria-label="Tunnel authentication"]').first();
    const tunnelGuideCard = page.locator('[aria-label="เปิดคู่มือตั้งค่า"], [aria-label="Open setup guide"]').first();
    await expect(tunnelAuthCard).toBeVisible();
    await expect(tunnelGuideCard).toBeVisible();
    await expect.poll(async () => {
      const authBox = await tunnelAuthCard.boundingBox();
      const guideBox = await tunnelGuideCard.boundingBox();
      if (authBox === null || guideBox === null) return null;
      return Math.round(guideBox.y - (authBox.y + authBox.height));
    }).toBeGreaterThanOrEqual(8);
    const authBox = await tunnelAuthCard.boundingBox();
    const guideBox = await tunnelGuideCard.boundingBox();
    expect(authBox).not.toBeNull();
    expect(guideBox).not.toBeNull();
    if (authBox !== null && guideBox !== null) expect(Math.round(guideBox.y - (authBox.y + authBox.height))).toBeLessThanOrEqual(12);
    await page.getByRole('button', { name: /ความปลอดภัย|Security/ }).click();
    await page.getByLabel(/^(โปรไฟล์สิทธิ์|Permission profile)$/, { exact: true }).selectOption('balanced');
    await expect(page.getByLabel(/^(โปรไฟล์สิทธิ์|Permission profile)$/, { exact: true })).toHaveValue('balanced');
    await page.locator('.settings-subnav').getByRole('button', { name: /^(เครื่องมือ|Tools)/ }).click();
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
    await attachStartupDiagnostics(testInfo, dataRoot);
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

test('Git page supports real vertical page scrolling plus X/Y diff scrolling', async ({ browserName }, testInfo) => {
  void browserName;
  test.setTimeout(90_000);
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-git-scroll-'));
  const fixtureRealRoot = await realpath(fixtureRoot);
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-git-scroll-data-'));
  const gitCeilingDirectories = [path.dirname(fixtureRoot), path.dirname(fixtureRealRoot)]
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(path.delimiter);

  const baselineLines = Array.from({ length: 140 }, (_, index) => `${index.toString().padStart(3, '0')}:${'A'.repeat(420)}`);
  const changedLines = Array.from({ length: 140 }, (_, index) => `${index.toString().padStart(3, '0')}:${'B'.repeat(420)}`);
  await writeFile(path.join(fixtureRoot, 'long-file.txt'), baselineLines.join('\n') + '\n', 'utf8');
  await execFileAsync('git', ['init', '--quiet'], { cwd: fixtureRoot, windowsHide: true });
  await execFileAsync('git', ['config', 'user.email', 'lnwjud-scroll@example.invalid'], { cwd: fixtureRoot, windowsHide: true });
  await execFileAsync('git', ['config', 'user.name', 'lnwjud scroll acceptance'], { cwd: fixtureRoot, windowsHide: true });
  await execFileAsync('git', ['add', '--', 'long-file.txt'], { cwd: fixtureRoot, windowsHide: true });
  await execFileAsync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: fixtureRoot, windowsHide: true });
  await writeFile(path.join(fixtureRoot, 'long-file.txt'), changedLines.join('\n') + '\n', 'utf8');
  await Promise.all(Array.from({ length: 64 }, (_, index) =>
    writeFile(path.join(fixtureRoot, `untracked-${index.toString().padStart(2, '0')}.txt`), `untracked ${index}\n`, 'utf8')
  ));
  await mkdir(path.join(fixtureRoot, 'src', 'unit'), { recursive: true });
  await writeFile(path.join(fixtureRoot, 'src', 'unit', 'nested.ts'), 'export const nested = true;\n', 'utf8');

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

  try {
    await waitForDevTools(devToolsPort, electronProcess, stderr);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${devToolsPort}`);
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error('Electron did not create a browser context');
    await expect.poll(() => context.pages().length, { timeout: 30_000 }).toBeGreaterThan(0);
    const page = context.pages()[0];
    if (page === undefined) throw new Error('Electron did not create a renderer page');

    await settleFirstRunAndOpenHome(page);
    await page.setViewportSize({ width: 1720, height: 820 });
    await page.getByRole('button', { name: 'Git', exact: true }).click();
    await expect(page.locator('.git-tree-file-row')).toHaveCount(66, { timeout: 30_000 });
    const nestedFolder = page.locator('.git-tree-folder-row').filter({ hasText: 'unit' });
    await expect(nestedFolder).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.git-tree-file-row[title="src/unit/nested.ts"]')).toBeVisible();
    await nestedFolder.click();
    await expect(page.locator('.git-tree-file-row[title="src/unit/nested.ts"]')).toHaveCount(0);
    await nestedFolder.click();
    await expect(page.locator('.git-tree-file-row[title="src/unit/nested.ts"]')).toBeVisible();
    const gitSearch = page.locator('.git-file-toolbar input');
    await gitSearch.fill('nested.ts');
    await expect(page.locator('.git-tree-file-row[title="src/unit/nested.ts"]')).toBeVisible();
    await gitSearch.fill('');

    const fileList = page.locator('.git-file-list');
    const expandedList = await fileList.evaluate((element) => ({
      height: element.clientHeight,
      bottom: element.getBoundingClientRect().bottom,
      viewportHeight: window.innerHeight,
    }));
    expect(expandedList.height).toBeGreaterThanOrEqual(400);
    expect(expandedList.viewportHeight - expandedList.bottom).toBeLessThan(80);
    await page.screenshot({ path: testInfo.outputPath('git-list-expanded-1720x820.png'), fullPage: false });
    await page.setViewportSize({ width: 900, height: 650 });
    const fileListMetrics = await fileList.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(fileListMetrics.scrollHeight).toBeGreaterThan(fileListMetrics.clientHeight);
    const fileListScrollTop = await fileList.evaluate((element) => {
      element.scrollTop = 120;
      return element.scrollTop;
    });
    expect(fileListScrollTop).toBeGreaterThan(0);

    await page.locator('.git-tree-file-row').filter({ hasText: 'long-file.txt' }).click();
    const leftPane = page.locator('.diff-pane-left');
    await expect(leftPane).toBeVisible({ timeout: 30_000 });
    const diffMetrics = await leftPane.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(diffMetrics.scrollWidth).toBeGreaterThan(diffMetrics.clientWidth);
    expect(diffMetrics.scrollHeight).toBeGreaterThan(diffMetrics.clientHeight);
    const diffScroll = await leftPane.evaluate((element) => {
      element.scrollLeft = 180;
      element.scrollTop = 180;
      return { left: element.scrollLeft, top: element.scrollTop };
    });
    expect(diffScroll.left).toBeGreaterThan(0);
    expect(diffScroll.top).toBeGreaterThan(0);

    const mainPane = page.locator('.main-pane');
    const mainMetrics = await mainPane.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(mainMetrics.scrollHeight).toBeGreaterThan(mainMetrics.clientHeight);
    const mainScrollTop = await mainPane.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    expect(mainScrollTop).toBeGreaterThan(0);

    await page.screenshot({ path: testInfo.outputPath('git-scroll-900x650.png'), fullPage: false });
    await browser.close();
  } catch (error: unknown) {
    const stderrPath = testInfo.outputPath('git-scroll-electron-stderr.txt');
    await writeFile(stderrPath, stderr.join(''), 'utf8');
    await testInfo.attach('electron-stderr', { path: stderrPath, contentType: 'text/plain' });
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
    const startedAt = new Date();
    const completedAt = new Date(startedAt.getTime() + 1);
    await audit.recordMcpTool({
      actorId: 'e2e', actorName: 'e2e', workspaceId, toolName: 'read_files', callId: 'e2e-expand-call', phase: 'started',
      targetSummary: 'one.ts, two.ts, three.ts (+4)', targetDetail, activityTargetDetail: detail,
      resultCode: 'STARTED', durationMs: 0, timestamp: startedAt.toISOString(),
    });
    await audit.recordMcpTool({
      actorId: 'e2e', actorName: 'e2e', workspaceId, toolName: 'read_files', callId: 'e2e-expand-call', phase: 'completed',
      targetSummary: 'one.ts, two.ts, three.ts (+4)', targetDetail,
      resultCode: 'SUCCESS', durationMs: 7, timestamp: completedAt.toISOString(),
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
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Electron DevTools: ${stderr.join('')}`);
}

async function attachStartupDiagnostics(testInfo: { attach(name: string, options: { body: string; contentType: string }): Promise<void> }, dataRoot: string): Promise<void> {
  try {
    const body = await readFile(path.join(dataRoot, 'crashes', 'crash-events.ndjson'), 'utf8');
    await testInfo.attach('startup-diagnostics', { body, contentType: 'application/x-ndjson' });
  } catch {
    await testInfo.attach('startup-diagnostics', { body: 'No startup diagnostics file was created.\n', contentType: 'text/plain' });
  }
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
