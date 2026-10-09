import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LogStreamPanel } from '../src/renderer/features/live/LogStreamPanel.js';

const props = {
  title: 'Live Logs',
  lines: [],
  tunnelLogPath: null,
  tunnelLogExists: true,
  pauseLabel: 'Pause',
  followLabel: 'Follow',
  filterPlaceholder: 'Search logs',
  clearLabel: 'Clear Tab',
  clearSessionLabel: 'Clear Session',
  clearWorkspaceLabel: 'Clear Workspace',
  exportLabel: 'Export',
  onClear: async () => undefined,
  onExport: async () => undefined,
  workspaceLabel: 'Workspace',
  sessionLabel: 'Session',
  scopeAllLabel: 'All',
} as const;

describe('Live Logs per-source filters', () => {
  it('hides misleading Workspace/Session filters and scoped clear actions from Tunnel only', () => {
    const tunnel = renderToStaticMarkup(createElement(LogStreamPanel, { ...props, source: 'tunnel' }));
    expect(tunnel).not.toContain('scope-filter-bar');
    expect(tunnel).not.toContain('Clear Session');
    expect(tunnel).not.toContain('Clear Workspace');
    expect(tunnel).not.toContain('ui-combobox');
    expect(tunnel).toContain('Search logs');
    expect(tunnel).toContain('Clear Tab');
    expect(tunnel).toContain('Export');
  });

  it.each(['mcp', 'process'] as const)('%s retains functional scope filters', (source) => {
    const markup = renderToStaticMarkup(createElement(LogStreamPanel, { ...props, source }));
    expect(markup).toContain('scope-filter-bar');
    expect(markup).toContain('Workspace');
    expect(markup).toContain('Session');
    expect(markup).toContain('Clear Session');
    expect(markup).toContain('Clear Workspace');
  });
});
