import { execFile } from 'node:child_process';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopRuntime } from '../src/main/desktop-services.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

beforeEach(() => {
  vi.stubEnv('LNWJUD_UNRESTRICTED', '1');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      // Ignore transient Windows cleanup locks.
    }
  }));
});

describe('multi-workspace concurrency acceptance', () => {
  it('runs two real MCP sessions in parallel without mixing workspace or session ownership', async () => {
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-multi-session-data-'));
    temporaryRoots.push(rawDataRoot);
    const dataRoot = await realpath(rawDataRoot);
    const workspaceRootA = await createWorkspaceFixture('a');
    const workspaceRootB = await createWorkspaceFixture('b');
    const runtime = createDesktopRuntime(dataRoot, {
      hostMutationApprovalProvider: async (): Promise<boolean> => true,
    });
    const clientA = new Client({ name: 'multi-session-a', version: '1.0.0' });
    const clientB = new Client({ name: 'multi-session-b', version: '1.0.0' });
    let transportA: StreamableHTTPClientTransport | null = null;
    let transportB: StreamableHTTPClientTransport | null = null;

    try {
      const workspaceA = await runtime.services.addWorkspace({ rootPath: workspaceRootA });
      const workspaceB = await runtime.services.addWorkspace({ rootPath: workspaceRootB });
      const connection = await runtime.services.startMcp({ workspaceId: workspaceA.id });
      expect(connection.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      if (connection.url === null) return;

      transportA = new StreamableHTTPClientTransport(new URL(connection.url));
      transportB = new StreamableHTTPClientTransport(new URL(connection.url));
      await Promise.all([clientA.connect(transportA), clientB.connect(transportB)]);
      expect(transportA.sessionId).toEqual(expect.any(String));
      expect(transportB.sessionId).toEqual(expect.any(String));
      expect(transportA.sessionId).not.toBe(transportB.sessionId);

      const [toolsA, toolsB] = await Promise.all([clientA.listTools(), clientB.listTools()]);
      expect(toolsA.tools.map((tool) => tool.name).sort()).toEqual(toolsB.tools.map((tool) => tool.name).sort());
      expect(toolsA.tools.length).toBeGreaterThan(0);

      await runtime.services.setWorkspaceActive({ workspaceId: workspaceA.id, active: false });
      expect((await runtime.services.getDashboard()).activeWorkspaces.map((workspace) => workspace.id)).toEqual([workspaceB.id]);
      const inactiveWrite = await clientA.callTool({
        name: 'write_file',
        arguments: { workspaceId: workspaceA.id, path: 'inactive-write.txt', content: 'blocked' },
      });
      expect(inactiveWrite.isError).toBe(true);
      expect(errorCode(inactiveWrite)).toBe('PERMISSION_DENIED');

      await runtime.services.setWorkspaceActive({ workspaceId: workspaceA.id, active: true });
      expect(new Set((await runtime.services.getDashboard()).activeWorkspaces.map((workspace) => workspace.id))).toEqual(new Set([workspaceA.id, workspaceB.id]));
      await runtime.services.selectWorkspace({ workspaceId: workspaceA.id });
      await prepareSessionFiles(clientA, workspaceA.id, 'a');
      await runtime.services.selectWorkspace({ workspaceId: workspaceB.id });
      await prepareSessionFiles(clientB, workspaceB.id, 'b');

      await runtime.services.selectWorkspace({ workspaceId: workspaceA.id });
      const buildA = await clientA.callTool({
        name: 'project_build', arguments: { workspaceId: workspaceA.id, userConfirmed: true },
      });
      await runtime.services.selectWorkspace({ workspaceId: workspaceB.id });
      const testB = await clientB.callTool({
        name: 'project_test', arguments: { workspaceId: workspaceB.id, userConfirmed: true },
      });
      expect(buildA.isError).not.toBe(true);
      expect(testB.isError).not.toBe(true);
      const processA = stringField(buildA, 'processId');
      const processB = stringField(testB, 'processId');

      await Promise.all([
        waitForFile(path.join(workspaceRootA, 'build.started')),
        waitForFile(path.join(workspaceRootB, 'test.started')),
      ]);

      const deniedProcess = await clientB.callTool({
        name: 'process_status',
        arguments: { workspaceId: workspaceA.id, processId: processA },
      });
      expect(deniedProcess.isError).toBe(true);
      expect(errorCode(deniedProcess)).toBe('PERMISSION_DENIED');

      const ownProcess = await clientA.callTool({
        name: 'process_status',
        arguments: { workspaceId: workspaceA.id, processId: processA },
      });
      expect(ownProcess.isError).not.toBe(true);
      expect(['starting', 'running']).toContain(structuredRecord(ownProcess).state);

      await runtime.services.selectWorkspace({ workspaceId: workspaceB.id });
      expect((await runtime.services.startMcp({ workspaceId: workspaceB.id })).url).toBe(connection.url);
      await runtime.services.selectWorkspace({ workspaceId: workspaceA.id });
      expect((await runtime.services.startMcp({ workspaceId: workspaceA.id })).url).toBe(connection.url);

      await Promise.all([
        writeFile(path.join(workspaceRootA, 'release.flag'), 'go', 'utf8'),
        writeFile(path.join(workspaceRootB, 'release.flag'), 'go', 'utf8'),
      ]);
      const [terminalA, terminalB] = await Promise.all([
        waitForTerminalProcess(clientA, workspaceA.id, processA),
        waitForTerminalProcess(clientB, workspaceB.id, processB),
      ]);
      expect(terminalA.state).toBe('exited');
      expect(terminalB.state).toBe('exited');

      await runtime.services.selectWorkspace({ workspaceId: workspaceA.id });
      const shellA = await clientA.callTool({
        name: 'shell',
        arguments: {
          workspaceId: workspaceA.id,
          executable: process.execPath,
          arguments: ['background.js', 'background-a'],
          cwd: workspaceRootA,
          execution: 'background',
          userConfirmed: true,
        },
      });
      await runtime.services.selectWorkspace({ workspaceId: workspaceB.id });
      const shellB = await clientB.callTool({
        name: 'shell',
        arguments: {
          workspaceId: workspaceB.id,
          executable: process.execPath,
          arguments: ['background.js', 'background-b'],
          cwd: workspaceRootB,
          execution: 'background',
          userConfirmed: true,
        },
      });
      try { await access(workspaceRootA); console.log('TMP_ROOT_EXISTS', workspaceRootA); } catch (e) { console.log('TMP_ROOT_MISSING', workspaceRootA, String(e)); }
      console.log('TMP_SHELL_A', JSON.stringify(shellA));
      expect(shellA.isError).not.toBe(true);
      expect(shellB.isError).not.toBe(true);
      const taskA = stringField(shellA, 'task_id');
      const taskB = stringField(shellB, 'task_id');

      const deniedTask = await clientB.callTool({
        name: 'shell',
        arguments: { operation: 'status', workspaceId: workspaceA.id, task_id: taskA },
      });
      expect(deniedTask.isError).toBe(true);
      expect(errorCode(deniedTask)).toBe('PERMISSION_DENIED');

      const [shellDoneA, shellDoneB] = await Promise.all([
        waitForTerminalShellTask(clientA, workspaceA.id, taskA),
        waitForTerminalShellTask(clientB, workspaceB.id, taskB),
      ]);
      expect(shellDoneA.isError).not.toBe(true);
      expect(shellDoneA.structuredContent).toMatchObject({ state: 'completed', exit_code: 0, stdout: 'background-a' });
      expect(shellDoneB.isError).not.toBe(true);
      expect(shellDoneB.structuredContent).toMatchObject({ state: 'completed', exit_code: 0, stdout: 'background-b' });

      const [gitA, gitB] = await Promise.all([
        clientA.callTool({ name: 'git_status', arguments: { workspaceId: workspaceA.id } }),
        clientB.callTool({ name: 'git_status', arguments: { workspaceId: workspaceB.id } }),
      ]);
      expect(gitPaths(gitA)).toContain('flow-a.txt');
      expect(gitPaths(gitB)).toContain('flow-b.txt');

      await expect(runtime.services.setAiDeletePolicy({ enabled: true })).resolves.toMatchObject({
        enabled: true,
        policy: { approvals: { delete_file: true } },
      });
      const [crossDeleteA, crossDeleteB] = await Promise.all([
        clientA.callTool({
          name: 'delete_file',
          arguments: { workspaceId: workspaceA.id, path: path.join(workspaceRootB, 'victim-b.txt') },
        }),
        clientB.callTool({
          name: 'delete_file',
          arguments: { workspaceId: workspaceB.id, path: path.join(workspaceRootA, 'victim-a.txt') },
        }),
      ]);
      expect(crossDeleteA.isError).not.toBe(true);
      expect(crossDeleteB.isError).not.toBe(true);
      await expect(access(path.join(workspaceRootA, 'victim-a.txt'))).rejects.toThrow();
      await expect(access(path.join(workspaceRootB, 'victim-b.txt'))).rejects.toThrow();

      await Promise.all([
        writeFile(path.join(workspaceRootA, 'victim-a.txt'), 'victim-a', 'utf8'),
        writeFile(path.join(workspaceRootB, 'victim-b.txt'), 'victim-b', 'utf8'),
      ]);
      await runtime.services.selectWorkspace({ workspaceId: workspaceA.id });
      const ownDeleteA = await clientA.callTool({ name: 'delete_file', arguments: { workspaceId: workspaceA.id, path: 'victim-a.txt' } });
      await runtime.services.selectWorkspace({ workspaceId: workspaceB.id });
      const ownDeleteB = await clientB.callTool({ name: 'delete_file', arguments: { workspaceId: workspaceB.id, path: 'victim-b.txt' } });
      expect(ownDeleteA.isError).not.toBe(true);
      expect(ownDeleteB.isError).not.toBe(true);
      await expect(access(path.join(workspaceRootA, 'victim-a.txt'))).rejects.toThrow();
      await expect(access(path.join(workspaceRootB, 'victim-b.txt'))).rejects.toThrow();

      const dashboard = await runtime.services.getDashboard();
      const scopedWorkLog = dashboard.workLog.filter((entry) =>
        entry.workspaceId === workspaceA.id || entry.workspaceId === workspaceB.id
      );
      expect(scopedWorkLog.some((entry) => entry.workspaceId === workspaceA.id)).toBe(true);
      expect(scopedWorkLog.some((entry) => entry.workspaceId === workspaceB.id)).toBe(true);
      expect(new Set(scopedWorkLog.map((entry) => entry.sessionId).filter((value): value is string => value !== null)).size)
        .toBeGreaterThanOrEqual(2);

      const live = await runtime.services.getLogSnapshot();
      const scopedMcpLines = live.lines.filter((line) =>
        line.source === 'mcp' && (line.workspaceId === workspaceA.id || line.workspaceId === workspaceB.id)
      );
      expect(scopedMcpLines.some((line) => line.workspaceId === workspaceA.id)).toBe(true);
      expect(scopedMcpLines.some((line) => line.workspaceId === workspaceB.id)).toBe(true);
      expect(new Set(scopedMcpLines.map((line) => line.sessionId).filter((value): value is string => value !== null)).size)
        .toBeGreaterThanOrEqual(2);

      await runtime.services.clearWorkLog({ workspaceId: workspaceA.id });
      const afterWorkLogClear = await runtime.services.getDashboard();
      expect(afterWorkLogClear.workLog.some((entry) => entry.workspaceId === workspaceA.id)).toBe(false);
      expect(afterWorkLogClear.workLog.some((entry) => entry.workspaceId === workspaceB.id)).toBe(true);

      await runtime.services.clearLogBuffer({ source: 'mcp', workspaceId: workspaceA.id });
      const afterLiveClear = await runtime.services.getLogSnapshot();
      expect(afterLiveClear.lines.some((line) => line.source === 'mcp' && line.workspaceId === workspaceA.id)).toBe(false);
      expect(afterLiveClear.lines.some((line) => line.source === 'mcp' && line.workspaceId === workspaceB.id)).toBe(true);
    } finally {
      await Promise.allSettled([
        writeFile(path.join(workspaceRootA, 'release.flag'), 'go', 'utf8'),
        writeFile(path.join(workspaceRootB, 'release.flag'), 'go', 'utf8'),
      ]);
      await Promise.allSettled([clientA.close(), clientB.close()]);
      await runtime.close();
    }
  }, 90_000);
});

async function createWorkspaceFixture(label: string): Promise<string> {
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), `lnwjud-multi-${label}-`));
  temporaryRoots.push(rawRoot);
  const root = await realpath(rawRoot);
  const barrierScript = [
    "const fs = require('node:fs');",
    "const mode = process.argv[2];",
    "fs.writeFileSync(`${mode}.started`, '1');",
    "const timer = setInterval(() => {",
    "  if (!fs.existsSync('release.flag')) return;",
    "  clearInterval(timer);",
    "  fs.writeFileSync(`${mode}.done`, '1');",
    "  process.stdout.write(`project-${mode}-pass\\n`);",
    "}, 5);",
  ].join('\n');
  const backgroundScript = "process.stdout.write(process.argv[2] ?? '')\n";
  await writeFile(path.join(root, 'barrier.js'), barrierScript, 'utf8');
  await writeFile(path.join(root, 'background.js'), backgroundScript, 'utf8');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: `lnwjud-multi-${label}`,
    private: true,
    scripts: {
      build: 'node barrier.js build',
      test: 'node barrier.js test',
    },
  }), 'utf8');
  await writeFile(path.join(root, 'package-lock.json'), '{}', 'utf8');
  await execFileAsync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['config', 'user.email', 'lnwjud-test@example.invalid'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['config', 'user.name', 'lnwjud acceptance'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['add', '--', 'barrier.js', 'background.js', 'package.json', 'package-lock.json'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root, windowsHide: true });
  return root;
}

