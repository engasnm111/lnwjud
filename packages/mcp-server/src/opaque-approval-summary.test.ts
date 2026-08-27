import { describe, expect, it } from 'vitest';
import { ok, type Result } from '@lnwjud/domain';
import { permissionProfiles, type PermissionProfile } from '@lnwjud/permissions';
import { ToolRegistry, type HostMutationApprovalRequest, type McpApplicationServices } from './tool-registry.js';

const actor = { clientId: 'approval-summary-test', clientName: 'approval-summary-test' };
const activeWorkspaceScopeProvider = async (): Promise<{ workspaceId: string; rootPath: string }> => ({ workspaceId: 'workspace-a', rootPath: 'E:\\project-a' });
const balancedProfile = (): PermissionProfile => permissionProfiles.balanced;

describe('opaque mutation native approval summaries', () => {
  it('keeps mcp_list and mcp_describe read-only while mcp_call remains opaque', () => {
    const byName = new Map(new ToolRegistry({}, actor).list().map((tool) => [tool.name, tool]));
    expect(byName.get('mcp_list')).toMatchObject({ permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false } });
    expect(byName.get('mcp_describe')).toMatchObject({ permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false } });
    expect(byName.get('mcp_call')).toMatchObject({ permission: 'DANGEROUS', annotations: { readOnlyHint: false, destructiveHint: true } });
  });

  it('shows child MCP identity and stable recursively redacted arguments without dispatching on veto', async () => {
    const requests: HostMutationApprovalRequest[] = [];
    let calls = 0;
    const registry = new ToolRegistry({
      extensions: {
        async callMcpTool(): Promise<Result<{ ok: boolean }>> { calls += 1; return ok({ ok: true }); },
      } as McpApplicationServices['extensions'],
    }, actor, {
      activeWorkspaceScopeProvider,
      profileProvider: balancedProfile,
      hostMutationApprovalProvider: async (request): Promise<boolean> => { requests.push(request); return false; },
    });

    await expect(registry.invoke('mcp_call', {
      server: 'child-server',
      tool: 'mutate',
      arguments: {
        z: 2,
        password: 'super-secret-password',
        nested: { apiKey: 'super-secret-api-key', a: 1 },
      },
      userConfirmed: true,
    })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });

    expect(calls).toBe(0);
    expect(requests).toHaveLength(1);
    const summary = requests[0]?.summary ?? '';
    expect(summary).toContain('server = child-server');
    expect(summary).toContain('childTool = mutate');
    expect(summary).toContain('arguments = {"nested":{"a":1,"apiKey":"[redacted]"},"password":"[redacted]","z":2}');
    expect(summary).toMatch(/child server controls its own filesystem\/network scope/i);
    expect(summary).not.toContain('super-secret');
    expect(summary.length).toBeLessThanOrEqual(8_192);
  });

  it('shows canonical Codex workspace, redacted instruction and opaque warning while bounding long summaries', async () => {
    const requests: HostMutationApprovalRequest[] = [];
    let runs = 0;
    const registry = new ToolRegistry({
      codex: { async run(): Promise<Result<{ codexTaskId: string }>> { runs += 1; return ok({ codexTaskId: 'task-1' }); } } as McpApplicationServices['codex'],
    }, actor, {
      codexToolsEnabled: true,
      activeWorkspaceScopeProvider,
      profileProvider: balancedProfile,
      hostMutationApprovalProvider: async (request): Promise<boolean> => { requests.push(request); return false; },
    });

    await registry.invoke('codex_run', {
      workspaceId: 'workspace-a',
      instruction: 'review project with token=super-secret-token',
      userConfirmed: true,
    });
    await registry.invoke('codex_run', {
      workspaceId: 'workspace-a',
      instruction: `review project ${'x'.repeat(12_000)}`,
      userConfirmed: true,
    });

    expect(runs).toBe(0);
    expect(requests).toHaveLength(2);
    const summary = requests[0]?.summary ?? '';
    expect(summary).toContain('workspaceRoot = E:\\project-a');
    expect(summary).toContain('instruction = ');
    expect(summary).toMatch(/workspace-write child agent.*not.*Recovery Trash/i);
    expect(summary).not.toContain('super-secret-token');
    expect(summary.length).toBeLessThanOrEqual(8_192);
    expect(requests[1]?.summary.length).toBeLessThanOrEqual(8_192);
  });

  it('previews project command before native approval and warns that script contents are opaque', async () => {
    const requests: HostMutationApprovalRequest[] = [];
    let previews = 0;
    let starts = 0;
    const processService = {
      async previewProjectCommand(): Promise<Result<{ executable: string; args: string[] }>> { previews += 1; return ok({ executable: 'pnpm.cmd', args: ['test', '--runInBand'] }); },
      async startProjectCommand(): Promise<Result<{ processId: string }>> { starts += 1; return ok({ processId: 'process-1' }); },
    } as unknown as McpApplicationServices['process'];
    const registry = new ToolRegistry({ process: processService }, actor, {
      activeWorkspaceScopeProvider,
      profileProvider: balancedProfile,
      hostMutationApprovalProvider: async (request): Promise<boolean> => { requests.push(request); return false; },
    });

    await registry.invoke('project_test', { workspaceId: 'workspace-a', userConfirmed: true });

    expect(previews).toBe(1);
    expect(starts).toBe(0);
    const summary = requests[0]?.summary ?? '';
    expect(summary).toContain('projectCommand = test');
    expect(summary).toContain('executable = pnpm.cmd');
    expect(summary).toContain('arguments = ["test","--runInBand"]');
    expect(summary).toMatch(/project-owned script body is opaque.*not covered by Recovery Trash/i);
  });
});
