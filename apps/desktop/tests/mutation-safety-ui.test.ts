import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APP_VERSION, type DashboardSnapshot } from '@lnwjud/ipc-contracts';
import { AppShell } from '../src/renderer/features/shell/AppShell.js';
import { SettingsPage } from '../src/renderer/features/settings/SettingsPage.js';

const noop = async (): Promise<void> => undefined;
const recoveryTrashPath = 'C:\\Users\\Tester\\AppData\\Roaming\\lnwjud\\recovery-trash';
const dashboard: DashboardSnapshot = {
  selectedWorkspace: { id: 'workspace-a', displayName: 'Project A', rootPath: 'E:\\project-a', realRootPath: 'E:\\project-a', createdAt: new Date(0).toISOString() },
  activeWorkspaces: [{ id: 'workspace-a', displayName: 'Project A', rootPath: 'E:\\project-a', realRootPath: 'E:\\project-a', createdAt: new Date(0).toISOString() }],
  gitSummary: { branch: 'main', changedFiles: 0, stagedFiles: 0, message: '' },
  mcp: { running: false, url: null, workspaceId: 'workspace-a' },
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
  destructiveDeletePolicy: {
    protectCriticalFiles: true,
    recoverableDelete: true,
    approvals: { delete_file: true, git_rm: false, git_clean: false, git_reset_restore: false, shell_rm_unlink: false, shell_rmdir: false, shell_del_erase: false, wsl_rm_unlink: false, wsl_rmdir: false },
  },
  stdioPermissionProfile: 'full',
  stdioStrictRoots: false,
  stdioAllowedRoots: [],
  backups: [],
  recovery: { trashRoot: recoveryTrashPath, trashItems: [], checkpoints: [] },
  connectionModes: { httpUrl: null, stdioCommand: 'lnwjud --mcp-stdio' },
  workLog: [],
  inFlight: [],
  tunnel: { state: 'stopped', source: 'desktop', hasApiKey: false, clientPath: null, profileExists: false, message: null, logPath: null, persistent: null },
  settings: {
    customPermission: { read: 'ALLOW', write: 'ASK', execute: 'ASK', dangerous: 'DENY', allowedExecutables: [] },
    mcpCallTimeoutMs: 60_000, mcpIdleTimeoutMs: 300_000, processTimeoutMs: 3_600_000, mcpPollWaitSeconds: 5, shellSynchronousWaitSeconds: 60,
    capabilityRoots: [], pdfProviderPath: '', lspCommands: {}, mcpHttpPort: 18_765, codexToolsEnabled: false,
    updateAutoCheck: true, updateCheckOnStartup: true, updateIntervalMinutes: 30, updateAutoDownload: true,
    closeBehavior: 'tray', launchAtStartup: false, startMinimized: false, tunnelAutoReconnect: true, tunnelMaxAutoRestarts: 5, recoveryRetentionDays: 0,
    extensions: { mode: 'enable_all', disabledServers: [], enabledServers: [], disabledSkillRoots: [], extraSkillRoots: [], extraMcpServers: [] },
  },
  appVersion: APP_VERSION,
};

function settingsMarkup(locale: 'th' | 'en'): string {
  return renderToStaticMarkup(createElement(SettingsPage, {
    locale,
    initialSection: 'security',
    dashboard: { ...dashboard, locale },
    onLocaleChange: noop,
    onPermissionProfileChange: noop,
    onUnrestrictedChange: async (): Promise<boolean> => false,
    onDestructiveDeletePolicyChange: noop,
    onStdioPolicyChange: async (): Promise<boolean> => false,
    onCreateBackup: noop,
    onScheduleRestoreBackup: async (): Promise<boolean> => false,
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
}

function recoveryMarkup(locale: 'th' | 'en'): string {
  return renderToStaticMarkup(createElement(SettingsPage, {
    locale,
    initialSection: 'backup',
    dashboard: { ...dashboard, locale },
    onLocaleChange: noop,
    onPermissionProfileChange: noop,
    onUnrestrictedChange: async (): Promise<boolean> => false,
    onDestructiveDeletePolicyChange: noop,
    onStdioPolicyChange: async (): Promise<boolean> => false,
    onCreateBackup: noop,
    onScheduleRestoreBackup: async (): Promise<boolean> => false,
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
}

describe('mutation safety UI contract', () => {
  it('renders the actual 4.12.0 application version', () => {
    expect(APP_VERSION).toBe('4.12.0');
    const markup = renderToStaticMarkup(createElement(AppShell, {
      locale: 'en', appVersion: APP_VERSION, mcpRunning: false, updateStatus: null, screen: 'settings',
      onNavigate: () => undefined, onLocaleChange: () => undefined, onUpdateAction: () => undefined, children: createElement('div'),
    }));
    expect(markup).toContain('v4.12.0');
  });

  it('renders all destructive auto-approval settings and keeps critical/recovery safeguards locked', () => {
    const markup = settingsMarkup('en');
    const destructiveSection = markup.slice(markup.indexOf('Delete &amp; Data-Loss Safety'), markup.indexOf('STDIO Security Policy'));
    for (const key of ['delete_file', 'git_rm', 'git_clean', 'git_reset_restore', 'shell_rm_unlink', 'shell_rmdir', 'shell_del_erase', 'wsl_rm_unlink', 'wsl_rmdir']) {
      expect(destructiveSection).toContain(`<strong>${key}</strong>`);
    }
    expect(destructiveSection).toContain('Protected Critical Files — always on');
    expect(destructiveSection).toContain('Recovery Trash — always on for delete_file');
    expect(destructiveSection.match(/role="switch"/g)).toHaveLength(11);
    expect(destructiveSection.match(/role="switch"[^>]*disabled/g)).toHaveLength(2);
  });

  it('displays the absolute host-provided Recovery Trash path without inventing a renderer path', () => {
    const markup = recoveryMarkup('en');
    expect(recoveryTrashPath).toMatch(/^[A-Za-z]:\\/);
    expect(markup).toContain(recoveryTrashPath.replaceAll('\\', '\\'));
    expect(markup).toContain('Local Recovery Trash location');
  });

  it('explains Full Access and destructive-only boundaries in English', () => {
    const markup = settingsMarkup('en');
    expect(markup).toContain('Structured file tools');
    expect(markup).toContain('canonical Active Project');
    expect(markup).toContain('Recovery Trash / checkpoints');
    expect(markup).toContain('Under Full Access');
    expect(markup).toContain('do not prompt');
    expect(markup).toContain('deletion/data-loss');
    expect(markup).toContain('dangerous machine-level commands remain blocked');
    expect(markup).toContain('exact target proven inside the Active Project');
    expect(markup).toContain('not covered by Recovery Trash');
  });

  it('explains the same Full Access boundaries in Thai', () => {
    const markup = settingsMarkup('th');
    expect(markup).toContain('เครื่องมือไฟล์แบบมีโครงสร้าง');
    expect(markup).toContain('Active Project แบบ canonical');
    expect(markup).toContain('Recovery Trash / checkpoint');
    expect(markup).toContain('เมื่อใช้ Full Access');
    expect(markup).toContain('จะไม่ถามยืนยัน');
    expect(markup).toContain('การลบ/ทำข้อมูลหาย');
    expect(markup).toContain('คำสั่งระดับเครื่องอันตรายยังถูกบล็อก');
    expect(markup).toContain('target ได้ชัดและอยู่ใน Active Project');
    expect(markup).toContain('ไม่อยู่ใน Recovery Trash');
  });
});
