import { describe, expect, it } from 'vitest';
import { CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY } from '@lnwjud/capabilities';
import { ok } from '@lnwjud/domain';
import { ToolRegistry, type McpApplicationServices, type WorkspaceScope } from './tool-registry.js';

const actor = { clientId: 'native-active-project-test', clientName: 'native active project test' };
const activeScope: WorkspaceScope = { workspaceId: 'workspace-a', rootPath: 'E:\\project-a' };
const approveMutation = async (): Promise<boolean> => true;

function registryWithCalls(calls: unknown[]): ToolRegistry {
  return new ToolRegistry({
    file: {
      async prepareExternalFileMutation(_actor, workspaceId, request): Promise<ReturnType<typeof ok>> {
        const target = String(request.targetPath ?? '');
        const normalized = target.includes('capture.wav')
          ? 'E:\\project-a\\capture.wav'
          : target.includes('capture.mp4')
            ? 'E:\\project-a\\capture.mp4'
            : 'E:\\project-a\\report.docx';
        return ok({
          sourcePaths: [...(request.sourcePaths ?? [])].map((value) => String(value).replace(/^report\.docx$/, 'E:\\project-a\\report.docx')),
          targetPath: normalized,
          targetRelativePath: normalized.split('\\').at(-1) ?? normalized,
          replacementBackup: { recoveryId: 'recovery-1', recoveryPath: 'E:\\recovery\\recovery-1\\payload' },
          workspaceId,
        });
      },
    } as McpApplicationServices['file'],
    capabilities: {
      async execute(tool, input): Promise<ReturnType<typeof ok>> {
        calls.push({ tool, input });
        return ok({ executed: true });
      },
    },
  }, actor, {
    activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope> => activeScope,
    hostMutationApprovalProvider: approveMutation,
  });
}

describe('native Active Project boundary', () => {
  it.each([
    ['office', { workspaceId: 'workspace-a', app: 'word', action: 'replace', file_path: 'report.docx', find: 'old', replace_with: 'new', userConfirmed: true }],
    ['audio', { workspaceId: 'workspace-a', action: 'record', output_path: 'capture.wav', userConfirmed: true }],
    ['screen_record', { workspaceId: 'workspace-a', action: 'start', output_path: 'capture.mp4', userConfirmed: true }],
  ] as const)('injects the host root into %s after file-safety preparation', async (tool, input) => {
    const calls: unknown[] = [];
    const registry = registryWithCalls(calls);

    const response = await registry.invoke(tool, input);

    expect(response.isError).not.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tool,
      input: {
        metadata: { [CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY]: activeScope.rootPath },
      },
    });
  });

  it('injects the host root for path-bearing native reads too', async () => {
    const calls: unknown[] = [];
    const registry = registryWithCalls(calls);

    const response = await registry.invoke('office', {
      workspaceId: 'workspace-a',
      app: 'excel',
      action: 'read',
      file_path: 'E:\\project-a\\report.xlsx',
      range: 'A1:B2',
    });

    expect(response.isError).not.toBe(true);
    expect(calls).toEqual([expect.objectContaining({
      tool: 'office',
      input: expect.objectContaining({
        metadata: { [CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY]: activeScope.rootPath },
      }),
    })]);
  });

  it('denies a mismatched workspace before a native provider sees the request', async () => {
    const calls: unknown[] = [];
    const registry = registryWithCalls(calls);

    const response = await registry.invoke('office', {
      workspaceId: 'workspace-b',
      app: 'excel',
      action: 'read',
      file_path: 'E:\\project-b\\report.xlsx',
      range: 'A1:B2',
    });

    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    expect(calls).toHaveLength(0);
  });
});
