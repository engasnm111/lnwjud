import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EMPTY_TUNNEL_STATUS, type DashboardSnapshot } from '@lnwjud/ipc-contracts';
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
  tunnel: EMPTY_TUNNEL_STATUS,
  appVersion: '4.0.1',
};

describe('shared incident capture busy UI', () => {
  it('keeps Stop available during Start and persistent startup while suppressing duplicate Stop', () => {
    const common = {
      locale: 'en' as const,
      onCaptureIncident: async (): Promise<void> => undefined,
      incidentBusy: false,
      incidentClassification: null,
      incidentCapturedAt: null,
      incidentNotice: null,
      workspaces: [],
      mcpBusy: false,
      onRefresh: async (): Promise<void> => undefined,
      onStopMcp: async (): Promise<void> => undefined,
      onRestartMcp: async (): Promise<void> => undefined,
      onSelectWorkspace: async (): Promise<void> => undefined,
      onSetWorkspaceActive: async (): Promise<void> => undefined,
      onAddWorkspace: async (): Promise<void> => undefined,
      onStartTunnel: async (): Promise<void> => undefined,
      onStopTunnel: async (): Promise<void> => undefined,
    };
    const renderHome = (
      tunnel: DashboardSnapshot['tunnel'],
      tunnelBusy: boolean,
      tunnelStartPending = false,
      tunnelStopPending = false,
    ): string => renderToStaticMarkup(createElement(ControlCenterPage, {
      ...common,
      dashboard: { ...dashboard, tunnel },
      tunnelBusy,
      tunnelStartPending,
      tunnelStopPending,
    } as unknown as Parameters<typeof ControlCenterPage>[0]));
    const stoppedControls = (markup: string): string => {
      const match = markup.match(/<button[^>]*>[^<]*Stop Tunnel[^<]*<\/button>/i);
      expect(match).not.toBeNull();
      return match?.[0] ?? '';
    };
    const startedControls = (markup: string): string => {
      const match = markup.match(/<button[^>]*>[^<]*Start Tunnel[^<]*<\/button>/i);
      expect(match).not.toBeNull();
      return match?.[0] ?? '';
    };

    const stopBusyMarkup = renderHome({
      ...EMPTY_TUNNEL_STATUS,
      state: 'running',
      source: 'desktop',
      hasApiKey: true,
      profileExists: true,
    }, true, false, true);
    expect(stoppedControls(stopBusyMarkup)).toMatch(/disabled=""/);

    const persistentStartingMarkup = renderHome({
      ...EMPTY_TUNNEL_STATUS,
      hasApiKey: true,
      profileExists: true,
      persistent: {
        enabled: true,
        tunnelIdMasked: 'tunnel…1234',
        runtimeAlias: 'lnwjud',
        mode: 'native-managed',
        state: 'starting',
        healthy: null,
        ready: null,
        pollHealthy: null,
        reconnectCount: 0,
        lastConnectedAt: null,
        lastReconnectAt: null,
        nextReconnectAt: null,
        lastErrorCode: null,
        clientVersion: null,
        localMcpUrl: null,
        uiUrl: null,
        readyBeforeRetire: false,
        strictZeroDowntime: false,
        capabilityEvidence: null,
      },
    }, false);
    expect(startedControls(persistentStartingMarkup)).toMatch(/disabled=""/);
    expect(stoppedControls(persistentStartingMarkup)).not.toMatch(/disabled=""/);

    const pendingStartMarkup = renderHome({
      ...EMPTY_TUNNEL_STATUS,
      hasApiKey: true,
      profileExists: true,
    }, true, true, false);
    expect(startedControls(pendingStartMarkup)).toMatch(/disabled=""/);
    expect(stoppedControls(pendingStartMarkup)).not.toMatch(/disabled=""/);

    const stopPendingMarkup = renderHome({
      ...EMPTY_TUNNEL_STATUS,
      state: 'running',
      hasApiKey: true,
      profileExists: true,
    }, true, false, true);
    expect(stoppedControls(stopPendingMarkup)).toMatch(/disabled=""/);
  });

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
      expect(markup).toMatch(/<button(?=[^>]*disabled="")[^>]*>Capture incident evidence<\/button>/);
      expect(markup).toContain('role="status"');
      expect(markup).toContain('Capturing incident evidence…');
    }
  });
});
