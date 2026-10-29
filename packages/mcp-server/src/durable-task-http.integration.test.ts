import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CAPABILITY_TASK_OWNER_METADATA_KEY, ShellCapabilityBackend, readCapabilityTaskOwner, type CapabilityTaskOwner } from '@lnwjud/capabilities';
import { appError, err } from '@lnwjud/domain';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { startMcpHttp, type McpHttpServerHandle } from './http.js';
import { createProtocolHttpRequestScope } from './request-scope.js';
import { nativeFixture } from '../../process/test/native-fixture.js';

const metadataSchema = z.object({ owner_client_id: z.string(), owner_session_id: z.string(), owner_workspace_id: z.string() });
const launchRecordSchema = z.object({ taskId: z.string(), ownerClientId: z.string(), ownerSessionId: z.string(), ownerWorkspaceId: z.string() });
const stdout = '  ready ไทย 😀\n  done ไทย 😀  \n';
const stderr = 'warning ไทย\nfinished\n';
const fixtureSource = `
import fs from 'node:fs';
import path from 'node:path';
const [readyPath, releasePath] = process.argv.slice(2);
let finished = false;
const watcher = fs.watch(path.dirname(releasePath), finish);
function finish() {
  if (finished || !fs.existsSync(releasePath)) return;
  finished = true;
  watcher.close();
  process.stdout.write('  done ไทย 😀  \\n');
  process.stderr.write('finished\\n');
}
process.stdout.write('  ready ไทย 😀\\n');
process.stderr.write('warning ไทย\\n');
fs.writeFileSync(readyPath, 'ready');
finish();
`;

const cases: Array<{ protocol: 'modern' | 'legacy'; launchTool: 'shell' | 'task_create' }> = [
  { protocol: 'modern', launchTool: 'shell' },
  { protocol: 'modern', launchTool: 'task_create' },
  { protocol: 'legacy', launchTool: 'shell' },
  { protocol: 'legacy', launchTool: 'task_create' },
];

