import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InFlightWorkItem, WorkLogEntry } from '@lnwjud/ipc-contracts';
import { formatWorkLogCopyText, newestFirstWorkLogRows, WorkLogPanel } from '../src/renderer/features/worklog/WorkLogPanel.js';

const mockInFlight: InFlightWorkItem[] = [
  {
    callId: 'call-1',
    toolName: 'shell',
    startedAt: '2026-08-19T14:00:00.000Z',
    targetSummary: 'npm test',
    workspaceId: 'workspace-1',
    sessionId: 'session-a',
  },
];

const mockEntries: WorkLogEntry[] = [
  {
    id: 'entry-1',
    timestamp: '2026-08-19T14:01:18.000Z',
    kind: 'result',
    toolName: 'shell',
    resultCode: 'SUCCESS',
    errorMessage: null,
    targetSummary: 'python -c "print(1)"',
    durationMs: 71,
    workspaceId: 'workspace-1',
    sessionId: 'session-a',
  },
  {
    id: 'entry-2',
    timestamp: '2026-08-19T14:00:36.000Z',
    kind: 'error',
    toolName: 'shell',
    resultCode: 'PERMISSION_REQUIRED',
    errorMessage: 'Destructive operation requires explicit user confirmation',
    targetSummary: 'powershell -NoProfile -Command Remove-Item test',
    durationMs: 12,
    workspaceId: 'workspace-1',
    sessionId: 'session-a',
  },
];

