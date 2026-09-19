import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APP_VERSION, EMPTY_TUNNEL_STATUS, type DashboardSnapshot } from '@lnwjud/ipc-contracts';
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
  tunnel: EMPTY_TUNNEL_STATUS,
  settings: {
    customPermission: { read: 'ALLOW', write: 'ASK', execute: 'ASK', dangerous: 'DENY', allowedExecutables: [] },
    desktopFullBypassAll: false,
    stdioFullBypassAll: false,
    mcpCallTimeoutMs: 60_000, mcpIdleTimeoutMs: 300_000, processTimeoutMs: 3_600_000, mcpPollWaitSeconds: 5, shellSynchronousWaitSeconds: 60,
    capabilityRoots: [], pdfProviderPath: '', lspCommands: {}, mcpHttpPort: 18_765, codexToolsEnabled: false, ponytailMode: 'off',
    updateAutoCheck: true, updateCheckOnStartup: true, updateIntervalMinutes: 30, updateAutoDownload: true,
    closeBehavior: 'tray', launchAtStartup: false, startMinimized: false, tunnelAutoReconnect: true, tunnelMaxAutoRestarts: 5, recoveryRetentionDays: 0,
    extensions: { mode: 'enable_all', disabledServers: [], enabledServers: [], disabledSkillRoots: [], extraSkillRoots: [], extraMcpServers: [] },
  },
  hostPlatform: 'win32',
  hostArch: 'x64',
  appVersion: APP_VERSION,
};

function settingsMarkup(locale: 'th' | 'en', overrides: Partial<DashboardSnapshot> = {}, section: 'security' | 'mcp' = 'security'): string {
  return renderToStaticMarkup(createElement(SettingsPage, {
    locale,
    initialSection: section,
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
    ponytailPolicyContext: { workspaceId: 'workspace-a', globalMode: dashboard.settings.ponytailMode, workspaceMode: 'inherit', effectiveWorkspaceMode: dashboard.settings.ponytailMode, effectiveWorkspaceSource: 'global', activeGoals: [] },
    ponytailPolicyBusy: false,
    ponytailPolicyError: null,
    onWorkspacePonytailModeChange: noop,
    onGoalPonytailModeChange: noop,
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
    ponytailPolicyContext: { workspaceId: 'workspace-a', globalMode: dashboard.settings.ponytailMode, workspaceMode: 'inherit', effectiveWorkspaceMode: dashboard.settings.ponytailMode, effectiveWorkspaceSource: 'global', activeGoals: [] },
    ponytailPolicyBusy: false,
    ponytailPolicyError: null,
    onWorkspacePonytailModeChange: noop,
    onGoalPonytailModeChange: noop,
    onChooseTunnelClientPath: async (): Promise<string | null> => null,
    onConfigureTunnelProfile: async (): Promise<string> => '',
    onStartTunnel: noop,
    onStopTunnel: noop,
  }));
}

