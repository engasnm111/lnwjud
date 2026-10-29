import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EMPTY_TUNNEL_STATUS, type DashboardSnapshot } from '@lnwjud/ipc-contracts';
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
  tunnel: EMPTY_TUNNEL_STATUS,
  settings: {
    customPermission: { read: 'ALLOW', write: 'ASK', execute: 'ASK', dangerous: 'DENY', allowedExecutables: [] },
    mcpCallTimeoutMs: 60_000, mcpIdleTimeoutMs: 300_000, processTimeoutMs: 3_600_000, mcpPollWaitSeconds: 5, shellSynchronousWaitSeconds: 60,
    capabilityRoots: [], pdfProviderPath: '', lspCommands: {}, mcpHttpPort: 18_765, mcpAllowedHostnames: [], codexToolsEnabled: false, eccEnabled: false, ponytailMode: 'off',
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

  it('keeps the Settings persistent Stop available while a Start is pending', () => {
    const tunnel = {
      ...EMPTY_TUNNEL_STATUS,
      state: 'starting',
      hasApiKey: true,
      runtimeCredentialAvailable: true,
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
    };
    const oauthStatus = { state: 'idle' as const, available: false, providerId: null, authorizationUrl: null, message: 'OAuth unavailable' };
    const props = {
      locale: 'en' as const,
      initialSection: 'tunnel' as const,
      dashboard: { ...dashboard, tunnel },
      onLocaleChange: noop,
      onFactoryReset: async () => ({ accepted: false }),
      onPermissionProfileChange: noop,
      onUnrestrictedChange: async () => false,
      onDestructiveDeletePolicyChange: noop,
      onStdioPolicyChange: async () => false,
      onCreateBackup: noop,
      onScheduleRestoreBackup: async () => true,
      onRestoreRecoveryItem: noop,
      onRestoreCheckpoint: noop,
      onSaveTunnelApiKey: noop,
      onSetTunnelClientPath: noop,
      onUserSettingsChange: async () => false,
      ponytailPolicyContext: null,
      ponytailPolicyBusy: false,
      ponytailPolicyError: null,
      onWorkspacePonytailModeChange: noop,
      onGoalPonytailModeChange: noop,
      onInstallPdfProvider: async () => ({} as never),
      onChooseTunnelClientPath: async () => null,
      onConfigureTunnelProfile: async () => '',
      onStartTunnel: async () => tunnel,
      onStopTunnel: noop,
      tunnelBusy: true,
      tunnelStartPending: true,
      tunnelStopPending: false,
      onBeginTunnelOAuthLogin: async () => oauthStatus,
      onGetTunnelOAuthLoginStatus: async () => oauthStatus,
      onCancelTunnelOAuthLogin: async () => oauthStatus,
      onSwitchTunnelAuthToLegacy: async () => tunnel,
      onLogoutTunnelOAuth: async () => tunnel,
      onOpenExternalSetupPage: noop,
      onRefresh: noop,
      guidedTunnelSetupOpen: false,
      onGuidedTunnelSetupOpenChange: () => undefined,
      onGuidedTunnelLocalComplete: () => undefined,
    } as unknown as Parameters<typeof SettingsPage>[0];
    const markup = renderToStaticMarkup(createElement(SettingsPage, props));
    const stopButton = markup.match(/<button[^>]*>[^<]*Stop Tunnel[^<]*<\/button>/i);

    expect(stopButton).not.toBeNull();
    expect(stopButton?.[0]).not.toMatch(/disabled=""/);
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

    expect(markup).toContain('Stop Tunnel and Local MCP before scheduling a database restore.');
    expect(markup).toMatch(/<button(?=[^>]*disabled="")[^>]*>Restore<\/button>/);
  });

  it('explains the incomplete parts of a cross-platform restore', () => {
    const markup = renderToStaticMarkup(createElement(SettingsPage, {
      locale: 'en',
      initialSection: 'backup',
      dashboard: {
        ...dashboard,
        backups: [{ ...dashboard.backups[0]!, platform: 'win32', arch: 'x64', dataSchemaVersion: 15, hostCompatibility: 'cross_host' }],
        restoreNotice: {
          schemaVersion: 1,
          backupId: dashboard.backups[0]!.id,
          restoredAt: '2026-08-22T00:00:00.000Z',
          sourcePlatform: 'win32',
          sourceArch: 'x64',
          targetPlatform: 'linux',
          targetArch: 'x64',
          hostCompatibility: 'cross_host',
          incomplete: true,
          relinkRequired: true,
          quarantinedItems: ['workspace:foreign-workspace', 'file:checkpoint-master.key'],
        },
      },
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

    expect(markup).toContain('A backup from another platform was restored.');
    expect(markup).toContain('Add or relink each project folder on this machine');
    expect(markup).toContain('Host-bound secrets and providers were not transplanted.');
    expect(markup).toContain('Cross-platform');
  });

  it('shows ECC as installed but disabled by default in Tools settings', () => {
    const markup = renderToStaticMarkup(createElement(SettingsPage, {
      locale: 'en', initialSection: 'tools', dashboard,
      onLocaleChange: noop, onPermissionProfileChange: noop,
      onUnrestrictedChange: async (): Promise<boolean> => false,
      onDestructiveDeletePolicyChange: noop,
      onStdioPolicyChange: async (): Promise<boolean> => false,
      onCreateBackup: noop, onScheduleRestoreBackup: async (): Promise<boolean> => true,
      onRestoreRecoveryItem: noop, onRestoreCheckpoint: noop,
      onSaveTunnelApiKey: noop, onSetTunnelClientPath: noop,
      onUserSettingsChange: async (): Promise<boolean> => false,
      onChooseTunnelClientPath: async (): Promise<string | null> => null,
      onConfigureTunnelProfile: async (): Promise<string> => '',
      onStartTunnel: noop, onStopTunnel: noop,
    }));

    expect(markup).toContain('ECC Integration');
    expect(markup).toContain('DISABLED');
    expect(markup).toContain('ECC is installed but disabled');
    expect(markup).toContain('Enable ECC');
  });

  it('disables only automatic-update settings while the updater is unavailable and preserves saved preferences', () => {
    const render = (locale: 'th' | 'en', updatesUnavailable: boolean): string => {
      const oauthStatus = { state: 'idle' as const, available: false, providerId: null, authorizationUrl: null, message: null };
      const props = {
        locale,
        initialSection: 'general' as const,
        dashboard,
        updatesUnavailable,
        onLocaleChange: noop,
        onFactoryReset: async () => ({ accepted: false }),
        onPermissionProfileChange: noop,
        onUnrestrictedChange: async () => false,
        onDestructiveDeletePolicyChange: noop,
        onStdioPolicyChange: async () => false,
        onCreateBackup: noop,
        onScheduleRestoreBackup: async () => true,
        onRestoreRecoveryItem: noop,
        onRestoreCheckpoint: noop,
        onSaveTunnelApiKey: noop,
        onSetTunnelClientPath: noop,
        onUserSettingsChange: async () => false,
        ponytailPolicyContext: null,
        ponytailPolicyBusy: false,
        ponytailPolicyError: null,
        onWorkspacePonytailModeChange: noop,
        onGoalPonytailModeChange: noop,
        onInstallPdfProvider: async () => ({} as never),
        onChooseTunnelClientPath: async () => null,
        onConfigureTunnelProfile: async () => '',
        onStartTunnel: async () => EMPTY_TUNNEL_STATUS,
        onStopTunnel: noop,
        onBeginTunnelOAuthLogin: async () => oauthStatus,
        onGetTunnelOAuthLoginStatus: async () => oauthStatus,
        onCancelTunnelOAuthLogin: async () => oauthStatus,
        onSwitchTunnelAuthToLegacy: async () => EMPTY_TUNNEL_STATUS,
        onLogoutTunnelOAuth: async () => EMPTY_TUNNEL_STATUS,
        onOpenExternalSetupPage: noop,
        onRefresh: noop,
        guidedTunnelSetupOpen: false,
        onGuidedTunnelSetupOpenChange: () => undefined,
        onGuidedTunnelLocalComplete: () => undefined,
      } as unknown as Parameters<typeof SettingsPage>[0];
      return renderToStaticMarkup(createElement(SettingsPage, props));
    };

    const unavailableMarkup = render('en', true);
    const switches = (markup: string): string[] => [...markup.matchAll(/<button(?=[^>]*role="switch")[^>]*>[\s\S]*?<\/button>/g)].map(([button]) => button);
    const unavailableSwitches = switches(unavailableMarkup);
    const disabledFor = (controls: readonly string[], label: string): boolean => {
      const control = controls.find((button) => button.includes(label));
      expect(control).toBeDefined();
      return /disabled=""/.test(control ?? '');
    };

    expect(unavailableMarkup).toContain('Automatic updates are unavailable in this build. Your saved preferences are unchanged.');
    expect(unavailableMarkup).toMatch(/<input(?=[^>]*type="number")(?=[^>]*value="30")(?=[^>]*disabled="")[^>]*>/);
    expect([
      disabledFor(unavailableSwitches, 'Start with the host'),
      disabledFor(unavailableSwitches, 'Start minimized'),
      disabledFor(unavailableSwitches, 'Automatic update checks'),
      disabledFor(unavailableSwitches, 'Check on startup'),
      disabledFor(unavailableSwitches, 'Automatic update download'),
    ]).toEqual([false, false, true, true, true]);
    expect(unavailableSwitches.filter((button) => button.includes('Automatic update')).every((button) => button.includes('aria-checked="true"'))).toBe(true);

    const configurableMarkup = render('en', false);
    expect(configurableMarkup).not.toContain('Automatic updates are unavailable in this build.');
    expect(switches(configurableMarkup).some((button) => button.includes('disabled=""'))).toBe(false);
    expect(configurableMarkup).toMatch(/<input(?=[^>]*type="number")(?=[^>]*value="30")(?![^>]*disabled="")[^>]*>/);
    expect(render('th', true)).toContain('ระบบอัปเดตอัตโนมัติไม่พร้อมใช้งานในบิลด์นี้ ค่าที่บันทึกไว้ยังคงเดิม');
  });
});
