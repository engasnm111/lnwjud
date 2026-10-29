import { execFile } from 'node:child_process';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { redactDiagnosticText } from '@lnwjud/application';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopRuntime } from '../src/main/desktop-services.js';

const execFileAsync = promisify(execFile);
const fixtureOwners = new Set<FixtureOwner>();

class FixtureOwner {
  private readonly roots = new Map<string, string>();
  private closed = false;
  private completed = false;

  public track(root: string, reason: string): void {
    if (this.closed || this.completed) {
      console.warn(`Retained acceptance fixture: ${root} (${reason})`);
      throw new Error('Acceptance fixture teardown has started');
    }
    this.ensureActive();
    this.roots.set(root, reason);
  }

  public ensureActive(): void {
    if (this.closed || this.completed) throw new Error('Acceptance fixture teardown has started');
  }

  public complete(): void {
    this.ensureActive();
    this.completed = true;
  }

  public async cleanup(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.roots].map(async ([root, reason]) => {
      if (!this.completed) {
        console.warn(`Retained acceptance fixture: ${root} (${reason})`);
        return;
      }
      try {
        const base = await realpath(os.tmpdir()), resolved = await realpath(root);
        if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('lnwjud-')) throw new Error('Fixture cleanup path is outside its temporary root');
        await rm(resolved, { recursive: true, force: true });
      } catch {
        console.warn(`Acceptance fixture cleanup did not complete: ${root}`);
      }
    }));
  }
}

function createFixtureOwner(): FixtureOwner {
  const owner = new FixtureOwner();
  fixtureOwners.add(owner);
  return owner;
}

beforeEach(() => {
  vi.stubEnv('LNWJUD_UNRESTRICTED', '1');
});

async function removeRetentionFixture(root: string, base: string): Promise<void> {
  const resolved = await realpath(root);
  if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('lnwjud-retention-test-')) {
    throw new Error('Fixture cleanup path is outside its temporary root');
  }
  await rm(resolved, { recursive: true, force: true });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  const owners = [...fixtureOwners];
  fixtureOwners.clear();
  await Promise.all(owners.map((owner) => owner.cleanup()));
});