describe('durable task ownership over HTTP', () => {
  it.skipIf(process.platform === 'darwin').each(cases)('$protocol $launchTool preserves outputs and ownership across provider replacement', async ({ protocol, launchTool }) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-owned-http-'));
    const rootA = path.join(directory, 'a');
    const rootB = path.join(directory, 'b');
    const taskDirectory = path.join(directory, 'tasks');
    await Promise.all([mkdir(rootA), mkdir(rootB)]);
    const native = process.platform === 'win32' ? await nativeFixture(directory) : undefined;
    const readyPath = path.join(rootA, 'ready.flag');
    const releasePath = path.join(rootA, 'release.flag');
    const fixturePath = path.join(rootA, 'fixture.mjs');
    await writeFile(fixturePath, fixtureSource, 'utf8');
    const makeBackend = (): ShellCapabilityBackend => new ShellCapabilityBackend({
      allowedRoots: [rootA, rootB],
      taskStateDirectory: taskDirectory,
      autoWaitSeconds: 0,
      ...(native === undefined ? {} : { windowsNativeAuthority: native.authority }),
    });
    let backend = makeBackend();
    const owners: CapabilityTaskOwner[] = [];
    const options = {
      port: 0,
      services: {
        capabilities: {
          async execute(tool: string, input: unknown, signal?: AbortSignal, authorization?: Parameters<ShellCapabilityBackend['execute']>[2]): ReturnType<ShellCapabilityBackend['execute']> {
            if (tool !== 'shell') return err(appError('INVALID_INPUT', 'Unsupported fixture capability'));
            owners.push(readCapabilityTaskOwner(input));
            return backend.execute(input, signal, authorization);
          },
        },
      },
      actor: { clientId: 'durable-http-owner', clientName: 'durable-http-owner' },
      activeWorkspaceScopesProvider: async (): Promise<Array<{ workspaceId: string; rootPath: string }>> => [{ workspaceId: 'workspace-a', rootPath: rootA }, { workspaceId: 'workspace-b', rootPath: rootB }],
      hostMutationApprovalProvider: async (): Promise<boolean> => true,
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
    };
    const handle = await startMcpHttp(options);
    let foreignHandle: McpHttpServerHandle | undefined;
    const makeClient = (): Client => new Client({ name: 'durable-http-fixture', version: '1.0.0' }, {
      versionNegotiation: { mode: protocol === 'modern' ? { pin: '2026-07-28' } : 'legacy' },
    });
    const client = makeClient();
    const foreignClient = makeClient();
    const transport = new StreamableHTTPClientTransport(handle.endpoint);
    let taskId: string | undefined;
    let launchOwner: CapabilityTaskOwner | undefined;
    try {
      await client.connect(transport);
      const conflict = await client.callTool({ name: launchTool, arguments: {
        workspaceId: 'workspace-a', executable: process.execPath, arguments: ['--version'], cwd: rootB,
        ...(launchTool === 'shell' ? { operation: 'run' } : {}),
      } });
      expect(conflict).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
      expect(owners).toEqual([]);

      const launched = await client.callTool({ name: launchTool, arguments: {
        workspaceId: 'workspace-a', executable: process.execPath, arguments: [fixturePath, readyPath, releasePath], cwd: rootA,
        timeout_seconds: 30, ...(launchTool === 'shell' ? { operation: 'run', execution: 'background' } : {}),
      } });
      expect(launched.isError, JSON.stringify(launched)).not.toBe(true);
      taskId = z.string().min(1).parse(launched.structuredContent?.task_id);
      launchOwner = owners[0];
      if (launchOwner === undefined) throw new Error('Trusted launch owner was not captured');
      expect(launchOwner).toMatchObject({ clientId: options.actor.clientId, workspaceId: 'workspace-a' });
      expect(launchOwner.sessionId).not.toBe('legacy');
      if (protocol === 'legacy') {
        expect(transport.sessionId).toEqual(expect.any(String));
        expect(launchOwner.sessionId).toBe(createProtocolHttpRequestScope(z.string().parse(transport.sessionId)).sessionId);
      }
      const ownerFields = { owner_client_id: launchOwner.clientId, owner_session_id: launchOwner.sessionId, owner_workspace_id: 'workspace-a' };
      const metadataPath = path.join(taskDirectory, taskId, 'task.json');
      expect(metadataSchema.parse(JSON.parse(await readFile(metadataPath, 'utf8')))).toEqual(ownerFields);
      await vi.waitFor(async () => { await access(readyPath); }, { timeout: 5000 });
      await vi.waitFor(async () => {
        const logs = await client.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-a', operation: 'logs', task_id: taskId } });
        expect(logs.structuredContent).toMatchObject({ state: 'running', stdout: '  ready ไทย 😀\n', stderr: 'warning ไทย\n' });
      }, { timeout: 5000 });
      backend = makeBackend();
      for (const operation of ['status', 'logs', 'result', 'wait']) {
        const observed = await client.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-a', operation, task_id: taskId, timeout_seconds: 0.1 } });
        expect(observed.isError, JSON.stringify(observed)).not.toBe(true);
        expect(observed.structuredContent).toMatchObject({ task_id: taskId, state: 'running' });
      }
      for (const name of ['task_status', 'task_result']) {
        const observed = await client.callTool({ name, arguments: { workspaceId: 'workspace-a', taskId } });
        expect(observed.structuredContent).toMatchObject({ task_id: taskId, state: 'running' });
      }
      for (const name of ['shell', 'task_list']) {
        const listed = await client.callTool({ name, arguments: { workspaceId: 'workspace-a', ...(name === 'shell' ? { operation: 'list', limit: 10 } : {}) } });
        expect(listed.structuredContent).toMatchObject({ tasks: expect.arrayContaining([expect.objectContaining({ task_id: taskId })]) });
      }
      expect(owners.every((owner) => owner.clientId === launchOwner?.clientId && owner.sessionId === launchOwner.sessionId && owner.workspaceId === 'workspace-a')).toBe(true);

      for (const operation of ['status', 'logs', 'result', 'wait', 'cancel']) {
        const denied = await client.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-b', operation, task_id: taskId, userConfirmed: true } });
        expect(denied).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
        expect(JSON.stringify(denied)).not.toContain('ready ไทย');
      }
      for (const name of ['task_status', 'task_result', 'task_cancel']) {
        const denied = await client.callTool({ name, arguments: { workspaceId: 'workspace-b', taskId, ...(name === 'task_cancel' ? { userConfirmed: true } : {}) } });
        expect(denied).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
      }
      const foreignWorkspaceList = await client.callTool({ name: 'task_list', arguments: { workspaceId: 'workspace-b' } });
      expect(foreignWorkspaceList.structuredContent).toMatchObject({ tasks: [] });
      if (protocol === 'modern') foreignHandle = await startMcpHttp(options);
      const foreignTransport = new StreamableHTTPClientTransport(foreignHandle?.endpoint ?? handle.endpoint);
      await foreignClient.connect(foreignTransport);
      if (protocol === 'legacy') expect(foreignTransport.sessionId).not.toBe(transport.sessionId);
      for (const operation of ['status', 'result', 'cancel']) {
        const denied = await foreignClient.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-a', operation, task_id: taskId, userConfirmed: true } });
        expect(denied).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
      }
      const stillRunning = await client.callTool({ name: 'task_status', arguments: { workspaceId: 'workspace-a', taskId } });
      expect(stillRunning.structuredContent).toMatchObject({ state: 'running' });
      await writeFile(releasePath, 'release');
      const terminal = await client.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-a', operation: 'wait', task_id: taskId, timeout_seconds: 5 } });
      expect(terminal.structuredContent).toMatchObject({ state: 'completed', exit_code: 0, stdout, stderr });
      backend = makeBackend();
      const result = await client.callTool({ name: 'task_result', arguments: { workspaceId: 'workspace-a', taskId } });
      expect(result.structuredContent).toMatchObject({ state: 'completed', exit_code: 0, stdout, stderr });
      expect(metadataSchema.parse(JSON.parse(await readFile(metadataPath, 'utf8')))).toEqual(ownerFields);
      const journalPath = path.join(taskDirectory, '.index', 'v1', 'launches.jsonl');
      const expectedRecord = { taskId, ownerClientId: launchOwner.clientId, ownerSessionId: launchOwner.sessionId, ownerWorkspaceId: 'workspace-a' };
      const readRecords = async (): Promise<z.infer<typeof launchRecordSchema>[]> => (await readFile(journalPath, 'utf8')).trim().split('\n').map((line) => launchRecordSchema.parse(JSON.parse(line)));
      expect(await readRecords()).toContainEqual(expectedRecord);
      await rm(journalPath);
      backend = makeBackend();
      const rebuilt = await client.callTool({ name: 'shell', arguments: { workspaceId: 'workspace-a', operation: 'list', limit: 10 } });
      expect(rebuilt.structuredContent).toMatchObject({ tasks: expect.arrayContaining([expect.objectContaining({ task_id: taskId })]) });
      expect(await readRecords()).toContainEqual(expectedRecord);
    } finally {
      await writeFile(releasePath, 'release');
      if (taskId !== undefined && launchOwner !== undefined) {
        const request = { task_id: taskId, metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: launchOwner } };
        const settled = await backend.execute({ ...request, operation: 'wait', timeout_seconds: 5 });
        if (!settled.ok || z.object({ state: z.string() }).parse(settled.value).state === 'running') {
          await backend.execute({ ...request, operation: 'cancel', userConfirmed: true });
        }
      }
      await Promise.all([client.close().catch(() => undefined), foreignClient.close().catch(() => undefined)]);
      await foreignHandle?.close();
      await handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
