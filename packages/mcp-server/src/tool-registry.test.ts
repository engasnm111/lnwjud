import { describe, expect, it } from 'vitest';
import { appError, err, ok } from '@lnwjud/domain';
import type { ActivitySinkEvent } from './activity-tracker.js';
import { ToolRegistry, type McpApplicationServices } from './tool-registry.js';

const actor = { clientId: 'client-1', clientName: 'test' };

describe('MCP tool registry', () => {
  it('returns the exact deterministic V1 tool order', () => {
    const registry = new ToolRegistry({}, actor);

    expect(registry.list().map((tool) => tool.name)).toEqual([
      'workspace_list', 'workspace_register', 'workspace_info', 'workspace_tree', 'project_snapshot', 'read_file', 'read_files',
      'search_files', 'search_text', 'git_status', 'git_diff', 'git_log', 'write_file',
      'apply_patch', 'move_file', 'delete_file', 'process_start', 'process_status',
      'process_logs', 'process_stop', 'project_dev', 'project_test', 'project_lint',
      'project_typecheck', 'project_build', 'codex_status', 'codex_run',
      'codex_task_status', 'codex_task_logs', 'codex_stop',
      'shell', 'dom_cdp', 'accessibility', 'input_event', 'vision', 'window', 'health',
      'system_info', 'notification', 'file_dialog', 'clipboard', 'web_fetch',
      'audio', 'screen_record', 'office', 'scheduler',
      'skills_list', 'skills_read', 'mcp_list', 'mcp_describe', 'mcp_call',
    ]);
  });

  it('exposes the Khai-Hub-compatible local capability contract', () => {
    const registry = new ToolRegistry({}, actor);
    const byName = new Map(registry.list().map((tool) => [tool.name, tool]));

    expect(byName.get('shell')?.parse({ operation: 'run', executable: 'node', arguments: [] })).toMatchObject({ ok: true });
    expect(byName.get('dom_cdp')?.parse({ action: 'query', parameters: { selector: '#app' } })).toMatchObject({ ok: true });
    expect(byName.get('accessibility')?.parse({})).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(byName.get('input_event')?.parse({ operation: 'click', parameters: { x: 1, y: 2 } })).toMatchObject({ ok: true });
    expect(byName.get('vision')?.parse({ action: 'capture_display' })).toMatchObject({ ok: true });
    expect(byName.get('window')?.parse({ operation: 'list' })).toMatchObject({ ok: true });
    expect(byName.get('window')?.parse({ operation: 'set_window_frame', parameters: { x: 0, y: 0, width: 800, height: 600 } })).toMatchObject({ ok: true });
    expect(byName.get('health')?.parse({ operation: 'check_all' })).toMatchObject({ ok: true });
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
    expect(byName.get('skills_list')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get('mcp_call')?.permission).toBe('DANGEROUS');
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

  it('records activity sink events for successful tool calls', async () => {
    const events: Array<{ phase: string; toolName: string; resultCode: string }> = [];
    const services: McpApplicationServices = {
      file: {
        async readFile() {
          return ok({ path: 'src\\file.ts', content: 'hello', truncated: false });
        },
        async readFiles() {
          return ok({ files: [] });
        },
        async writeFile() {
          return ok({ path: 'x' });
        },
        async applyPatch() {
          return ok({ paths: [] });
        },
        async moveFile() {
          return ok({ from: 'a', to: 'b' });
        },
        async deleteFile() {
          return ok({ path: 'x' });
        },
      },
    };

    const response = await new ToolRegistry(services, actor, {
      activity: {
        async record(event: ActivitySinkEvent): Promise<void> {
          events.push({ phase: event.phase, toolName: event.toolName, resultCode: event.resultCode });
        },
      },
    }).invoke('read_file', { workspaceId: 'workspace-1', path: 'src\\file.ts' });

    expect(response.isError).not.toBe(true);
    expect(events).toEqual([
      { phase: 'started', toolName: 'read_file', resultCode: 'STARTED' },
      { phase: 'completed', toolName: 'read_file', resultCode: 'SUCCESS' },
    ]);
  });
});
