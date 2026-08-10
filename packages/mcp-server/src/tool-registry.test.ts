import { describe, expect, it } from 'vitest';
import { appError, err, ok } from '@lnwjud/domain';
import { ToolRegistry, type McpApplicationServices } from './tool-registry.js';

const actor = { clientId: 'client-1', clientName: 'test' };

describe('MCP tool registry', () => {
  it('returns the exact deterministic V1 tool order', () => {
    const registry = new ToolRegistry({}, actor);

    expect(registry.list().map((tool) => tool.name)).toEqual([
      'workspace_info', 'workspace_tree', 'project_snapshot', 'read_file', 'read_files',
      'search_files', 'search_text', 'git_status', 'git_diff', 'git_log', 'write_file',
      'apply_patch', 'move_file', 'delete_file', 'process_start', 'process_status',
      'process_logs', 'process_stop', 'project_dev', 'project_test', 'project_lint',
      'project_typecheck', 'project_build', 'codex_status', 'codex_run',
      'codex_task_status', 'codex_task_logs', 'codex_stop',
    ]);
  });

  it('rejects invalid workspace IDs, line ranges, oversized results, and process log queries at the schema boundary', async () => {
    const registry = new ToolRegistry({}, actor);

    await expect(registry.invoke('read_file', { workspaceId: '', path: 'src\\file.ts' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    await expect(registry.invoke('read_file', { workspaceId: 'workspace-1', path: 'src\\file.ts', startLine: 10, endLine: 2 })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    await expect(registry.invoke('search_text', { workspaceId: 'workspace-1', query: 'x', maxResults: 501 })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    await expect(registry.invoke('process_logs', { workspaceId: 'workspace-1', processId: 'process-1', tailLines: 10001 })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
  });

  it('marks read-only and destructive annotations accurately and excludes forbidden tools', () => {
    const registry = new ToolRegistry({}, actor);
    const byName = new Map(registry.list().map((tool) => [tool.name, tool]));

    expect(byName.get('read_file')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get('delete_file')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get('write_file')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(registry.list().some((tool) => ['run_shell', 'powershell', 'cmd', 'git_reset', 'git_clean', 'kill_pid'].includes(tool.name))).toBe(false);
  });

  it('maps application errors without exposing internal details', async () => {
    const services: McpApplicationServices = {
      file: { async readFile(): Promise<ReturnType<typeof err>> { return err(appError('INTERNAL_ERROR', 'internal stack must not escape', true)); } },
    };

    const response = await new ToolRegistry(services, actor).invoke('read_file', { workspaceId: 'workspace-1', path: 'src\\file.ts' });

    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INTERNAL_ERROR', recoverable: true } } });
    expect(response.content[0]?.text).not.toContain('stack');
  });

  it('maps thrown application exceptions to INTERNAL_ERROR and sends redacted diagnostics', async () => {
    const diagnostics: unknown[] = [];
    const services: McpApplicationServices = {
      search: {
        async searchText(): Promise<never> {
          throw new Error('Authorization: Bearer secret-token');
        },
        async searchFiles() {
          return ok({ paths: [], truncated: false });
        },
      },
    };

    const response = await new ToolRegistry(services, actor, { diagnostic: (event: unknown): void => { diagnostics.push(event); } })
      .invoke('search_text', { workspaceId: 'workspace-1', query: 'needle' });

    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INTERNAL_ERROR', message: 'Operation failed' } } });
    expect(response.content[0]?.text).not.toContain('secret-token');
    expect(JSON.stringify(diagnostics)).not.toContain('secret-token');
    expect(diagnostics).toHaveLength(1);
  });
});
