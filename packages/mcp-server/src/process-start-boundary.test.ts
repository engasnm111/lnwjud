import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { ToolRegistry, type McpApplicationServices, type WorkspaceScope } from './tool-registry.js';

const actor = { clientId: 'process-boundary', clientName: 'process-boundary-test' };
const activeScope = async (): Promise<WorkspaceScope | null> => ({ workspaceId: 'workspace-a', rootPath: 'E:\\project-a' });

describe('process_start gateway boundary', () => {
  it('requires confirmation for an outside absolute cwd, then allows the exact approved action', async () => {
    const approvals: unknown[] = [];
    const starts: unknown[] = [];
    const registry = registryWithCapture(starts, approvals);

    const blocked = await registry.invoke('process_start', {
      workspaceId: 'workspace-a', executable: 'node.exe', args: ['script.js'], cwd: 'E:\\project-b',
    });
    expect(blocked).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    expect(approvals).toEqual([]);
    expect(starts).toEqual([]);

    const approved = await registry.invoke('process_start', {
      workspaceId: 'workspace-a', executable: 'node.exe', args: ['script.js'], cwd: 'E:\\project-b', userConfirmed: true,
    });
    expect(approved.isError).not.toBe(true);
    expect(approvals).toHaveLength(1);
    expect(starts).toEqual([expect.objectContaining({ cwd: 'E:\\project-b' })]);
  });

  it.each([
    ['rm', ['-rf', 'target']],
    ['powershell.exe', ['-Command', 'Remove-Item target']],
    ['git.exe', ['clean', '-fd']],
  ] as const)('requires confirmation for risky command %s and dispatches only after approval', async (executable, args) => {
    const approvals: unknown[] = [];
    const starts: unknown[] = [];
    const registry = registryWithCapture(starts, approvals);

    const blocked = await registry.invoke('process_start', { workspaceId: 'workspace-a', executable, args });
    expect(blocked).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    expect(approvals).toEqual([]);
    expect(starts).toEqual([]);

    const approved = await registry.invoke('process_start', { workspaceId: 'workspace-a', executable, args, userConfirmed: true });
    expect(approved.isError).not.toBe(true);
    expect(approvals).toHaveLength(1);
    expect(starts).toHaveLength(1);
  });

  it.each([
    ['cp', ['source', 'target']],
    ['mv.exe', ['source', 'target']],
  ] as const)('allows ordinary non-destructive command %s without confirmation', async (executable, args) => {
    const approvals: unknown[] = [];
    const starts: unknown[] = [];
    const registry = registryWithCapture(starts, approvals);
    const response = await registry.invoke('process_start', { workspaceId: 'workspace-a', executable, args });
    expect(response.isError).not.toBe(true);
    expect(approvals).toEqual([]);
    expect(starts).toHaveLength(1);
  });

  it('anchors missing and relative cwd values to the host active workspace without prompting for ordinary execution', async () => {
    const approvals: unknown[] = [];
    const starts: unknown[] = [];
    const registry = registryWithCapture(starts, approvals);

    const missing = await registry.invoke('process_start', { workspaceId: 'workspace-a', executable: 'node.exe', args: ['script.js'] });
    const relative = await registry.invoke('process_start', { workspaceId: 'workspace-a', executable: 'node.exe', args: ['script.js'], cwd: 'tools' });

    expect(missing.isError).not.toBe(true);
    expect(relative.isError).not.toBe(true);
    expect(approvals).toEqual([]);
    expect(starts).toEqual([
      expect.objectContaining({ cwd: 'E:\\project-a' }),
      expect.objectContaining({ cwd: 'E:\\project-a\\tools' }),
    ]);
  });

  it('hard-blocks machine-level destructive execution even when confirmed', async () => {
    const approvals: unknown[] = [];
    const starts: unknown[] = [];
    const registry = registryWithCapture(starts, approvals);
    const response = await registry.invoke('process_start', { workspaceId: 'workspace-a', executable: 'shutdown.exe', args: ['/s'], userConfirmed: true });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    expect(approvals).toEqual([]);
    expect(starts).toEqual([]);
  });
});

function registryWithCapture(starts: unknown[], approvals: unknown[]): ToolRegistry {
  const services: McpApplicationServices = {
    process: {
      async start(_actor, _workspaceId, request): Promise<ReturnType<typeof ok>> {
        starts.push(request);
        return ok({ processId: 'process-1' });
      },
    } as McpApplicationServices['process'],
  };
  return new ToolRegistry(services, actor, {
    activeWorkspaceScopeProvider: activeScope,
    hostMutationApprovalProvider: async (request): Promise<boolean> => {
      approvals.push(request);
      return true;
    },
  });
}
