import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { FileService } from '@lnwjud/application';
import { SharedManagedWriterAdmission } from '@lnwjud/capabilities';
import { ok, type Result } from '@lnwjud/domain';
import { permissionProfiles } from '@lnwjud/permissions';
import { WindowsNativeAuthority } from '@lnwjud/process';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { describe, expect, it, vi } from 'vitest';
import { DurableShellTaskIndex } from '../../capabilities/src/durable-shell-task-index.js';
import { startMcpHttp } from './http.js';

async function heldWriterBacklog(root: string, workspaceId: string): Promise<{
  admission: SharedManagedWriterAdmission;
  verifyHeld(): Promise<void>;
}> {
  const taskDirectory = path.join(root, 'tasks');
  const index = new DurableShellTaskIndex(taskDirectory, {
    maxConcurrentTasks: 10_000, inspectTask: async () => 'unknown' as const,
    verifyContainedTermination: async (): Promise<boolean> => false,
  });
  for (let number = 0; number < 29; number += 1) {
    const taskId = `held-${number}`;
    const requestDigest = createHash('sha256').update(taskId).digest('hex');
    expect(await index.reserve({
      taskId, requestDigest, ownerClientId: 'old-owner', ownerWorkspaceId: workspaceId,
      capacityClass: number < 16 ? 'durable_shell' : 'managed_writer',
      mutationKind: 'opaque_contained_process',
      nativeReceiptPath: path.join(taskDirectory, taskId, 'containment.receipt.json'),
      nativeBinding: { taskId, reservationId: taskId, attemptId: `attempt-${number}`, generation: 1,
        requestDigest, ownerClientId: 'old-owner', ownerSessionId: 'old-session', workspaceId },
    })).toMatchObject({ ok: true, value: { created: true } });
  }
  const request = vi.fn(async (): Promise<never> => { throw new Error('SERVICE_UNAVAILABLE'); });
  const authority = new WindowsNativeAuthority({
    helper: { executable: path.join(root, 'absent-helper.exe'), sha256: 'a'.repeat(64), buildId: 'lnwjud-containment-v2' },
    pin: { modulePath: path.join(root, 'absent-pin.node'), sha256: 'b'.repeat(64) },
    profileDirectory: path.join(root, 'profile'),
  }, { request, async startWatcher(): Promise<void> {} });
  const activeDirectory = path.join(taskDirectory, '.index', 'v1', 'active');
  const snapshot = async (): Promise<Array<readonly [string, string]>> => Promise.all(
    (await readdir(activeDirectory)).sort().map(async (name): Promise<readonly [string, string]> =>
      [name, await readFile(path.join(activeDirectory, name), 'utf8')]));
  const original = await snapshot();
  expect(original).toHaveLength(29);
  return {
    admission: new SharedManagedWriterAdmission(taskDirectory, authority),
    async verifyHeld(): Promise<void> {
      expect(await index.diagnostics()).toMatchObject({
        durable_shell_reservations: 16, managed_writer_reservations: 13,
        unresolved_reservations: 29, unreadable_reservations: 0,
      });
      expect(await snapshot()).toEqual(original);
      expect(request).not.toHaveBeenCalled();
    },
  };
}

