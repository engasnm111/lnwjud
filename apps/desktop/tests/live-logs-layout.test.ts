import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LiveLogsPage } from '../src/renderer/features/live/LiveLogsPage.js';
import { filterLogLinesByScope, formatLogCopyText, logDisplayParts, LogStreamPanel, visibleLogLines } from '../src/renderer/features/live/LogStreamPanel.js';
import { StandaloneLogViewer } from '../src/renderer/features/live/StandaloneLogViewer.js';

const noop = async (): Promise<void> => undefined;

describe('viewport-sized log and list layout', () => {
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
    const copied = formatLogCopyText(result);
    expect(copied).toContain(result.text);
    const localDate = new Date(result.timestamp);
    const expected = `${String(localDate.getDate()).padStart(2, '0')}-${String(localDate.getMonth() + 1).padStart(2, '0')}-${localDate.getFullYear()} ${String(localDate.getHours()).padStart(2, '0')}:${String(localDate.getMinutes()).padStart(2, '0')}:${String(localDate.getSeconds()).padStart(2, '0')}`;
    expect(copied.startsWith(expected)).toBe(true);
    expect(copied).not.toContain(result.timestamp);
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
    expect((markup.match(/>lnwjud<\/option>/g) ?? [])).toHaveLength(1);
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
