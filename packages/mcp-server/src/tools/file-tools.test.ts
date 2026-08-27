import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { ContextEconomyRuntime } from '../context-economy.js';
import { fileTools } from './file-tools.js';
import type { McpToolContext } from './tool-types.js';

describe('fileTools cancellation', () => {
  it('forwards the invocation signal to every file mutation', async () => {
    const observedSignals: Array<AbortSignal | undefined> = [];
    const record = (signal?: AbortSignal): ReturnType<typeof ok> => {
      observedSignals.push(signal);
      return ok({});
    };
    const context = {
      actor: { clientId: 'test', clientName: 'test' },
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        file: {
          async writeFile(_actor: unknown, _workspaceId: unknown, _request: unknown, signal?: AbortSignal) { return record(signal); },
          async applyPatch(_actor: unknown, _workspaceId: unknown, _request: unknown, signal?: AbortSignal) { return record(signal); },
          async editFile(_actor: unknown, _workspaceId: unknown, _request: unknown, signal?: AbortSignal) { return record(signal); },
          async moveFile(_actor: unknown, _workspaceId: unknown, _request: unknown, signal?: AbortSignal) { return record(signal); },
          async copyFile(_actor: unknown, _workspaceId: unknown, _request: unknown, signal?: AbortSignal) { return record(signal); },
          async deleteFile(_actor: unknown, _workspaceId: unknown, _request: unknown, signal?: AbortSignal) { return record(signal); },
          async listRecoveryItems() { return ok({ recoveryTrashRoot: null, items: [] }); },
          async restoreDeletedFile(_actor: unknown, _workspaceId: unknown, _request: unknown, signal?: AbortSignal) { return record(signal); },
        },
      },
    } as unknown as McpToolContext;
    const tools = fileTools(context);
    const signal = new AbortController().signal;
    const calls: ReadonlyArray<readonly [string, unknown]> = [
      ['write_file', { workspaceId: 'workspace-1', path: 'a.txt', content: 'a', overwriteExisting: true, userConfirmed: true }],
      ['apply_patch', { workspaceId: 'workspace-1', files: [{ path: 'a.txt', content: 'b' }], userConfirmed: true }],
      ['edit_file', { workspaceId: 'workspace-1', path: 'a.txt', oldText: 'a', newText: 'b', userConfirmed: true }],
      ['move_file', { workspaceId: 'workspace-1', sourcePath: 'a.txt', destinationPath: 'b.txt', userConfirmed: true }],
      ['copy_file', { workspaceId: 'workspace-1', sourcePath: 'a.txt', destinationPath: 'b.txt' }],
      ['delete_file', { workspaceId: 'workspace-1', path: 'a.txt', userConfirmed: true }],
      ['restore_deleted_file', { workspaceId: 'workspace-1', recoveryId: '123e4567-e89b-42d3-a456-426614174000', userConfirmed: true }],
    ];

    for (const [name, input] of calls) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new Error(`Missing file tool: ${name}`);
      await tool.execute(input, signal);
    }

    expect(observedSignals).toEqual([signal, signal, signal, signal, signal, signal, signal]);
  });

  it('requires confirmation again inside the checkpoint restore handler', async () => {
    let restores = 0;
    const context = {
      actor: { clientId: 'test', clientName: 'test' },
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        checkpoint: {
          async list() { return ok([]); },
          async restore() { restores += 1; return ok({ restoredPaths: ['a.txt'] }); },
        },
      },
    } as unknown as McpToolContext;
    const tool = fileTools(context).find((candidate) => candidate.name === 'restore_checkpoint');
    if (tool === undefined) throw new Error('Missing restore_checkpoint');
    const request = { workspaceId: 'workspace-1', checkpointId: '123e4567-e89b-42d3-a456-426614174000' };

    await expect(tool.execute(request, new AbortController().signal)).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(tool.execute({ ...request, userConfirmed: true }, new AbortController().signal)).resolves.toMatchObject({ ok: true });
    expect(restores).toBe(1);
  });
});