describe('modern MCP HTTP lost-response write safety', () => {
  it('aborts a pending admitted write when the client disconnects before the filesystem mutation', async () => {
    const raw = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-http-write-disconnect-'));
    const root = await realpath(raw);
    await mkdir(path.join(root, 'src'));
    const workspace: Workspace = { id: 'workspace-disconnect', displayName: 'Disconnect fixture',
      rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
    const repository: WorkspaceRepository = {
      async list() { return [workspace]; },
      async get(id) { return id === workspace.id ? workspace : null; },
      async insert() {},
      async delete() {},
    };
    const backlog = await heldWriterBacklog(root, workspace.id);
    let admitted!: () => void;
    let release!: () => void;
    const admissionReached = new Promise<void>(resolve => { admitted = resolve; });
    const admissionGate = new Promise<void>(resolve => { release = resolve; });
    let firstAdmission = true;
    class ObservedFileService extends FileService {
      public lastSignal: AbortSignal | undefined;
      override writeFile(...args: Parameters<FileService['writeFile']>): ReturnType<FileService['writeFile']> {
        this.lastSignal = args[3];
        return super.writeFile(...args);
      }
    }
    const file = new ObservedFileService(repository, undefined, undefined, {
      profile: permissionProfiles.full,
      writeOperationJournalRoot: path.join(root, 'receipts'),
      writerAdmission: {
        async enter(input: Parameters<SharedManagedWriterAdmission['enter']>[0]): ReturnType<SharedManagedWriterAdmission['enter']> {
          const permit = await backlog.admission.enter(input);
          if (firstAdmission) {
            firstAdmission = false;
            admitted();
            await admissionGate;
          }
          return permit;
        },
      },
    });
    const handle = await startMcpHttp({
      port: 0,
      actor: { clientId: 'http-write-disconnect', clientName: 'http-write-disconnect' },
      services: { file },
      authorizationModeProvider: () => 'full_bypass',
      activeWorkspaceScopesProvider: async () => [{ workspaceId: workspace.id, rootPath: root }],
    });
    const client = new Client({ name: 'lost-response-fixture', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const transport = new StreamableHTTPClientTransport(handle.endpoint);
    const reconnected = new Client({ name: 'lost-response-fixture', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const operationId = '123e4567-e89b-42d3-a456-426614174477';
    let pending: Promise<unknown> | undefined;
    try {
      await client.connect(transport);
      pending = client.callTool({ name: 'write_file', arguments: {
        workspaceId: workspace.id, operationId, path: 'src/late.txt', content: 'must never commit',
        mode: 'create_new',
      } }).catch(() => undefined);
      await admissionReached;
      expect(file.lastSignal).toBeDefined();
      await client.close();
      await vi.waitFor(() => { expect(file.lastSignal?.aborted).toBe(true); }, { timeout: 4000 });
      await reconnected.connect(new StreamableHTTPClientTransport(handle.endpoint));
      expect(await reconnected.callTool({ name: 'write_file_status', arguments: { workspaceId: workspace.id, operationId } }))
        .toMatchObject({ structuredContent: { state: 'outcome_unverified' } });
      expect(await reconnected.callTool({ name: 'write_file', arguments: {
        workspaceId: workspace.id, operationId: '123e4567-e89b-42d3-a456-426614174479',
        path: 'src/concurrent.txt', content: 'independent write', mode: 'create_new',
      } })).not.toMatchObject({ isError: true });
      expect(await readFile(path.join(root, 'src', 'concurrent.txt'), 'utf8')).toBe('independent write');
      release();
      await pending;
      await vi.waitFor(async () => {
        expect(await reconnected.callTool({ name: 'write_file_status', arguments: { workspaceId: workspace.id, operationId } }))
          .toMatchObject({ structuredContent: { state: 'failed', result: { ok: false, error: { code: 'PROCESS_TIMEOUT' } } } });
      }, { timeout: 4000 });
      await expect(readFile(path.join(root, 'src', 'late.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await backlog.verifyHeld();
    } finally {
      release?.();
      await pending?.catch(() => undefined);
      await client.close().catch(() => undefined);
      await reconnected.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);

  it('reconciles a write committed before transport loss without replaying its side effect', async () => {
    const raw = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-http-write-late-commit-'));
    const root = await realpath(raw);
    await mkdir(path.join(root, 'src'));
    const workspace: Workspace = { id: 'workspace-late-commit', displayName: 'Late commit fixture',
      rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
    const repository: WorkspaceRepository = {
      async list() { return [workspace]; },
      async get(id) { return id === workspace.id ? workspace : null; },
      async insert() {},
      async delete() {},
    };
    const backlog = await heldWriterBacklog(root, workspace.id);
    let committed!: () => void;
    let release!: () => void;
    const published = new Promise<void>(resolve => { committed = resolve; });
    const completionGate = new Promise<void>(resolve => { release = resolve; });
    let writeCount = 0;
    const writer = {
      async write(filePath: string, content: string | Buffer, options: {
        validateDestination?: () => Promise<Result<void>>;
        createNew?: boolean;
      } = {}): Promise<Result<void>> {
        const validation = await options.validateDestination?.();
        if (validation && !validation.ok) return validation;
        await writeFile(filePath, content, { flag: options.createNew ? 'wx' : 'w' });
        writeCount += 1;
        if (writeCount === 1) {
          committed();
          await completionGate;
        }
        return ok(undefined);
      },
    };
    const actor = { clientId: 'http-write-late-commit', clientName: 'http-write-late-commit' };
    const file = new FileService(repository, undefined, undefined, {
      profile: permissionProfiles.full,
      writer,
      writerAdmission: backlog.admission,
      writeOperationJournalRoot: path.join(root, 'receipts'),
    });
    const handle = await startMcpHttp({
      port: 0, actor, services: { file },
      authorizationModeProvider: () => 'full_bypass',
      activeWorkspaceScopesProvider: async () => [{ workspaceId: workspace.id, rootPath: root }],
    });
    const client = new Client({ name: 'late-commit-fixture', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const transport = new StreamableHTTPClientTransport(handle.endpoint);
    const reconnected = new Client({ name: 'late-commit-fixture', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const operationId = '123e4567-e89b-42d3-a456-426614174478';
    const request = { workspaceId: workspace.id, operationId, path: 'src/late.txt',
      content: 'committed before acknowledgement', mode: 'create_new' as const };
    let pending: Promise<unknown> | undefined;
    try {
      await client.connect(transport);
      pending = client.callTool({ name: 'write_file', arguments: request }).catch(() => undefined);
      await published;
      expect(await readFile(path.join(root, 'src', 'late.txt'), 'utf8')).toBe(request.content);
      await client.close();
      await reconnected.connect(new StreamableHTTPClientTransport(handle.endpoint));
      expect(await reconnected.callTool({ name: 'write_file_status', arguments: { workspaceId: workspace.id, operationId } }))
        .toMatchObject({ structuredContent: { state: 'outcome_unverified' } });
      expect(await reconnected.callTool({ name: 'write_file', arguments: {
        workspaceId: workspace.id, operationId: '123e4567-e89b-42d3-a456-426614174480',
        path: 'src/concurrent.txt', content: 'concurrent committed write', mode: 'create_new',
      } })).not.toMatchObject({ isError: true });
      expect(await readFile(path.join(root, 'src', 'concurrent.txt'), 'utf8')).toBe('concurrent committed write');
      release();
      await pending;
      await vi.waitFor(async () => {
        expect(await reconnected.callTool({ name: 'write_file_status', arguments: { workspaceId: workspace.id, operationId } }))
          .toMatchObject({ structuredContent: { state: 'succeeded', result: { ok: true } } });
      }, { timeout: 4000 });
      expect(await reconnected.callTool({ name: 'write_file', arguments: request })).not.toMatchObject({ isError: true });
      expect(writeCount).toBe(2);
      expect(await readFile(path.join(root, 'src', 'late.txt'), 'utf8')).toBe(request.content);
      await backlog.verifyHeld();
    } finally {
      release?.();
      await pending?.catch(() => undefined);
      await client.close().catch(() => undefined);
      await reconnected.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
});
