import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DashboardSnapshot } from '@lnwjud/ipc-contracts';
import { SettingsPage } from '../src/renderer/features/settings/SettingsPage.js';

const noop = async (): Promise<void> => undefined;
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
  destructiveDeletePolicy: {
    protectCriticalFiles: true,
    recoverableDelete: true,
    approvals: { delete_file: false, git_rm: false, git_clean: false, git_reset_restore: false, shell_rm_unlink: false, shell_rmdir: false, shell_del_erase: false, wsl_rm_unlink: false, wsl_rmdir: false },
  },
  stdioPermissionProfile: 'full',
  stdioStrictRoots: false,
  stdioAllowedRoots: [],
  backups: [{ id: 'backup-2026-08-22T00-00-00-000Z-deadbeef', createdAt: '2026-08-22T00:00:00.000Z', reason: 'daily', sizeBytes: 4096 }],
  recovery: { trashRoot: 'C:\\Users\\Tester\\AppData\\Roaming\\lnwjud\\recovery-trash', trashItems: [], checkpoints: [] },
  connectionModes: { httpUrl: null, stdioCommand: 'lnwjud --mcp-stdio' },
  workLog: [],
  inFlight: [],
  tunnel: { state: 'stopped', source: 'desktop', hasApiKey: false, clientPath: null, profileExists: false, message: null, logPath: null },
  settings: {
    customPermission: { read: 'ALLOW', write: 'ASK', execute: 'ASK', dangerous: 'DENY', allowedExecutables: [] },
    mcpCallTimeoutMs: 60_000, mcpIdleTimeoutMs: 300_000, processTimeoutMs: 3_600_000, mcpPollWaitSeconds: 5, shellSynchronousWaitSeconds: 60,
    capabilityRoots: [], pdfProviderPath: '', lspCommands: {}, mcpHttpPort: 18_765, codexToolsEnabled: false,
    updateAutoCheck: true, updateCheckOnStartup: true, updateIntervalMinutes: 30, updateAutoDownload: true,
    closeBehavior: 'tray', launchAtStartup: false, startMinimized: false, tunnelAutoReconnect: true, tunnelMaxAutoRestarts: 5, recoveryRetentionDays: 0,
    extensions: { mode: 'enable_all', disabledServers: [], enabledServers: [], disabledSkillRoots: [], extraSkillRoots: [], extraMcpServers: [] },
  },
  appVersion: '4.6.0',
};

describe('Backup settings UI', () => {
  it('shows consistent backup controls and an available restore action', () => {
    const markup = renderToStaticMarkup(createElement(SettingsPage, {
      locale: 'en',
      initialSection: 'backup',
      dashboard,
      onLocaleChange: noop,
      onPermissionProfileChange: noop,
      onUnrestrictedChange: async (): Promise<boolean> => false,
      onDestructiveDeletePolicyChange: noop,
      onStdioPolicyChange: async (): Promise<boolean> => false,
      onCreateBackup: noop,
      onScheduleRestoreBackup: async (): Promise<boolean> => true,
      onRestoreRecoveryItem: noop,
      onRestoreCheckpoint: noop,
      onSaveTunnelApiKey: noop,
      onSetTunnelClientPath: noop,
      onUserSettingsChange: async (): Promise<boolean> => false,
      onChooseTunnelClientPath: async (): Promise<string | null> => null,
      onConfigureTunnelProfile: async (): Promise<string> => '',
      onStartTunnel: noop,
      onStopTunnel: noop,
    }));

    expect(markup).toContain('Recovery Center');
    expect(markup).toContain('Application Database Backup');
    expect(markup).toContain('Backup Now');
    expect(markup).toContain('SQLite consistent snapshots');
    expect(markup).toContain('Restore</button>');
  });

  it('disables restore while local MCP or Secure Tunnel is active', () => {
    const markup = renderToStaticMarkup(createElement(SettingsPage, {
      locale: 'en',
      initialSection: 'backup',
      dashboard: { ...dashboard, mcp: { running: true, url: 'http://127.0.0.1:18765/mcp', workspaceId: null } },
      onLocaleChange: noop,
      onPermissionProfileChange: noop,
      onUnrestrictedChange: async (): Promise<boolean> => false,
      onDestructiveDeletePolicyChange: noop,
      onStdioPolicyChange: async (): Promise<boolean> => false,
      onCreateBackup: noop,
      onScheduleRestoreBackup: async (): Promise<boolean> => true,
      onRestoreRecoveryItem: noop,
      onRestoreCheckpoint: noop,
      onSaveTunnelApiKey: noop,
      onSetTunnelClientPath: noop,
      onUserSettingsChange: async (): Promise<boolean> => false,
      onChooseTunnelClientPath: async (): Promise<string | null> => null,
      onConfigureTunnelProfile: async (): Promise<string> => '',
      onStartTunnel: noop,
      onStopTunnel: noop,
    }));

    expect(markup).toContain('Stop Tunnel and local MCP before scheduling a database restore.');
    expect(markup).toContain('<button type="button" disabled="">Restore</button>');
  });
});