async function prepareSessionFiles(client: Client, workspaceId: string, label: string): Promise<void> {
  const flow = await client.callTool({
    name: 'write_file',
    arguments: { workspaceId, path: `flow-${label}.txt`, content: `flow-${label}` },
  });
  expect(flow.isError).not.toBe(true);
  const victim = await client.callTool({
    name: 'write_file',
    arguments: { workspaceId, path: `victim-${label}.txt`, content: `victim-${label}` },
  });
  expect(victim.isError).not.toBe(true);
}

async function waitForFile(filePath: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}`);
}

async function waitForTerminalShellTask(
  client: Client,
  workspaceId: string,
  taskId: string,
): Promise<{ readonly isError?: boolean; readonly structuredContent?: Readonly<Record<string, unknown>> }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await client.callTool({
      name: 'shell',
      arguments: { operation: 'wait', workspaceId, task_id: taskId, timeout_seconds: 2 },
    });
    const state = structuredRecord(response).state;
    if (state !== 'running' && state !== 'queued') return response;
  }
  throw new Error(`Timed out waiting for shell task ${taskId}`);
}

async function waitForTerminalProcess(client: Client, workspaceId: string, processId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + (process.env.CI ? 45_000 : 15_000);
  while (Date.now() < deadline) {
    const response = await client.callTool({
      name: 'process_status',
      arguments: { workspaceId, processId },
    });
    const record = structuredRecord(response);
    const state = record.state;
    if (state === 'exited' || state === 'failed' || state === 'stopped' || state === 'timed_out' || state === 'termination_unverified') {
      return record;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for process ${processId}`);
}

function stringField(response: { readonly structuredContent?: Readonly<Record<string, unknown>> }, field: string): string {
  const value = response.structuredContent?.[field];
  if (typeof value !== 'string') throw new Error(`Missing string field: ${field}`);
  return value;
}

function structuredRecord(response: { readonly structuredContent?: Readonly<Record<string, unknown>> }): Record<string, unknown> {
  if (response.structuredContent === undefined) throw new Error('MCP response did not include structured content');
  return { ...response.structuredContent };
}

function errorCode(response: { readonly structuredContent?: Readonly<Record<string, unknown>> }): string | null {
  const error = response.structuredContent?.error;
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function gitPaths(response: { readonly structuredContent?: Readonly<Record<string, unknown>> }): string[] {
  const entries = response.structuredContent?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || !('path' in entry) || typeof entry.path !== 'string') return [];
    return [entry.path];
  });
}
