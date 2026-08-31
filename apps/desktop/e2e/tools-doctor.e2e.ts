import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type Browser, type Locator, type Page } from '@playwright/test';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopRoot, 'dist', 'main', 'main.js');
const electronExecutable = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const packagedExecutable = process.env.LNWJUD_PACKAGED_EXECUTABLE?.trim() || undefined;

type LaunchedDesktop = {
  readonly process: ChildProcess;
  readonly browser: Browser;
  readonly page: Page;
  readonly dataRoot: string;
  readonly fixtureRoot: string;
  readonly devToolsPort: number;
};

test.describe('Tools catalog and Doctor real Electron acceptance', () => {
  test.setTimeout(120_000);

  test('normal runtime renders the full first-party catalog and readiness counts', async () => {
    const app = await launchDesktop();
    try {
      await openTools(app.page);
      await expect(app.page.getByRole('tab', { name: /lnwjud \(231\)/ })).toBeVisible();
      await expect(app.page.locator('.tool-card')).toHaveCount(231);
      await expect(app.page.locator('.tool-status-strip')).toContainText(/ready|needs_setup/);
    } finally { await closeDesktop(app); }
  });

  test('missing LSP dependency is needs_setup and explains the real requirement', async () => {
    const app = await launchDesktop();
    try {
      await openTools(app.page);
      const card = toolCard(app.page, 'lsp_diagnostics');
      await expect(card).toContainText('needs_setup');
      await card.click();
      await expect(app.page.getByRole('dialog')).toContainText('configured_lsp');
      await expect(app.page.getByRole('dialog')).toContainText(/No local language-server command|Language Server/);
    } finally { await closeDesktop(app); }
  });

  test('selected dependency recheck recovers the tool and preserves the full Doctor report', async () => {
    const app = await launchDesktop();
    try {
      await openTools(app.page);
      await expect(toolCard(app.page, 'lsp_diagnostics')).toContainText('needs_setup');
      const nodePath = process.execPath;
      await app.page.evaluate(async (configuredNodePath) => {
        const dashboard = await window.lnwjud.getDashboard();
        await window.lnwjud.setUserSettings({
          settings: { ...dashboard.settings, lspCommands: { typescript: JSON.stringify([configuredNodePath, '--version']) } },
        });
      }, nodePath);
      await app.page.getByRole('button', { name: 'Doctor', exact: true }).click();
      const lspCheck = app.page.getByTestId('doctor-check-configured_lsp');
      await expect(lspCheck).toHaveClass(/doctor-warn/);
      await lspCheck.getByRole('button', { name: /ตรวจรายการนี้ใหม่|Recheck this issue/ }).click();
      await expect(lspCheck).toHaveClass(/doctor-pass/);
      await expect(app.page.getByTestId('doctor-check-persistent_tunnel_identity')).toHaveCount(1);
      await openTools(app.page);
      await expect(toolCard(app.page, 'lsp_diagnostics')).toContainText('ready');
    } finally { await closeDesktop(app); }
  });

  test('permission deny blocks dangerous tools without invoking their runtime', async () => {
    const app = await launchDesktop();
    try {
      await app.page.evaluate(async () => { await window.lnwjud.setPermissionProfile({ profile: 'safe' }); });
      const before = await app.page.evaluate(async () => (await window.lnwjud.getDashboard()).auditEventCount);
      await openTools(app.page);
      const card = toolCard(app.page, 'delete_file');
      await expect(card).toContainText('blocked');
      await card.click();
      await expect(app.page.getByRole('dialog')).toContainText('DENY');
      await app.page.getByRole('button', { name: /ปิดรายละเอียดเครื่องมือ|Close tool details/ }).click();
      const after = await app.page.evaluate(async () => (await window.lnwjud.getDashboard()).auditEventCount);
      expect(after).toBe(before);
    } finally { await closeDesktop(app); }
  });

  test('offline external MCP is rendered separately as needs_setup with UNKNOWN permission', async () => {
    const first = await launchDesktop();
    const { dataRoot, fixtureRoot } = first;
    try {
      await first.page.evaluate(async () => {
        const dashboard = await window.lnwjud.getDashboard();
        await window.lnwjud.setUserSettings({
          settings: {
            ...dashboard.settings,
            extensions: {
              mode: 'enable_all', disabledServers: [], enabledServers: [], disabledSkillRoots: [], extraSkillRoots: [],
              extraMcpServers: [{ name: 'offline-fixture', command: 'Z:\\missing\\offline-mcp.exe', args: [], cwd: '', type: 'stdio', env: {} }],
            },
          },
        });
      });
    } finally { await closeDesktop(first, true); }

    const second = await launchDesktop({ dataRoot, fixtureRoot });
    try {
      await openTools(second.page);
      await second.page.getByRole('tab', { name: /External MCP \(\d+\)/ }).click();
      const card = toolCard(second.page, '@offline-fixture');
      await expect(card).toContainText('needs_setup');
      await expect(card).toContainText('UNKNOWN');
    } finally { await closeDesktop(second); }
  });

  test('locale switch refreshes bilingual copy while reusing cached readiness probes', async () => {
    const app = await launchDesktop();
    try {
      await openTools(app.page);
      const before = await app.page.evaluate(async () => {
        const snapshot = await window.lnwjud.getToolCatalog({ locale: 'th' });
        const tool = snapshot.items.find((item) => item.name === 'lsp_diagnostics');
        return { checkedAt: tool?.checkedAt, shortDescription: tool?.shortDescription };
      });
      await app.page.getByRole('button', { name: 'English' }).click();
      await expect(app.page.getByRole('heading', { name: 'Tools' })).toBeVisible();
      const after = await app.page.evaluate(async () => {
        const snapshot = await window.lnwjud.getToolCatalog({ locale: 'en' });
        const tool = snapshot.items.find((item) => item.name === 'lsp_diagnostics');
        return { checkedAt: tool?.checkedAt, shortDescription: tool?.shortDescription };
      });
      expect(after.checkedAt).toBe(before.checkedAt);
      expect(after.shortDescription).not.toBe(before.shortDescription);
    } finally { await closeDesktop(app); }
  });

  test('startup blocks on required failure but optional dependency failure does not block', async () => {
    test.skip(packagedExecutable !== undefined, 'Packaged builds carry bundled required executables; PATH-only startup dependency failure is a source-build scenario.');
    const requiredFailBin = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-path-required-fail-'));
    const optionalFailBin = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-path-optional-fail-'));
    await copyFile(process.execPath, path.join(optionalFailBin, 'rg.exe'));

    const requiredFail = await launchDesktop({ pathOverride: requiredFailBin });
    try {
      await expect(requiredFail.page.getByRole('heading', { name: 'Doctor', exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(requiredFail.page.getByTestId('doctor-check-executable_ripgrep')).toHaveClass(/doctor-fail/);
    } finally { await closeDesktop(requiredFail); }

    const optionalFail = await launchDesktop({ pathOverride: optionalFailBin });
    try {
      await dismissFirstRunTip(optionalFail.page);
      await expect(optionalFail.page.getByRole('heading', { name: /ศูนย์ควบคุม Agent|Agent Control Center/ })).toBeVisible({ timeout: 30_000 });
      await optionalFail.page.getByRole('button', { name: 'Doctor', exact: true }).click();
      await expect(optionalFail.page.getByTestId('doctor-check-executable_git')).toHaveClass(/doctor-warn/);
    } finally {
      await closeDesktop(optionalFail);
      await Promise.all([removeTemporaryRoot(requiredFailBin), removeTemporaryRoot(optionalFailBin)]);
    }
  });
});

async function launchDesktop(options: { readonly dataRoot?: string; readonly fixtureRoot?: string; readonly pathOverride?: string } = {}): Promise<LaunchedDesktop> {
  const dataRoot = options.dataRoot ?? await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tools-doctor-data-'));
  const fixtureRoot = options.fixtureRoot ?? await createFixture();
  const devToolsPort = await findEphemeralPort();
  const mcpPort = await findEphemeralPort();
  const launchExecutable = packagedExecutable ?? electronExecutable;
  const launchArgs = packagedExecutable === undefined
    ? [`--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${dataRoot}`, mainEntry]
    : [`--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${dataRoot}`];
  const inheritedPath = globalThis.process.env.Path ?? globalThis.process.env.PATH ?? '';
  const sourceRuntimePath = path.join(desktopRoot, 'build', 'runtime-tools', 'ripgrep');
  const defaultPath = packagedExecutable === undefined
    ? [sourceRuntimePath, inheritedPath].filter((entry) => entry.length > 0).join(path.delimiter)
    : inheritedPath;
  const effectivePath = options.pathOverride ?? defaultPath;
  const process = spawn(launchExecutable, launchArgs, {
    cwd: desktopRoot,
    shell: false,
    windowsHide: true,
    env: {
      ...globalThis.process.env,
      PATH: effectivePath,
      Path: effectivePath,
      APPDATA: dataRoot,
      LNWJUD_DATA_PATH: dataRoot,
      LNWJUD_WORKSPACE: fixtureRoot,
      LNWJUD_MCP_PORT: String(mcpPort),
      LNWJUD_UNRESTRICTED: '1',
      LNWJUD_E2E_FIXTURE: '1',
      LNWJUD_E2E_NODE_PATH: globalThis.process.execPath,
    },
  });
  const stderr: string[] = [];
  process.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
  await waitForDevTools(devToolsPort, process, stderr);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${devToolsPort}`);
  const context = browser.contexts()[0];
  if (context === undefined) throw new Error('Electron did not create a browser context');
  await expect.poll(() => context.pages().length).toBeGreaterThan(0);
  const page = context.pages()[0];
  if (page === undefined) throw new Error('Electron did not create a renderer page');
  return { process, browser, page, dataRoot, fixtureRoot, devToolsPort };
}

async function openTools(page: Page): Promise<void> {
  await dismissFirstRunTip(page);
  await page.getByRole('button', { name: /เครื่องมือ|Tools/, exact: true }).click();
  await expect(page.getByRole('heading', { name: /เครื่องมือ|Tools/, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.tool-card').first()).toBeVisible({ timeout: 30_000 });
}

async function dismissFirstRunTip(page: Page): Promise<void> {
  const mcpRunning = await page.evaluate(async () => (await window.lnwjud.getDashboard()).mcp.running);
  if (!mcpRunning) await page.evaluate(async () => { await window.lnwjud.restartMcp(); });

  try {
    await expect.poll(async () => page.evaluate(async () => {
      const dashboard = await window.lnwjud.getDashboard();
      return window.localStorage.getItem('lnwjud.startup-doctor.passed-version.v1') === dashboard.appVersion;
    }), { timeout: 30_000, intervals: [100, 250, 500] }).toBe(true);
  } catch (cause: unknown) {
    const diagnostics = await page.evaluate(async () => {
      const report = await window.lnwjud.runDoctor();
      const coreIds = new Set(['os', 'database', 'executable_ripgrep', 'mcp-port']);
      const coreChecks = report.checks
        .filter((check) => coreIds.has(check.id))
        .map((check) => ({ id: check.id, required: check.required, status: check.status, message: check.message }));
      let catalog: { ok: true; itemCount: number } | { ok: false; error: string };
      try {
        const snapshot = await window.lnwjud.getToolCatalog({ locale: (await window.lnwjud.getDashboard()).locale });
        catalog = { ok: true, itemCount: snapshot.items.length };
      } catch (error: unknown) {
        catalog = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      return { coreChecks, catalog, bodyText: document.body.innerText.slice(0, 4_000) };
    });
    throw new Error(`Startup Doctor did not become ready: ${JSON.stringify(diagnostics)}`, { cause });
  }

  const later = page.getByRole('button', { name: /ไว้ทีหลัง|Set up later/ });
  await later.click({ timeout: 30_000 }).catch(() => undefined);
}

function toolCard(page: Page, name: string): Locator {
  const exactName = new RegExp(`^${escapeRegExp(name)}$`);
  return page.locator('button.tool-card').filter({ has: page.locator('code').filter({ hasText: exactName }) }).first();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-tools-doctor-workspace-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'app.ts'), 'export const ready = true;\n', 'utf8');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'tools-doctor-e2e-fixture', scripts: { test: 'node --version' } }), 'utf8');
  return root;
}

async function findEphemeralPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  if (address === null || typeof address === 'string') throw new Error('Could not allocate an ephemeral port');
  return address.port;
}

async function waitForDevTools(port: number, electronProcess: ChildProcess, stderr: readonly string[]): Promise<void> {
  await expect.poll(async () => {
    if (electronProcess.exitCode !== null) throw new Error(`Electron exited with ${electronProcess.exitCode}: ${stderr.join('')}`);
    try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; }
  }, { timeout: packagedExecutable === undefined ? 20_000 : 60_000, intervals: [50, 100, 250, 500] }).toBe(true);
}

async function closeDesktop(app: LaunchedDesktop, keepRoots = false): Promise<void> {
  await app.browser.close().catch(() => undefined);
  await terminateProcessTree(app.process);
  await terminateDevToolsProcess(app.devToolsPort);
  if (!keepRoots) await Promise.all([removeTemporaryRoot(app.dataRoot), removeTemporaryRoot(app.fixtureRoot)]);
}

async function terminateDevToolsProcess(port: number): Promise<void> {
  const output = await new Promise<string>((resolve) => {
    const netstat = spawn('netstat.exe', ['-ano', '-p', 'tcp'], { shell: false, windowsHide: true });
    let stdout = '';
    netstat.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    netstat.once('error', () => resolve(''));
    netstat.once('close', () => resolve(stdout));
  });
  const suffix = `:${port}`;
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u);
    if (columns.length < 5 || !columns[1]?.endsWith(suffix) || columns[3] !== 'LISTENING') continue;
    const pid = Number.parseInt(columns[4] ?? '', 10);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  await Promise.all([...pids].map((pid) => terminatePidTree(pid)));
  await expect.poll(async () => {
    try { return !(await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return true; }
  }, { timeout: 10_000, intervals: [50, 100, 250] }).toBe(true);
}

async function terminateProcessTree(process: ChildProcess): Promise<void> {
  if (process.pid === undefined) return;
  await terminatePidTree(process.pid);
}

async function terminatePidTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true });
    killer.once('error', () => resolve());
    killer.once('close', () => resolve());
  });
}

async function removeTemporaryRoot(root: string): Promise<void> {
  await expect.poll(async () => {
    try { await rm(root, { recursive: true, force: true }); return true; } catch { return false; }
  }, { timeout: 10_000, intervals: [50, 100, 250] }).toBe(true);
}
