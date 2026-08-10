import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CodexService,
  FileService,
  GitService,
  ProcessService,
  ProjectService,
  SearchService,
  WorkspaceInfoService,
  WorkspaceQueryService,
} from '@lnwjud/application';
import { AuditService } from '@lnwjud/audit';
import { CodexAdapter, type CodexDiscoveryPort, type CodexInvocationBuilderPort } from '@lnwjud/codex';
import { ok, type Result } from '@lnwjud/domain';
import { ProcessManager } from '@lnwjud/process';
import { ToolRegistry, type McpApplicationServices } from '@lnwjud/mcp-server';
import { SqliteAuditRepository, SqliteDatabase, SqliteWorkspaceRepository } from '@lnwjud/storage';
import { WorkspaceService } from '@lnwjud/workspace';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Codex review flow', () => {
  it('delegates to a fake Codex executable, reviews the diff, and runs the project test', async () => {
    const fixtureRoot = await createFixture();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-codex-flow-state-'));
    temporaryRoots.push(stateRoot);
    const fakeCodexPath = path.join(stateRoot, 'fake-codex.mjs');
    await writeFile(fakeCodexPath, fakeCodexSource(), 'utf8');

    const database = new SqliteDatabase(path.join(stateRoot, 'state.sqlite'));
    const workspaces = new SqliteWorkspaceRepository(database);
    const auditRepository = new SqliteAuditRepository(database);
    const workspaceService = new WorkspaceService(workspaces);
    const added = await workspaceService.add('Codex fixture', fixtureRoot);
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const actor = { clientId: 'codex-flow-client', clientName: 'codex integration test' };
    const workspaceId = added.value.id;
    const projectService = new ProjectService(workspaces);
    const processService = new ProcessService(workspaces, {
      projectService: {
        async getCommand(): Promise<Result<{ executable: string; args: readonly string[] }>> {
          return ok({ executable: process.execPath, args: ['-e', "process.stdout.write('project-test-pass\\n')"] });
        },
      },
    });
    const codex = new CodexService(workspaces, {
      adapter: fakeCodexAdapter(fakeCodexPath),
      auditService: new AuditService(auditRepository),
      taskIdFactory: (): string => 'codex-review-task',
    });
    const git = new GitService(workspaces);
    const services: McpApplicationServices = {
      workspaceInfo: new WorkspaceInfoService(workspaces),
      workspaceQuery: new WorkspaceQueryService(workspaces),
      project: projectService,
      file: new FileService(workspaces),
      search: new SearchService(workspaces),
      git,
      process: processService,
      codex,
    };
    const registry = new ToolRegistry(services, actor);

    try {
      const run = await registry.invoke('codex_run', { workspaceId, instruction: 'Review the fixture and update the permitted review file.' });
      expect(run).toMatchObject({ structuredContent: { codexTaskId: 'codex-review-task', processId: expect.any(String) } });
      const codexTaskId = stringField(run, 'codexTaskId');
      const terminal = await waitForCodexTerminal(registry, workspaceId, codexTaskId);
      expect(terminal.state).toBe('exited');

      const logs = await registry.invoke('codex_task_logs', { workspaceId, codexTaskId, tailLines: 20 });
      expect(logs).toMatchObject({ structuredContent: { entries: [{ text: expect.stringContaining('fake-codex-started') }] } });

      const diff = await registry.invoke('git_diff', { workspaceId, path: 'src/reviewed.ts' });
      expect(diff).toMatchObject({ structuredContent: { patch: expect.stringContaining("+export const reviewed = true;") } });

      const projectTest = await registry.invoke('project_test', { workspaceId });
      expect(projectTest).toMatchObject({ structuredContent: { processId: expect.any(String) } });
      const projectProcessId = stringField(projectTest, 'processId');
      await waitForProcessTerminal(registry, workspaceId, projectProcessId);
      const projectLogs = await registry.invoke('process_logs', { workspaceId, processId: projectProcessId, tailLines: 20 });
      expect(projectLogs).toMatchObject({ structuredContent: { entries: [{ text: expect.stringContaining('project-test-pass') }] } });

      const events = await auditRepository.list();
      expect(events).toHaveLength(1);
      expect(events[0]?.action).toBe('codex_run');
      expect(JSON.stringify(events)).not.toContain('Review the fixture and update the permitted review file.');
      expect(await readFile(path.join(fixtureRoot, 'src', 'reviewed.ts'), 'utf8')).toBe('export const reviewed = true;\n');
    } finally {
      database.close();
    }
  });
});

function fakeCodexAdapter(fakeCodexPath: string): CodexAdapter {
  const discovery: CodexDiscoveryPort = {
    async discover() {
      return ok({
        status: { installed: true, executablePath: process.execPath, version: 'fake-0.1.0', capabilities: ['exec'] },
        capabilities: { instructionMode: 'positional-argument', names: ['prompt'] },
      });
    },
  };
  const manager = new ProcessManager();
  const invocationBuilder: CodexInvocationBuilderPort = {
    build(executable, _capabilities, instruction) {
      return ok({ executable, args: [fakeCodexPath, instruction] });
    },
  };
  return new CodexAdapter(discovery, manager, invocationBuilder);
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-codex-flow-fixture-'));
  temporaryRoots.push(root);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'reviewed.ts'), 'export const reviewed = false;\n', 'utf8');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'lnwjud-codex-fixture', scripts: { test: 'node -e "process.stdout.write(\'project-test-pass\\n\')"' } }), 'utf8');
  await writeFile(path.join(root, 'package-lock.json'), '{}', 'utf8');
  await execFileAsync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['config', 'user.email', 'lnwjud-test@example.invalid'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['config', 'user.name', 'lnwjud codex integration'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['add', '--', 'package.json', 'package-lock.json', 'src'], { cwd: root, windowsHide: true });
  await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root, windowsHide: true });
  return root;
}

function fakeCodexSource(): string {
  return [
    "import { writeFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    "process.stdout.write('fake-codex-started\\n');",
    "await writeFile(path.join(process.cwd(), 'src', 'reviewed.ts'), 'export const reviewed = true;\\n', 'utf8');",
  ].join('\n');
}

async function waitForCodexTerminal(registry: ToolRegistry, workspaceId: string, codexTaskId: string): Promise<Record<string, unknown>> {
  return waitForTerminal(async () => structuredRecord(await registry.invoke('codex_task_status', { workspaceId, codexTaskId })));
}

async function waitForProcessTerminal(registry: ToolRegistry, workspaceId: string, processId: string): Promise<Record<string, unknown>> {
  return waitForTerminal(async () => structuredRecord(await registry.invoke('process_status', { workspaceId, processId })));
}

async function waitForTerminal(readStatus: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = await readStatus();
    const state = status.state;
    if (state === 'exited' || state === 'failed' || state === 'stopped' || state === 'timed_out') return status;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for process');
}

function stringField(response: { readonly structuredContent?: Readonly<Record<string, unknown>> }, field: string): string {
  const value = response.structuredContent?.[field];
  if (typeof value !== 'string') throw new Error(`Missing string field: ${field}`);
  return value;
}

function structuredRecord(response: { readonly structuredContent?: Readonly<Record<string, unknown>> }): Record<string, unknown> {
  if (response.structuredContent === undefined) throw new Error('MCP response did not include structured content');
  return response.structuredContent;
}
