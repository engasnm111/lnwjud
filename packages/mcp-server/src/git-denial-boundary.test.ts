import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { ToolRegistry, type McpApplicationServices, type WorkspaceScope } from './tool-registry.js';

const actor = { clientId: 'git-denial', clientName: 'git-denial-test' };
const activeScope = async (): Promise<WorkspaceScope | null> => ({ workspaceId: 'workspace-a', rootPath: 'E:\\project-a' });

describe('Git destructive deny boundary', () => {
  it.each([
    ['ambiguous checkout path', ['checkout', 'src/file.ts']],
    ['force branch rename', ['branch', '-M', 'old', 'existing']],
    ['force branch copy', ['branch', '-C', 'source', 'existing']],
  ] as const)('denies confirmed %s before native approval and backend dispatch', async (_label, args) => {
    let backendCalls = 0;
    let approvalCalls = 0;
    const registry = new ToolRegistry({
      git: {
        async run(): Promise<ReturnType<typeof ok>> {
          backendCalls += 1;
          return ok({ exitCode: 0, stdout: '', stderr: '' });
        },
      } as McpApplicationServices['git'],
    }, actor, {
      activeWorkspaceScopeProvider: activeScope,
      hostMutationApprovalProvider: async (): Promise<boolean> => {
        approvalCalls += 1;
        return true;
      },
    });

    const response = await registry.invoke('git', { workspaceId: 'workspace-a', args, userConfirmed: true });

    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    expect(approvalCalls).toBe(0);
    expect(backendCalls).toBe(0);
  });
});
