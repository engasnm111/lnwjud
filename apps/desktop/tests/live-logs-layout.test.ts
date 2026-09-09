import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LiveLogsPage } from '../src/renderer/features/live/LiveLogsPage.js';
import { filterLogLinesByScope, formatLogCopyText, logDisplayParts, LogStreamPanel, visibleLogLines } from '../src/renderer/features/live/LogStreamPanel.js';
import * as logStreamPanelModule from '../src/renderer/features/live/LogStreamPanel.js';
import { StandaloneLogViewer } from '../src/renderer/features/live/StandaloneLogViewer.js';

const noop = async (): Promise<void> => undefined;

describe('viewport-sized log and list layout', () => {
  it('keeps only the newest normalized hidden-detail search result during an async race', async () => {
    const createState = (logStreamPanelModule as unknown as { createDetailSearchState?: () => unknown }).createDetailSearchState;
    const reduce = (logStreamPanelModule as unknown as { reduceDetailSearchState?: (state: unknown, action: unknown) => unknown }).reduceDetailSearchState;
    const activeIds = (logStreamPanelModule as unknown as { activeDetailMatchIds?: (state: unknown, query: string) => ReadonlySet<string> }).activeDetailMatchIds;
    expect(typeof reduce).toBe('function');
    let state = createState!();
    const first = deferred<readonly string[]>();
    const second = deferred<readonly string[]>();
    const run = async (generation: number, query: string, result: Promise<readonly string[]>): Promise<void> => {
      state = reduce!(state, { type: 'start', generation, query });
      const matchingIds = await result;
      state = reduce!(state, { type: 'success', generation, query, matchingIds });
    };
    const firstRun = run(1, 'first', first.promise);
    const secondRun = run(2, ' SECOND ', second.promise);
    second.resolve(['line:2']);
    await secondRun;
    first.resolve(['line:1']);
    await firstRun;

    const currentMatches = activeIds!(state, 'second');
    expect([...currentMatches]).toEqual(['line:2']);
    expect(activeIds!(state, 'first').size).toBe(0);
    expect(visibleLogLines([
      { id: 1, source: 'mcp', timestamp: '2026-08-30T00:00:01.000Z', level: 'info', text: 'unrelated-one', workspaceId: null, sessionId: null },
      { id: 2, source: 'mcp', timestamp: '2026-08-30T00:00:02.000Z', level: 'info', text: 'unrelated-two', workspaceId: null, sessionId: null },
    ], { workspaceId: null, sessionId: null }, 'second', [], currentMatches).map((line) => line.id)).toEqual([2]);
  });

  it('labels tunnel logs as OAuth when OAuth authentication is active', () => {
    const embedded = renderToStaticMarkup(createElement(LiveLogsPage, {
      locale: 'en', lines: [], tunnelLogPath: null, tunnelLogExists: false,
      tunnelAuth: {
        mode: 'oauth', authReady: true, runtimeCredentialAvailable: true, hasLegacyApiKey: true,
        accountLabel: 'oauth@example.test', organizationId: null, workspaceId: null, expiresAt: null,
        requiresUserAction: false, message: null,
      },
      onClear: noop, onClearAll: noop, onExport: noop, onPopOut: noop, onCaptureIncident: noop,
      incidentBusy: false, incidentClassification: null, incidentCapturedAt: null, incidentNotice: null, workspaces: [],
    }));
    expect(embedded).toContain('OAuth / Tunnel');
    expect(embedded).toContain('Real-time OAuth session, Secure Tunnel transport, MCP activity, and process logs');
    expect(embedded).not.toContain('Real-time tunnel, MCP activity, and process logs');
  });

  it('marks both embedded and pop-out viewers with dedicated fixed viewport containers', () => {
    const embedded = renderToStaticMarkup(createElement(LiveLogsPage, {
      locale: 'en', lines: [], tunnelLogPath: null, tunnelLogExists: false,
      onClear: noop, onClearAll: noop, onExport: noop, onPopOut: noop, onCaptureIncident: noop,
      incidentBusy: false, incidentClassification: null, incidentCapturedAt: null, incidentNotice: null, workspaces: [],
    }));
    const standalone = renderToStaticMarkup(createElement(StandaloneLogViewer));

    expect(embedded).toContain('class="page-content live-logs-page"');
    expect(standalone).toContain('class="window-container log-viewer-window"');
  });

  it('renders newest log lines first regardless of arrival order', () => {
    const markup = renderToStaticMarkup(createElement(LogStreamPanel, {
      source: 'mcp',
      title: 'MCP',
      lines: [
        { id: 1, source: 'mcp', timestamp: '2026-08-22T00:00:01.000Z', level: 'info', text: 'old-line', workspaceId: 'ws-a', sessionId: 'session-a' },
        { id: 3, source: 'mcp', timestamp: '2026-08-22T00:00:03.000Z', level: 'info', text: 'new-line', workspaceId: 'ws-a', sessionId: 'session-a' },
        { id: 2, source: 'mcp', timestamp: '2026-08-22T00:00:02.000Z', level: 'info', text: 'middle-line', workspaceId: 'ws-a', sessionId: 'session-a' },
      ],
      filterPlaceholder: 'filter', pauseLabel: 'pause', followLabel: 'follow', clearLabel: 'clear', clearSessionLabel: 'clear session', clearWorkspaceLabel: 'clear workspace', exportLabel: 'export',
      onClear: noop, onExport: noop,
    }));
    expect(markup.indexOf('new-line')).toBeLessThan(markup.indexOf('middle-line'));
    expect(markup.indexOf('middle-line')).toBeLessThan(markup.indexOf('old-line'));
  });

  it('splits MCP task/result markers into their own colored column and keeps full text copyable', () => {
    const task = { id: 10, source: 'mcp' as const, timestamp: '2026-08-22T00:00:10.000Z', level: 'info' as const, workspaceId: 'ws-a', sessionId: 'session-a', text: '[TASK] shell STARTED callId=abc — powershell -NoProfile -NonInteractive -Command Write-Output full-command' };
    const result = { id: 11, source: 'mcp' as const, timestamp: '2026-08-22T00:00:11.000Z', level: 'info' as const, workspaceId: 'ws-a', sessionId: 'session-a', text: '[RESULT] shell SUCCESS callId=abc — powershell -NoProfile -NonInteractive -Command Write-Output full-command' };
    expect(logDisplayParts(task)).toEqual({ kind: 'task', detail: 'shell STARTED callId=abc — powershell -NoProfile -NonInteractive -Command Write-Output full-command' });
    expect(logDisplayParts(result).kind).toBe('result');
    const copied = formatLogCopyText(result, null, 'th');
    expect(copied).toContain(result.text);
    expect(copied.startsWith('22-08-2026 07:00:11')).toBe(true);
    expect(copied).not.toContain(result.timestamp);
    const english = formatLogCopyText(result, null, 'en');
    expect(english).toMatch(/^\d{2}-\d{2}-2026 \d{2}:\d{2}:\d{2} (AM|PM)/);
    const markup = renderToStaticMarkup(createElement(LogStreamPanel, {
      source: 'mcp', title: 'MCP activity', lines: [task, result], tunnelLogPath: null, tunnelLogExists: false,
      filterPlaceholder: 'filter', pauseLabel: 'pause', followLabel: 'follow', clearLabel: 'clear', clearSessionLabel: 'clear session', clearWorkspaceLabel: 'clear workspace', exportLabel: 'export',
      copyLabel: 'Copy', copiedLabel: 'Copied', onClear: noop, onExport: noop,
    }));
    expect(markup).toContain('event-tag result');
    expect(markup).toContain('event-tag task');
    expect(markup).toContain('row-copy-button');
    expect(markup).not.toContain('[RESULT] shell SUCCESS callId=abc — powershell');
  });

  it('explains what Processes contains and renders mirrored process lifecycle badges', () => {
    const embedded = renderToStaticMarkup(createElement(LiveLogsPage, {
      locale: 'en', lines: [], tunnelLogPath: null, tunnelLogExists: false,
      onClear: noop, onClearAll: noop, onExport: noop, onPopOut: noop, onCaptureIncident: noop,
      incidentBusy: false, incidentClassification: null, incidentCapturedAt: null, incidentNotice: null, workspaces: [],
    }));
    expect(embedded).toContain('Processes');

    const processLine = {
      id: 12, source: 'process' as const, timestamp: '2026-09-02T00:00:12.000Z', level: 'info' as const,
      workspaceId: 'ws-a', sessionId: 'session-a', text: '[RESULT] shell SUCCESS callId=process-call — pnpm lint',
      correlation: { kind: 'mcp' as const, phase: 'completed' as const, callId: 'process-call', toolName: 'shell', resultCode: 'SUCCESS' as const },
    };
    expect(logDisplayParts(processLine)).toEqual({ kind: 'result', detail: 'shell SUCCESS callId=process-call — pnpm lint' });
    const processMarkup = renderToStaticMarkup(createElement(LogStreamPanel, {
      source: 'process', title: 'Processes', lines: [processLine], tunnelLogPath: null, tunnelLogExists: false,
      description: 'Shows real process work run by the Agent', waitingLabel: 'No process activity yet',
      filterPlaceholder: 'filter', pauseLabel: 'pause', followLabel: 'follow', clearLabel: 'clear', clearSessionLabel: 'clear session', clearWorkspaceLabel: 'clear workspace', exportLabel: 'export',
      onClear: noop, onExport: noop,
    }));
    expect(processMarkup).toContain('Shows real process work run by the Agent');
    expect(processMarkup).toContain('event-tag result');
  });

  it('offers clear-all controls in both embedded and pop-out Live Logs', () => {
    const embedded = renderToStaticMarkup(createElement(LiveLogsPage, {
      locale: 'en', lines: [], tunnelLogPath: null, tunnelLogExists: false,
      onClear: noop, onClearAll: noop, onExport: noop, onPopOut: noop, onCaptureIncident: noop,
      incidentBusy: false, incidentClassification: null, incidentCapturedAt: null, incidentNotice: null, workspaces: [],
    }));
    const standalone = renderToStaticMarkup(createElement(StandaloneLogViewer));
    expect(embedded).toContain('Clear All Logs');
    expect(standalone).toContain('ล้าง Log ทั้งหมด');
  });

  it('uses full-width equal Workspace/Session filters across log panels and white clear-all text', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const livePanel = readFileSync(new URL('../src/renderer/features/live/LogStreamPanel.tsx', import.meta.url), 'utf8');
    const workLogPanel = readFileSync(new URL('../src/renderer/features/worklog/WorkLogPanel.tsx', import.meta.url), 'utf8');
    expect(css).toMatch(/\.scope-filter-bar label\s*\{[^}]*flex:\s*1 1 0[^}]*min-width:\s*220px/s);
    expect(css).toMatch(/\.scope-filter-bar select\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.clear-all-logs-button\s*\{[^}]*color:\s*#fff/s);
    expect(livePanel).toContain('className="scope-filter-bar"');
    expect(workLogPanel).toContain('className="scope-filter-bar"');
  });

  it('filters Live Logs by workspace/session and keeps scoped rows distinct', () => {
    const lines = [
      { id: 20, source: 'mcp' as const, timestamp: '2026-08-22T00:00:20.000Z', level: 'info' as const, text: 'same', workspaceId: 'ws-a', sessionId: 'session-a' },
      { id: 21, source: 'mcp' as const, timestamp: '2026-08-22T00:00:20.000Z', level: 'info' as const, text: 'same', workspaceId: 'ws-a', sessionId: 'session-b' },
      { id: 22, source: 'mcp' as const, timestamp: '2026-08-22T00:00:20.000Z', level: 'info' as const, text: 'same', workspaceId: 'ws-b', sessionId: 'session-c' },
    ];
    expect(filterLogLinesByScope(lines, { workspaceId: 'ws-a', sessionId: null })).toHaveLength(2);
    expect(filterLogLinesByScope(lines, { workspaceId: 'ws-a', sessionId: 'session-b' })).toEqual([lines[1]]);
    const markup = renderToStaticMarkup(createElement(LogStreamPanel, {
      source: 'mcp', title: 'MCP', lines, tunnelLogPath: null, tunnelLogExists: false,
      filterPlaceholder: 'filter', pauseLabel: 'pause', followLabel: 'follow', clearLabel: 'clear', clearSessionLabel: 'clear session', clearWorkspaceLabel: 'clear workspace', exportLabel: 'export',
      workspaceLabel: 'Workspace', sessionLabel: 'Session', scopeAllLabel: 'All', onClear: noop, onExport: noop,
    }));
    expect(markup).toContain('scope-filter-bar');
    expect(markup).toContain('scope-badge workspace');
    expect(markup).toContain('scope-badge session');
  });

  it('treats legacy slash/case path workspace IDs as the registered project and exports the exact visible order', () => {
    const workspaces = [
      { id: 'project-a', displayName: 'lnwjud', rootPath: 'E:\\lnwjud', realRootPath: 'E:\\lnwjud', createdAt: '2026-08-01T00:00:00.000Z' },
    ];
    const lines = [
      { id: 30, source: 'mcp' as const, timestamp: '2026-08-22T00:00:30.000Z', level: 'info' as const, text: 'backslash', workspaceId: 'E:\\lnwjud', sessionId: 'session-a' },
      { id: 31, source: 'mcp' as const, timestamp: '2026-08-22T00:00:31.000Z', level: 'info' as const, text: 'slash', workspaceId: 'e:/LNWJUD/', sessionId: 'session-a' },
      { id: 32, source: 'mcp' as const, timestamp: '2026-08-22T00:00:32.000Z', level: 'info' as const, text: 'other', workspaceId: 'other-workspace', sessionId: 'session-a' },
    ];
    expect(filterLogLinesByScope(lines, { workspaceId: 'project-a', sessionId: null }, '', workspaces).map((line) => line.id)).toEqual([30, 31]);
    expect(visibleLogLines(lines, { workspaceId: 'project-a', sessionId: null }, '', workspaces).map((line) => line.id)).toEqual([31, 30]);
  });

  it('shows each project root once and hides machine roots in the workspace selector', () => {
    const workspaces = [
      { id: 'drive-e', displayName: 'Local Disk E:', rootPath: 'E:\\', realRootPath: 'E:\\', createdAt: '2026-08-01T00:00:00.000Z', kind: 'machine_root' as const },
      { id: 'project-a', displayName: 'lnwjud', rootPath: 'E:\\lnwjud', realRootPath: 'E:\\lnwjud', createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'project-alias', displayName: 'lnwjud', rootPath: 'E:/lnwjud/', realRootPath: 'E:/lnwjud/', createdAt: '2026-08-01T00:00:00.000Z' },
    ];
    const markup = renderToStaticMarkup(createElement(LogStreamPanel, {
      source: 'mcp', title: 'MCP', lines: [], tunnelLogPath: null, tunnelLogExists: false,
      filterPlaceholder: 'filter', pauseLabel: 'pause', followLabel: 'follow', clearLabel: 'clear', clearSessionLabel: 'clear session', clearWorkspaceLabel: 'clear workspace', exportLabel: 'export',
      workspaceLabel: 'Workspace', sessionLabel: 'Session', scopeAllLabel: 'All', onClear: noop, onExport: noop, workspaces,
    }));
    expect(markup).not.toContain('Local Disk E:');
    expect((markup.match(/>lnwjud — project-a<\/option>/g) ?? [])).toHaveLength(1);
  });

  it('keeps Live Logs inside the window and scrolls only the log table', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.live-logs-page\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.live-logs-page \.log-stream\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/\.log-viewer-window\s*\{[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.log-viewer-shell\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.log-viewer-shell \.log-stream\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/\.page-content\s*\{[^}]*padding-bottom:\s*var\(--page-bottom-gap\)/s);
  });

  it('keeps ordinary pages content-sized so the bottom gap follows the real content', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const workLog = readFileSync(new URL('../src/renderer/features/worklog/WorkLogPage.tsx', import.meta.url), 'utf8');
    expect(css).toMatch(/\.page-content\s*\{[^}]*flex:\s*0 0 auto[^}]*min-height:\s*100%[^}]*padding-bottom:\s*var\(--page-bottom-gap\)/s);
    expect(workLog).toContain('page-content viewport-list-page worklog-page');
  });

  it('keeps a long correlated line collapsed and exposes an accessible localized detail control', () => {
    const line = {
      id: 401, source: 'mcp' as const, timestamp: '2026-08-30T00:00:00.000Z', level: 'info' as const,
      text: '[TASK] read_files STARTED callId=call-live — a.ts, b.ts, c.ts (+6)', workspaceId: null, sessionId: null,
      correlation: { kind: 'mcp' as const, phase: 'started' as const, callId: 'call-live', toolName: 'read_files', resultCode: null },
      targetDetail: { detailRef: 'call-live', itemCount: 9, preview: ['a.ts', 'b.ts', 'c.ts'], legacyIncomplete: false },
    };
    const markup = renderToStaticMarkup(createElement(LogStreamPanel, {
      source: 'mcp', title: 'MCP', lines: [line], tunnelLogPath: null, tunnelLogExists: false,
      filterPlaceholder: 'filter', pauseLabel: 'pause', followLabel: 'follow', clearLabel: 'clear',
      clearSessionLabel: 'clear session', clearWorkspaceLabel: 'clear workspace', exportLabel: 'export', waitingLabel: 'waiting',
      showMoreLabel: 'Show more', showLessLabel: 'Show less', detailHeadingLabel: 'Target items',
      onClear: noop, onExport: noop,
    }));

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls="log-detail-');
    expect(markup).toContain('>Show more<');
    expect(markup).not.toContain('>Show less<');
  });

  it('formats every resolved item for copy independently from the collapsed display', () => {
    const line = {
      id: 402, source: 'mcp' as const, timestamp: '2026-08-30T00:00:00.000Z', level: 'info' as const,
      text: '[TASK] read_files STARTED callId=call-live — a.ts, b.ts, c.ts (+6)', workspaceId: null, sessionId: null,
    };
    const formatWithDetail = formatLogCopyText as unknown as (
      value: typeof line,
      detail: { readonly kind: 'files'; readonly items: readonly string[] },
    ) => string;
    const copied = formatWithDetail(line, {
      kind: 'files', items: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts', 'i.ts'],
    });
    for (const item of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts', 'i.ts']) expect(copied).toContain(item);
  });

  it('shows and copies full scoped MCP identifiers and complete diagnostics', () => {
    const workspaceId = '372e9384-9628-43be-b766-661cdb591383';
    const sessionId = 'session-1234567890abcdef-fully-visible';
    const callId = 'call-1234567890abcdef-fully-visible';
    const line = {
      id: 403, source: 'mcp' as const, timestamp: '2026-08-30T00:00:00.000Z', level: 'info' as const,
      text: `[RESULT] run_goal goalKey=activity-log-full-detail-no-truncation workspace=${workspaceId}`,
      workspaceId, sessionId,
      correlation: { kind: 'mcp' as const, phase: 'completed' as const, callId, toolName: 'run_goal', resultCode: 'SUCCESS' as const },
      targetDetail: { detailRef: `${callId}:completed`, itemCount: 3, preview: [], legacyIncomplete: false },
    };
    const workspaces = [{ id: workspaceId, displayName: 'lnwjud', rootPath: 'E:\\lnwjud', realRootPath: 'E:\\lnwjud', createdAt: '2026-08-01T00:00:00.000Z' }];
    const markup = renderToStaticMarkup(createElement(LogStreamPanel, {
      source: 'mcp', title: 'MCP', lines: [line], tunnelLogPath: null, tunnelLogExists: false,
      filterPlaceholder: 'filter', pauseLabel: 'pause', followLabel: 'follow', clearLabel: 'clear', clearSessionLabel: 'clear session', clearWorkspaceLabel: 'clear workspace', exportLabel: 'export',
      onClear: noop, onExport: noop, workspaces,
    }));
    expect(markup).toContain(`lnwjud — ${workspaceId}`);
    expect(markup).toContain(sessionId);
    expect(markup).not.toContain('372e9384…1383');

    const copied = formatLogCopyText(line, {
      kind: 'details', items: ['goalId=e27da685-745f-484c-86c8-235eb8cb42e5', `workspaceId=${workspaceId}`, 'status=active'],
    });
    for (const expected of [
      'lineId=403', 'source=mcp', `workspaceId=${workspaceId}`, `sessionId=${sessionId}`, `callId=${callId}`,
      'toolName=run_goal', 'phase=completed', 'resultCode=SUCCESS', 'goalId=e27da685-745f-484c-86c8-235eb8cb42e5', 'status=active',
    ]) expect(copied).toContain(expected);
    expect(copied).not.toContain('…');
  });

  it('uses the same fixed-viewport/internal-scroll pattern for project and Git lists', () => {
    const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');
    const projects = readFileSync(new URL('../src/renderer/features/projects/ProjectsPage.tsx', import.meta.url), 'utf8');
    const git = readFileSync(new URL('../src/renderer/features/git/GitPage.tsx', import.meta.url), 'utf8');
    expect(projects).toContain('page-content viewport-list-page');
    expect(git).toContain('page-content viewport-list-page git-page');
    expect(css).toMatch(/\.project-list-panel\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.project-list-scroll\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/\.git-file-list\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
    expect(css).toMatch(/\.git-not-repo-notice\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.git-switch-list\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
  });
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}
