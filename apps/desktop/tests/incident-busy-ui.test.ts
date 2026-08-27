import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DashboardSnapshot } from '@lnwjud/ipc-contracts';
import { ControlCenterPage } from '../src/renderer/features/home/ControlCenterPage.js';
import { LiveLogsPage } from '../src/renderer/features/live/LiveLogsPage.js';

const dashboard: DashboardSnapshot = {
  selectedWorkspace: null,
  activeWorkspaces: [],
  gitSummary: { branch: null, changedFiles: 0, stagedFiles: 0, message: '' },
  mcp: { running: false, url: null, workspaceId: null },
  codex: { installed: false, version: null },
  managedProcessCount: 0,
  auditEventCount: 0,
  recentAuditEvents: [],
  permissionProfile: 'safe',
  capabilities: [],
  agentState: 'stopped',
  mode: 'WORK',
  locale: 'en',
  unrestricted: false,
  allowAiDelete: false,
  stdioPermissionProfile: 'full',
  stdioStrictRoots: false,
  stdioAllowedRoots: [],
  connectionModes: { httpUrl: null, stdioCommand: 'lnwjud --mcp-stdio' },
  workLog: [],
  inFlight: [],
  tunnel: { state: 'stopped', source: 'desktop', hasApiKey: false, clientPath: null, profileExists: false, message: null, logPath: null },
  appVersion: '4.0.1',
};

describe('shared incident capture busy UI', () => {
  it('disables and announces capture on Control Center and Live Logs', () => {
    const common = { locale: 'en' as const, onCaptureIncident: async (): Promise<void> => undefined, incidentBusy: true, incidentClassification: null, incidentCapturedAt: null, incidentNotice: null };
    const home = renderToStaticMarkup(createElement(ControlCenterPage, {
      ...common, dashboard, workspaces: [], mcpBusy: false, tunnelBusy: false,
      onRefresh: async () => undefined, onStopMcp: async () => undefined, onRestartMcp: async () => undefined,
      onSelectWorkspace: async () => undefined, onSetWorkspaceActive: async () => undefined, onAddWorkspace: async () => undefined, onStartTunnel: async () => undefined,
      onStopTunnel: async () => undefined,
    }));
    const live = renderToStaticMarkup(createElement(LiveLogsPage, {
      ...common, lines: [], tunnelLogPath: null, tunnelLogExists: false,
      onClear: async () => undefined, onExport: async () => undefined, onPopOut: async () => undefined,
    }));
    for (const markup of [home, live]) {
      expect(markup).toContain('<button type="button" disabled="">Capture incident evidence</button>');
      expect(markup).toContain('role="status"');
      expect(markup).toContain('Capturing incident evidence…');
    }
  });
});