describe('WorkLogPanel', () => {
  it('renders entries and inFlight items with structured details and duration', () => {
    const markup = renderToStaticMarkup(createElement(WorkLogPanel, {
      title: 'บันทึกการทำงาน',
      emptyLabel: 'ยังไม่มีกิจกรรม',
      filterAllLabel: 'ทั้งหมด',
      filterErrorLabel: 'เฉพาะ error',
      clearSessionLabel: 'ล้าง Session นี้', clearWorkspaceLabel: 'ล้าง Workspace นี้', clearAllLabel: 'ล้างทั้งหมด',
      filter: 'all',
      onFilterChange: () => {},
      onClear: async () => {},
      entries: mockEntries,
      inFlight: mockInFlight,
    }));

    expect(markup).toContain('บันทึกการทำงาน');
    expect(markup).toContain('[TASK]');
    expect(markup).toContain('[RESULT]');
    expect(markup).toContain('[ERROR]');
    expect(markup).toContain('npm test');
    expect(markup).toContain('python -c &quot;print(1)&quot;');
    expect(markup).toContain('powershell -NoProfile -Command Remove-Item test');
    expect(markup).toContain('Destructive operation requires explicit user confirmation');
    expect(markup).toContain('71ms');
    expect(markup).toContain('12ms');
  });

  it('filters by error properly when filter is error', () => {
    const markup = renderToStaticMarkup(createElement(WorkLogPanel, {
      title: 'บันทึกการทำงาน',
      emptyLabel: 'ยังไม่มีกิจกรรม',
      filterAllLabel: 'ทั้งหมด',
      filterErrorLabel: 'เฉพาะ error',
      clearSessionLabel: 'ล้าง Session นี้', clearWorkspaceLabel: 'ล้าง Workspace นี้', clearAllLabel: 'ล้างทั้งหมด',
      filter: 'error',
      onFilterChange: () => {},
      onClear: async () => {},
      entries: mockEntries,
      inFlight: [],
    }));

    expect(markup).toContain('[ERROR]');
    expect(markup).toContain('Destructive operation requires explicit user confirmation');
    expect(markup).not.toContain('python -c &quot;print(1)&quot;');
  });

  it('renders search and copy controls and filters rows by full log details', () => {
    const markup = renderToStaticMarkup(createElement(WorkLogPanel, {
      title: 'บันทึกการทำงาน', emptyLabel: 'ยังไม่มีกิจกรรม', filterAllLabel: 'ทั้งหมด', filterErrorLabel: 'เฉพาะ error',
      clearSessionLabel: 'ล้าง Session นี้', clearWorkspaceLabel: 'ล้าง Workspace นี้', clearAllLabel: 'ล้างทั้งหมด', filter: 'all', onFilterChange: () => {}, onClear: async () => {}, entries: mockEntries, inFlight: mockInFlight,
      searchPlaceholder: 'ค้นหาบันทึกการทำงาน...', copyLabel: 'คัดลอก', copiedLabel: 'คัดลอกแล้ว',
    }));
    expect(markup).toContain('type="search"');
    expect(markup).toContain('ค้นหาบันทึกการทำงาน...');
    expect(markup.match(/row-copy-button/g)?.length).toBe(3);

    const resultMatches = newestFirstWorkLogRows(mockEntries, mockInFlight, 'all', 'print(1)');
    expect(resultMatches).toHaveLength(1);
    expect(resultMatches[0]?.id).toBe('entry-1');
    const errorMatches = newestFirstWorkLogRows(mockEntries, mockInFlight, 'all', 'explicit user confirmation');
    expect(errorMatches).toHaveLength(1);
    expect(errorMatches[0]?.id).toBe('entry-2');
  });
  it('disambiguates duplicate workspace names and suppresses duplicate registrations for the same root', () => {
    const workspaces = [
      { id: 'drive-e', displayName: 'Local Disk E:', rootPath: 'E:\\', realRootPath: 'E:\\', createdAt: '2026-08-01T00:00:00.000Z', kind: 'machine_root' as const },
      { id: 'workspace-a', displayName: 'lnwjud', rootPath: 'E:\\lnwjud', realRootPath: 'E:\\lnwjud', createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'workspace-alias', displayName: 'lnwjud', rootPath: 'E:/lnwjud/', realRootPath: 'E:/lnwjud/', createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'workspace-b', displayName: 'lnwjud', rootPath: 'D:\\projects\\lnwjud', realRootPath: 'D:\\projects\\lnwjud', createdAt: '2026-08-01T00:00:00.000Z' },
    ];
    const markup = renderToStaticMarkup(createElement(WorkLogPanel, {
      title: 'Work log', emptyLabel: 'Empty', filterAllLabel: 'All', filterErrorLabel: 'Errors',
      clearSessionLabel: 'Clear session', clearWorkspaceLabel: 'Clear workspace', clearAllLabel: 'Clear all',
      filter: 'all', onFilterChange: () => {}, onClear: async () => {}, entries: [], inFlight: [], workspaces,
    }));
    expect(markup).toContain('lnwjud — E:\\lnwjud');
    expect(markup).toContain('lnwjud — D:\\projects\\lnwjud');
    expect(markup.match(/value="workspace-alias"/g)).toBeNull();
    expect(markup).not.toContain('Local Disk E:');
  });

  it('filters by workspace and session without collapsing identical in-flight call IDs', () => {
    const inFlight: InFlightWorkItem[] = [
      { ...mockInFlight[0]!, callId: 'same-call', workspaceId: 'workspace-1', sessionId: 'session-a' },
      { ...mockInFlight[0]!, callId: 'same-call', workspaceId: 'workspace-1', sessionId: 'session-b' },
      { ...mockInFlight[0]!, callId: 'other-call', workspaceId: 'workspace-2', sessionId: 'session-c' },
    ];
    const allWorkspaceOne = newestFirstWorkLogRows([], inFlight, 'all', '', { workspaceId: 'workspace-1', sessionId: null });
    expect(allWorkspaceOne).toHaveLength(2);
    expect(new Set(allWorkspaceOne.map((row) => row.id)).size).toBe(2);
    const oneSession = newestFirstWorkLogRows([], inFlight, 'all', '', { workspaceId: 'workspace-1', sessionId: 'session-b' });
    expect(oneSession).toHaveLength(1);
    expect(oneSession[0]?.item.sessionId).toBe('session-b');
  });

  it('treats slash and case variants of a legacy workspace path as the same project', () => {
    const workspaces = [
      { id: 'lnwjud-project', displayName: 'lnwjud', rootPath: 'E:\\lnwjud', realRootPath: 'E:\\lnwjud', createdAt: '2026-08-01T00:00:00.000Z' },
    ];
    const entries: WorkLogEntry[] = [
      { ...mockEntries[0]!, id: 'slash', workspaceId: 'e:/LNWJUD/' },
      { ...mockEntries[1]!, id: 'backslash', workspaceId: 'E:\\lnwjud' },
      { ...mockEntries[0]!, id: 'other', workspaceId: 'E:\\other' },
    ];

    const rows = newestFirstWorkLogRows(entries, [], 'all', '', { workspaceId: 'lnwjud-project', sessionId: null }, workspaces);
    expect(rows.map((row) => row.id)).toEqual(['slash', 'backslash']);
  });

  it('formats copied/exported timestamps in the same local timezone used by the UI', () => {
    const rows = newestFirstWorkLogRows(mockEntries, mockInFlight);
    const row = rows[0]!;
    const text = formatWorkLogCopyText(row);
    const localDate = new Date(row.timestamp);
    const expected = `${String(localDate.getDate()).padStart(2, '0')}-${String(localDate.getMonth() + 1).padStart(2, '0')}-${localDate.getFullYear()} ${String(localDate.getHours()).padStart(2, '0')}:${String(localDate.getMinutes()).padStart(2, '0')}:${String(localDate.getSeconds()).padStart(2, '0')}`;
    expect(text.startsWith(expected)).toBe(true);
    expect(text).not.toContain(row.timestamp);
  });

  it('renders export when supplied so the Work Log page can export its visible rows', () => {
    const markup = renderToStaticMarkup(createElement(WorkLogPanel, {
      title: 'Work log', emptyLabel: 'Empty', filterAllLabel: 'All', filterErrorLabel: 'Errors',
      clearSessionLabel: 'Clear session', clearWorkspaceLabel: 'Clear workspace', clearAllLabel: 'Clear all',
      exportLabel: 'Export visible', onExport: async () => {},
      filter: 'all', onFilterChange: () => {}, onClear: async () => {}, entries: mockEntries, inFlight: mockInFlight,
    }));
    expect(markup).toContain('Export visible');
  });

});
