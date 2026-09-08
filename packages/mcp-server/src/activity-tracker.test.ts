import { describe, expect, it } from 'vitest';
import { ActivityTracker, describeStructuredResultDetail, describeToolTarget, summarizeStructuredResultTarget, summarizeToolTarget, type ActivitySinkEvent } from './activity-tracker.js';

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

  it('publishes starts first but persists completion audit evidence before publishing idle', async () => {
    const order: string[] = [];
    const tracker = new ActivityTracker(
      { async record(event): Promise<void> { order.push(`compact:${event.phase}`); } },
      undefined,
      { async record(event): Promise<void> { order.push(`audit:${event.phase}`); } },
    );
    const callId = await tracker.begin('read_file', { path: 'src/app.ts' });
    await tracker.end(callId, 'SUCCESS', 1);
    expect(order).toEqual(['compact:started', 'audit:started', 'audit:completed', 'compact:completed']);
  });

  it('summarizes common and capability tool targets without leaking payloads', () => {
    expect(summarizeToolTarget('search_text', { query: 'hello' })).toBe('hello');
    expect(summarizeToolTarget('shell', { executable: 'node', arguments: ['-e', '1'] })).toBe('node -e 1');
    expect(summarizeToolTarget('git', { args: ['status', '--short'] })).toBe('git status --short');
    expect(summarizeToolTarget('git_status', { workspaceId: 'workspace-1' })).toBe('git status');
    expect(summarizeToolTarget('workspace_list', {})).toBe('list registered workspaces');
    expect(summarizeToolTarget('shell', { operation: 'result', task_id: '1234567890abcdef' })).toBe('shell:result task=1234567890abcdef');
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

  it('keeps full opaque identifiers and complete sanitized structured diagnostics', async () => {
    const workspaceId = '372e9384-9628-43be-b766-661cdb591383';
    const goalId = 'e27da685-745f-484c-86c8-235eb8cb42e5';
    expect(summarizeToolTarget('run_goal', { workspaceId, goalKey: 'activity-log-full-detail-no-truncation' }))
      .toBe(`goalKey=activity-log-full-detail-no-truncation workspace=${workspaceId}`);
    expect(summarizeToolTarget('get_goal', { goalId })).toBe(`goal=${goalId}`);

    const inputDetail = describeToolTarget('run_goal', {
      workspaceId,
      goalKey: 'activity-log-full-detail-no-truncation',
      objective: 'retain this complete diagnostic text',
      content: 'full text payload is retained',
      password: 'must-never-leak',
      image_base64: 'AAAA-BINARY-DATA',
    }).detail;
    expect(inputDetail?.kind).toBe('details');
    expect(inputDetail?.items).toContain(`workspaceId=${workspaceId}`);
    expect(inputDetail?.items).toContain('objective=retain this complete diagnostic text');
    expect(inputDetail?.items).toContain('content=full text payload is retained');
    expect(inputDetail?.items).toContain('password=[REDACTED]');
    expect(inputDetail?.items.some((item) => item.includes('image_base64=[binary payload omitted from activity log;'))).toBe(true);
    expect(JSON.stringify(inputDetail)).not.toContain('must-never-leak');
    expect(JSON.stringify(inputDetail)).not.toContain('AAAA-BINARY-DATA');

    const resultDetail = describeStructuredResultDetail({ goalId, status: 'active', leaseToken: 'top-secret', nested: { revision: 12 } });
    expect(resultDetail).toEqual({
      kind: 'details',
      items: [`goalId=${goalId}`, 'status=active', 'leaseToken=[REDACTED]', 'nested.revision=12'],
    });

    const auditDetails: unknown[] = [];
    const tracker = new ActivityTracker(undefined, undefined, {
      async record(_event, detail): Promise<void> { auditDetails.push(detail); },
    });
    const callId = await tracker.begin('run_goal', { workspaceId, goalKey: 'activity-log-full-detail-no-truncation' });
    await tracker.end(callId, 'SUCCESS', 4, undefined, resultDetail);
    expect(auditDetails[0]).toEqual(expect.objectContaining({ kind: 'details' }));
    expect(auditDetails[1]).toEqual(resultDetail);
  });

  it('marks only meaningful generic diagnostics as expandable', async () => {
    const workspaceId = '372e9384-9628-43be-b766-661cdb591383';
    const events: ActivitySinkEvent[] = [];
    const tracker = new ActivityTracker({ async record(event): Promise<void> { events.push(event); } });

    const simpleCall = await tracker.begin('list_goals', { workspaceId, userConfirmed: true });
    expect(tracker.listInFlight().find((entry) => entry.callId === simpleCall)?.targetDetail).toMatchObject({
      itemCount: 2,
      preview: [],
      hasAdditionalDetail: false,
    });
    await tracker.end(simpleCall, 'SUCCESS', 1, undefined, describeStructuredResultDetail({ goals: [] }));
    expect(events.at(-1)?.targetDetail).toMatchObject({ hasAdditionalDetail: true });

    const filteredCall = await tracker.begin('list_goals', { workspaceId, status: 'active', userConfirmed: true });
    expect(tracker.listInFlight().find((entry) => entry.callId === filteredCall)?.targetDetail).toMatchObject({
      preview: [],
      hasAdditionalDetail: true,
    });
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

  it('propagates tracestate and bounded redacted baggage while exposing per-tool telemetry', async () => {
    const events: ActivitySinkEvent[] = [];
    const tracker = new ActivityTracker({ async record(event): Promise<void> { events.push(event); } });
    const callId = await tracker.begin('tool_batch', {
      metadata: {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        tracestate: 'vendor=opaque',
        baggage: 'tenant=acme,api_key=super-secret,region=apac',
      },
    });
    await tracker.end(callId, 'SUCCESS', 20, undefined, { kind: 'details', items: ['results[0].ok=true', 'results[1].ok=false', 'results[1].error.code=FAILED'] });
    const snapshot = tracker.telemetrySnapshot();
    expect(snapshot).toMatchObject({ calls: 1, completed: 1, successes: 1, errors: 0, active: 0, p50LatencyMs: 20, p95LatencyMs: 20, maxLatencyMs: 20, batchPartialFailures: 1 });
    expect(snapshot.byTool.tool_batch).toMatchObject({ calls: 1, successes: 1, averageLatencyMs: 20, p95LatencyMs: 20 });
    expect(events[0]).toMatchObject({ traceState: 'vendor=opaque', baggage: 'tenant=acme,api_key=[redacted],region=apac' });
    expect(JSON.stringify(events)).not.toContain('super-secret');
  });

  it('keeps session identity on in-flight and completed activity events', async () => {
    const events: ActivitySinkEvent[] = [];
    const tracker = new ActivityTracker({ async record(event): Promise<void> { events.push(event); } });
    const callId = await tracker.begin('read_file', { workspaceId: 'ws-1', path: 'src/app.ts' }, { sessionId: 'session-a' });
    expect(tracker.listInFlight()[0]).toMatchObject({ sessionId: 'session-a', workspaceId: 'ws-1' });
    await tracker.end(callId, 'SUCCESS', 1);
    expect(events).toEqual([expect.objectContaining({ phase: 'started', sessionId: 'session-a' }), expect.objectContaining({ phase: 'completed', sessionId: 'session-a' })]);
  });

  it('preserves complete sanitized collection arguments while compact snapshots stay small', async () => {
    const fileInputs = [
      'src/alpha.ts',
      'src/alpha.ts',
      'เอกสาร/ไฟล์.ts',
      'src/api_key=super-secret.txt',
      'src/four.ts',
      'src/five.ts',
      'src/six.ts',
    ];
    const fileTarget = describeToolTarget('read_files', { files: fileInputs.map((path) => ({ path })) });
    expect(fileTarget.summary).toBe('src/alpha.ts, src/alpha.ts, เอกสาร/ไฟล์.ts');
    expect(fileTarget.detail).toEqual({
      kind: 'files',
      items: ['src/alpha.ts', 'src/alpha.ts', 'เอกสาร/ไฟล์.ts', 'src/api_key=[REDACTED]', 'src/four.ts', 'src/five.ts', 'src/six.ts'],
    });

    const toolTarget = describeToolTarget('tool_batch', {
      parallel: true,
      calls: [
        { tool: 'search_text', arguments: { query: 'first query', path: 'src' } },
        { tool: 'search_text', arguments: { query: 'second query', api_key: 'super-secret' } },
        { tool: 'search_all', arguments: { query: 'third query', maxResults: 50 } },
      ],
    });
    expect(toolTarget.summary).toBe('search_text + search_text + search_all');
    expect(toolTarget.detail).toEqual({
      kind: 'details',
      items: [
        'parallel=true',
        'calls[0].tool=search_text',
        'calls[0].arguments.query=first query',
        'calls[0].arguments.path=src',
        'calls[1].tool=search_text',
        'calls[1].arguments.query=second query',
        'calls[1].arguments.api_key=[REDACTED]',
        'calls[2].tool=search_all',
        'calls[2].arguments.query=third query',
        'calls[2].arguments.maxResults=50',
      ],
    });
    expect(JSON.stringify(toolTarget.detail)).not.toContain('super-secret');

    const events: ActivitySinkEvent[] = [];
    const tracker = new ActivityTracker({ async record(event): Promise<void> { events.push(event); } });
    const callId = await tracker.begin('read_files', { files: fileInputs.map((path) => ({ path })) });
    const inFlight = tracker.listInFlight()[0]!;
    expect(inFlight.targetDetail).toEqual({
      detailRef: callId,
      itemCount: 7,
      preview: ['src/alpha.ts', 'src/alpha.ts', 'เอกสาร/ไฟล์.ts'],
      hasAdditionalDetail: true,
      legacyIncomplete: false,
    });
    expect(inFlight).not.toHaveProperty('detail');
    await tracker.end(callId, 'SUCCESS', 1);
    expect(events).toHaveLength(2);
    expect(events[0]?.targetDetail).toEqual(inFlight.targetDetail);
    expect(events[1]?.targetDetail).toEqual(inFlight.targetDetail);
    expect(JSON.stringify(events)).not.toContain('(+');
    expect(JSON.stringify(events)).not.toContain('src/four.ts');
  });
});