describe('multi-workspace concurrency acceptance', () => {
  it('keeps fixtures when termination has not been verified', async () => {
    const oldOwner = createFixtureOwner();
    const base = await realpath(os.tmpdir());
    const kept = await mkdtemp(path.join(base, 'lnwjud-retention-test-'));
    try {
      oldOwner.track(kept, 'termination unverified');
      await oldOwner.cleanup();
      const nextOwner = createFixtureOwner();
      const released = await mkdtemp(path.join(base, 'lnwjud-retention-test-'));
      nextOwner.track(released, 'next fixture');
      await expect(access(kept)).resolves.toBeUndefined();
      expect(() => oldOwner.ensureActive()).toThrow('Acceptance fixture teardown has started');
      expect(() => oldOwner.complete()).toThrow('Acceptance fixture teardown has started');
      expect(() => oldOwner.track(kept, 'late dispatch')).toThrow('Acceptance fixture teardown has started');
      expect(() => nextOwner.ensureActive()).not.toThrow();
      nextOwner.complete();
      await nextOwner.cleanup();
      await expect(access(released)).rejects.toThrow();
    } finally {
      await removeRetentionFixture(kept, base);
    }
  });

  it('runs two real MCP sessions in parallel without mixing workspace or session ownership', async () => {
    const owner = createFixtureOwner();
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-multi-session-data-'));
    owner.track(rawDataRoot, 'acceptance setup not fully settled');
    const dataRoot = await realpath(rawDataRoot);
    const workspaceRootA = await createWorkspaceFixture('a', owner);
    const workspaceRootB = await createWorkspaceFixture('b', owner);
    owner.ensureActive();
    let allWorkCompleted = false;
    const runtime = createDesktopRuntime(dataRoot, {
      hostMutationApprovalProvider: async (): Promise<boolean> => true,
    });
    const originalProjectStart = runtime.mcpServices.process.startProjectCommand.bind(runtime.mcpServices.process);
    let buildCause: string | null = null;
    let testCause: string | null = null;
    const projectStartSpy = vi.spyOn(runtime.mcpServices.process, 'startProjectCommand').mockImplementation(async (...args) => {
      const result = await originalProjectStart(...args);
      if (args[2] === 'build' && !result.ok) buildCause = redactDiagnosticText(result.error.message);
      if (args[2] === 'test' && !result.ok) testCause = redactDiagnosticText(result.error.message);
      return result;
    });
    const clientA = new Client({ name: 'multi-session-a', version: '1.0.0' });
    const clientB = new Client({ name: 'multi-session-b', version: '1.0.0' });
    const callA = clientA.callTool.bind(clientA), callB = clientB.callTool.bind(clientB);
    const callASpy = vi.spyOn(clientA, 'callTool').mockImplementation((...args) => { owner.ensureActive(); return callA(...args); });
    const callBSpy = vi.spyOn(clientB, 'callTool').mockImplementation((...args) => { owner.ensureActive(); return callB(...args); });
    let transportA: StreamableHTTPClientTransport | null = null;
    let transportB: StreamableHTTPClientTransport | null = null;

    try {
      owner.ensureActive();
      const workspaceA = await runtime.services.addWorkspace({ rootPath: workspaceRootA });
      owner.ensureActive();
      const workspaceB = await runtime.services.addWorkspace({ rootPath: workspaceRootB });
      owner.ensureActive();
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

      owner.ensureActive();
      await runtime.services.setWorkspaceActive({ workspaceId: workspaceA.id, active: false });
      expect((await runtime.services.getDashboard()).activeWorkspaces.map((workspace) => workspace.id)).toEqual([workspaceB.id]);
      const inactiveWrite = await clientA.callTool({
        name: 'write_file',
        arguments: { workspaceId: workspaceA.id, path: 'inactive-write.txt', content: 'blocked' },
      });
      expect(inactiveWrite.isError).toBe(true);
      expect(errorCode(inactiveWrite)).toBe('PERMISSION_DENIED');

      owner.ensureActive();
      await runtime.services.setWorkspaceActive({ workspaceId: workspaceA.id, active: true });
      expect(new Set((await runtime.services.getDashboard()).activeWorkspaces.map((workspace) => workspace.id))).toEqual(new Set([workspaceA.id, workspaceB.id]));
      owner.ensureActive();
      await runtime.services.selectWorkspace({ workspaceId: workspaceA.id });
      await prepareSessionFiles(clientA, workspaceA.id, 'a');
      owner.ensureActive();
      await runtime.services.selectWorkspace({ workspaceId: workspaceB.id });
      await prepareSessionFiles(clientB, workspaceB.id, 'b');

      owner.ensureActive();
      await runtime.services.selectWorkspace({ workspaceId: workspaceA.id });
      owner.ensureActive();
      const buildA = await clientA.callTool({
        name: 'project_build', arguments: { workspaceId: workspaceA.id, userConfirmed: true },
      });
      if (process.platform !== 'darwin') {
        expect(buildA.isError, redactDiagnosticText(JSON.stringify({ result: buildA.structuredContent, cause: buildCause })).slice(0, 2048)).not.toBe(true);
      }
      owner.ensureActive();
      await runtime.services.selectWorkspace({ workspaceId: workspaceB.id });
      const testB = await clientB.callTool({
        name: 'project_test', arguments: { workspaceId: workspaceB.id, userConfirmed: true },
      });
      if (process.platform === 'darwin') {
        // No macOS owner-loss-safe all-descendant fence exists yet: no child may launch.
        expect(buildA.isError).toBe(true);
        expect(testB.isError).toBe(true);
        await expect(access(path.join(workspaceRootA, 'build.started'))).rejects.toThrow();
        await expect(access(path.join(workspaceRootB, 'test.started'))).rejects.toThrow();
        expect(buildCause).toBe('macOS process writer containment unavailable: escaped descendants are not kernel-fenced');
        expect(testCause).toBe('macOS process writer containment unavailable: escaped descendants are not kernel-fenced');
        allWorkCompleted = true;
        return;
      }
      expect(testB.isError, redactDiagnosticText(JSON.stringify(testB.structuredContent) ?? '').slice(0, 2048)).not.toBe(true);
      const processA = stringField(buildA, 'processId');
      const processB = stringField(testB, 'processId');

      try {
        await Promise.all([
          waitForFile(path.join(workspaceRootA, 'build.started')),
          waitForFile(path.join(workspaceRootB, 'test.started')),
        ]);
      } catch (error: unknown) {
        // An accepted native process may still fail before its fixture runs.
        // Preserve the live process states in CI diagnostics instead of only
        // reporting an uninformative timeout.
        const [statusA, statusB] = await Promise.allSettled([
          clientA.callTool({ name: 'process_status', arguments: { workspaceId: workspaceA.id, processId: processA } }),
          clientB.callTool({ name: 'process_status', arguments: { workspaceId: workspaceB.id, processId: processB } }),
        ]);
        const a = statusA.status === 'fulfilled' ? statusA.value.structuredContent?.state : 'unavailable';
        const b = statusB.status === 'fulfilled' ? statusB.value.structuredContent?.state : 'unavailable';
        throw new Error(`Process startup did not reach both fixtures: ${error instanceof Error ? error.message : String(error)}; build=${String(a)}, test=${String(b)}`);
      }

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

      owner.ensureActive();
      await runtime.services.selectWorkspace({ workspaceId: workspaceB.id });
      owner.ensureActive();
      expect((await runtime.services.startMcp({ workspaceId: workspaceB.id })).url).toBe(connection.url);
      owner.ensureActive();
      await runtime.services.selectWorkspace({ workspaceId: workspaceA.id });
      owner.ensureActive();
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

      owner.ensureActive();
      await runtime.services.selectWorkspace({ workspaceId: workspaceA.id });
      owner.ensureActive();
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
      owner.ensureActive();
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
      expect(shellDoneA.isError, JSON.stringify(shellDoneA.structuredContent)).not.toBe(true);
      expect(shellDoneA.structuredContent, JSON.stringify(shellDoneA.structuredContent)).toMatchObject({ state: 'completed', exit_code: 0, stdout: 'background-a' });
      expect(shellDoneB.isError, JSON.stringify(shellDoneB.structuredContent)).not.toBe(true);
      expect(shellDoneB.structuredContent, JSON.stringify(shellDoneB.structuredContent)).toMatchObject({ state: 'completed', exit_code: 0, stdout: 'background-b' });

      const [gitA, gitB] = await Promise.all([
        clientA.callTool({ name: 'git_status', arguments: { workspaceId: workspaceA.id } }),
        clientB.callTool({ name: 'git_status', arguments: { workspaceId: workspaceB.id } }),
      ]);
      expect(gitPaths(gitA)).toContain('flow-a.txt');
      expect(gitPaths(gitB)).toContain('flow-b.txt');

      owner.ensureActive();
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
      expect(crossDeleteA.isError, JSON.stringify(crossDeleteA)).not.toBe(true);
      expect(crossDeleteB.isError, JSON.stringify(crossDeleteB)).not.toBe(true);
      await expect(access(path.join(workspaceRootA, 'victim-a.txt'))).rejects.toThrow();
      await expect(access(path.join(workspaceRootB, 'victim-b.txt'))).rejects.toThrow();

      await Promise.all([
        writeFile(path.join(workspaceRootA, 'victim-a.txt'), 'victim-a', 'utf8'),
        writeFile(path.join(workspaceRootB, 'victim-b.txt'), 'victim-b', 'utf8'),
      ]);
      owner.ensureActive();
      await runtime.services.selectWorkspace({ workspaceId: workspaceA.id });
      const ownDeleteA = await clientA.callTool({ name: 'delete_file', arguments: { workspaceId: workspaceA.id, path: 'victim-a.txt' } });
      owner.ensureActive();
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

      owner.ensureActive();
      await runtime.services.clearWorkLog({ workspaceId: workspaceA.id });
      const afterWorkLogClear = await runtime.services.getDashboard();
      expect(afterWorkLogClear.workLog.some((entry) => entry.workspaceId === workspaceA.id)).toBe(false);
      expect(afterWorkLogClear.workLog.some((entry) => entry.workspaceId === workspaceB.id)).toBe(true);

      owner.ensureActive();
      await runtime.services.clearLogBuffer({ source: 'mcp', workspaceId: workspaceA.id });
      const afterLiveClear = await runtime.services.getLogSnapshot();
      expect(afterLiveClear.lines.some((line) => line.source === 'mcp' && line.workspaceId === workspaceA.id)).toBe(false);
      expect(afterLiveClear.lines.some((line) => line.source === 'mcp' && line.workspaceId === workspaceB.id)).toBe(true);
      allWorkCompleted = true;
    } finally {
      callASpy.mockRestore(); callBSpy.mockRestore();
      projectStartSpy.mockRestore();
      await Promise.allSettled([
        writeFile(path.join(workspaceRootA, 'release.flag'), 'go', 'utf8'),
        writeFile(path.join(workspaceRootB, 'release.flag'), 'go', 'utf8'),
      ]);
      await Promise.allSettled([clientA.close(), clientB.close()]);
      await runtime.close();
      if (allWorkCompleted) owner.complete();
    }
  }, process.env.CI ? 180_000 : 90_000);

  it('serves three real MCP sessions and a 12-request burst through one Desktop listener', async () => {
    const owner = createFixtureOwner();
    const rawDataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-three-chat-data-'));
    owner.track(rawDataRoot, 'acceptance setup not fully settled');
    const dataRoot = await realpath(rawDataRoot);
    const workspaceRoot = await createWorkspaceFixture('three-chat', owner);
    owner.ensureActive();
    const runtime = createDesktopRuntime(dataRoot, {
      hostMutationApprovalProvider: async (): Promise<boolean> => true,
    });
    const clients = Array.from({ length: 3 }, (_, index) => new Client({ name: `three-chat-${index + 1}`, version: '1.0.0' }));
    const callSpies = clients.map((client) => {
      const call = client.callTool.bind(client);
      return vi.spyOn(client, 'callTool').mockImplementation((...args) => { owner.ensureActive(); return call(...args); });
    });
    const transports: StreamableHTTPClientTransport[] = [];
    let allWorkCompleted = false;

    try {
      owner.ensureActive();
      const workspace = await runtime.services.addWorkspace({ rootPath: workspaceRoot });
      owner.ensureActive();
      const connection = await runtime.services.startMcp({ workspaceId: workspace.id });
      expect(connection.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      if (connection.url === null) return;

      for (let index = 0; index < clients.length; index += 1) {
        transports.push(new StreamableHTTPClientTransport(new URL(connection.url)));
      }
      await Promise.all(clients.map((client, index) => client.connect(transports[index]!)));
      expect(new Set(transports.map((transport) => transport.sessionId)).size).toBe(3);

      const burst = clients.flatMap((client) => Array.from({ length: 4 }, () => client.callTool({
        name: 'workspace_info',
        arguments: { workspaceId: workspace.id },
      })));
      const results = await Promise.all(burst);
      expect(results).toHaveLength(12);
      for (const result of results) expect(result.isError, JSON.stringify(result)).not.toBe(true);
      allWorkCompleted = true;
    } finally {
      for (const spy of callSpies) spy.mockRestore();
      await Promise.allSettled(clients.map((client) => client.close()));
      await runtime.close();
      if (allWorkCompleted) owner.complete();
    }
  }, process.env.CI ? 60_000 : 30_000);
});

async function createWorkspaceFixture(label: string, owner: FixtureOwner): Promise<string> {
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), `lnwjud-multi-${label}-`));
  owner.track(rawRoot, 'acceptance setup not fully settled');
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
  owner.ensureActive();
  await execFileAsync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
  owner.ensureActive();
  await execFileAsync('git', ['config', 'user.email', 'lnwjud-test@example.invalid'], { cwd: root, windowsHide: true });
  owner.ensureActive();
  await execFileAsync('git', ['config', 'user.name', 'lnwjud acceptance'], { cwd: root, windowsHide: true });
  owner.ensureActive();
  await execFileAsync('git', ['add', '--', 'barrier.js', 'background.js', 'package.json', 'package-lock.json'], { cwd: root, windowsHide: true });
  owner.ensureActive();
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

async function waitForFile(filePath: string, timeoutMs = process.env.CI ? 90_000 : 20_000): Promise<void> {
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
  const deadline = Date.now() + (process.env.CI ? 60_000 : 20_000);
  while (Date.now() < deadline) {
    const response = await client.callTool({
      name: 'shell',
      arguments: { operation: 'wait', workspaceId, task_id: taskId, timeout_seconds: 2 },
    });
    const state = structuredRecord(response).state;
    if (state !== 'starting' && state !== 'running' && state !== 'queued') return response;
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
