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
    desktopFullBypassAll: false,
    stdioFullBypassAll: false,
    mcpCallTimeoutMs: 60_000, mcpIdleTimeoutMs: 300_000, processTimeoutMs: 3_600_000, mcpPollWaitSeconds: 5, shellSynchronousWaitSeconds: 60,
    capabilityRoots: [], pdfProviderPath: '', lspCommands: {}, mcpHttpPort: 18_765, codexToolsEnabled: false,
    updateAutoCheck: true, updateCheckOnStartup: true, updateIntervalMinutes: 30, updateAutoDownload: true,
    closeBehavior: 'tray', launchAtStartup: false, startMinimized: false, tunnelAutoReconnect: true, tunnelMaxAutoRestarts: 5, recoveryRetentionDays: 0,
    extensions: { mode: 'enable_all', disabledServers: [], enabledServers: [], disabledSkillRoots: [], extraSkillRoots: [], extraMcpServers: [] },
  },
  appVersion: APP_VERSION,
};

function settingsMarkup(locale: 'th' | 'en', overrides: Partial<DashboardSnapshot> = {}): string {
  return renderToStaticMarkup(createElement(SettingsPage, {
    locale,
    initialSection: 'security',
    dashboard: { ...dashboard, ...overrides, locale },
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
  it('renders the actual 4.31.0 application version', () => {
    expect(APP_VERSION).toBe('4.31.0');
    const markup = renderToStaticMarkup(createElement(AppShell, {
      locale: 'en', appVersion: APP_VERSION, mcpRunning: false, desktopFullBypassOn: false, stdioFullBypassOn: false, updateStatus: null, screen: 'settings',
      onNavigate: () => undefined, onLocaleChange: () => undefined, onUpdateAction: () => undefined, children: createElement('div'),
    }));
    expect(markup).toContain('v4.31.0');
  });

  it('keeps Desktop and STDIO Full Bypass independently visible in the application header', () => {
    const markup = renderToStaticMarkup(createElement(AppShell, {
      locale: 'en', appVersion: APP_VERSION, mcpRunning: true, desktopFullBypassOn: true, stdioFullBypassOn: true, updateStatus: null, screen: 'home',
      onNavigate: () => undefined, onLocaleChange: () => undefined, onUpdateAction: () => undefined, children: createElement('div'),
    }));
    expect(markup).toContain('DESKTOP FULL BYPASS ON');
    expect(markup).toContain('STDIO FULL BYPASS ON');
  });

  it('places both Full Bypass controls in the Full Access Unrestricted card, outside Custom', () => {
    const markup = settingsMarkup('en', { permissionProfile: 'full', stdioPermissionProfile: 'full' });
    const fullStart = markup.indexOf('aria-label="Full Access (Unrestricted)"');
    const customStart = markup.indexOf('aria-label="Custom Permission Profile"');
    expect(fullStart).toBeGreaterThan(0);
    expect(customStart).toBeGreaterThan(fullStart);

    const fullCard = markup.slice(fullStart, customStart);
    const customCard = markup.slice(customStart);
    expect(fullCard).toContain('Desktop Full Bypass');
    expect(fullCard).toContain('STDIO Full Bypass');
    expect(fullCard).toContain('Bypass always-confirm tools');
    expect(customCard).not.toContain('Desktop Full Bypass');
    expect(customCard).not.toContain('STDIO Full Bypass');
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

  it('explains the Full Bypass OFF and ON boundaries in English', () => {
    const markup = settingsMarkup('en');
    expect(markup).toContain('Structured file tools');
    expect(markup).toContain('canonical Active Project');
    expect(markup).toContain('Recovery Trash / checkpoints');
    expect(markup).toContain('With Full Bypass OFF');
    expect(markup).toContain('ordinary Full Access work does not prompt');
    expect(markup).toContain('always-confirm, destructive, and out-of-scope');
    expect(markup).toContain('With Full Bypass ON');
    expect(markup).toContain('all lnwjud application approvals and scope checks are skipped');
    expect(markup).toContain('not covered by Recovery Trash');
  });

  it('explains the same Full Bypass boundaries in Thai', () => {
    const markup = settingsMarkup('th');
    expect(markup).toContain('เครื่องมือไฟล์แบบมีโครงสร้าง');
    expect(markup).toContain('Active Project แบบ canonical');
    expect(markup).toContain('Recovery Trash / checkpoint');
    expect(markup).toContain('เมื่อ Full Bypass ปิด');
    expect(markup).toContain('งานปกติของ Full Access จะไม่ถาม');
    expect(markup).toContain('tool ที่ต้องยืนยันเสมอ');
    expect(markup).toContain('เมื่อเปิด Full Bypass');
    expect(markup).toContain('ข้ามการอนุมัติและขอบเขตระดับแอปทั้งหมด');
    expect(markup).toContain('ไม่อยู่ใน Recovery Trash');
  });
});
