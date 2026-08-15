import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { chromium, expect, test, type Page } from '@playwright/test';

const execFileAsync = promisify(execFile);
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopRoot, 'dist', 'main', 'main.js');
const electronExecutable = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const packagedExecutable = process.env.LNWJUD_PACKAGED_EXECUTABLE;

test('desktop serves the real MCP client development workflow', async () => {
  test.setTimeout(180_000);
  const fixtureRoot = await createFixture();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-mcp-client-data-'));
  let electronProcess: ChildProcess | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let page: Page | undefined;
  let client: Client | undefined;

  try {
    const devToolsPort = await findEphemeralPort();
    const launchExecutable = packagedExecutable ?? electronExecutable;
    const launchArguments = packagedExecutable === undefined
      ? [`--remote-debugging-port=${devToolsPort}`, mainEntry]
      : [`--remote-debugging-port=${devToolsPort}`];
    electronProcess = spawn(launchExecutable, launchArguments, {
      cwd: desktopRoot,
      shell: false,
      windowsHide: true,
    env: {
      ...process.env,
      LNWJUD_DATA_PATH: dataRoot,
      LNWJUD_WORKSPACE: fixtureRoot,
      LNWJUD_UNRESTRICTED: '1',
      LNWJUD_E2E_FIXTURE: '1',
      LNWJUD_E2E_NODE_PATH: process.execPath,
    },
    });
    const stderr: string[] = [];
    electronProcess.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));

    await waitForDevTools(devToolsPort, electronProcess, stderr);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${devToolsPort}`);
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error('Electron did not create a browser context');
    await expect.poll(() => context.pages().length).toBeGreaterThan(0);
    page = context.pages()[0];
    if (page === undefined) throw new Error('Electron did not create a renderer page');

    await expect(page.getByRole('heading', { name: 'ศูนย์ควบคุม Agent' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('workspace-real-root')).toHaveText(fixtureRoot, { timeout: 30_000 });
    const workspaceId = (await page.getByTestId('workspace-id').textContent())?.trim();
    if (workspaceId === undefined || workspaceId.length === 0) throw new Error('Desktop did not expose the registered workspace ID');

    await expect(page.getByTestId('mcp-status')).toHaveText(/Agent พร้อมทำงาน|Agent ready/);
    const endpointText = (await page.getByTestId('mcp-endpoint').textContent())?.trim();
    if (endpointText === undefined || endpointText.length === 0 || endpointText === '—') throw new Error('Desktop did not expose an MCP endpoint');
    const endpoint = new URL(endpointText);
    expect(endpoint.hostname).toBe('127.0.0.1');
    expect(endpoint.pathname).toBe('/mcp');

    client = new Client(
      { name: 'lnwjud-desktop-e2e-client', version: '0.1.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'workspace_list', 'workspace_register', 'workspace_info', 'workspace_tree', 'project_snapshot', 'read_file', 'read_files',
      'search_files', 'search_text', 'git_status', 'git_diff', 'git_log', 'write_file',
      'apply_patch', 'move_file', 'delete_file', 'process_start', 'process_status',
      'process_logs', 'process_stop', 'project_dev', 'project_test', 'project_lint',
      'project_typecheck', 'project_build', 'codex_status', 'codex_run',
      'codex_task_status', 'codex_task_logs', 'codex_stop',
      'shell', 'dom_cdp', 'accessibility', 'input_event', 'vision', 'window', 'health',
      'system_info', 'notification', 'file_dialog', 'clipboard', 'web_fetch',
      'audio', 'screen_record', 'office', 'scheduler',
      'skills_list', 'skills_read', 'mcp_list', 'mcp_describe', 'mcp_call',
    ]);

    if (process.platform === 'win32') {
      const nativeHealth = await callTool(client, 'health', { operation: 'check_tool', tool: 'accessibility' });
      expect(toolRecord(nativeHealth)).toMatchObject({ tool: 'accessibility', available: true });
      const nativeWindows = await callTool(client, 'window', { operation: 'list' });
      expect(toolRecord(nativeWindows)).toMatchObject({ windows: expect.any(Array) });
    }

    const codexStatus = await callTool(client, 'codex_status', {});
    const codexRecord = toolRecord(codexStatus);
    if (typeof codexRecord.installed === 'boolean') {
      expect(codexRecord.capabilities).toEqual(expect.any(Array));
    } else {
      expect(codexStatus).toMatchObject({ isError: true });
      expect(codexRecord).toMatchObject({ error: { code: 'CODEX_NOT_AVAILABLE' } });
    }
    expect(JSON.stringify(codexStatus)).not.toMatch(/password|token|credential|api[_-]?key/i);

    const info = await callTool(client, 'workspace_info', { workspaceId });
    expect(toolRecord(info)).toMatchObject({ id: workspaceId, realRootPath: fixtureRoot });

    const readBefore = await callTool(client, 'read_file', { workspaceId, path: 'src\\app.ts' });
    expect(toolRecord(readBefore)).toMatchObject({ content: "export const value = 'before';\n" });
    const search = await callTool(client, 'search_text', { workspaceId, query: 'before', glob: 'src/*.ts' });
    expect(toolRecord(search)).toMatchObject({ matches: [{ path: expect.stringContaining('src'), text: expect.stringContaining('before') }] });

    const safeWrite = await callTool(client, 'write_file', { workspaceId, path: 'src\\safe-blocked.ts', content: 'blocked\n' });
    // Desktop MCP runtime is forced to the full permission profile.
    expect(toolRecord(safeWrite)).toMatchObject({ path: 'src\\safe-blocked.ts' });
    await page.getByRole('button', { name: 'ตั้งค่า', exact: true }).click();
    await page.getByLabel('Permission profile').selectOption('balanced');
    await expect(page.getByLabel('Permission profile')).toHaveValue('full');
    await page.getByRole('button', { name: 'หน้าหลัก', exact: true }).click();

    const write = await callTool(client, 'write_file', { workspaceId, path: 'src\\created.ts', content: 'export const created = true;\n' });
    expect(toolRecord(write)).toMatchObject({ path: 'src\\created.ts' });
    const patch = await callTool(client, 'apply_patch', {
      workspaceId,
      files: [{ path: 'src\\app.ts', content: "export const value = 'after';\n" }],
    });
    expect(toolRecord(patch)).toMatchObject({ paths: ['src\\app.ts'] });

    // Unrestricted mode: secrets are intentionally readable on every drive.
    const secretRead = await callTool(client, 'read_file', { workspaceId, path: '.env' });
    expect(JSON.stringify(secretRead)).toContain('hidden');
    expect(JSON.stringify(secretRead)).not.toContain('SECRET_ACCESS_DENIED');
    const deniedTraversal = await callTool(client, 'read_file', { workspaceId, path: '..\\outside.txt' });
    expect(deniedTraversal).toMatchObject({ isError: true });
    expect(toolRecord(deniedTraversal)).toMatchObject({ error: { code: 'PATH_OUTSIDE_WORKSPACE' } });

    const gitStatus = await callTool(client, 'git_status', { workspaceId });
    const gitEntries = toolRecord(gitStatus).entries;
    if (!Array.isArray(gitEntries)) throw new Error('Git status did not return entries');
    expect(gitEntries).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'src/app.ts' })]));
    const gitDiff = await callTool(client, 'git_diff', { workspaceId, path: 'src\\app.ts' });
    expect(toolRecord(gitDiff)).toMatchObject({ patch: expect.stringContaining("-export const value = 'before';") });

    const projectTest = await callTool(client, 'project_test', { workspaceId });
    expect(projectTest).toMatchObject({ structuredContent: { processId: expect.any(String) } });
    const processId = stringField(toolRecord(projectTest), 'processId');
    const terminal = await waitForTerminalProcess(client, workspaceId, processId);
    expect(terminal).toMatchObject({ state: 'exited' });
    const logs = await callTool(client, 'process_logs', { workspaceId, processId, tailLines: 20 });
    const logEntries = toolRecord(logs).entries;
    if (!Array.isArray(logEntries)) throw new Error('Process logs did not return entries');
    expect(logEntries).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('project-test-pass') })]));

    const snapshot = await callTool(client, 'project_snapshot', { workspaceId });
    expect(toolRecord(snapshot)).toMatchObject({ project: { kind: 'node' }, git: { changedFiles: expect.any(Number) } });
    expect(await readFile(path.join(fixtureRoot, 'src', 'app.ts'), 'utf8')).toContain("value = 'after'");

    await client.close();
    client = undefined;
    await page.getByRole('button', { name: 'หยุด', exact: true }).click();
    await expect(page.getByTestId('mcp-status')).toHaveText(/Agent หยุดทำงาน|Agent stopped/, { timeout: 30_000 });
    await browser.close();
    browser = undefined;
  } finally {
    if (client !== undefined) await client.close().catch(() => undefined);
    if (page !== undefined) await page.evaluate(() => window.lnwjud.stopMcp()).catch(() => undefined);
    if (browser !== undefined) await browser.close().catch(() => undefined);
    if (electronProcess !== undefined) await terminateProcessTree(electronProcess);
    await Promise.all([removeTemporaryRoot(fixtureRoot), removeTemporaryRoot(dataRoot)]);
  }
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-mcp-client-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'app.ts'), "export const value = 'before';\n", 'utf8');
  await writeFile(path.join(root, '.env'), 'SECRET_NOT_FOR_TOOLS=hidden\n', 'utf8');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'lnwjud-desktop-flow-fixture',
    scripts: { test: "node -e \"process.stdout.write('project-test-pass\\n')\"" },
  }), 'utf8');
  await writeFile(path.join(root, 'package-lock.json'), '{}', 'utf8');
  await execFileAsync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['config', 'user.email', 'lnwjud-test@example.invalid'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['config', 'user.name', 'lnwjud desktop e2e'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['add', '--', 'package.json', 'package-lock.json', 'src'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root, windowsHide: true });
  return root;
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
  }, { timeout: 15_000, intervals: [50, 100, 250] }).toBe(true);
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

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  return client.callTool({ name, arguments: args });
}

async function waitForTerminalProcess(client: Client, workspaceId: string, processId: string): Promise<Record<string, unknown>> {
  await expect.poll(async () => {
    const response = await callTool(client, 'process_status', { workspaceId, processId });
    const state = toolRecord(response).state;
    return state === 'exited' || state === 'failed' || state === 'stopped' || state === 'timed_out' ? state : 'running';
  }, { timeout: 15_000, intervals: [50, 100, 250] }).not.toBe('running');
  return toolRecord(await callTool(client, 'process_status', { workspaceId, processId }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.structuredContent)) throw new Error('MCP response did not include structured content');
  return value.structuredContent;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== 'string') throw new Error(`Missing string field: ${field}`);
  return fieldValue;
}
