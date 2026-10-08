import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isProcessActivityTool, LogHub } from '../src/main/log-hub.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('LogHub', () => {
  it('starts only one live filesystem tail timer on repeated start and stops it on shutdown', () => {
    vi.useFakeTimers();
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    const before = vi.getTimerCount();
    hub.start();
    const first = vi.getTimerCount();
    hub.start();
    expect(first - before).toBe(1);
    expect(vi.getTimerCount()).toBe(first);
    hub.stop();
    expect(vi.getTimerCount()).toBe(before);
  });

  it('includes filesystem error messages in work-log lines', () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    hub.syncWorkLog([{
      id: '1',
      kind: 'error',
      toolName: 'write_file',
      resultCode: 'FILE_NOT_FOUND',
      errorMessage: 'File or directory was not found',
      targetSummary: 'docs\\plan.md',
    }], []);

    expect(hub.snapshot().lines[0]?.level).toBe('error');
    expect(hub.snapshot().lines[0]?.text).toContain('[RESULT] write_file FILE_NOT_FOUND — File or directory was not found');
  });

  it('treats recoverable control flow and generic diagnostic probes as notices, not errors', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-loghub-control-flow-'));
    temporaryRoots.push(root);
    const activityPath = path.join(root, 'mcp-activity.log');
    await writeFile(activityPath, [
      { callId: 'confirm', toolName: 'apply_patch', phase: 'completed', resultCode: 'PERMISSION_REQUIRED', resultMessage: 'explicit confirmation required' },
      { callId: 'conflict', toolName: 'edit_file', phase: 'completed', resultCode: 'CONFLICT', resultMessage: 'exact edit did not match' },
      { callId: 'scope', toolName: 'search_text', phase: 'completed', resultCode: 'PATH_OUTSIDE_WORKSPACE', resultMessage: 'outside workspace' },
      { callId: 'stale-status', toolName: 'process_status', phase: 'completed', resultCode: 'PROCESS_NOT_FOUND', resultMessage: 'Process was not found' },
      { callId: 'stale-shell', toolName: 'shell', phase: 'completed', resultCode: 'PERMISSION_DENIED', resultMessage: 'Task is not owned by this client session and workspace' },
      { callId: 'bad-goal-probe', toolName: 'get_scheduled_continuation', phase: 'completed', resultCode: 'INVALID_INPUT', resultMessage: 'Tool input is invalid' },
      { callId: 'stale-engineering', toolName: 'edit_file', phase: 'completed', resultCode: 'ENGINEERING_POLICY_CHANGED', resultMessage: 'The Engineering task binding scope is stale' },
      { callId: 'service-probe', toolName: 'service_context', phase: 'completed', resultCode: 'INTERNAL_ERROR', resultMessage: 'Operation failed' },
      { callId: 'process-probe', toolName: 'process_context', phase: 'completed', resultCode: 'INTERNAL_ERROR', resultMessage: 'Operation failed' },
      { callId: 'bad-task-probe', toolName: 'task_create', phase: 'completed', resultCode: 'INVALID_INPUT', resultMessage: "Executable 'echo noop' was not found" },
      { callId: 'real-error', toolName: 'write_file', phase: 'completed', resultCode: 'FILE_NOT_FOUND', resultMessage: 'File was not found' },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');

    const hub = new LogHub({ tunnelLogPath: path.join(root, 'missing-tunnel.log'), mcpActivityLogPath: activityPath });
    hub.start();
    await vi.advanceTimersByTimeAsync(700);
    hub.stop();

    const lines = hub.snapshot().lines.filter((line) => line.source === 'mcp');
    const byCall = (callId: string): (typeof lines)[number] | undefined => lines.find((line) => line.correlation?.kind === 'mcp' && line.correlation.callId === callId);
    for (const callId of ['confirm', 'conflict', 'scope', 'stale-status', 'stale-shell', 'bad-goal-probe', 'stale-engineering', 'service-probe', 'process-probe', 'bad-task-probe']) {
      expect(byCall(callId)?.level).toBe('warn');
      expect(byCall(callId)?.text).toContain('[RESULT]');
    }
    expect(byCall('real-error')?.level).toBe('error');
    expect(byCall('real-error')?.text).toContain('[RESULT]');
  });

  it('feeds and snapshots lines per source with dedupe', () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    hub.feedIfNew('mcp', 'a', 'info', 'first');
    hub.feedIfNew('mcp', 'a', 'info', 'duplicate');
    hub.feedIfNew('mcp', 'b', 'error', 'second');
    hub.feed('process', 'info', 'proc line');

    const snapshot = hub.snapshot();
    expect(snapshot.lines).toHaveLength(3);
    expect(snapshot.lines.map((line) => line.text)).toEqual(['first', 'second', 'proc line']);
    expect(snapshot.tunnelLogExists).toBe(false);
    const telemetry = hub.telemetrySnapshot();
    expect(telemetry.totalLines).toBe(3);
    expect(telemetry.totalRetainedBytes).toBeGreaterThan(0);
    expect(telemetry.sources.mcp).toMatchObject({ lines: 2, seenKeys: 2 });
    expect(telemetry.sources.process.lines).toBe(1);
  });

  it('removes terminal control sequences before logs reach the UI or exports', () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    hub.feed('process', 'info', '\u001b[33mwarning\u001b[22m\u001b[39m \u001b]8;;https://example.test\u0007link\u001b]8;;\u0007');
    hub.feed('process', 'info', '🙂'.repeat(3_000));

    expect(hub.snapshot().lines[0]?.text).toBe('warning link');
    expect(Buffer.byteLength(hub.snapshot().lines[1]?.text ?? '', 'utf8')).toBe(8_192);
    expect(hub.snapshot().lines[1]?.text).not.toContain('�');
  });

  it('bounds retained log payload bytes per source', () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    for (let index = 0; index < 1_100; index += 1) hub.feed('process', 'info', `${index}:${'x'.repeat(8_192)}`);

    const lines = hub.snapshot().lines;
    expect(lines.reduce((bytes, line) => bytes + Buffer.byteLength(JSON.stringify(line), 'utf8'), 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(lines.at(-1)?.text).toContain('1099:');
    expect(lines[0]?.text).not.toMatch(/^0:/);
  });

  it('clears a single source', () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    hub.feed('tunnel', 'info', 't1');
    hub.feed('mcp', 'info', 'm1');

    hub.clear('tunnel');

    const snapshot = hub.snapshot();
    expect(snapshot.lines.map((line) => line.source)).toEqual(['mcp']);
  });

  it('clears only the requested MCP workspace/session scope', () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    const timestamp = '2026-08-20T00:00:01.000Z';
    hub.syncWorkLog([
      { id: 'a', timestamp, kind: 'result', toolName: 'read_file', resultCode: 'SUCCESS', targetSummary: null, workspaceId: 'ws-a', sessionId: 'session-a' },
      { id: 'b', timestamp, kind: 'result', toolName: 'read_file', resultCode: 'SUCCESS', targetSummary: null, workspaceId: 'ws-a', sessionId: 'session-b' },
      { id: 'c', timestamp, kind: 'result', toolName: 'read_file', resultCode: 'SUCCESS', targetSummary: null, workspaceId: 'ws-b', sessionId: 'session-c' },
    ], []);

    hub.clear('mcp', { workspaceId: 'ws-a', sessionId: 'session-a' });
    expect(hub.snapshot().lines.filter((line) => line.source === 'mcp').map((line) => [line.workspaceId, line.sessionId])).toEqual([
      ['ws-a', 'session-b'],
      ['ws-b', 'session-c'],
    ]);

    hub.clear('mcp', { workspaceId: 'ws-a' });
    expect(hub.snapshot().lines.filter((line) => line.source === 'mcp').map((line) => [line.workspaceId, line.sessionId])).toEqual([
      ['ws-b', 'session-c'],
    ]);
  });

  it('tails an appended tunnel log file', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-loghub-'));
    temporaryRoots.push(root);
    const logPath = path.join(root, 'lnwjud-tunnel.log');
    await writeFile(logPath, '{"level":"info","msg":"boot"}\n', 'utf8');
    const hub = new LogHub({ tunnelLogPath: logPath });
    hub.start();
    await vi.advanceTimersByTimeAsync(700);
    expect(hub.snapshot().lines.map((line) => line.text)).toContain('boot');

    await appendFile(logPath, 'plain text line\n{"level":"error","msg":"boom"}\n', 'utf8');
    await vi.advanceTimersByTimeAsync(700);
    hub.stop();
    const texts = hub.snapshot().lines.map((line) => line.text);
    expect(texts).toContain('plain text line');
    expect(texts).toContain('boom');
    expect(hub.snapshot().lines.find((line) => line.text === 'boom')?.level).toBe('error');
  });

  it('keeps tunnel-client event times when replaying prior sessions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-loghub-tunnel-time-'));
    temporaryRoots.push(root);
    const logPath = path.join(root, 'lnwjud-tunnel.log');
    const eventTime = '2026-09-24T23:37:10.5453473+07:00';
    await writeFile(logPath, `${JSON.stringify({
      time: eventTime,
      level: 'INFO',
      msg: '🌐 WEB UI: http://127.0.0.1:49629/ui',
    })}\n`, 'utf8');

    const hub = new LogHub({ tunnelLogPath: logPath });
    hub.start();
    hub.stop();

    expect(hub.snapshot().lines).toHaveLength(1);
    expect(hub.snapshot().lines[0]?.timestamp).toBe(eventTime);
  });

  it('replays the bounded startup tail in one sync instead of waiting through 64 KiB polling chunks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-loghub-startup-tail-'));
    temporaryRoots.push(root);
    const logPath = path.join(root, 'lnwjud-tunnel.log');
    const rows = Array.from({ length: 128 }, (_, index) => JSON.stringify({
      level: 'info',
      msg: `${index}:${'x'.repeat(900)}`,
    }));
    await writeFile(logPath, `${rows.join('\n')}\n`, 'utf8');

    const hub = new LogHub({ tunnelLogPath: logPath });
    hub.start();
    const texts = hub.snapshot().lines.map((line) => line.text);
    hub.stop();

    expect(Buffer.byteLength(await readFile(logPath), 'utf8')).toBeGreaterThan(64 * 1024);
    expect(texts).toContain(`127:${'x'.repeat(900)}`);
  });

  it('can start a fresh visible session without replaying existing tunnel history', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-loghub-fresh-session-'));
    temporaryRoots.push(root);
    const logPath = path.join(root, 'lnwjud-tunnel.log');
    await writeFile(logPath, '{"level":"info","msg":"old session"}\n', 'utf8');

    const hub = new LogHub({ tunnelLogPath: logPath });
    hub.start({ skipExisting: true });
    expect(hub.snapshot().lines).toHaveLength(0);

    await appendFile(logPath, '{"level":"info","msg":"current session"}\n', 'utf8');
    await vi.advanceTimersByTimeAsync(700);
    hub.stop();

    expect(hub.snapshot().lines.map((line) => line.text)).toEqual(['current session']);
  });

  it('normalizes structured tunnel lifecycle fields into bounded categories', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-loghub-lifecycle-'));
    temporaryRoots.push(root);
    const logPath = path.join(root, 'lnwjud-tunnel.log');
    await writeFile(logPath, [
      { level: 'warn', event: 'ttl_limit_exceeded', msg: 'retrying later' },
      { status: 'STDIO.MCP-CLOSED', message: 'display text is neutral' },
      { reason: 'control-plane connection disconnected', msg: 'display text is neutral' },
      { status: 'DISCONNECTED', msg: 'display text is neutral' },
      { status: 'CONNECTED', msg: 'display text is neutral' },
      { event: 'documentation_loaded', msg: 'shutdown documentation loaded' },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');

    const hub = new LogHub({ tunnelLogPath: logPath });
    hub.start();
    await vi.advanceTimersByTimeAsync(700);
    hub.stop();

    expect(hub.snapshot().lines.map((line) => line.correlation)).toEqual([
      expect.objectContaining({ kind: 'tunnel', lifecycle: 'ttl_expired' }),
      expect.objectContaining({ kind: 'tunnel', lifecycle: 'stdio_stopped' }),
      expect.objectContaining({ kind: 'tunnel', lifecycle: 'transport_stopped' }),
      expect.objectContaining({ kind: 'tunnel', lifecycle: 'transport_stopped' }),
      expect.objectContaining({ kind: 'tunnel', lifecycle: 'transport_live' }),
      expect.objectContaining({ kind: 'tunnel', lifecycle: 'other' }),
    ]);
  });

  it('keeps a tunnel log line intact when it crosses a read chunk boundary', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-loghub-boundary-'));
    temporaryRoots.push(root);
    const logPath = path.join(root, 'lnwjud-tunnel.log');
    const message = 'x'.repeat(70_000);
    await writeFile(logPath, `${JSON.stringify({ level: 'info', msg: message })}\n`, 'utf8');

    const hub = new LogHub({ tunnelLogPath: logPath });
    hub.start();
    await vi.advanceTimersByTimeAsync(700);
    hub.stop();

    const lines = hub.snapshot().lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe(message.slice(0, 8_192));
  });

  it('bounds an unterminated tailed record while waiting for a newline', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-loghub-pending-'));
    temporaryRoots.push(root);
    const logPath = path.join(root, 'lnwjud-tunnel.log');
    await writeFile(logPath, 'x'.repeat(200_000), 'utf8');

    const hub = new LogHub({ tunnelLogPath: logPath });
    hub.start();
    await vi.advanceTimersByTimeAsync(2_000);
    const pending = (hub as unknown as { tunnelFile: { pending: string } }).tunnelFile.pending;
    hub.stop();

    expect(Buffer.byteLength(pending, 'utf8')).toBeLessThanOrEqual(8_192);
  });

  it('tails MCP activity NDJSON into the mcp source without waiting for getDashboard', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-loghub-mcp-'));
    temporaryRoots.push(root);
    const activityPath = path.join(root, 'mcp-activity.log');
    await writeFile(activityPath, `${JSON.stringify({
      callId: 'c1',
      toolName: 'read_file',
      phase: 'started',
      resultCode: 'STARTED',
      targetSummary: 'src\\\\app.ts',
    })}\n`, 'utf8');
    const hub = new LogHub({
      tunnelLogPath: path.join(root, 'missing-tunnel.log'),
      mcpActivityLogPath: activityPath,
    });
    hub.start();
    await vi.advanceTimersByTimeAsync(700);
    expect(hub.snapshot().lines.some((line) => line.source === 'mcp' && line.text.includes('read_file'))).toBe(true);

    await appendFile(activityPath, `${JSON.stringify({
      callId: 'c1',
      toolName: 'read_file',
      phase: 'completed',
      resultCode: 'SUCCESS',
      targetSummary: 'src\\\\app.ts',
    })}\n`, 'utf8');
    await vi.advanceTimersByTimeAsync(700);
    hub.stop();
    const mcpTexts = hub.snapshot().lines.filter((line) => line.source === 'mcp').map((line) => line.text);
    expect(mcpTexts.some((text) => text.includes('[RESULT] read_file SUCCESS'))).toBe(true);
  });

  it('surfaces and dedupes tailing errors instead of silently dropping them', async () => {
    vi.useFakeTimers();
    const invalidPath = '\0invalid-log-path';
    const hub = new LogHub({ tunnelLogPath: invalidPath });
    hub.start();
    await vi.advanceTimersByTimeAsync(1_200);
    hub.stop();

    const errors = hub.snapshot().lines.filter((line) => line.source === 'tunnel' && line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.text).toContain('Unable to tail log file');
  });

  it('keeps distinct authoritative work-log entries sharing callId, phase, and timestamp', () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    const sameTimestamp = '2026-08-20T00:00:01.000Z';
    hub.syncWorkLog([
      { id: 'audit-1', timestamp: sameTimestamp, callId: 'reused', kind: 'task', toolName: 'read_file', resultCode: 'STARTED', targetSummary: null },
      { id: 'audit-2', timestamp: sameTimestamp, callId: 'reused', kind: 'task', toolName: 'write_file', resultCode: 'STARTED', targetSummary: null },
    ], []);

    expect(hub.snapshot().lines.filter((line) => line.source === 'mcp').map((line) => line.correlation)).toEqual([
      expect.objectContaining({ kind: 'mcp', phase: 'started', callId: 'reused', toolName: 'read_file' }),
      expect.objectContaining({ kind: 'mcp', phase: 'started', callId: 'reused', toolName: 'write_file' }),
    ]);
  });

  it('dedupes an exact replay by stable authoritative entry ID', () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    hub.syncWorkLog([{
      id: 'audit-1',
      timestamp: '2026-08-20T00:00:01.000Z',
      callId: 'c1',
      kind: 'result',
      toolName: 'read_file',
      resultCode: 'SUCCESS',
      errorMessage: null,
      targetSummary: 'src\\app.ts',
    }], []);
    hub.syncWorkLog([{
      id: 'audit-1',
      timestamp: '2026-08-20T00:00:01.000Z',
      callId: 'c1',
      kind: 'result',
      toolName: 'read_file',
      resultCode: 'SUCCESS',
      errorMessage: null,
      targetSummary: 'src\\app.ts',
    }], []);
    expect(hub.snapshot().lines).toHaveLength(1);
  });

  it('merges one start observed through both work-log and in-flight views', () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    const startedAt = '2026-08-20T00:00:01.000Z';
    hub.syncWorkLog(
      [{ id: 'audit-start', timestamp: startedAt, callId: 'same', kind: 'task', toolName: 'read_file', resultCode: 'STARTED', targetSummary: null }],
      [{ callId: 'same', toolName: 'read_file', targetSummary: null, startedAt }],
    );
    hub.syncWorkLog([], [{ callId: 'same', toolName: 'read_file', targetSummary: null, startedAt }]);

    expect(hub.snapshot().lines.filter((line) => line.source === 'mcp')).toHaveLength(1);
  });

  it('keeps different in-flight call IDs that start in the same millisecond', () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    const startedAt = '2026-08-20T00:00:01.000Z';
    hub.syncWorkLog([], [
      { callId: 'first', toolName: 'read_file', targetSummary: null, startedAt },
      { callId: 'second', toolName: 'write_file', targetSummary: null, startedAt },
    ]);

    expect(hub.snapshot().lines.filter((line) => line.source === 'mcp').map((line) => line.correlation)).toEqual([
      expect.objectContaining({ kind: 'mcp', callId: 'first' }),
      expect.objectContaining({ kind: 'mcp', callId: 'second' }),
    ]);
  });


  it('keeps identical MCP occurrences from different sessions distinct', () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    const timestamp = '2026-08-20T00:00:01.000Z';
    hub.syncWorkLog([
      { id: 'audit-a', timestamp, callId: 'same-call', kind: 'task', toolName: 'read_file', resultCode: 'STARTED', targetSummary: null, workspaceId: 'ws-1', sessionId: 'session-a' },
      { id: 'audit-b', timestamp, callId: 'same-call', kind: 'task', toolName: 'read_file', resultCode: 'STARTED', targetSummary: null, workspaceId: 'ws-1', sessionId: 'session-b' },
    ], []);

    const lines = hub.snapshot().lines.filter((line) => line.source === 'mcp');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => [line.workspaceId, line.sessionId])).toEqual([
      ['ws-1', 'session-a'],
      ['ws-1', 'session-b'],
    ]);
  });

  it('parses workspace/session scope from MCP activity NDJSON', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-loghub-mcp-scope-'));
    temporaryRoots.push(root);
    const activityPath = path.join(root, 'mcp-activity.log');
    await writeFile(activityPath, `${JSON.stringify({
      callId: 'scope-call', toolName: 'read_file', phase: 'completed', resultCode: 'SUCCESS',
      workspaceId: 'workspace-a', sessionId: 'session-a', timestamp: '2026-08-20T00:00:01.000Z',
    })}
`, 'utf8');
    const hub = new LogHub({ tunnelLogPath: path.join(root, 'missing-tunnel.log'), mcpActivityLogPath: activityPath });
    hub.start();
    await vi.advanceTimersByTimeAsync(700);
    hub.stop();

    expect(hub.snapshot().lines).toContainEqual(expect.objectContaining({
      source: 'mcp', workspaceId: 'workspace-a', sessionId: 'session-a',
    }));
  });

  it('mirrors real Agent process tools into the Processes live-log source', () => {
    expect(isProcessActivityTool('shell')).toBe(true);
    expect(isProcessActivityTool('process_start')).toBe(true);
    expect(isProcessActivityTool('task_status')).toBe(true);
    expect(isProcessActivityTool('project_build')).toBe(true);
    expect(isProcessActivityTool('verify_incremental')).toBe(true);
    expect(isProcessActivityTool('read_file')).toBe(false);

    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    hub.syncWorkLog([
      {
        id: 'shell-start', timestamp: '2026-09-02T00:00:01.000Z', callId: 'shell-call', kind: 'task', toolName: 'shell', resultCode: 'STARTED', targetSummary: 'pnpm test', workspaceId: 'workspace-a', sessionId: 'session-a',
      },
      {
        id: 'shell-result', timestamp: '2026-09-02T00:00:02.000Z', callId: 'shell-call', kind: 'result', toolName: 'shell', resultCode: 'SUCCESS', targetSummary: 'pnpm test', workspaceId: 'workspace-a', sessionId: 'session-a',
      },
      {
        id: 'read-result', timestamp: '2026-09-02T00:00:03.000Z', callId: 'read-call', kind: 'result', toolName: 'read_file', resultCode: 'SUCCESS', targetSummary: 'README.md', workspaceId: 'workspace-a', sessionId: 'session-a',
      },
    ], []);

    const processLines = hub.snapshot().lines.filter((line) => line.source === 'process');
    expect(processLines).toHaveLength(2);
    expect(processLines.map((line) => line.text)).toEqual([
      expect.stringContaining('[TASK] shell STARTED'),
      expect.stringContaining('[RESULT] shell SUCCESS'),
    ]);
    expect(processLines.every((line) => line.workspaceId === 'workspace-a' && line.sessionId === 'session-a')).toBe(true);
    expect(processLines.every((line) => line.correlation?.kind === 'mcp' && line.correlation.toolName === 'shell')).toBe(true);
  });

  it('tails process-related MCP activity directly into Processes without waiting for dashboard sync', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-loghub-process-live-'));
    temporaryRoots.push(root);
    const activityPath = path.join(root, 'mcp-activity.log');
    await writeFile(activityPath, `${JSON.stringify({
      callId: 'process-live', toolName: 'shell', phase: 'completed', resultCode: 'SUCCESS',
      workspaceId: 'workspace-a', sessionId: 'session-a', timestamp: '2026-09-02T00:00:01.000Z', targetSummary: 'pnpm lint',
    })}\n`, 'utf8');
    const hub = new LogHub({ tunnelLogPath: path.join(root, 'missing-tunnel.log'), mcpActivityLogPath: activityPath });
    hub.start();
    await vi.advanceTimersByTimeAsync(700);
    hub.stop();

    expect(hub.snapshot().lines).toContainEqual(expect.objectContaining({
      source: 'process', workspaceId: 'workspace-a', sessionId: 'session-a',
      correlation: expect.objectContaining({ kind: 'mcp', toolName: 'shell', phase: 'completed' }),
    }));
  });

  it('keeps tunnel logs global and process logs workspace scoped', () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    hub.feed('tunnel', 'info', 'connected');
    hub.syncProcesses([{
      id: 'process-1', workspaceId: 'workspace-a', sessionId: null,
      executable: 'node', args: ['server.js'], state: 'running', logSummary: '',
    }]);

    const [tunnel, processLine] = hub.snapshot().lines;
    expect(tunnel).toMatchObject({ source: 'tunnel', workspaceId: null, sessionId: null });
    expect(processLine).toMatchObject({ source: 'process', workspaceId: 'workspace-a', sessionId: null });
  });

  it('retains the newest 10,000 lines per source instead of dropping recent activity too early', () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log' });
    for (let index = 0; index < 10_005; index += 1) {
      hub.feed('mcp', 'info', `line-${index}`);
    }
    const lines = hub.snapshot().lines.filter((line) => line.source === 'mcp');
    expect(lines).toHaveLength(10_000);
    expect(lines[0]?.text).toBe('line-5');
    expect(lines.at(-1)?.text).toBe('line-10004');
  });

  it('notifies subscribers of new lines', () => {
    const onLine = vi.fn();
    const hub = new LogHub({ tunnelLogPath: 'Z:\\missing\\lnwjud-tunnel.log', onLine });
    hub.feed('tunnel', 'warn', 'watch out');
    expect(onLine).toHaveBeenCalledWith(expect.objectContaining({ source: 'tunnel', level: 'warn', text: 'watch out' }));
  });
});
