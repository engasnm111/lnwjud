import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appError, err, ok } from '@lnwjud/domain';
import { LocalCapabilityService, ShellCapabilityBackend } from '@lnwjud/capabilities';
import { permissionProfiles, type PermissionProfile } from '@lnwjud/permissions';
import { DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY, type DestructiveAutoApprovalPolicy } from '@lnwjud/shared';
import type { ActivitySinkEvent } from './activity-tracker.js';
import { ToolRegistry, type McpApplicationServices, type ToolRegistryOptions, type WorkspaceScope } from './tool-registry.js';
import { GoalRequestCancellationService } from '@lnwjud/application';
import { CODEX_TOOL_NAMES } from './tools/codex-tools.js';
import { isAdvertisedDeliveryState } from './tool-delivery-contract.js';
import { UPGRADE_TOOL_CATALOG } from './upgrade-catalog.js';

const actor = { clientId: 'client-1', clientName: 'test' };
const approveMutation: NonNullable<ToolRegistryOptions['hostMutationApprovalProvider']> = async () => true;

afterEach(() => {
  vi.useRealTimers();
});

describe('MCP tool registry', () => {
  it('returns the exact deterministic tool order', () => {
    const registry = new ToolRegistry({}, actor);
    expect(registry.list().map((tool) => tool.name)).toEqual([
      'workspace_list', 'workspace_register', 'workspace_info', 'workspace_tree', 'project_snapshot', 'read_file', 'read_files',
      'search_files', 'search_text', 'git_status', 'git_diff', 'git_log', 'git', 'write_file',
      'apply_patch', 'edit_file', 'move_file', 'copy_file', 'delete_file', 'list_recovery_items', 'restore_deleted_file', 'list_checkpoints', 'restore_checkpoint', 'process_start', 'process_list', 'process_status',
      'process_logs', 'process_stop', 'project_dev', 'project_test', 'project_lint',
      'project_typecheck', 'project_build', 'shell', 'dom_cdp', 'computer_use', 'accessibility', 'input_event', 'vision', 'vision_annotated_capture', 'ui_target_action', 'window', 'health',
      'system_info', 'notification', 'file_dialog', 'clipboard', 'web_fetch',
      'audio', 'screen_record', 'office', 'scheduler',
      'wsl_exec', 'wsl_fs',
      'skills_list', 'skills_read', 'mcp_list', 'mcp_describe', 'mcp_call',
      'workspace_context', 'workspace_context_continue', 'workspace_full_scan', 'workspace_full_scan_continue',
      'workspace_snapshot', 'search_all', 'read_many_files',
      'read_file_page', 'read_file_page_continue',
      'workspace_index', 'workspace_index_status', 'workspace_index_watch', 'workspace_index_stop',
      'session_handoff', 'verify_incremental',
      'run_goal', 'get_goal', 'checkpoint_goal', 'finish_goal', 'cancel_goal', 'list_goals',
      'prepare_scheduled_continuation', 'record_scheduled_continuation_receipt', 'claim_scheduled_continuation', 'get_scheduled_continuation', 'expedite_scheduled_continuation', 'cancel_scheduled_continuation',
      ...UPGRADE_TOOL_CATALOG.filter((entry) => isAdvertisedDeliveryState(entry.deliveryState)).map((entry) => entry.name),
      'tool_batch',
    ]);
  });

  it('adds a registry-level confirmation envelope to every advertised tool schema', () => {
    const registry = new ToolRegistry({}, actor);
    for (const tool of registry.list()) {
      if (tool.inputSchema instanceof z.ZodObject) {
        expect(tool.inputSchema.shape, tool.name).toHaveProperty('userConfirmed');
        continue;
      }
      expect(tool.inputSchema, tool.name).toBeInstanceOf(z.ZodUnion);
      if (tool.inputSchema instanceof z.ZodUnion) {
        for (const option of tool.inputSchema.options) {
          expect(option, tool.name).toBeInstanceOf(z.ZodObject);
          if (option instanceof z.ZodObject) {
            expect(option.shape, tool.name).toHaveProperty('userConfirmed');
          }
        }
      }
    }
  });

  it('hides Codex delegation tools by default and exposes them only when explicitly enabled', () => {
    const hidden = new ToolRegistry({}, actor);
    const enabled = new ToolRegistry({}, actor, { codexToolsEnabled: true });
    expect(hidden.list().filter((tool) => tool.name.startsWith('codex_'))).toHaveLength(0);
    expect(enabled.list().filter((tool) => tool.name.startsWith('codex_')).map((tool) => tool.name)).toEqual([...CODEX_TOOL_NAMES]);
    expect(enabled.list()).toHaveLength(hidden.list().length + CODEX_TOOL_NAMES.length);
  });

  it('does not advertise a fixed drive letter in workspace registration metadata', () => {
    const registry = new ToolRegistry({}, actor);
    const registration = registry.list().find((tool) => tool.name === 'workspace_register');
    expect(registration?.description).not.toContain('E:\\');
  });

  it('marks workspace discovery as a genuine read-only operation', () => {
    const registry = new ToolRegistry({}, actor);
    const workspaceList = registry.list().find((tool) => tool.name === 'workspace_list');
    expect(workspaceList).toMatchObject({
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    expect(permissionProfiles.safe.defaults.READ).toBe('ALLOW');
    expect(permissionProfiles.balanced.defaults.READ).toBe('ALLOW');
    expect(permissionProfiles.full.defaults.READ).toBe('ALLOW');
  });

  it('lists workspaces without mutation approval in every built-in profile', async () => {
    const list = vi.fn(async () => ok([{ id: 'workspace-1', displayName: 'Project', rootPath: 'D:\\Project', realRootPath: 'D:\\Project' }]));
    const approval = vi.fn(async () => true);
    const services = { workspaceInfo: { list } } as unknown as McpApplicationServices;
    for (const profile of [permissionProfiles.safe, permissionProfiles.balanced, permissionProfiles.full]) {
      const registry = new ToolRegistry(services, actor, {
        profileProvider: (): typeof profile => profile,
        hostMutationApprovalProvider: approval,
      });
      await expect(registry.invoke('workspace_list', {})).resolves.toMatchObject({
        structuredContent: { value: [{ id: 'workspace-1' }] },
      });
    }
    expect(list).toHaveBeenCalledTimes(3);
    expect(approval).not.toHaveBeenCalled();
  });

  it('exposes the local desktop capability contract', () => {
    const registry = new ToolRegistry({}, actor);
    const byName = new Map(registry.list().map((tool) => [tool.name, tool]));
    expect(byName.get('shell')?.parse({ operation: 'run', executable: 'node', arguments: [] })).toMatchObject({ ok: true });
    const domCdp = byName.get('dom_cdp');
    expect(domCdp?.parse({ action: 'query', parameters: { selector: '#app' } })).toMatchObject({ ok: false });
    expect(domCdp?.parse({ action: 'query', tab_id: 'tab-1', parameters: { selector: '#app' } })).toMatchObject({ ok: true });
    expect(domCdp?.parse({ action: 'list_tabs' })).toMatchObject({ ok: true });
    expect(domCdp?.parse({ action: 'new_tab', parameters: { url: 'about:blank' } })).toMatchObject({ ok: true });
    expect(domCdp?.parse({
      tab_id: 'tab-1',
      steps: [{ action: 'query', parameters: { selector: 'body', tab_id: 'tab-2' } }],
    })).toMatchObject({ ok: false });
    expect(byName.get('computer_use')?.parse({ workspaceId: 'workspace-1', action: 'click', target: { x: 10, y: 20 }, userConfirmed: true })).toMatchObject({ ok: true });
    expect(byName.get('accessibility')?.parse({})).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(byName.get('input_event')?.parse({ operation: 'click', parameters: { x: 1, y: 2 } })).toMatchObject({ ok: true });
    expect(byName.get('vision')?.parse({ action: 'capture_display' })).toMatchObject({ ok: true });
    expect(byName.get('window')?.parse({ operation: 'list' })).toMatchObject({ ok: true });
    expect(byName.get('window')?.parse({ operation: 'set_window_frame', parameters: { title: 'Editor', x: 0, y: 0, width: 800, height: 600 } })).toMatchObject({ ok: true });
    expect(byName.get('health')?.parse({ operation: 'check_all' })).toMatchObject({ ok: true });
    expect(byName.get('wsl_exec')?.parse({ workspaceId: 'workspace-1', executable: 'node', arguments: ['--version'] })).toMatchObject({ ok: true });
    expect(byName.get('wsl_fs')?.parse({ operation: 'translate', workspaceId: 'workspace-1', direction: 'windows_to_wsl', path: 'C:\\workspace' })).toMatchObject({ ok: true });
  });

  it('forces MCP command execution to return immediately and caps follow-up waits', async () => {
    const calls: Array<{ tool: string; input: unknown }> = [];
    const registry = new ToolRegistry({
      capabilities: {
        async execute(tool, input): Promise<ReturnType<typeof ok>> {
          calls.push({ tool, input });
          return ok({ accepted: true });
        },
      },
    }, actor, { hostMutationApprovalProvider: approveMutation });
    const byName = new Map(registry.list().map((tool) => [tool.name, tool]));
    expect(byName.get('shell')?.description).toContain('ALWAYS forced to execution=background');
    expect(byName.get('shell')?.parse({ operation: 'run', executable: 'node', arguments: [] })).toMatchObject({ ok: true, value: { execution: 'background' } });
    expect(byName.get('wsl_exec')?.parse({ operation: 'run', workspaceId: 'workspace-1', executable: 'true', arguments: [] })).toMatchObject({ ok: true, value: { execution: 'background' } });
    await registry.invoke('shell', { operation: 'run', executable: 'node', arguments: ['--version'], execution: 'foreground', userConfirmed: true });
    await registry.invoke('shell', { operation: 'wait', task_id: 'task-1', timeout_seconds: 60 });
    await registry.invoke('wsl_exec', { operation: 'run', workspaceId: 'workspace-1', executable: 'true', arguments: [], execution: 'foreground', userConfirmed: true });
    await registry.invoke('wsl_exec', { operation: 'wait', workspaceId: 'workspace-1', task_id: 'task-2', timeout_seconds: 60 });
    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({ tool: 'shell', input: { operation: 'run', execution: 'background' } });
    expect(calls[1]).toMatchObject({ tool: 'shell', input: { operation: 'wait', timeout_seconds: 5 } });
    expect(calls[2]).toMatchObject({ tool: 'wsl_exec', input: { operation: 'run', execution: 'background' } });
    expect(calls[3]).toMatchObject({ tool: 'wsl_exec', input: { operation: 'wait', timeout_seconds: 5 } });
  });

  it('uses the live configured MCP poll window and clamps it to the supported 5-60 second range', async () => {
    const waits: number[] = [];
    let configured = 30;
    const registry = new ToolRegistry({
      runtimeTiming: (): { mcpPollWaitSeconds: number } => ({ mcpPollWaitSeconds: configured }),
      capabilities: {
        async execute(_tool, input): Promise<ReturnType<typeof ok>> {
          const request = input as { operation?: string; timeout_seconds?: number };
          if (request.operation === 'wait' && request.timeout_seconds !== undefined) waits.push(request.timeout_seconds);
          return ok({ accepted: true });
        },
      },
    }, actor);
    await registry.invoke('shell', { operation: 'wait', task_id: 'task-1', timeout_seconds: 60 });
    configured = 1;
    await registry.invoke('shell', { operation: 'wait', task_id: 'task-1', timeout_seconds: 60 });
    configured = 999;
    await registry.invoke('wsl_exec', { operation: 'wait', workspaceId: 'workspace-1', task_id: 'task-2', timeout_seconds: 60 });
    expect(waits).toEqual([30, 5, 60]);
    const shellDescription = registry.list().find((tool) => tool.name === 'shell')?.description ?? '';
    const wslDescription = registry.list().find((tool) => tool.name === 'wsl_exec')?.description ?? '';
    for (const description of [shellDescription, wslDescription]) {
      expect(description).toContain('When the user requires babysitting until completion, keep using bounded waits');
      expect(description).toContain('do not report completion until the terminal result is inspected');
      expect(description).not.toContain('do not keep polling in the same chat turn');
    }
  });

  it('blocks dangerous capability execution under the safe profile before reaching the backend', async () => {
    let executed = false;
    const registry = new ToolRegistry({ capabilities: { async execute(): Promise<ReturnType<typeof ok>> { executed = true; return ok({ executed: true }); } } }, actor, {
      profileProvider: (): typeof permissionProfiles.safe => permissionProfiles.safe,
    });
    const response = await registry.invoke('dom_cdp', { action: 'type', tab_id: 'tab-1', parameters: { selector: 'input', text: 'unsafe' } });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    expect(executed).toBe(false);
  });

  it('uses action-level permission for mixed tools so Safe can read without allowing mutations', async () => {
    const calls: Array<{ tool: string; input: unknown }> = [];
    const registry = new ToolRegistry({ capabilities: { async execute(tool, input): Promise<ReturnType<typeof ok>> { calls.push({ tool, input }); return ok({ executed: true }); } } }, actor, {
      profileProvider: (): typeof permissionProfiles.safe => permissionProfiles.safe,
    });
    const read = await registry.invoke('web_fetch', { url: 'https://example.com', method: 'GET' });
    expect(read.isError).not.toBe(true);
    await expect(registry.invoke('web_fetch', { url: 'https://example.com', method: 'POST', userConfirmed: true })).resolves.toMatchObject({
      isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } },
    });
    const clipboardRead = await registry.invoke('clipboard', { action: 'get_text' });
    expect(clipboardRead.isError).not.toBe(true);
    expect(calls.map((call) => call.tool)).toEqual(['web_fetch', 'clipboard']);
  });

  it('lets explicit confirmation satisfy ASK without overriding a profile DENY', async () => {
    const calls: string[] = [];
    const services: McpApplicationServices = {
      capabilities: { async execute(tool): Promise<ReturnType<typeof ok>> { calls.push(tool); return ok({ executed: true }); } },
    };
    const balanced = new ToolRegistry(services, actor, {
      profileProvider: (): typeof permissionProfiles.balanced => permissionProfiles.balanced,
      hostMutationApprovalProvider: approveMutation,
    });
    const safe = new ToolRegistry(services, actor, {
      profileProvider: (): typeof permissionProfiles.safe => permissionProfiles.safe,
      hostMutationApprovalProvider: approveMutation,
    });
    const allowed = await balanced.invoke('web_fetch', { url: 'https://example.com/item/1', method: 'DELETE', userConfirmed: true });
    expect(allowed.isError).not.toBe(true);
    await expect(safe.invoke('web_fetch', { url: 'https://example.com/item/1', method: 'DELETE', userConfirmed: true })).resolves.toMatchObject({
      isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } },
    });
    expect(calls).toEqual(['web_fetch']);
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
    expect(byName.get('git')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get('write_file')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get('edit_file')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get('list_recovery_items')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get('list_checkpoints')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get('restore_checkpoint')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get('skills_list')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get('mcp_call')?.permission).toBe('DANGEROUS');
    expect(byName.get('tool_batch')?.permission).toBe('EXECUTE');
    expect(byName.get('tool_batch')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get('workspace_context')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get('read_file_page')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(registry.list().some((tool) => ['run_shell', 'powershell', 'cmd', 'git_reset', 'git_clean', 'kill_pid'].includes(tool.name))).toBe(false);
  });

  it('maps application errors without exposing internal details', async () => {
    const services: McpApplicationServices = { file: { async readFile(): Promise<ReturnType<typeof err>> { return err(appError('INTERNAL_ERROR', 'internal stack must not escape', true)); } } };
    const response = await new ToolRegistry(services, actor).invoke('read_file', { workspaceId: 'workspace-1', path: 'src\\file.ts' });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INTERNAL_ERROR', recoverable: true } } });
    expect(response.content[0]?.text).not.toContain('stack');
  });

  it('does not impose a default 90-second response cutoff on long-running tools', async () => {
    vi.useFakeTimers();
    const services: McpApplicationServices = { search: {
      async searchText() { await new Promise((resolve) => setTimeout(resolve, 95_000)); return ok({ matches: [], truncated: false }); },
      async searchFiles() { return ok({ paths: [], truncated: false }); },
    } };
    const registry = new ToolRegistry(services, actor);
    let settled = false;
    const pending = registry.invoke('search_text', { workspaceId: 'workspace-1', query: 'slow-but-valid' });
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(90_001);
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);
    await expect(pending).resolves.toMatchObject({ structuredContent: { matches: [], truncated: false } });
  });

  it('returns a recoverable timeout before a slow tool can outlive the MCP response budget', async () => {
    const services: McpApplicationServices = { search: {
      async searchText() { await new Promise((resolve) => setTimeout(resolve, 80)); return ok({ matches: [], truncated: false }); },
      async searchFiles() { return ok({ paths: [], truncated: false }); },
    } };
    const registry = new ToolRegistry(services, actor, { maxToolDurationMs: 10 });
    const started = Date.now();
    const response = await registry.invoke('search_text', { workspaceId: 'workspace-1', query: 'slow' });
    expect(Date.now() - started).toBeLessThan(70);
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'PROCESS_TIMEOUT', recoverable: true } } });
  });

  it('aborts a timed-out invocation before allowing the next MCP call to succeed', async () => {
    let firstInvocationAborted = false;
    const services: McpApplicationServices = { search: {
      async searchText(_actor, _workspaceId, request, signal) {
        if (request.query === 'fast') return ok({ matches: [], truncated: false });
        return new Promise<ReturnType<typeof ok>>((resolve) => {
          signal?.addEventListener('abort', () => { firstInvocationAborted = true; resolve(ok({ matches: [], truncated: true })); }, { once: true });
        });
      },
      async searchFiles() { return ok({ paths: [], truncated: false }); },
    } };
    const registry = new ToolRegistry(services, actor, { maxToolDurationMs: 15 });
    await expect(registry.invoke('search_text', { workspaceId: 'workspace-1', query: 'slow' })).resolves.toMatchObject({
      isError: true, structuredContent: { error: { code: 'PROCESS_TIMEOUT', recoverable: true } },
    });
    expect(firstInvocationAborted).toBe(true);
    const followUp = await registry.invoke('search_text', { workspaceId: 'workspace-1', query: 'fast' });
    expect(followUp.isError).not.toBe(true);
    expect(followUp.structuredContent).toMatchObject({ matches: [], truncated: false });
  });

  it('maps thrown application exceptions to INTERNAL_ERROR and sends redacted diagnostics', async () => {
    const diagnostics: unknown[] = [];
    const services: McpApplicationServices = { search: {
      async searchText(): Promise<never> { throw new Error('Authorization: Bearer secret-token'); },
      async searchFiles() { return ok({ paths: [], truncated: false }); },
    } };
    const response = await new ToolRegistry(services, actor, { diagnostic: (event: unknown): void => { diagnostics.push(event); } }).invoke('search_text', { workspaceId: 'workspace-1', query: 'needle' });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INTERNAL_ERROR', message: 'Operation failed' } } });
    expect(response.content[0]?.text).not.toContain('secret-token');
    expect(JSON.stringify(diagnostics)).not.toContain('secret-token');
    expect(diagnostics).toHaveLength(1);
  });

  it('records activity sink events for successful tool calls', async () => {
    const events: Array<{ phase: string; toolName: string; resultCode: string }> = [];
    const services: McpApplicationServices = { file: {
      async readFile() { return ok({ path: 'src\\file.ts', content: 'hello', truncated: false }); },
      async readFiles() { return ok({ files: [] }); },
      async writeFile() { return ok({ path: 'x' }); },
      async applyPatch() { return ok({ paths: [] }); },
      async moveFile() { return ok({ from: 'a', to: 'b' }); },
      async copyFile() { return ok({ sourcePath: 'a', destinationPath: 'b' }); },
      async deleteFile() { return ok({ path: 'x' }); },
    } };
    const response = await new ToolRegistry(services, actor, { activity: { async record(event: ActivitySinkEvent): Promise<void> { events.push({ phase: event.phase, toolName: event.toolName, resultCode: event.resultCode }); } } }).invoke('read_file', { workspaceId: 'workspace-1', path: 'src\\file.ts' });
    expect(response.isError).not.toBe(true);
    expect(events).toEqual([
      { phase: 'started', toolName: 'read_file', resultCode: 'STARTED' },
      { phase: 'completed', toolName: 'read_file', resultCode: 'SUCCESS' },
    ]);
  });

  it('attributes shell cwd and task follow-ups to the matching registered workspace for activity logs', async () => {
    const events: ActivitySinkEvent[] = [];
    let taskSequence = 0;
    const registry = new ToolRegistry({
      workspaceInfo: {
        async info(): Promise<ReturnType<typeof err>> { return err(appError('WORKSPACE_NOT_FOUND', 'not used')); },
        async list(): Promise<ReturnType<typeof ok>> { return ok([
          { id: 'machine-root', displayName: 'E', rootPath: 'E:\\', realRootPath: 'E:\\' },
          { id: 'workspace-project', displayName: 'lnwjud', rootPath: 'E:\\lnwjud', realRootPath: 'E:\\lnwjud' },
        ]); },
      },
      capabilities: { async execute(tool, input): Promise<ReturnType<typeof ok>> {
        expect(tool).toBe('shell');
        const request = input as { operation?: string; task_id?: string };
        if (request.operation === 'run') { taskSequence += 1; return ok({ task_id: `task-${taskSequence}`, state: 'running' }); }
        return ok({ task_id: request.task_id, state: 'completed', exit_code: 0 });
      } },
    }, actor, {
      activity: { async record(event: ActivitySinkEvent): Promise<void> { events.push(event); } },
      hostMutationApprovalProvider: approveMutation,
    });
    await registry.invoke('shell', { operation: 'run', executable: 'node', arguments: ['--version'], cwd: 'E:\\lnwjud\\packages\\mcp-server', userConfirmed: true });
    await registry.invoke('shell', { operation: 'wait', task_id: 'task-1' });
    await registry.invoke('shell', { operation: 'run', executable: 'node', arguments: ['--version'], cwd: 'C:\\outside', userConfirmed: true });
    expect(events[0]?.targetSummary).toBe('node --version');
    expect(events[2]?.targetSummary).toBe('node --version');
    expect(events.slice(0, 4).map((event) => ({ phase: event.phase, workspaceId: event.workspaceId }))).toEqual([
      { phase: 'started', workspaceId: 'workspace-project' },
      { phase: 'completed', workspaceId: 'workspace-project' },
      { phase: 'started', workspaceId: 'workspace-project' },
      { phase: 'completed', workspaceId: 'workspace-project' },
    ]);
    expect(events.slice(4).every((event) => event.workspaceId === undefined)).toBe(true);
  });

  it('executes tool_batch children through the registry and records each child activity', async () => {
    const events: Array<{ phase: string; toolName: string; resultCode: string }> = [];
    const registry = new ToolRegistry({ file: { async readFile(input): Promise<ReturnType<typeof ok>> { return ok({ path: input.path, content: `content:${input.path}`, truncated: false }); } } }, actor, {
      activity: { async record(event: ActivitySinkEvent): Promise<void> { events.push({ phase: event.phase, toolName: event.toolName, resultCode: event.resultCode }); } },
    });
    const response = await registry.invoke('tool_batch', { parallel: true, calls: [
      { id: 'read-a', tool: 'read_file', arguments: { workspaceId: 'workspace-1', path: 'a.txt' } },
      { id: 'read-b', tool: 'read_file', arguments: { workspaceId: 'workspace-1', path: 'b.txt' } },
    ] });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ summary: { total: 2, succeeded: 2, failed: 0 } });
    expect(events.filter((event) => event.phase === 'started').map((event) => event.toolName)).toEqual(['tool_batch', 'read_file', 'read_file']);
    expect(events.filter((event) => event.phase === 'completed').map((event) => event.toolName).sort()).toEqual(['read_file', 'read_file', 'tool_batch']);
  });

  it('keeps successful batch siblings when one child returns an MCP error', async () => {
    const registry = new ToolRegistry({ file: { async readFile(input): Promise<ReturnType<typeof ok>> { return ok({ path: input.path, content: 'ok', truncated: false }); } } }, actor);
    const response = await registry.invoke('tool_batch', { parallel: true, calls: [
      { id: 'good-a', tool: 'read_file', arguments: { workspaceId: 'workspace-1', path: 'a.txt' } },
      { id: 'bad', tool: 'does_not_exist', arguments: {} },
      { id: 'good-b', tool: 'read_file', arguments: { workspaceId: 'workspace-1', path: 'b.txt' } },
    ] });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ summary: { total: 3, succeeded: 2, failed: 1 }, results: [
      { id: 'good-a', status: 'succeeded' },
      { id: 'bad', status: 'failed', error: { code: 'INVALID_INPUT' } },
      { id: 'good-b', status: 'succeeded' },
    ] });
  });

  it('requires explicit confirmation before recoverable Git mutations reach the backend', async () => {
    let executed = 0;
    const registry = new ToolRegistry({ git: { async run(): Promise<ReturnType<typeof ok>> { executed += 1; return ok({ exitCode: 0, stdout: '', stderr: '' }); } } }, actor, {
      profileProvider: (): PermissionProfile => permissionProfiles.balanced,
      hostMutationApprovalProvider: approveMutation,
    });
    const blocked = await registry.invoke('git', { workspaceId: 'workspace-1', args: ['add', '--', 'src/file.ts'] });
    expect(blocked).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    expect(executed).toBe(0);
    const allowed = await registry.invoke('git', { workspaceId: 'workspace-1', args: ['add', '--', 'src/file.ts'], userConfirmed: true });
    expect(allowed.isError).not.toBe(true);
    expect(executed).toBe(1);
  });

  it('allows only scoped delete_file to bypass chat confirmation when the AI delete policy is enabled', async () => {
    let deletes = 0;
    const registry = new ToolRegistry({
      file: { async deleteFile(): Promise<ReturnType<typeof ok>> { deletes += 1; return ok(undefined); } } as McpApplicationServices['file'],
      capabilities: { async execute(): Promise<ReturnType<typeof ok>> { return ok({ ok: true }); } },
    }, actor, {
      allowAiDeleteProvider: (): boolean => true,
      activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope | null> => ({ workspaceId: 'workspace-1', rootPath: 'E:\\project' }),
    });
    const deleted = await registry.invoke('delete_file', { workspaceId: 'workspace-1', path: 'tmp.txt' });
    expect(deleted.isError).not.toBe(true);
    expect(deletes).toBe(1);
    await expect(registry.invoke('shell', { operation: 'run', executable: 'rm', arguments: ['tmp.txt'] })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
  });

  it('auto-approves enabled exact scoped destructive command families but keeps broad or escaped forms interactive', async () => {
    const capabilityInputs: unknown[] = [];
    const capabilityAuthorizations: unknown[] = [];
    let gitRuns = 0;
    const registry = new ToolRegistry({
      capabilities: { async execute(_tool, input, _signal, authorization): Promise<ReturnType<typeof ok>> { capabilityInputs.push(input); capabilityAuthorizations.push(authorization); return ok({ ok: true }); } },
      git: { async run(): Promise<ReturnType<typeof ok>> { gitRuns += 1; return ok({ exitCode: 0, stdout: '', stderr: '' }); } } as McpApplicationServices['git'],
    }, actor, {
      destructivePolicyProvider: (): DestructiveAutoApprovalPolicy => ({ ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY, approvals: { ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY.approvals, git_rm: true, shell_rm_unlink: true } }),
      activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope | null> => ({ workspaceId: 'workspace-1', rootPath: 'E:\\project' }),
    });

    await expect(registry.invoke('git', { workspaceId: 'workspace-1', args: ['rm', '--', 'src/old.ts'] })).resolves.not.toMatchObject({ isError: true });
    await expect(registry.invoke('shell', { workspaceId: 'workspace-1', operation: 'run', executable: 'rm', arguments: ['src/old.tmp'] })).resolves.not.toMatchObject({ isError: true });
    expect(gitRuns).toBe(1);
    expect(capabilityInputs).toHaveLength(1);
    expect(capabilityInputs[0]).not.toMatchObject({ userConfirmed: true });
    expect(capabilityAuthorizations[0]).toMatchObject({ applicationApproved: true, source: 'scoped_policy' });

    await expect(registry.invoke('shell', { workspaceId: 'workspace-1', operation: 'run', executable: 'rm', arguments: ['..\\outside.tmp'] })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('shell', { workspaceId: 'workspace-1', operation: 'run', executable: 'rm', arguments: ['-rf', 'src'] })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('git', { workspaceId: 'workspace-1', args: ['clean', '-fd'] })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    expect(gitRuns).toBe(1);
    expect(capabilityInputs).toHaveLength(1);
  });

  it('binds mutation authority to the host active workspace instead of request workspaceId', async () => {
    let deletes = 0;
    let projectStarts = 0;
    const registry = new ToolRegistry({
      file: { async deleteFile(): Promise<ReturnType<typeof ok>> { deletes += 1; return ok(undefined); } } as McpApplicationServices['file'],
      process: { async startProjectCommand(): Promise<ReturnType<typeof ok>> { projectStarts += 1; return ok({ processId: 'process-1', executable: 'pnpm', args: ['test'], cwd: 'E:\\project-a', state: 'running', startedAt: new Date(0).toISOString() }); } } as McpApplicationServices['process'],
    }, actor, {
      destructivePolicyProvider: (): DestructiveAutoApprovalPolicy => ({ ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY, approvals: { ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY.approvals, delete_file: true } }),
      activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope | null> => ({ workspaceId: 'workspace-a', rootPath: 'E:\\project-a' }),
    });
    const deletedA = await registry.invoke('delete_file', { workspaceId: 'workspace-a', path: 'tmp-a.txt' });
    expect(deletedA.isError).not.toBe(true);
    expect(deletes).toBe(1);
    await expect(registry.invoke('delete_file', { workspaceId: 'workspace-b', path: 'tmp-b.txt', userConfirmed: true })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    await expect(registry.invoke('delete_file', { path: 'no-workspace.txt' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    await expect(registry.invoke('project_test', { workspaceId: 'workspace-b', userConfirmed: true })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    expect(deletes).toBe(1);
    expect(projectStarts).toBe(0);
  });

  it('routes absolute file, database, and command targets to any matching member of the active workspace set', async () => {
    const rawRootA = await mkdtemp(path.join(tmpdir(), 'lnwjud-active-a-'));
    const rawRootB = await mkdtemp(path.join(tmpdir(), 'lnwjud-active-b-'));
    const rootA = await realpath(rawRootA);
    const rootB = await realpath(rawRootB);
    try {
      const databasePath = path.join(rootB, 'state.sqlite');
      const database = new DatabaseSync(databasePath);
      database.exec("CREATE TABLE probe (value TEXT NOT NULL); INSERT INTO probe (value) VALUES ('ok');");
      database.close();

      const fileWrites: Array<{ workspaceId: string | undefined; path: string }> = [];
      const capabilityCalls: Array<{ tool: string; input: Record<string, unknown> }> = [];
      const services = {
        workspaceInfo: {
          info: async (_actor: unknown, workspaceId: string) => {
            if (workspaceId === 'workspace-a') return ok({ id: workspaceId, realRootPath: rootA, rootPath: rootA });
            if (workspaceId === 'workspace-b') return ok({ id: workspaceId, realRootPath: rootB, rootPath: rootB });
            return err(appError('WORKSPACE_NOT_FOUND', 'missing workspace'));
          },
        },
        file: {
          async writeFile(_actor: unknown, workspaceId: string | undefined, request: { path: string }): Promise<ReturnType<typeof ok>> {
            fileWrites.push({ workspaceId, path: request.path });
            return ok({ path: request.path, bytesWritten: 1 });
          },
        } as McpApplicationServices['file'],
        capabilities: {
          async execute(tool: string, input: unknown): Promise<ReturnType<typeof ok>> {
            capabilityCalls.push({ tool, input: input as Record<string, unknown> });
            return ok({ accepted: true });
          },
        },
      } as unknown as McpApplicationServices;
      const registry = new ToolRegistry(services, actor, {
        activeWorkspaceScopesProvider: async (): Promise<readonly WorkspaceScope[]> => [
          { workspaceId: 'workspace-a', rootPath: rootA },
          { workspaceId: 'workspace-b', rootPath: rootB },
        ],
        hostMutationApprovalProvider: approveMutation,
      });

      const absoluteFile = path.join(rootB, 'note.txt');
      const write = await registry.invoke('write_file', { workspaceId: 'workspace-a', path: absoluteFile, content: 'x' });
      expect(write.isError).not.toBe(true);
      expect(fileWrites).toEqual([{ workspaceId: 'workspace-b', path: absoluteFile }]);

      const queried = await registry.invoke('db_query', {
        workspaceId: 'workspace-a',
        target: databasePath,
        sql: 'SELECT value FROM probe',
      });
      expect(queried).toMatchObject({ structuredContent: { result: [{ value: 'ok' }] } });

      const command = await registry.invoke('shell', {
        workspaceId: 'workspace-a',
        operation: 'run',
        executable: 'node.exe',
        arguments: ['--version'],
        cwd: rootB,
      });
      expect(command.isError).not.toBe(true);
      expect(capabilityCalls.at(-1)).toMatchObject({
        tool: 'shell',
        input: {
          workspaceId: 'workspace-b',
          cwd: rootB,
          metadata: { 'lnwjud.activeWorkspaceRoot.v1': rootB },
        },
      });
    } finally {
      await Promise.all([rm(rootA, { recursive: true, force: true }), rm(rootB, { recursive: true, force: true })]);
    }
  });

  it('allows explicitly absolute Shell and WSL working directories outside the host active workspace root after approval', async () => {
    const capabilityCalls: unknown[] = [];
    const registry = new ToolRegistry({ capabilities: { async execute(tool, input): Promise<ReturnType<typeof ok>> { capabilityCalls.push({ tool, input }); return ok({ accepted: true }); } } }, actor, {
      activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope | null> => ({ workspaceId: 'workspace-a', rootPath: 'E:\\project-a' }),
      hostMutationApprovalProvider: approveMutation,
    });
    await expect(registry.invoke('shell', { workspaceId: 'workspace-a', operation: 'run', executable: 'node.exe', arguments: ['script.js'], cwd: 'E:\\project-b', userConfirmed: true })).resolves.not.toMatchObject({ isError: true });
    await expect(registry.invoke('wsl_exec', { workspaceId: 'workspace-a', operation: 'run', executable: 'node', arguments: ['script.js'], cwd: 'E:\\project-b', userConfirmed: true })).resolves.not.toMatchObject({ isError: true });
    expect(capabilityCalls).toHaveLength(2);
    expect(capabilityCalls[0]).toMatchObject({ tool: 'shell', input: { cwd: 'E:\\project-b' } });
    expect(capabilityCalls[1]).toMatchObject({ tool: 'wsl_exec', input: { cwd: 'E:\\project-b' } });
    expect((capabilityCalls[0] as { input: { metadata?: Record<string, unknown> } }).input.metadata).not.toHaveProperty('lnwjud.activeWorkspaceRoot.v1');
    expect((capabilityCalls[1] as { input: { metadata?: Record<string, unknown> } }).input.metadata).not.toHaveProperty('lnwjud.activeWorkspaceRoot.v1');
  });

  it('anchors missing and relative Shell or WSL cwd values to the host active workspace root', async () => {
    const capabilityCalls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const registry = new ToolRegistry({ capabilities: { async execute(tool, input): Promise<ReturnType<typeof ok>> { capabilityCalls.push({ tool, input: input as Record<string, unknown> }); return ok({ accepted: true }); } } }, actor, {
      activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope | null> => ({ workspaceId: 'workspace-a', rootPath: 'E:\\project-a' }),
      hostMutationApprovalProvider: approveMutation,
    });
    await registry.invoke('shell', { workspaceId: 'workspace-a', operation: 'run', executable: 'node.exe', arguments: ['script.js'], cwd: 'src', userConfirmed: true });
    await registry.invoke('wsl_exec', { workspaceId: 'workspace-a', operation: 'run', executable: 'node', arguments: ['script.js'], userConfirmed: true });
    expect(capabilityCalls).toHaveLength(2);
    expect(capabilityCalls[0]).toMatchObject({ tool: 'shell', input: { cwd: 'E:\\project-a\\src', metadata: { 'lnwjud.activeWorkspaceRoot.v1': 'E:\\project-a' } } });
    expect(capabilityCalls[1]).toMatchObject({ tool: 'wsl_exec', input: { cwd: 'E:\\project-a', metadata: { 'lnwjud.activeWorkspaceRoot.v1': 'E:\\project-a' } } });
  });

  it('lets a host-native exact-action approval veto risky execution while scoped recoverable auto-delete stays non-interactive', async () => {
    let hostApproved = false;
    let capabilityExecutions = 0;
    let deletes = 0;
    const approvalRequests: unknown[] = [];
    const registry = new ToolRegistry({
      capabilities: { async execute(): Promise<ReturnType<typeof ok>> { capabilityExecutions += 1; return ok({ accepted: true }); } },
      file: { async deleteFile(): Promise<ReturnType<typeof ok>> { deletes += 1; return ok({ path: 'tmp.txt', recoverable: true, recoveryId: 'recovery-1' }); } } as McpApplicationServices['file'],
    }, actor, {
      destructivePolicyProvider: (): DestructiveAutoApprovalPolicy => ({ ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY, approvals: { ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY.approvals, delete_file: true } }),
      activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope | null> => ({ workspaceId: 'workspace-a', rootPath: 'E:\\project-a' }),
      profileProvider: (): PermissionProfile => permissionProfiles.balanced,
      hostMutationApprovalProvider: async (request: unknown): Promise<boolean> => { approvalRequests.push(request); return hostApproved; },
    } as ToolRegistryOptions & { readonly hostMutationApprovalProvider: (request: unknown) => Promise<boolean> });
    const denied = await registry.invoke('shell', { workspaceId: 'workspace-a', operation: 'run', executable: 'node.exe', arguments: ['--eval', 'require("fs").rmSync("x")'], cwd: 'tools', userConfirmed: true });
    expect(denied).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    expect(capabilityExecutions).toBe(0);
    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]).toMatchObject({ toolName: 'shell', mutationKind: 'opaque_mutation', workspaceId: 'workspace-a', workspaceRoot: 'E:\\project-a' });
    expect((approvalRequests[0] as { summary?: string }).summary).toContain('executable = node.exe');
    hostApproved = true;
    const approved = await registry.invoke('shell', { workspaceId: 'workspace-a', operation: 'run', executable: 'node.exe', arguments: ['--eval', 'require("fs").rmSync("x")'], cwd: 'tools', userConfirmed: true });
    expect(approved.isError).not.toBe(true);
    expect(capabilityExecutions).toBe(1);
    expect(approvalRequests).toHaveLength(2);
    const autoDeleted = await registry.invoke('delete_file', { workspaceId: 'workspace-a', path: 'tmp.txt' });
    expect(autoDeleted.isError).not.toBe(true);
    expect(deletes).toBe(1);
    expect(approvalRequests).toHaveLength(2);
  });

  it('backs up and normalizes mutating Office targets inside the host active workspace', async () => {
    const preparedInputs: unknown[] = [];
    const capabilityInputs: unknown[] = [];
    const registry = new ToolRegistry({
      file: { async prepareExternalFileMutation(_actor, workspaceId, request): Promise<ReturnType<typeof ok>> {
        preparedInputs.push({ workspaceId, request });
        return ok({ sourcePaths: [], targetPath: 'E:\\project-a\\report.docx', targetRelativePath: 'report.docx', replacementBackup: { recoveryId: 'backup-1', recoveryPath: 'E:\\recovery\\backup-1\\payload' } });
      } } as McpApplicationServices['file'],
      capabilities: { async execute(tool, input): Promise<ReturnType<typeof ok>> { capabilityInputs.push({ tool, input }); return ok({ replaced: true }); } },
    }, actor, {
      activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope | null> => ({ workspaceId: 'workspace-a', rootPath: 'E:\\project-a' }),
      profileProvider: (): PermissionProfile => permissionProfiles.balanced,
      hostMutationApprovalProvider: approveMutation,
    });
    await expect(registry.invoke('office', { workspaceId: 'workspace-a', app: 'word', action: 'replace', file_path: 'report.docx', find: 'old', replace_with: 'new' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('office', { workspaceId: 'workspace-b', app: 'word', action: 'replace', file_path: 'report.docx', find: 'old', replace_with: 'new', userConfirmed: true })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    const replaced = await registry.invoke('office', { workspaceId: 'workspace-a', app: 'word', action: 'replace', file_path: 'report.docx', find: 'old', replace_with: 'new', userConfirmed: true });
    expect(replaced).toMatchObject({ structuredContent: { replaced: true, replacementBackup: { recoveryId: 'backup-1', recoveryPath: 'E:\\recovery\\backup-1\\payload' } } });
    expect(preparedInputs).toEqual([{ workspaceId: 'workspace-a', request: { sourcePaths: [], targetPath: 'report.docx', userConfirmed: true } }]);
    expect(capabilityInputs).toEqual([{ tool: 'office', input: expect.objectContaining({ workspaceId: 'workspace-a', file_path: 'E:\\project-a\\report.docx', userConfirmed: true }) }]);
  });

  it.each([
    ['audio', { action: 'record', output_path: 'capture.wav' }, 'E:\\project-a\\capture.wav'],
    ['screen_record', { action: 'start', output_path: 'capture.mp4' }, 'E:\\project-a\\capture.mp4'],
  ] as const)('backs up and scopes %s output replacement to the host active workspace', async (tool, request, normalizedTarget) => {
    const preparedInputs: unknown[] = [];
    const capabilityInputs: unknown[] = [];
    const registry = new ToolRegistry({
      file: { async prepareExternalFileMutation(_actor, workspaceId, mutation): Promise<ReturnType<typeof ok>> {
        preparedInputs.push({ workspaceId, mutation });
        return ok({ sourcePaths: [], targetPath: normalizedTarget, targetRelativePath: path.win32.basename(normalizedTarget), replacementBackup: { recoveryId: 'media-backup-1', recoveryPath: 'E:\\recovery\\media-backup-1\\payload' } });
      } } as McpApplicationServices['file'],
      capabilities: { async execute(capability, input): Promise<ReturnType<typeof ok>> { capabilityInputs.push({ capability, input }); return ok({ started: true }); } },
    }, actor, {
      activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope | null> => ({ workspaceId: 'workspace-a', rootPath: 'E:\\project-a' }),
      hostMutationApprovalProvider: approveMutation,
    });
    await expect(registry.invoke(tool, { ...request, userConfirmed: true })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    await expect(registry.invoke(tool, { ...request, workspaceId: 'workspace-b', userConfirmed: true })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    const response = await registry.invoke(tool, { ...request, workspaceId: 'workspace-a', userConfirmed: true });
    expect(response).toMatchObject({ structuredContent: { started: true, replacementBackup: { recoveryId: 'media-backup-1', recoveryPath: 'E:\\recovery\\media-backup-1\\payload' } } });
    expect(preparedInputs).toEqual([{ workspaceId: 'workspace-a', mutation: { sourcePaths: [], targetPath: request.output_path, userConfirmed: true } }]);
    expect(capabilityInputs).toEqual([{ capability: tool, input: expect.objectContaining({ workspaceId: 'workspace-a', output_path: normalizedTarget, userConfirmed: true }) }]);
  });

  it('blocks parser-bypass Git and interpreter invocations before any backend call', async () => {
    const calls: string[] = [];
    const registry = new ToolRegistry({
      git: { async run(): Promise<ReturnType<typeof ok>> { calls.push('git'); return ok({ exitCode: 0, stdout: '', stderr: '' }); } } as McpApplicationServices['git'],
      capabilities: { async execute(tool): Promise<ReturnType<typeof ok>> { calls.push(tool); return ok({ ok: true }); } },
    }, actor);
    await expect(registry.invoke('git', { workspaceId: 'workspace-1', args: ['-C', 'E:\\outside', 'clean', '-fd'] })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    await expect(registry.invoke('git', { workspaceId: 'workspace-1', args: ['-c', 'alias.wipe=!rm -rf .', 'wipe'] })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    await expect(registry.invoke('git', { workspaceId: 'workspace-1', args: ['clean', '-fd'], userConfirmed: true })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    await expect(registry.invoke('shell', { operation: 'run', executable: 'pwsh.exe', arguments: ['-EncodedCommand', 'VwByAGkAdABlAC0ATwB1AHQAcAB1AHQA'] })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('shell', { workspaceId: 'workspace-1', operation: 'run', executable: 'rm', arguments: ['victim.txt'], userConfirmed: true })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED' } } });
    await expect(registry.invoke('wsl_exec', { workspaceId: 'workspace-1', operation: 'run', executable: 'cp', arguments: ['a', 'b'] })).resolves.not.toMatchObject({ isError: true });
    await expect(registry.invoke('shell', { operation: 'run', executable: 'node.exe', arguments: ['cleanup.js'] })).resolves.not.toMatchObject({ isError: true });
    expect(calls).toEqual(['wsl_exec', 'shell']);
  });

  it('allows Full profile ordinary mutations without forging caller confirmation while always-confirm families still prompt', async () => {
    const calls: string[] = [];
    const fileCalls: Array<{ readonly tool: string; readonly input: unknown; readonly authorization: unknown }> = [];
    const registry = new ToolRegistry({
      file: {
        async writeFile(_actor, _workspaceId, input, _signal, authorization): Promise<ReturnType<typeof ok>> { fileCalls.push({ tool: 'write_file', input, authorization }); return ok({ path: 'a.txt', bytesWritten: 1 }); },
        async applyPatch(_actor, _workspaceId, input, _signal, authorization): Promise<ReturnType<typeof ok>> { fileCalls.push({ tool: 'apply_patch', input, authorization }); return ok({ paths: ['a.txt'] }); },
        async deleteFile(): Promise<ReturnType<typeof ok>> { calls.push('delete_file'); return ok({ path: 'a.txt', recoverable: true }); },
      } as McpApplicationServices['file'],
      git: { async run(): Promise<ReturnType<typeof ok>> { calls.push('git'); return ok({ exitCode: 0, stdout: '', stderr: '' }); } } as McpApplicationServices['git'],
      process: { async start(): Promise<ReturnType<typeof ok>> { calls.push('process_start'); return ok({ processId: 'p1' }); } } as McpApplicationServices['process'],
      capabilities: { async execute(tool): Promise<ReturnType<typeof ok>> { calls.push(tool); return ok({ ok: true }); } },
    }, actor);

    await expect(registry.invoke('write_file', { workspaceId: 'workspace-1', path: 'a.txt', content: 'x' })).resolves.not.toMatchObject({ isError: true });
    await expect(registry.invoke('apply_patch', { workspaceId: 'workspace-1', files: [{ path: 'a.txt', content: 'y' }] })).resolves.not.toMatchObject({ isError: true });
    await expect(registry.invoke('git', { workspaceId: 'workspace-1', args: ['add', '--', 'a.txt'] })).resolves.not.toMatchObject({ isError: true });
    await expect(registry.invoke('process_start', { workspaceId: 'workspace-1', executable: 'powershell.exe', args: ['-Command', 'Get-Item .'] })).resolves.not.toMatchObject({ isError: true });
    await expect(registry.invoke('shell', { workspaceId: 'workspace-1', operation: 'run', executable: 'node.exe', arguments: ['-e', 'console.log(1)'] })).resolves.not.toMatchObject({ isError: true });
    await expect(registry.invoke('delete_file', { workspaceId: 'workspace-1', path: 'a.txt' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('mcp_call', { server: 'child', tool: 'delete_file', arguments: { path: 'a.txt' } })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('web_fetch', { url: 'https://example.com/item/1', method: 'POST' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('scheduler', { action: 'run', task_name: 'Task' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    expect(fileCalls).toEqual([
      { tool: 'write_file', input: expect.not.objectContaining({ userConfirmed: true }), authorization: expect.objectContaining({ mode: 'standard', applicationApproved: true, source: 'profile' }) },
      { tool: 'apply_patch', input: expect.not.objectContaining({ userConfirmed: true }), authorization: expect.objectContaining({ mode: 'standard', applicationApproved: true, source: 'profile' }) },
    ]);
    expect(calls).toEqual(['git', 'process_start', 'shell']);
  });

  it('registers fenced MCP requests and aborts them when their goal is cancelled', async () => {
    const cancellation = new GoalRequestCancellationService({ waitMs: 100 });
    let started = false;
    let aborted = false;
    const services: McpApplicationServices = {
      goalRequestCancellation: cancellation,
      file: {
        async writeFile(_actor, _workspaceId, _request, signal) {
          started = true;
          return new Promise((resolve) => {
            signal?.addEventListener('abort', () => {
              aborted = true;
              resolve(ok({ path: 'src/file.ts', bytesWritten: 0 }));
            }, { once: true });
          });
        },
      },
    };
    const registry = new ToolRegistry(services, actor);
    const pending = registry.invoke('write_file', {
      workspaceId: 'workspace-1',
      path: 'src/file.ts',
      content: 'cancel me',
      goalLease: { goalId: 'goal-cancel', leaseToken: 'lease-token', leaseGeneration: 1 },
    });

    for (let attempt = 0; attempt < 20 && !started; attempt += 1) await Promise.resolve();
    expect(started).toBe(true);
    await expect(cancellation.cancelForGoal('goal-cancel')).resolves.toMatchObject({
      goalId: 'goal-cancel', requested: 1, stopped: 1, remaining: 0, timedOut: false,
    });
    expect(aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ structuredContent: { path: 'src/file.ts' } });
  });

  it('honors Custom ALLOW for ordinary replacement and opaque operations instead of silently converting it to ASK', async () => {
    const customAllow: PermissionProfile = {
      name: 'custom',
      defaults: { READ: 'ALLOW', WRITE: 'ALLOW', EXECUTE: 'ALLOW', DANGEROUS: 'ALLOW' },
      allowedProjectExecutables: permissionProfiles.custom.allowedProjectExecutables,
    };
    const hostApproval = vi.fn(async () => true);
    const applyPatch = vi.fn(async () => ok({ paths: ['a.txt'] }));
    const capabilityExecute = vi.fn(async () => ok({ shown: true }));
    const registry = new ToolRegistry({
      file: { applyPatch } as unknown as McpApplicationServices['file'],
      capabilities: { execute: capabilityExecute },
    }, actor, {
      profileProvider: (): PermissionProfile => customAllow,
      hostMutationApprovalProvider: hostApproval,
    });

    await expect(registry.invoke('apply_patch', { workspaceId: 'workspace-1', files: [{ path: 'a.txt', content: 'next' }] })).resolves.not.toMatchObject({ isError: true });
    await expect(registry.invoke('notification', { title: 'Done', message: 'Finished' })).resolves.not.toMatchObject({ isError: true });
    expect(applyPatch).toHaveBeenCalledTimes(1);
    expect(capabilityExecute).toHaveBeenCalledTimes(1);
    expect(hostApproval).not.toHaveBeenCalled();
  });

  it('allows non-destructive git commands without confirmation', async () => {
    let executed = 0;
    const registry = new ToolRegistry({ git: { async run(): Promise<ReturnType<typeof ok>> { executed += 1; return ok({ exitCode: 0, stdout: '', stderr: '' }); } } }, actor);
    const response = await registry.invoke('git', { workspaceId: 'workspace-1', args: ['status', '--short'] });
    expect(response.isError).not.toBe(true);
    expect(executed).toBe(1);
  });

  it('requires explicit confirmation for every remote mutation, child MCP calls, and opaque shell commands', async () => {
    const calls: string[] = [];
    const registry = new ToolRegistry({
      capabilities: { async execute(tool): Promise<ReturnType<typeof ok>> { calls.push(tool); return ok({ ok: true }); } },
      extensions: { async callMcpTool(): Promise<ReturnType<typeof ok>> { calls.push('mcp_call'); return ok({ ok: true }); } } as McpApplicationServices['extensions'],
    }, actor, { profileProvider: (): PermissionProfile => permissionProfiles.balanced, hostMutationApprovalProvider: approveMutation });
    await expect(registry.invoke('web_fetch', { url: 'https://example.com/item/1', method: 'DELETE' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('web_fetch', { url: 'https://example.com/item/1', method: 'POST' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('web_fetch', { url: 'https://example.com/item/1', method: 'PUT' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    expect((await registry.invoke('shell', { operation: 'run', executable: 'npm.cmd', arguments: ['run', 'cleanup'] })).isError).not.toBe(true);
    await expect(registry.invoke('mcp_call', { server: 'child', tool: 'delete_file', arguments: { path: 'x' } })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    expect(calls).toEqual(['shell']);
    expect((await registry.invoke('web_fetch', { url: 'https://example.com/item/1', method: 'DELETE', userConfirmed: true })).isError).not.toBe(true);
    expect((await registry.invoke('shell', { operation: 'run', executable: 'npm.cmd', arguments: ['run', 'cleanup'], userConfirmed: true })).isError).not.toBe(true);
    expect((await registry.invoke('mcp_call', { server: 'child', tool: 'delete_file', arguments: { path: 'x' }, userConfirmed: true })).isError).not.toBe(true);
    expect(calls).toEqual(['shell', 'web_fetch', 'shell', 'mcp_call']);
  });

  it('marks Full Bypass calls in activity and bypasses special confirmation and application command scope gates', async () => {
    const events: ActivitySinkEvent[] = [];
    const calls: string[] = [];
    const authorizations: unknown[] = [];
    const capabilityInputs: unknown[] = [];
    const registry = new ToolRegistry({
      capabilities: { async execute(tool, input, _signal, authorization): Promise<ReturnType<typeof ok>> { calls.push(tool); capabilityInputs.push(input); authorizations.push(authorization); return ok({ ok: true }); } },
      extensions: { async callMcpTool(): Promise<ReturnType<typeof ok>> { calls.push('mcp_call'); return ok({ ok: true }); } } as McpApplicationServices['extensions'],
    }, actor, {
      profileProvider: (): PermissionProfile => permissionProfiles.full,
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
      activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope | null> => ({ workspaceId: 'workspace-a', rootPath: 'E:\\project-a' }),
      activity: { async record(event: ActivitySinkEvent): Promise<void> { events.push(event); } },
    });

    await expect(registry.invoke('mcp_call', { server: 'child', tool: 'delete_file', arguments: { path: 'x' } })).resolves.not.toMatchObject({ isError: true });
    await expect(registry.invoke('shell', { workspaceId: 'workspace-a', operation: 'run', executable: 'shutdown.exe', arguments: ['/s'], cwd: 'C:\\Windows' })).resolves.not.toMatchObject({ isError: true });
    await expect(registry.invoke('hook_register', { name: 'audit', event: 'beforeTool' })).resolves.not.toMatchObject({ isError: true });
    await expect(registry.invoke('hook_remove', { name: 'audit' })).resolves.toMatchObject({ structuredContent: { removed: true } });
    expect(calls).toEqual(['mcp_call', 'shell']);
    expect(capabilityInputs).toEqual([expect.not.objectContaining({ userConfirmed: true })]);
    expect(authorizations).toEqual([expect.objectContaining({ mode: 'full_bypass', applicationApproved: true, bypassApplicationAuthorization: true, source: 'full_bypass' })]);
    expect(events.filter((event) => event.phase === 'started')).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: 'mcp_call', authorizationMode: 'full_bypass' }),
      expect.objectContaining({ toolName: 'shell', authorizationMode: 'full_bypass' }),
    ]));
    expect(events.filter((event) => event.phase === 'completed')).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: 'mcp_call', resultCode: 'SUCCESS', authorizationMode: 'full_bypass' }),
      expect.objectContaining({ toolName: 'shell', resultCode: 'SUCCESS', authorizationMode: 'full_bypass' }),
    ]));
  });

  it('propagates Full Bypass through the real local capability dispatcher and shell backend', async () => {
    const activeRoot = await mkdtemp(path.join(tmpdir(), 'lnwjud-registry-active-'));
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'lnwjud-registry-outside-'));
    try {
      const noopBackend = { async execute(): Promise<ReturnType<typeof ok>> { return ok({}); } };
      const capabilities = new LocalCapabilityService({
        shell: new ShellCapabilityBackend({ allowedRoots: [activeRoot] }),
        domCdp: noopBackend,
        accessibility: noopBackend,
        inputEvent: noopBackend,
        vision: noopBackend,
        window: noopBackend,
        health: noopBackend,
      });
      const registry = new ToolRegistry({ capabilities }, actor, {
        profileProvider: (): PermissionProfile => permissionProfiles.full,
        authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
        activeWorkspaceScopeProvider: async (): Promise<WorkspaceScope | null> => ({ workspaceId: 'workspace-a', rootPath: activeRoot }),
      });

      await expect(registry.invoke('shell', {
        workspaceId: 'workspace-a',
        operation: 'run',
        executable: 'missing-command',
        arguments: [],
        cwd: outsideRoot,
        dry_run: true,
      })).resolves.toMatchObject({
        structuredContent: { dry_run: true, cwd: await realpath(outsideRoot) },
      });
    } finally {
      await Promise.all([
        rm(activeRoot, { recursive: true, force: true }),
        rm(outsideRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it('guards opaque execution and UI side-effect boundaries', async () => {
    const calls: string[] = [];
    const registry = new ToolRegistry({
      capabilities: { async execute(tool): Promise<ReturnType<typeof ok>> { calls.push(tool); return ok({ ok: true }); } },
      process: { async start(): Promise<ReturnType<typeof ok>> { calls.push('process_start'); return ok({ processId: 'p1' }); } } as McpApplicationServices['process'],
      codex: { async run(): Promise<ReturnType<typeof ok>> { calls.push('codex_run'); return ok({ codexTaskId: 'c1' }); } } as McpApplicationServices['codex'],
    }, actor, { codexToolsEnabled: true, profileProvider: (): PermissionProfile => permissionProfiles.balanced });
    await expect(registry.invoke('process_start', { workspaceId: 'workspace-1', executable: 'powershell', args: ['-Command', 'Remove-Item x.txt'] })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    for (const command of ['rm', 'del']) {
      await expect(registry.invoke('process_start', { workspaceId: 'workspace-1', executable: 'powershell', args: ['-Command', `${command} x.txt`] })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    }
    await expect(registry.invoke('codex_run', { workspaceId: 'workspace-1', instruction: 'edit the project' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('dom_cdp', { action: 'evaluate', tab_id: 'tab-1', parameters: { expression: 'fetch("/api/item/1", {method:"DELETE"})' } })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    await expect(registry.invoke('accessibility', { action: 'click', parameters: { name: 'button' } })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_REQUIRED' } } });
    expect(calls).toEqual([]);
  });
});
