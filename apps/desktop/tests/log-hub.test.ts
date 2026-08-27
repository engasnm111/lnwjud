import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogHub } from '../src/main/log-hub.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('LogHub', () => {
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

    expect(hub.snapshot().lines[0]?.text).toContain('[ERROR] write_file FILE_NOT_FOUND — File or directory was not found');
  });

  it('treats confirmation requests and stale process reads as notices, not errors', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-loghub-control-flow-'));
    temporaryRoots.push(root);
    const activityPath = path.join(root, 'mcp-activity.log');
    await writeFile(activityPath, [
      { callId: 'confirm', toolName: 'apply_patch', phase: 'completed', resultCode: 'PERMISSION_REQUIRED', resultMessage: 'explicit confirmation required' },
      { callId: 'stale-status', toolName: 'process_status', phase: 'completed', resultCode: 'PROCESS_NOT_FOUND', resultMessage: 'Process was not found' },
      { callId: 'real-error', toolName: 'write_file', phase: 'completed', resultCode: 'FILE_NOT_FOUND', resultMessage: 'File was not found' },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');

    const hub = new LogHub({ tunnelLogPath: path.join(root, 'missing-tunnel.log'), mcpActivityLogPath: activityPath });
    hub.start();
    await vi.advanceTimersByTimeAsync(700);
    hub.stop();

    const lines = hub.snapshot().lines.filter((line) => line.source === 'mcp');
    expect(lines.find((line) => line.text.includes('apply_patch'))?.level).toBe('info');
    expect(lines.find((line) => line.text.includes('process_status'))?.level).toBe('info');
    expect(lines.find((line) => line.text.includes('write_file'))?.level).toBe('error');
    expect(lines.find((line) => line.text.includes('apply_patch'))?.text).toContain('[RESULT]');
    expect(lines.find((line) => line.text.includes('process_status'))?.text).toContain('[RESULT]');
    expect(lines.find((line) => line.text.includes('write_file'))?.text).toContain('[ERROR]');
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
