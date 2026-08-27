import { describe, expect, it } from 'vitest';
import { LogHub } from '../src/main/log-hub.js';

describe('LogHub clear semantics', () => {
  it('keeps process dedupe state so cleared historical entries do not reappear', () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:/missing-lnwjud-tunnel.log' });
    hub.feedIfNew('process', 'process:1:running:first', 'info', 'first');
    expect(hub.snapshot().lines.map((line) => line.text)).toEqual(['first']);

    hub.clear('process');
    hub.feedIfNew('process', 'process:1:running:first', 'info', 'first');
    expect(hub.snapshot().lines).toHaveLength(0);

    hub.feedIfNew('process', 'process:1:exited:done', 'info', 'done');
    expect(hub.snapshot().lines.map((line) => line.text)).toEqual(['done']);
  });

  it('keeps MCP delivery cursors so a cleared work-log entry stays cleared', () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:/missing-lnwjud-tunnel.log' });
    const first = { id: 'audit-1', timestamp: '2026-08-22T00:00:00.000Z', kind: 'result' as const, toolName: 'read_file', resultCode: 'SUCCESS', errorMessage: null, targetSummary: 'a', durationMs: 1, workspaceId: 'w' };
    hub.syncWorkLog([first], []);
    expect(hub.snapshot().lines).toHaveLength(1);

    hub.clear('mcp');
    hub.syncWorkLog([first], []);
    expect(hub.snapshot().lines).toHaveLength(0);

    hub.syncWorkLog([first, { ...first, id: 'audit-2', timestamp: '2026-08-22T00:00:01.000Z', targetSummary: 'b' }], []);
    expect(hub.snapshot().lines).toHaveLength(1);
  });

  it('clears legacy slash/case workspace aliases when the registered project is selected', () => {
    const hub = new LogHub({ tunnelLogPath: 'Z:/missing-lnwjud-tunnel.log' });
    const workspaces = [
      { id: 'lnwjud-project', displayName: 'lnwjud', rootPath: 'E:\\lnwjud', realRootPath: 'E:\\lnwjud', createdAt: '2026-08-01T00:00:00.000Z' },
    ];
    hub.feedIfNew('mcp', 'slash', 'info', 'slash', undefined, undefined, { workspaceId: 'e:/LNWJUD/' });
    hub.feedIfNew('mcp', 'backslash', 'info', 'backslash', undefined, undefined, { workspaceId: 'E:\\lnwjud' });
    hub.feedIfNew('mcp', 'other', 'info', 'other', undefined, undefined, { workspaceId: 'E:\\other' });

    hub.clear('mcp', { workspaceId: 'lnwjud-project' }, workspaces);
    expect(hub.snapshot().lines.map((line) => line.text)).toEqual(['other']);
  });
});
