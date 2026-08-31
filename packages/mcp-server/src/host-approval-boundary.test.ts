import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { permissionProfiles, type PermissionProfile } from '@lnwjud/permissions';
import { DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY, type DestructiveAutoApprovalPolicy } from '@lnwjud/shared';
import { ToolRegistry, type McpApplicationServices, type WorkspaceScope } from './tool-registry.js';

const actor = { clientId: 'host-approval', clientName: 'host-approval-test' };
const activeScope = async (): Promise<WorkspaceScope | null> => ({ workspaceId: 'workspace-a', rootPath: 'E:\\project-a' });
const balancedProfile = (): PermissionProfile => permissionProfiles.balanced;

describe('mandatory independent host approval', () => {
  it.each([
    ['write_file overwrite', 'write_file', { workspaceId: 'workspace-a', path: 'existing.txt', content: 'next', overwriteExisting: true, userConfirmed: true }],
    ['codex_run', 'codex_run', { workspaceId: 'workspace-a', instruction: 'edit the project', userConfirmed: true }],
    ['mcp_call', 'mcp_call', { server: 'child', tool: 'write', arguments: { path: 'x' }, userConfirmed: true }],
  ] as const)('denies %s when no trusted host approval provider exists', async (_label, tool, input) => {
    const calls: string[] = [];
    const registry = new ToolRegistry(servicesWithCalls(calls), actor, {
      activeWorkspaceScopeProvider: activeScope,
      profileProvider: balancedProfile,
      codexToolsEnabled: true,
    });

    const response = await registry.invoke(tool, input);

    expect(response).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Host exact-action approval') } },
    });
    expect(calls).toEqual([]);
  });

  it.each([
    ['shell inline Node editor', 'shell', { workspaceId: 'workspace-a', operation: 'run', executable: 'node.exe', arguments: ['-e', "const fs=require('fs'); const p='src/a.ts'; fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('a', 'b'))"] }],
    ['process_start inline PowerShell editor', 'process_start', { workspaceId: 'workspace-a', executable: 'powershell.exe', args: ['-NoProfile', '-Command', "Set-Content -LiteralPath 'src/a.ts' -Value 'next'"] }],
  ] as const)('rejects misrouted text editor %s before native approval is requested', async (_label, tool, input) => {
    const calls: string[] = [];
    const approvals: string[] = [];
    const registry = new ToolRegistry(servicesWithCalls(calls), actor, {
      activeWorkspaceScopeProvider: activeScope,
      profileProvider: balancedProfile,
      hostMutationApprovalProvider: async (): Promise<boolean> => { approvals.push(tool); return true; },
    });

    const response = await registry.invoke(tool, input);

    expect(response).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Use edit_file') } },
    });
    expect(approvals).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each([
    ['process_start', 'process_start', { workspaceId: 'workspace-a', executable: 'node.exe', args: ['script.js'] }],
    ['shell real run', 'shell', { workspaceId: 'workspace-a', operation: 'run', executable: 'node.exe', arguments: ['script.js'] }],
  ] as const)('allows ordinary %s without a native host approval provider', async (_label, tool, input) => {
    const calls: string[] = [];
    const registry = new ToolRegistry(servicesWithCalls(calls), actor, { activeWorkspaceScopeProvider: activeScope, profileProvider: balancedProfile });
    const response = await registry.invoke(tool, input);
    expect(response.isError).not.toBe(true);
    expect(calls).toEqual([tool]);
  });

  it.each([
    ['scheduler run', 'scheduler', { action: 'run', task_name: 'LnwjudTask', userConfirmed: true }],
    ['scheduler delete', 'scheduler', { action: 'delete', task_name: 'LnwjudTask', userConfirmed: true }],
    ['hook removal', 'hook_remove', { name: 'audit', userConfirmed: true }],
    ['worktree removal', 'git_worktree_remove', { workspaceId: 'workspace-a', worktreePath: '.worktrees/agent-1', dryRun: false, userConfirmed: true }],
    ['self-heal apply', 'self_heal_apply', { workspaceId: 'workspace-a', planId: 'reviewed-plan', dryRun: false, userConfirmed: true }],
  ] as const)('denies destructive administrative operation %s without native host approval', async (_label, tool, input) => {
    const calls: string[] = [];
    const registry = new ToolRegistry(servicesWithCalls(calls), actor, {
      activeWorkspaceScopeProvider: activeScope,
      profileProvider: balancedProfile,
    });

    const response = await registry.invoke(tool, input);

    expect(response).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Host exact-action approval') } },
    });
    expect(calls).toEqual([]);
  });

  it('allows exact recoverable auto-approved delete_file without a host prompt only inside the active workspace', async () => {
    const calls: string[] = [];
    const policy: DestructiveAutoApprovalPolicy = {
      ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY,
      approvals: { ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY.approvals, delete_file: true },
    };
    const registry = new ToolRegistry(servicesWithCalls(calls), actor, {
      activeWorkspaceScopeProvider: activeScope,
      destructivePolicyProvider: (): DestructiveAutoApprovalPolicy => policy,
    });

    const response = await registry.invoke('delete_file', { workspaceId: 'workspace-a', path: 'tmp.txt' });

    expect(response.isError).not.toBe(true);
    expect(calls).toEqual(['delete_file']);
  });
});

function servicesWithCalls(calls: string[]): McpApplicationServices {
  return {
    file: {
      async writeFile(): Promise<ReturnType<typeof ok>> { calls.push('write_file'); return ok({ path: 'existing.txt' }); },
      async deleteFile(): Promise<ReturnType<typeof ok>> { calls.push('delete_file'); return ok({ path: 'tmp.txt', recoveryId: 'recovery-1', recoverable: true }); },
    } as McpApplicationServices['file'],
    process: {
      async start(): Promise<ReturnType<typeof ok>> { calls.push('process_start'); return ok({ processId: 'process-1' }); },
    } as McpApplicationServices['process'],
    codex: {
      async run(): Promise<ReturnType<typeof ok>> { calls.push('codex_run'); return ok({ codexTaskId: 'codex-1' }); },
    } as McpApplicationServices['codex'],
    capabilities: {
      async execute(tool): Promise<ReturnType<typeof ok>> { calls.push(tool); return ok({ task_id: 'task-1', state: 'running' }); },
    },
    extensions: {
      async callMcpTool(): Promise<ReturnType<typeof ok>> { calls.push('mcp_call'); return ok({ ok: true }); },
    } as McpApplicationServices['extensions'],
  };
}
