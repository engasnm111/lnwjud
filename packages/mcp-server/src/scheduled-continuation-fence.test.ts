import { describe, expect, it, vi } from 'vitest';
import { ok } from '@lnwjud/domain';
import { permissionProfiles } from '@lnwjud/permissions';
import { ToolRegistry, type McpApplicationServices } from './tool-registry.js';

const actor = { clientId: 'client-1', clientName: 'test', sessionId: 'session-a' };

function activeFence(): ReturnType<typeof ok> {
  return ok({ goalId: 'goal-1', leaseGeneration: 2 });
}

describe('scheduled continuation mutation fence', () => {
  it('blocks file mutation without the current goalLease proof before the file handler executes', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const writeFile = vi.fn().mockResolvedValue(ok({ path: 'src/file.ts', bytesWritten: 1 }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      file: { writeFile },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('write_file', {
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
      content: 'x',
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('blocks Git mutation without the current goalLease proof before the Git handler executes', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const run = vi.fn().mockResolvedValue(ok({ exitCode: 0, stdout: '', stderr: '' }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      git: { run },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('git', {
      workspaceId: 'workspace-1',
      args: ['add', 'src/file.ts'],
    });

    expect(response.isError).toBe(true);
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(run).not.toHaveBeenCalled();
  });

  it('blocks process execution without the current goalLease proof before the process handler executes', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const start = vi.fn().mockResolvedValue(ok({ processId: 'process-1' }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      process: { start },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('process_start', {
      workspaceId: 'workspace-1',
      executable: 'node',
      args: ['--version'],
    });

    expect(response.isError).toBe(true);
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(start).not.toHaveBeenCalled();
  });

  it('blocks detected project commands without the current goalLease proof before preview or process start', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const previewProjectCommand = vi.fn().mockResolvedValue(ok({ executable: 'pnpm', args: ['build'] }));
    const startProjectCommand = vi.fn().mockResolvedValue(ok({ processId: 'process-project' }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      process: { previewProjectCommand, startProjectCommand },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('project_build', {
      workspaceId: 'workspace-1',
      userConfirmed: true,
    });

    expect(response.isError).toBe(true);
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(previewProjectCommand).not.toHaveBeenCalled();
    expect(startProjectCommand).not.toHaveBeenCalled();
  });

  it('blocks incremental verification without the current goalLease proof before it can launch a typecheck', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('verify_incremental', {
      workspaceId: 'workspace-1',
      userConfirmed: true,
    });

    expect(response.isError).toBe(true);
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
  });

  it('blocks delegated Codex mutation without the current goalLease proof before the Codex backend executes', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const run = vi.fn().mockResolvedValue(ok({ codexTaskId: 'codex-1' }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      codex: { run },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor, { codexToolsEnabled: true }).invoke('codex_run', {
      workspaceId: 'workspace-1',
      instruction: 'edit the project',
      userConfirmed: true,
    });

    expect(response.isError).toBe(true);
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(run).not.toHaveBeenCalled();
  });

  it('blocks Computer Use mutation without the current goalLease proof before any capability executes', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const execute = vi.fn().mockResolvedValue(ok({ clicked: true }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      capabilities: { execute },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('computer_use', {
      workspaceId: 'workspace-1',
      action: 'click',
      target: { x: 10, y: 20 },
      userConfirmed: true,
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not fence read-only file access', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const readFile = vi.fn().mockResolvedValue(ok({ path: 'src/file.ts', content: 'ok', startLine: 1, endLine: 1 }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      file: { readFile },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor).invoke('read_file', {
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
    });

    expect(response.isError).not.toBe(true);
    expect(readFile).toHaveBeenCalled();
    expect(inspectWorkspaceFence).not.toHaveBeenCalled();
  });

  it('does not require or inspect a goal lease when Full Bypass is active', async (): Promise<void> => {
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(activeFence());
    const writeFile = vi.fn().mockResolvedValue(ok({ path: 'src/file.ts', bytesWritten: 1 }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      file: { writeFile },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor, {
      profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
    }).invoke('write_file', {
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
      content: 'x',
    });

    expect(response.isError).not.toBe(true);
    expect(inspectWorkspaceFence).not.toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledTimes(1);
  });
});
