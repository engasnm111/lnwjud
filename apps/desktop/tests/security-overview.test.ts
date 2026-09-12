import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DashboardSnapshot } from '@lnwjud/ipc-contracts';
import { ControlCenterPage } from '../src/renderer/features/home/ControlCenterPage.js';

const baseDashboard: DashboardSnapshot = {
  selectedWorkspace: null,
  activeWorkspaces: [],
  gitSummary: { branch: null, changedFiles: 0, stagedFiles: 0, message: '' },
  mcp: { running: false, url: null, workspaceId: null },
  codex: { installed: false, version: null },
  managedProcessCount: 0,
  auditEventCount: 0,
  recentAuditEvents: [],
  permissionProfile: 'balanced',
  capabilities: [],
  agentState: 'idle',
  mode: 'WORK',
  locale: 'en',
  unrestricted: false,
  allowAiDelete: false,
  stdioPermissionProfile: 'balanced',
  stdioStrictRoots: true,
  stdioAllowedRoots: ['C:\\workspace'],
  backups: [],
  connectionModes: { httpUrl: null, stdioCommand: 'lnwjud-mcp-stdio.cmd' },
  workLog: [],
  inFlight: [],
  tunnel: { state: 'stopped', source: 'desktop', hasApiKey: false, clientPath: null, profileExists: false, message: null, logPath: null, persistent: null },
  appVersion: '4.6.1',
};

function render(dashboard: DashboardSnapshot, locale: 'th' | 'en' = 'en'): string {
  return renderToStaticMarkup(createElement(ControlCenterPage, {
    dashboard,
    locale,
    workspaces: [],
    mcpBusy: false,
    tunnelBusy: false,
    onRefresh: async () => undefined,
    onStopMcp: async () => undefined,
    onRestartMcp: async () => undefined,
    onSelectWorkspace: async () => undefined,
    onSetWorkspaceActive: async () => undefined,
    onAddWorkspace: async () => true,
    onStartTunnel: async () => undefined,
    onStopTunnel: async () => undefined,
    onOpenTunnelSetup: () => undefined,
    onCaptureIncident: async () => undefined,
    incidentBusy: false,
    incidentClassification: null,
    incidentCapturedAt: null,
    incidentNotice: null,
  }));
}

describe('Security Overview', () => {
  it('shows a restricted posture when STDIO uses strict roots and risky switches are off', () => {
    const markup = render(baseDashboard);
    expect(markup).toContain('Security Overview');
    expect(markup).toContain('Restricted scope');
    expect(markup).toContain('BALANCED');
    expect(markup).toContain('Allowed Roots');
    expect(markup).not.toContain('explicitly requested absolute paths are accessible');
  });

  it('warns when standalone/headless STDIO has broad full access without Strict Roots', () => {
    const markup = render({
      ...baseDashboard,
      stdioPermissionProfile: 'full',
      stdioStrictRoots: false,
      stdioAllowedRoots: [],
      unrestricted: true,
      allowAiDelete: true,
    });
    expect(markup).toContain('Broad access');
    expect(markup).toContain('explicitly requested absolute paths are accessible');
    expect(markup).toContain('drives are not scanned');
    expect(markup).toContain('AI File Delete');
  });

  it('does not claim an orphan external tunnel is fully connected when local setup is missing', () => {
    const markup = render({
      ...baseDashboard,
      tunnel: {
        state: 'running',
        source: 'external',
        hasApiKey: false,
        clientPath: 'C:\\fixture\\tunnel-client.exe',
        profileExists: false,
        message: null,
        logPath: null,
        persistent: null,
      },
    });
    expect(markup).toContain('A tunnel process is still running, but lnwjud setup is incomplete.');
    expect(markup).not.toContain('Tunnel connected (from script) — Start is disabled');
  });

  it('hides transient runtime internals while Tunnel is starting, but keeps real errors visible', () => {
    const startingMarkup = render({
      ...baseDashboard,
      tunnel: {
        ...baseDashboard.tunnel,
        state: 'starting',
        hasApiKey: true,
        runtimeCredentialAvailable: true,
        profileExists: true,
        message: 'Managed tunnel runtime did not become fully ready',
      },
    });
    expect(startingMarkup).not.toContain('Managed tunnel runtime did not become fully ready');

    const errorMarkup = render({
      ...baseDashboard,
      tunnel: {
        ...baseDashboard.tunnel,
        state: 'error',
        hasApiKey: true,
        runtimeCredentialAvailable: true,
        profileExists: true,
        message: 'Tunnel startup failed',
      },
    });
    expect(errorMarkup).toContain('Tunnel startup failed');
    expect(errorMarkup).toContain('role="alert"');
    expect(errorMarkup).toContain('error-text');
  });

  it('renders OAuth-specific Home connection copy instead of Runtime API key wording', () => {
    const markup = render({
      ...baseDashboard,
      tunnel: {
        ...baseDashboard.tunnel,
        authReady: true,
        runtimeCredentialAvailable: true,
        profileExists: true,
        auth: {
          mode: 'oauth', authReady: true, runtimeCredentialAvailable: true, hasLegacyApiKey: true,
          accountLabel: 'oauth@example.test', organizationId: null, workspaceId: null, expiresAt: null,
          requiresUserAction: false, message: null,
        },
      },
    });
    expect(markup).toContain('ChatGPT Connection');
    expect(markup).toContain('Remote MCP · OAuth');
    expect(markup).toContain('Advanced option');
    expect(markup).toContain('ChatGPT Connection — OAuth');
    expect(markup).toContain('oauth@example.test');
    expect(markup).not.toContain('Save a Runtime API key once in Settings');
  });

  it('simplifies the Home surface around one ChatGPT connection area and removes the redundant WORK mode card', () => {
    const markup = render(baseDashboard);
    expect(markup).toContain('aria-label="ChatGPT Connection"');
    expect(markup).toContain('Remote MCP · OAuth');
    expect(markup).toContain('Secure MCP Tunnel for ChatGPT');
    expect(markup).toContain('class="agent-actions-menu"');
    expect(markup).toContain('Restart Desktop Agent');
    expect(markup).toContain('Stop Desktop Agent');
    expect(markup).not.toContain('<p>Mode</p>');
    expect(markup).not.toContain('WORK mode');
  });

  it('localizes the security summary to Thai', () => {
    const markup = render({ ...baseDashboard, locale: 'th' }, 'th');
    expect(markup).toContain('ภาพรวมความปลอดภัย');
    expect(markup).toContain('จำกัดขอบเขตแล้ว');
    expect(markup).toContain('Strict Roots จำกัด standalone/headless STDIO');
  });
});
