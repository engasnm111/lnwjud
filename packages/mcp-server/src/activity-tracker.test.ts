import { describe, expect, it } from 'vitest';
import { ActivityTracker, summarizeStructuredResultTarget, summarizeToolTarget, type ActivitySinkEvent } from './activity-tracker.js';

describe('ActivityTracker', () => {
  it('tracks in-flight calls and records started/completed sink events', async () => {
    const events: ActivitySinkEvent[] = [];
    const tracker = new ActivityTracker({
      async record(event): Promise<void> {
        events.push(event);
      },
    });

    const callId = await tracker.begin('read_file', { workspaceId: 'ws-1', path: 'src\\app.ts' });
    expect(tracker.listInFlight()).toHaveLength(1);
    expect(tracker.listInFlight()[0]).toMatchObject({
      callId,
      toolName: 'read_file',
      workspaceId: 'ws-1',
      targetSummary: 'src\\app.ts',
    });

    await tracker.end(callId, 'FILE_NOT_FOUND', 12, 'File or directory was not found');
    expect(tracker.listInFlight()).toHaveLength(0);
    expect(events).toEqual([
      expect.objectContaining({ phase: 'started', resultCode: 'STARTED', toolName: 'read_file' }),
      expect.objectContaining({ phase: 'completed', resultCode: 'FILE_NOT_FOUND', durationMs: 12, callId, resultMessage: 'File or directory was not found' }),
    ]);
  });

  it('reports activity sink failures without failing the tool lifecycle', async () => {
    const failures: string[] = [];
    const tracker = new ActivityTracker({
      async record(): Promise<void> {
        throw new Error('activity storage unavailable');
      },
    }, (error) => {
      failures.push(error instanceof Error ? error.message : String(error));
    });

    const callId = await tracker.begin('read_file', { path: 'src\\app.ts' });
    await expect(tracker.end(callId, 'SUCCESS', 2)).resolves.toBeUndefined();
    expect(failures).toEqual(['activity storage unavailable', 'activity storage unavailable']);
  });

  it('summarizes common and capability tool targets without leaking payloads', () => {
    expect(summarizeToolTarget('search_text', { query: 'hello' })).toBe('hello');
    expect(summarizeToolTarget('shell', { executable: 'node', arguments: ['-e', '1'] })).toBe('node -e 1');
    expect(summarizeToolTarget('git', { args: ['status', '--short'] })).toBe('git status --short');
    expect(summarizeToolTarget('git_status', { workspaceId: 'workspace-1' })).toBe('git status');
    expect(summarizeToolTarget('workspace_list', {})).toBe('list registered workspaces');
    expect(summarizeToolTarget('shell', { operation: 'result', task_id: '1234567890abcdef' })).toBe('shell:result task=12345678…cdef');
    expect(summarizeToolTarget('process_status', { processId: 'process-1' })).toBe('process=process-1');
    expect(summarizeToolTarget('move_file', { sourcePath: 'src/a.ts', destinationPath: 'src/b.ts' })).toBe('src/a.ts → src/b.ts');
    expect(summarizeToolTarget('web_fetch', { method: 'GET', url: 'https://example.com/api' })).toBe('GET https://example.com/api');
    expect(summarizeToolTarget('mcp_call', { server: 'child', tool: 'search', arguments: { secret: 'do-not-log' } })).toBe('child/search');
    expect(summarizeToolTarget('office', { app: 'excel', action: 'read', file_path: 'E:\\book.xlsx', values: { password: 'secret' } })).toBe('E:\\book.xlsx');
    expect(summarizeToolTarget('workspace_index', { workspaceId: 'workspace-1', rebuild: true })).toContain('rebuild=true');
    expect(summarizeToolTarget('dom_cdp', {
      action: 'navigate',
      tab_id: 'supabase-tab',
      parameters: { url: 'https://supabase.com/dashboard/project/sql' },
    })).toBe('dom_cdp:navigate tab=supabase-tab');
  });

  it('uses resolved command details for completion after a generic task start', async () => {
    const events: ActivitySinkEvent[] = [];
    const tracker = new ActivityTracker({ async record(event): Promise<void> { events.push(event); } });
    const callId = await tracker.begin('project_test', { workspaceId: 'ws-1' });
    tracker.updateTarget(callId, 'pnpm.cmd test --runInBand');
    expect(tracker.listInFlight()[0]?.targetSummary).toBe('pnpm.cmd test --runInBand');
    await tracker.end(callId, 'SUCCESS', 8);
    expect(events[0]?.targetSummary).toBe('project test');
    expect(events[1]?.targetSummary).toBe('pnpm.cmd test --runInBand');
  });

  it('extracts exact commands from structured process results', () => {
    expect(summarizeStructuredResultTarget({ processId: 'p1', executable: 'pnpm.cmd', args: ['test', '--runInBand'], cwd: 'E:\\app' })).toBe('pnpm.cmd test --runInBand');
    expect(summarizeStructuredResultTarget({ command: { executable: 'pnpm.cmd', args: ['typecheck'] } })).toBe('pnpm.cmd typecheck');
  });

  it('keeps long shell arguments copyable while redacting credential-like values', () => {
    const args = ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output', 'one', 'two', 'three', 'four', 'five', 'api_key=super-secret'];
    const summary = summarizeToolTarget('shell', { executable: 'powershell.exe', arguments: args });
    expect(summary).toContain('one two three four five');
    expect(summary).toContain('api_key=[redacted]');
    expect(summary).not.toContain('super-secret');
  });

  it('propagates bounded trace context into audit events and in-flight state', async () => {
    const events: ActivitySinkEvent[] = [];
    const tracker = new ActivityTracker({ async record(event): Promise<void> { events.push(event); } });

    const callId = await tracker.begin('wsl_exec', {
      metadata: { trace_id: 'trace-123', traceparent: '00-trace-123-span-456-01' },
      workspaceId: 'ws-1',
    });
    expect(tracker.listInFlight()[0]).toMatchObject({ traceId: 'trace-123', traceParent: '00-trace-123-span-456-01' });
    await tracker.end(callId, 'SUCCESS', 3);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ traceId: 'trace-123', traceParent: '00-trace-123-span-456-01' }),
    ]));
  });

  it('keeps session identity on in-flight and completed activity events', async () => {
    const events: ActivitySinkEvent[] = [];
    const tracker = new ActivityTracker({ async record(event): Promise<void> { events.push(event); } });
    const callId = await tracker.begin('read_file', { workspaceId: 'ws-1', path: 'src/app.ts' }, { sessionId: 'session-a' });
    expect(tracker.listInFlight()[0]).toMatchObject({ sessionId: 'session-a', workspaceId: 'ws-1' });
    await tracker.end(callId, 'SUCCESS', 1);
    expect(events).toEqual([expect.objectContaining({ phase: 'started', sessionId: 'session-a' }), expect.objectContaining({ phase: 'completed', sessionId: 'session-a' })]);
  });
});