describe('mutation safety UI contract', () => {
  it('renders the actual 5.3.1 application version', () => {
    expect(APP_VERSION).toBe('5.3.1');
    const markup = renderToStaticMarkup(createElement(AppShell, {
      locale: 'en', appVersion: APP_VERSION, hostPlatform: 'win32', mcpRunning: false, desktopFullBypassOn: false, stdioFullBypassOn: false, updateStatus: null, screen: 'settings',
      onNavigate: () => undefined, onLocaleChange: () => undefined, onUpdateAction: () => undefined, children: createElement('div'),
    }));
    expect(markup).toContain('v5.3.1');
    expect(markup).toContain('data-host-platform="win32"');
  });

  it('labels the sidebar runtime as Desktop Agent and keeps the OS suffix cross-platform', () => {
    const markup = renderToStaticMarkup(createElement(AppShell, {
      locale: 'en', appVersion: APP_VERSION, hostPlatform: 'win32', mcpRunning: true, desktopFullBypassOn: false, stdioFullBypassOn: false, updateStatus: null, screen: 'home',
      onNavigate: () => undefined, onLocaleChange: () => undefined, onUpdateAction: () => undefined, children: createElement('div'),
    }));
    expect(markup).toMatch(/Desktop Agent · (Windows|macOS|Linux|Desktop)/);
    expect(markup).toContain('Connected');
    expect(markup).not.toContain('Native Desktop');
  });

  it('keeps Desktop and STDIO Full Bypass independently visible in the application header', () => {
    const markup = renderToStaticMarkup(createElement(AppShell, {
      locale: 'en', appVersion: APP_VERSION, hostPlatform: 'win32', mcpRunning: true, desktopFullBypassOn: true, stdioFullBypassOn: true, updateStatus: null, screen: 'home',
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
    expect(fullCard).toContain('skip lnwjud prompts');
    expect(fullCard).toContain('risky actions or paths outside projects');
    expect(fullCard).toContain('Windows/macOS/Linux and external services can still deny an action');
    expect(customCard).not.toContain('Desktop Full Bypass');
    expect(customCard).not.toContain('STDIO Full Bypass');
  });

  it('renders all destructive auto-approval settings and keeps critical/recovery safeguards locked', () => {
    const markup = settingsMarkup('en');
    const destructiveSection = markup.slice(markup.indexOf('Delete &amp; Data-Loss Safety'), markup.indexOf('aria-label="Direct STDIO permissions"'));
    for (const key of ['delete_file', 'git_rm', 'git_clean', 'git_reset_restore', 'shell_rm_unlink', 'shell_rmdir', 'shell_del_erase', 'wsl_rm_unlink', 'wsl_rmdir']) {
      expect(destructiveSection).toContain(`<strong>${key}</strong>`);
    }
    expect(destructiveSection).toContain('Protected Critical Files — always on');
    expect(destructiveSection).toContain('Recovery Trash — always on for delete_file');
    expect(destructiveSection.match(/role="switch"/g)).toHaveLength(11);
    expect(destructiveSection.match(/role="switch"[^>]*disabled/g)).toHaveLength(2);
  });

  it('hides Windows-only WSL destructive controls on macOS and Linux', () => {
    for (const hostPlatform of ['darwin', 'linux'] as const) {
      const markup = settingsMarkup('en', { hostPlatform, hostArch: hostPlatform === 'darwin' ? 'arm64' : 'x64' });
      const destructiveSection = markup.slice(markup.indexOf('Delete &amp; Data-Loss Safety'), markup.indexOf('aria-label="Direct STDIO permissions"'));
      expect(destructiveSection).not.toContain('<strong>wsl_rm_unlink</strong>');
      expect(destructiveSection).not.toContain('<strong>wsl_rmdir</strong>');
      expect(destructiveSection.match(/role="switch"/g)).toHaveLength(9);
    }
  });

  it('displays the absolute host-provided Recovery Trash path without inventing a renderer path', () => {
    const markup = recoveryMarkup('en');
    expect(recoveryTrashPath).toMatch(/^[A-Za-z]:\\/);
    expect(markup).toContain(recoveryTrashPath.replaceAll('\\', '\\'));
    expect(markup).toContain('Local Recovery Trash location');
  });

  it('explains the Full Bypass OFF and ON boundaries in English', () => {
    const markup = settingsMarkup('en');
    expect(markup).toContain('Lets some local tools use explicitly requested paths more broadly');
    expect(markup).toContain('does not disable approval prompts');
    expect(markup).toContain('or let structured file tools bypass the Active Project');
    expect(markup).toContain('With Full Bypass off');
    expect(markup).toContain('safeguards to deletes, data-loss actions, and out-of-scope work');
    expect(markup).toContain('With Full Bypass on');
    expect(markup).toContain('lnwjud approval, command policy, Active Project, and allowed-root checks are skipped');
    expect(markup).toContain('current goalLease ownership proof is still required for an active rolling scheduled/durable goal');
    expect(markup).toContain('Windows/macOS/Linux and external services can still deny an action');
  });

  it('explains the same Full Bypass boundaries in Thai', () => {
    const markup = settingsMarkup('th');
    expect(markup).toContain('เครื่องมือบางชนิดในเครื่องเข้าถึง path ที่ระบุได้กว้างขึ้น');
    expect(markup).toContain('ไม่ได้ปิดการถามยืนยัน');
    expect(markup).toContain('ไม่ได้ทำให้เครื่องมือไฟล์ข้าม Active Project');
    expect(markup).toContain('ถ้า Full Bypass ปิด');
    expect(markup).toContain('ป้องกันงานลบ งานที่อาจทำข้อมูลหาย และงานนอกขอบเขต');
    expect(markup).toContain('ถ้า Full Bypass เปิด');
    expect(markup).toContain('ข้าม approval, command policy, Active Project และ allowed-root checks ของ lnwjud');
    expect(markup).toContain('ไม่ข้าม current goalLease ownership proof ของ active rolling scheduled/durable goal');
    expect(markup).toContain('Windows/macOS/Linux และบริการภายนอกยังสามารถปฏิเสธคำสั่งได้');
  });

  it('renders one Ponytail policy editor with a global default and optional inherited overrides', () => {
    const markup = settingsMarkup('en', {}, 'mcp');
    expect(markup).toContain('id="ponytail-global-mode"');
    expect(markup).not.toContain('id="ponytail-mode"');
    expect(markup).toContain('Ponytail Policy');
    expect(markup).toContain('Global default');
    expect(markup).toContain('<option value="off" selected="">Off</option>');
    expect(markup).toContain('<option value="lite">Lite</option>');
    expect(markup).toContain('<option value="full">Full</option>');
    expect(markup).toContain('<option value="ultra">Ultra</option>');
    expect(markup).toContain('Advanced overrides — optional');
    expect(markup).toContain('Inherit Global');
    expect(markup).toContain('Effective: Off · Global');
  });
});
