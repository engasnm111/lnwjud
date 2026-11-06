import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { FileService } from '@lnwjud/application';
import { ok } from '@lnwjud/domain';
import { permissionProfiles } from '@lnwjud/permissions';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { describe, expect, it, vi } from 'vitest';
import { startMcpHttp } from './http.js';

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
    let admitted!: () => void;
    let release!: () => void;
    const admissionReached = new Promise<void>(resolve => { admitted = resolve; });
    const admissionGate = new Promise<void>(resolve => { release = resolve; });
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
        async enter(): Promise<{ ok: true; value: { id: string; releaseAfterVerifiedTermination(): Promise<void> } }> {
          admitted();
          await admissionGate;
          return ok({ id: 'test-admission', async releaseAfterVerifiedTermination() {} });
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
      release();
      await pending;
      await vi.waitFor(async () => {
        const status = await file.writeFileStatus({ clientId: 'http-write-disconnect', clientName: 'http-write-disconnect' },
          workspace.id, operationId);
        expect(status).toMatchObject({ ok: true, value: { state: 'failed',
          result: { ok: false, error: { code: 'PROCESS_TIMEOUT' } } } });
      }, { timeout: 4000 });
      await expect(readFile(path.join(root, 'src', 'late.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      release?.();
      await pending?.catch(() => undefined);
      await client.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
});
