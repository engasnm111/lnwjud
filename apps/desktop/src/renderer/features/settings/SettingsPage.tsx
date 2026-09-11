import { useEffect, useState, type ReactElement } from 'react';
import type { DashboardSnapshot, DestructiveDeletePolicy, ExternalSetupTarget, PdfProviderInstallResult, PermissionProfileName, PonytailModeOverride, PonytailPolicyContext, TunnelOAuthLoginStatus, TunnelStatus, UiLocale, UserSettings } from '@lnwjud/ipc-contracts';
import { formatDateTime } from '../../date-time.js';
import { createTranslator } from '../../i18n/index.js';
import { tunnelRuntimeCredentialAvailable } from '../../tunnel-auth-readiness.js';
import { tunnelAuthPresentation } from '../../tunnel-auth-presentation.js';
import { GuidedTunnelSetup } from '../onboarding/GuidedTunnelSetup.js';
import { isTunnelRunning } from '../onboarding/guided-tunnel-setup-state.js';
import { SettingSwitch } from './SettingSwitch.js';
import { UserConfigPanel, type UserConfigSection } from './UserConfigPanel.js';

interface SettingsPageProps {
  readonly locale: UiLocale;
  readonly dashboard: DashboardSnapshot;
  readonly onLocaleChange: (locale: UiLocale) => Promise<void>;
  readonly onPermissionProfileChange: (profile: PermissionProfileName) => Promise<void>;
  readonly onUnrestrictedChange: (enabled: boolean) => Promise<boolean>;
  readonly onDestructiveDeletePolicyChange: (policy: DestructiveDeletePolicy) => Promise<void>;
  readonly onStdioPolicyChange: (profile: PermissionProfileName, strictRoots: boolean, allowedRoots: readonly string[]) => Promise<boolean>;
  readonly onCreateBackup: () => Promise<void>;
  readonly onScheduleRestoreBackup: (backupId: string) => Promise<boolean>;
  readonly onRestoreRecoveryItem: (workspaceId: string, recoveryId: string) => Promise<void>;
  readonly onRestoreCheckpoint: (workspaceId: string, checkpointId: string) => Promise<void>;
  readonly onSaveTunnelApiKey: (apiKey: string) => Promise<void>;
  readonly onSetTunnelClientPath: (clientPath: string) => Promise<void>;
  readonly onUserSettingsChange: (settings: UserSettings) => Promise<boolean>;
  readonly ponytailPolicyContext: PonytailPolicyContext | null;
  readonly ponytailPolicyBusy: boolean;
  readonly ponytailPolicyError: string | null;
  readonly onWorkspacePonytailModeChange: (mode: PonytailModeOverride) => Promise<void>;
  readonly onGoalPonytailModeChange: (goalId: string, expectedRevision: number, mode: PonytailModeOverride) => Promise<void>;
  readonly onInstallPdfProvider: () => Promise<PdfProviderInstallResult>;
  readonly onChooseTunnelClientPath: () => Promise<string | null>;
  readonly onConfigureTunnelProfile: (tunnelId: string) => Promise<string>;
  readonly onStartTunnel: () => Promise<TunnelStatus>;
  readonly onStopTunnel: () => Promise<void>;
  readonly onBeginTunnelOAuthLogin: () => Promise<TunnelOAuthLoginStatus>;
  readonly onGetTunnelOAuthLoginStatus: () => Promise<TunnelOAuthLoginStatus>;
  readonly onCancelTunnelOAuthLogin: () => Promise<TunnelOAuthLoginStatus>;
  readonly onSwitchTunnelAuthToLegacy: () => Promise<TunnelStatus>;
  readonly onLogoutTunnelOAuth: () => Promise<TunnelStatus>;
  readonly onOpenExternalSetupPage: (target: ExternalSetupTarget) => Promise<void>;
  readonly onRefresh: () => Promise<void>;
  readonly guidedTunnelSetupOpen: boolean;
  readonly onGuidedTunnelSetupOpenChange: (open: boolean) => void;
  readonly onGuidedTunnelLocalComplete: () => void;
  readonly initialSection?: SettingsSection;
  readonly requestedSection?: { readonly section: SettingsSection; readonly focus?: SettingsFocusTarget; readonly requestId: number } | undefined;
}

export type SettingsSection = 'general' | 'security' | 'tools' | 'mcp' | 'tunnel' | 'backup';
export type SettingsFocusTarget = 'security-profile' | 'tools-codex' | 'tools-local-providers' | 'mcp-servers';
type DestructiveApprovalKey = keyof DestructiveDeletePolicy['approvals'];

export function SettingsPage(props: SettingsPageProps): ReactElement {
  const t = createTranslator(props.locale);
  const hostPlatform = props.dashboard.hostPlatform;
  const hostArch = props.dashboard.hostArch;
  const secureStorageLabel = hostPlatform === 'darwin' ? 'macOS Keychain' : hostPlatform === 'linux' ? 'system keyring' : 'Windows DPAPI';
  const guidedTunnelRunning = isTunnelRunning(props.dashboard.tunnel);
  const guidedTunnelConfigured = tunnelRuntimeCredentialAvailable(props.dashboard.tunnel) && props.dashboard.tunnel.profileExists;
  const tunnelPresentation = tunnelAuthPresentation(props.dashboard.tunnel);
  const remoteMcp = props.dashboard.remoteMcp ?? {
    state: 'stopped' as const, provider: 'ngrok' as const, installed: false, automaticInstallAvailable: false, automaticInstallMethod: null, hasAuthtoken: false, ngrokPath: null,
    localMcpUrl: props.dashboard.mcp.url, localGatewayUrl: null, publicMcpUrl: null, pairingCode: null, pairingCodeExpiresAt: null,
    oauthProtected: true, oauthConnected: false, pairingRequired: false, autoStartEnabled: false, message: null,
  };
  const ngrokReady = remoteMcp.installed && remoteMcp.ngrokPath !== null;
  const ngrokAutoInstallAvailable = remoteMcp.automaticInstallAvailable;
  const remoteMcpOnline = remoteMcp.state === 'running';
  const secureTunnelOnline = props.dashboard.tunnel.state === 'running';
  const activeRemoteConnections = Number(remoteMcpOnline) + Number(secureTunnelOnline);
  const [remoteMethodOpen, setRemoteMethodOpen] = useState(remoteMcpOnline || !guidedTunnelConfigured);
  const [secureMethodOpen, setSecureMethodOpen] = useState(!remoteMcpOnline);
  const [activeSection, setActiveSection] = useState<SettingsSection>(props.initialSection ?? 'general');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [clientPath, setClientPath] = useState(props.dashboard.tunnel.clientPath ?? '');
  const [tunnelId, setTunnelId] = useState('');
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [tunnelMessage, setTunnelMessage] = useState<string | null>(null);
  const [remoteMcpAuthtoken, setRemoteMcpAuthtoken] = useState('');
  const [remoteMcpBusy, setRemoteMcpBusy] = useState(false);
  const [remoteMcpMessage, setRemoteMcpMessage] = useState<string | null>(null);
  const [oauthLogin, setOauthLogin] = useState<TunnelOAuthLoginStatus | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [stdioProfile, setStdioProfile] = useState<PermissionProfileName>(props.dashboard.stdioPermissionProfile);
  const [strictRoots, setStrictRoots] = useState(props.dashboard.stdioStrictRoots);
  const [allowedRootsText, setAllowedRootsText] = useState(props.dashboard.stdioAllowedRoots.join('\n'));
  const [stdioDirty, setStdioDirty] = useState(false);
  const [stdioMessage, setStdioMessage] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [recoveryBusyId, setRecoveryBusyId] = useState<string | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [retentionBusy, setRetentionBusy] = useState(false);

  useEffect(() => {
    if (props.requestedSection === undefined) return;
    setActiveSection(props.requestedSection.section);
  }, [props.requestedSection]);

  useEffect(() => {
    if (remoteMcpOnline) {
      setRemoteMethodOpen(true);
      setSecureMethodOpen(false);
      return;
    }
    if (secureTunnelOnline) setSecureMethodOpen(true);
  }, [remoteMcpOnline, secureTunnelOnline]);

  useEffect(() => {
    const request = props.requestedSection;
    if (request?.focus === undefined || activeSection !== request.section) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(`[data-settings-focus="${request.focus}"]`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target?.focus({ preventScroll: true });
    });
    return (): void => { window.cancelAnimationFrame(frame); };
  }, [activeSection, props.requestedSection]);

  const persistedRootsText = props.dashboard.stdioAllowedRoots.join('\n');
  useEffect(() => {
    if (stdioDirty) return;
    setStdioProfile(props.dashboard.stdioPermissionProfile);
    setStrictRoots(props.dashboard.stdioStrictRoots);
    setAllowedRootsText(persistedRootsText);
  }, [props.dashboard.stdioPermissionProfile, props.dashboard.stdioStrictRoots, persistedRootsText, stdioDirty]);

  useEffect(() => {
    setClientPath(props.dashboard.tunnel.clientPath ?? '');
  }, [props.dashboard.tunnel.clientPath]);

  useEffect(() => {
    if (oauthLogin?.state !== 'waiting_for_browser' && oauthLogin?.state !== 'exchanging') return;
    let cancelled = false;
    const poll = window.setInterval(() => {
      void props.onGetTunnelOAuthLoginStatus().then(async (status) => {
        if (cancelled) return;
        setOauthLogin(status);
        if (status.state === 'completed') await props.onRefresh();
      }).catch(() => undefined);
    }, 1_000);
    return (): void => { cancelled = true; window.clearInterval(poll); };
  }, [oauthLogin?.state, props]);

  function updateDestructivePolicy(next: DestructiveDeletePolicy): void {
    void props.onDestructiveDeletePolicyChange(next);
  }

  function setDestructiveApproval(key: DestructiveApprovalKey, enabled: boolean): void {
    const current = props.dashboard.destructiveDeletePolicy;
    updateDestructivePolicy({
      ...current,
      protectCriticalFiles: true,
      recoverableDelete: true,
      approvals: { ...current.approvals, [key]: enabled },
    });
  }

  async function restoreTrashItem(workspaceId: string, recoveryId: string, relativePath: string, kind: 'deleted' | 'replacement_backup'): Promise<void> {
    const isReplacementBackup = kind === 'replacement_backup';
    const confirmed = window.confirm(props.locale === 'th'
      ? isReplacementBackup
        ? `ย้อน ${relativePath} กลับเป็นรุ่นก่อนเขียนทับ? ระบบจะเก็บรุ่นปัจจุบันเข้า Recovery Trash ไว้ให้ Undo ก่อน`
        : `กู้คืน ${relativePath} กลับตำแหน่งเดิม? ระบบจะไม่เขียนทับไฟล์ที่มีอยู่`
      : isReplacementBackup
        ? `Restore the pre-replacement version of ${relativePath}? The current version will first be kept in Recovery Trash for undo.`
        : `Restore ${relativePath} to its original location? Existing files will not be overwritten.`);
    if (!confirmed) return;
    setRecoveryBusyId(recoveryId);
    setRecoveryError(null);
    try {
      await props.onRestoreRecoveryItem(workspaceId, recoveryId);
      setRecoveryMessage(props.locale === 'th' ? `กู้คืน ${relativePath} แล้ว` : `Restored ${relativePath}.`);
    } catch (cause: unknown) {
      setRecoveryError(cause instanceof Error ? cause.message : (props.locale === 'th' ? 'กู้คืนไม่สำเร็จ' : 'Restore failed.'));
    } finally {
      setRecoveryBusyId(null);
    }
  }

  async function restoreCheckpoint(workspaceId: string, checkpointId: string, paths: readonly string[]): Promise<void> {
    const confirmed = window.confirm(props.locale === 'th'
      ? `ย้อนกลับ ${paths.length} ไฟล์ตาม checkpoint นี้? ระบบจะสร้าง checkpoint ใหม่ของสถานะปัจจุบันไว้ให้ Undo ก่อน`
      : `Restore ${paths.length} file(s) from this checkpoint? A new rollback checkpoint will be created first.`);
    if (!confirmed) return;
    setRecoveryBusyId(checkpointId);
    setRecoveryError(null);
    try {
      await props.onRestoreCheckpoint(workspaceId, checkpointId);
      setRecoveryMessage(props.locale === 'th' ? 'กู้ checkpoint แล้ว และสร้างจุด Undo ใหม่ไว้แล้ว' : 'Checkpoint restored and a new undo point was created.');
    } catch (cause: unknown) {
      setRecoveryError(cause instanceof Error ? cause.message : (props.locale === 'th' ? 'กู้ checkpoint ไม่สำเร็จ' : 'Checkpoint restore failed.'));
    } finally {
      setRecoveryBusyId(null);
    }
  }

  async function saveStdioPolicy(): Promise<void> {
    const roots = splitList(allowedRootsText);
    if (strictRoots && roots.length === 0) {
      setPolicyError(props.locale === 'th' ? 'Strict Roots ต้องกำหนด Allowed Root อย่างน้อย 1 path' : 'Strict Roots requires at least one Allowed Root path.');
      return;
    }
    setPolicyError(null);
    try {
      const restartRequired = await props.onStdioPolicyChange(stdioProfile, strictRoots, roots);
      setStdioDirty(false);
      setStdioMessage(restartRequired
        ? (props.locale === 'th' ? 'บันทึกแล้ว — ค่าใหม่จะใช้กับ standalone/headless STDIO connection ครั้งถัดไป' : 'Saved — the new policy applies to the next standalone/headless STDIO connection.')
        : t('settings.saved'));
    } catch (cause: unknown) {
      setPolicyError(cause instanceof Error ? cause.message : 'Could not save STDIO policy');
    }
  }

  async function browseTunnelClient(): Promise<void> {
    try {
      const selected = await props.onChooseTunnelClientPath();
      if (selected === null) return;
      setClientPath(selected);
      await props.onSetTunnelClientPath(selected);
      setSavedMessage(props.locale === 'th' ? 'บันทึก tunnel-client แล้ว' : 'tunnel-client saved.');
    } catch (cause: unknown) {
      setTunnelMessage(cause instanceof Error ? cause.message : 'Could not select tunnel-client');
    }
  }

  async function configureTunnel(): Promise<void> {
    if (tunnelId.trim().length === 0) {
      setTunnelMessage(props.locale === 'th' ? 'กรุณาใส่ Tunnel ID' : 'Enter a Tunnel ID.');
      return;
    }
    setTunnelBusy(true);
    setTunnelMessage(null);
    try {
      const profilePath = await props.onConfigureTunnelProfile(tunnelId.trim());
      setTunnelMessage(props.locale === 'th' ? `ตั้งค่า Tunnel สำเร็จ: ${profilePath}` : `Tunnel configured: ${profilePath}`);
    } catch (cause: unknown) {
      setTunnelMessage(cause instanceof Error ? cause.message : (props.locale === 'th' ? 'ตั้งค่า Tunnel ไม่สำเร็จ' : 'Tunnel setup failed.'));
    } finally {
      setTunnelBusy(false);
    }
  }

  async function reconnectSameTunnel(): Promise<void> {
    setTunnelBusy(true);
    setTunnelMessage(null);
    try {
      await props.onStartTunnel();
      setTunnelMessage(props.locale === 'th' ? 'สั่ง Reconnect Tunnel ID เดิมแล้ว' : 'Reconnect of the same tunnel identity requested.');
    } catch (cause: unknown) {
      setTunnelMessage(cause instanceof Error ? cause.message : (props.locale === 'th' ? 'Reconnect ไม่สำเร็จ' : 'Reconnect failed.'));
    } finally { setTunnelBusy(false); }
  }

  async function stopPersistentTunnel(): Promise<void> {
    setTunnelBusy(true);
    setTunnelMessage(null);
    try {
      await props.onStopTunnel();
      setTunnelMessage(props.locale === 'th' ? 'หยุด Persistent Tunnel แล้ว' : 'Persistent tunnel stopped.');
    } catch (cause: unknown) {
      setTunnelMessage(cause instanceof Error ? cause.message : (props.locale === 'th' ? 'หยุด Tunnel ไม่สำเร็จ' : 'Could not stop tunnel.'));
    } finally { setTunnelBusy(false); }
  }

  async function beginOAuthLogin(): Promise<void> {
    setOauthBusy(true);
    setTunnelMessage(null);
    try {
      const status = await props.onBeginTunnelOAuthLogin();
      setOauthLogin(status);
      if (!status.available && status.message !== null) setTunnelMessage(status.message);
    } catch (cause: unknown) {
      setTunnelMessage(cause instanceof Error ? cause.message : 'OAuth login could not be started');
    } finally { setOauthBusy(false); }
  }

  async function rollbackToLegacyAuth(): Promise<void> {
    setOauthBusy(true);
    try {
      await props.onSwitchTunnelAuthToLegacy();
      await props.onRefresh();
      setOauthLogin(null);
    } catch (cause: unknown) {
      setTunnelMessage(cause instanceof Error ? cause.message : 'Could not switch back to Runtime API key authentication');
    } finally { setOauthBusy(false); }
  }

  async function logoutOAuth(): Promise<void> {
    setOauthBusy(true);
    try {
      await props.onLogoutTunnelOAuth();
      await props.onRefresh();
      setOauthLogin(null);
    } catch (cause: unknown) {
      setTunnelMessage(cause instanceof Error ? cause.message : 'OAuth logout failed');
    } finally { setOauthBusy(false); }
  }

  async function setRecoveryRetentionDays(days: number): Promise<void> {
    const previousDays = props.dashboard.settings.recoveryRetentionDays;
    if (days > 0 && (previousDays === 0 || days < previousDays)) {
      const confirmed = window.confirm(props.locale === 'th'
        ? `เปิดลบข้อมูลกู้คืนอัตโนมัติที่เก่ากว่า ${days} วัน? ข้อมูลที่เก่ากว่านี้อาจถูกลบทันทีและกู้คืนไม่ได้`
        : `Enable automatic cleanup for recovery data older than ${days} days? Older recovery data may be removed immediately and cannot be restored.`);
      if (!confirmed) return;
    }
    setRetentionBusy(true);
    setRecoveryError(null);
    try {
      await props.onUserSettingsChange({ ...props.dashboard.settings, recoveryRetentionDays: days });
      setRecoveryMessage(days === 0
        ? (props.locale === 'th' ? 'ตั้งค่าให้เก็บข้อมูลกู้คืนไว้จนกว่าจะลบเอง' : 'Recovery data will be kept until you remove it manually.')
        : (props.locale === 'th' ? `ตั้งค่าลบข้อมูลกู้คืนที่เก่ากว่า ${days} วันอัตโนมัติแล้ว` : `Recovery data older than ${days} days will be removed automatically.`));
    } catch (cause: unknown) {
      setRecoveryError(cause instanceof Error ? cause.message : (props.locale === 'th' ? 'บันทึกอายุข้อมูลกู้คืนไม่สำเร็จ' : 'Could not save recovery retention.'));
    } finally {
      setRetentionBusy(false);
    }
  }

  async function createBackupNow(): Promise<void> {
    setBackupBusy(true);
    setBackupError(null);
    try {
      await props.onCreateBackup();
      setBackupMessage(props.locale === 'th' ? 'สำรองข้อมูลเรียบร้อยแล้ว' : 'Backup completed.');
    } catch (cause: unknown) {
      setBackupError(cause instanceof Error ? cause.message : 'Backup failed');
    } finally {
      setBackupBusy(false);
    }
  }

  async function scheduleRestore(backupId: string): Promise<void> {
    const confirmed = window.confirm(props.locale === 'th'
      ? 'กู้ฐานข้อมูลโปรแกรมจาก Backup ชุดนี้เมื่อเปิด lnwjud ครั้งถัดไป? ระบบจะสร้าง Backup ฉุกเฉินของฐานข้อมูลปัจจุบันก่อนแทนที่'
      : 'Restore the application database from this backup on the next lnwjud start? An emergency backup of the current database will be created before replacement.');
    if (!confirmed) return;
    setBackupBusy(true);
    setBackupError(null);
    try {
      const restartRequired = await props.onScheduleRestoreBackup(backupId);
      setBackupMessage(restartRequired
        ? (props.locale === 'th' ? 'เตรียม Restore แล้ว — ปิดและเปิด lnwjud ใหม่เพื่อใช้ข้อมูลชุดนี้' : 'Restore scheduled — restart lnwjud to apply it.')
        : (props.locale === 'th' ? 'เตรียม Restore แล้ว' : 'Restore scheduled.'));
    } catch (cause: unknown) {
      setBackupError(cause instanceof Error ? cause.message : 'Could not schedule restore');
    } finally {
      setBackupBusy(false);
    }
  }

  async function runRemoteMcpAction(action: 'install' | 'save' | 'start' | 'stop' | 'regenerate'): Promise<void> {
    if (action === 'regenerate') {
      const confirmed = window.confirm(props.locale === 'th'
        ? 'เชื่อม ChatGPT ใหม่? การเชื่อมต่อ OAuth ที่จำไว้และ Refresh Token เดิมจะถูกยกเลิก จากนั้นกด Connect ใน ChatGPT ใหม่ได้เลยโดยไม่ต้องใช้ PIN สำหรับ ChatGPT callback ที่รองรับ'
        : 'Reconnect ChatGPT? The remembered OAuth trust and existing refresh tokens will be revoked. Then press Connect in ChatGPT again; supported ChatGPT callbacks require no PIN.');
      if (!confirmed) return;
    }
    setRemoteMcpBusy(true);
    setRemoteMcpMessage(null);
    try {
      if (action === 'install') await window.lnwjud.installRemoteMcpProvider();
      if (action === 'save') {
        await window.lnwjud.saveRemoteMcpAuthtoken({ authtoken: remoteMcpAuthtoken });
        setRemoteMcpAuthtoken('');
      }
      if (action === 'start') await window.lnwjud.startRemoteMcp();
      if (action === 'stop') await window.lnwjud.stopRemoteMcp();
      if (action === 'regenerate') await window.lnwjud.regenerateRemoteMcpPairingCode();
      await props.onRefresh();
      setRemoteMcpMessage(props.locale === 'th' ? 'อัปเดต Remote MCP เรียบร้อยแล้ว' : 'Remote MCP updated.');
    } catch (cause: unknown) {
      setRemoteMcpMessage(cause instanceof Error ? cause.message : 'Remote MCP action failed');
    } finally {
      setRemoteMcpBusy(false);
    }
  }

  async function copyRemoteMcpUrl(): Promise<void> {
    const value = remoteMcp.publicMcpUrl;
    if (value === null) return;
    await navigator.clipboard.writeText(value);
    setRemoteMcpMessage(props.locale === 'th' ? 'คัดลอก Public MCP URL แล้ว' : 'Public MCP URL copied.');
  }

  async function openNgrokAuthtokenPage(): Promise<void> {
    setRemoteMcpMessage(null);
    try {
      await props.onOpenExternalSetupPage('ngrok_authtoken');
    } catch (cause: unknown) {
      const detail = cause instanceof Error ? cause.message : '';
      setRemoteMcpMessage(props.locale === 'th'
        ? `ERROR: เปิดหน้า ngrok Authtoken ไม่สำเร็จ${detail.length === 0 ? '' : ` — ${detail}`}`
        : `ERROR: Could not open the ngrok authtoken page${detail.length === 0 ? '' : ` — ${detail}`}`);
    }
  }

  const navItems: readonly { id: SettingsSection; icon: string; title: string; description: string }[] = [
    { id: 'general', icon: '⌘', title: props.locale === 'th' ? 'ทั่วไป' : 'General', description: props.locale === 'th' ? 'ภาษา, Startup, Update' : 'Language, startup, updates' },
    { id: 'security', icon: '◇', title: props.locale === 'th' ? 'ความปลอดภัย' : 'Security', description: props.locale === 'th' ? 'สิทธิ์และ Workspace policy' : 'Permissions and workspace policy' },
    { id: 'tools', icon: '◎', title: props.locale === 'th' ? 'Tools' : 'Tools', description: props.locale === 'th' ? 'Codex, Timeout, Roots' : 'Codex, timeouts, roots' },
    { id: 'mcp', icon: '⬡', title: 'MCP & Extensions', description: props.locale === 'th' ? 'Servers, Skills, Allowlist' : 'Servers, skills, allowlist' },
    { id: 'tunnel', icon: '↗', title: props.locale === 'th' ? 'Remote MCP & Tunnel' : 'Remote MCP & Tunnel', description: props.locale === 'th' ? 'OAuth, ngrok, API Key, Client' : 'OAuth, ngrok, API key, client' },
    { id: 'backup', icon: '▣', title: props.locale === 'th' ? 'กู้คืนข้อมูล' : 'Recovery', description: props.locale === 'th' ? 'Recovery Trash, Checkpoint, Backup' : 'Recovery Trash, checkpoints, backups' },
  ];

  const userConfigSection: UserConfigSection | null = activeSection === 'backup' ? null : activeSection;
  const currentNav = navItems.find((item) => item.id === activeSection) ?? navItems[0]!;

  return (
    <div className="page-content settings-page-v2">
      <div className="page-heading settings-page-heading">
        <div>
          <span className="settings-eyebrow">CONTROL CENTER</span>
          <h1>{t('settings.title')}</h1>
          <p className="page-subtitle">{props.locale === 'th' ? 'ตั้งค่าระบบจากหน้าเดียว โดยไม่ต้องแก้ไฟล์ config เอง' : 'Configure the system without editing configuration files manually.'}</p>
        </div>
        <div className="settings-health-chip"><span className="status-dot online" />{props.locale === 'th' ? 'Local settings' : 'Local settings'}</div>
      </div>

      <div className="settings-shell-v2">
        <aside className="settings-subnav" aria-label="Settings sections">
          {navItems.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`settings-nav-item ${activeSection === item.id ? 'is-active' : ''}`}
              aria-current={activeSection === item.id ? 'page' : undefined}
              onClick={() => setActiveSection(item.id)}
            >
              <span className="settings-nav-icon" aria-hidden="true">{item.icon}</span>
              <span className="settings-nav-copy"><strong>{item.title}</strong><small>{item.description}</small></span>
              <span className="settings-nav-chevron" aria-hidden="true">›</span>
            </button>
          ))}
        </aside>

        <div className="settings-content-v2">
          <header className="settings-section-header">
            <span className="settings-section-kicker">SETTINGS / {currentNav.title.toUpperCase()}</span>
            <h2>{currentNav.title}</h2>
            <p>{currentNav.description}</p>
          </header>

          {activeSection === 'general' ? (
            <section className="panel settings-card settings-card-polished" aria-label={t('settings.generalTitle')}>
              <SettingsCardHeading icon="A" title={t('settings.generalTitle')} subtitle={props.locale === 'th' ? 'ภาษา UI, Tray และข้อความระบบ' : 'UI, tray, and system-message language'} badge={props.locale.toUpperCase()} />
              <div className="setting-field max-field-width">
                <label className="field-label" htmlFor="locale-select">{t('settings.locale')}</label>
                <select id="locale-select" className="settings-select" value={props.locale} onChange={(event) => { void props.onLocaleChange(event.target.value as UiLocale); }}>
                  <option value="th">🇹🇭 {t('language.th')}</option>
                  <option value="en">🇺🇸 {t('language.en')}</option>
                </select>
              </div>
              <p className="hint">{props.locale === 'th' ? 'เปลี่ยนภาษาหน้าจอ Tray และข้อความระบบทันที' : 'Changes screen, tray, and system-message language immediately.'}</p>
            </section>
          ) : null}

          {activeSection === 'security' ? (
            <>
              <section className="panel settings-card settings-card-polished" aria-label={t('settings.securityTitle')} data-settings-focus="security-profile" tabIndex={-1}>
                <SettingsCardHeading icon="◇" title={t('settings.securityTitle')} subtitle={profileHint(props.locale, props.dashboard.permissionProfile)} badge={props.dashboard.permissionProfile.toUpperCase()} />
                <div className="setting-field max-field-width">
                  <label className="field-label" htmlFor="permission-profile">{t('settings.permissions')}</label>
                  <select id="permission-profile" aria-label="Permission profile" className="settings-select" value={props.dashboard.permissionProfile} onChange={(event) => { void props.onPermissionProfileChange(event.target.value as PermissionProfileName); }}>
                    <option value="safe">🛡️ {t('permission.safe')}</option>
                    <option value="balanced">⚖️ {t('permission.balanced')}</option>
                    <option value="full">⚡ {t('permission.full')}</option>
                    <option value="custom">🔧 {t('permission.custom')}</option>
                  </select>
                </div>
              </section>

              <UserConfigPanel
                locale={props.locale}
                hostPlatform={hostPlatform}
                hostArch={hostArch}
                permissionProfile={props.dashboard.permissionProfile}
                stdioPermissionProfile={props.dashboard.stdioPermissionProfile}
                settings={props.dashboard.settings}
                section="security"
                unrestricted={props.dashboard.unrestricted}
                onUnrestrictedChange={props.onUnrestrictedChange}
                onSave={props.onUserSettingsChange}
                onInstallPdfProvider={props.onInstallPdfProvider}
              />

              <section className="panel settings-card settings-card-polished" aria-label="AI destructive action policy">
                <SettingsCardHeading
                  icon="⌫"
                  title={props.locale === 'th' ? 'ความปลอดภัยการลบ / ทำข้อมูลหาย' : 'Delete & Data-Loss Safety'}
                  subtitle={props.locale === 'th' ? 'Full จะถามเฉพาะ destructive family ที่ยังไม่ได้อนุญาต หรือพิสูจน์ขอบเขตไม่ได้' : 'Full prompts only for destructive families that are not safely auto-approved by these settings'}
                  badge={`${Object.values(props.dashboard.destructiveDeletePolicy.approvals).filter(Boolean).length}/9`}
                />
                <div className="alert-box-warning" role="note">
                  ⚠️ {props.locale === 'th'
                    ? 'เมื่อ Full Bypass ปิด Full Access จะไม่ถามงานปกติ และ auto-approval ด้านล่างมีผลเฉพาะงานลบ/ทำข้อมูลหายที่พิสูจน์ target ได้ชัดใน Active Project; เมื่อเปิด Full Bypass จะข้ามการอนุมัติและขอบเขตระดับแอปทั้งหมด'
                    : 'With Full Bypass OFF, Full Access does not prompt for ordinary work and the auto-approval controls below remain narrowly scoped to exact targets in the Active Project. With Full Bypass ON, all lnwjud application approvals and scope checks are skipped.'}
                </div>
                <div className="setting-grid two-col align-center">
                  <SettingSwitch checked disabled label={props.locale === 'th' ? 'Protected Critical Files — บังคับเปิด' : 'Protected Critical Files — always on'} description={props.locale === 'th' ? 'critical path และ workspace root ไม่ถูก auto-approve แม้เปิด destructive family นั้นไว้' : 'Critical paths and workspace roots are never auto-approved even when a destructive family is enabled'} onChange={() => undefined} />
                  <SettingSwitch checked disabled label={props.locale === 'th' ? 'Recovery Trash — บังคับเปิดสำหรับ delete_file' : 'Recovery Trash — always on for delete_file'} description={props.locale === 'th' ? 'delete_file แบบมีโครงสร้างย้าย target เข้า Recovery Trash ก่อนเสมอ' : 'Structured delete_file moves its target into Recovery Trash before deletion'} onChange={() => undefined} />
                </div>

                <div className="settings-mini-heading"><strong>{props.locale === 'th' ? 'Structured delete — กู้คืนได้' : 'Structured delete — recoverable'}</strong><span>Host Active Project</span></div>
                <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.delete_file} label="delete_file" description={props.locale === 'th' ? 'Auto-approve ได้เฉพาะ path เดียวใน Active Project, ไม่ใช่ root/critical/wildcard และมี Recovery Trash' : 'Auto-approves one exact Active Project path only; roots, critical paths, and wildcards remain guarded and Recovery Trash is required'} onChange={(enabled) => setDestructiveApproval('delete_file', enabled)} />

                <div className="settings-mini-heading"><strong>Git destructive families</strong><span>{props.locale === 'th' ? 'exact scoped forms เท่านั้น' : 'exact scoped forms only'}</span></div>
                <div className="setting-grid two-col align-center">
                  <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.git_rm} label="git_rm" description={props.locale === 'th' ? 'อนุญาต git rm เฉพาะ target เดียวที่ระบุหลัง --; recursive/broad/critical ยังถาม' : 'Allows git rm only for one exact target after --; recursive, broad, and critical targets still ask'} onChange={(enabled) => setDestructiveApproval('git_rm', enabled)} />
                  <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.git_clean} label="git_clean" description={props.locale === 'th' ? 'อนุญาต git clean เฉพาะ exact path; clean ทั้ง repo, -d/-x และ broad forms ยังถาม' : 'Allows git clean only for an exact path; repo-wide clean, -d/-x, and broad forms still ask'} onChange={(enabled) => setDestructiveApproval('git_clean', enabled)} />
                  <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.git_reset_restore} label="git_reset_restore" description={props.locale === 'th' ? 'อนุญาต exact-path git restore; reset --hard และ restore แบบกว้างยังถามเพราะพิสูจน์ target ไม่ได้' : 'Allows exact-path git restore; reset --hard and broad restore still ask because the affected scope cannot be proven narrowly'} onChange={(enabled) => setDestructiveApproval('git_reset_restore', enabled)} />
                </div>

                <div className="settings-mini-heading"><strong>{props.locale === 'th' ? 'Shell / Process destructive families' : 'Shell / Process destructive families'}</strong><span>{props.locale === 'th' ? 'ไม่อยู่ใน Recovery Trash' : 'not Recovery Trash-backed'}</span></div>
                <div className="setting-grid two-col align-center">
                  <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.shell_rm_unlink} label="shell_rm_unlink" description={props.locale === 'th' ? 'Auto-approve rm/unlink target เดียว; -r/-R/recursive, wildcard และ path นอกโปรเจกต์ยังถาม' : 'Auto-approves one rm/unlink target; recursive flags, wildcards, and paths outside the project still ask'} onChange={(enabled) => setDestructiveApproval('shell_rm_unlink', enabled)} />
                  <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.shell_rmdir} label="shell_rmdir" description={props.locale === 'th' ? 'Auto-approve rmdir แบบ target เดียว; recursive/parents และ broad forms ยังถาม' : 'Auto-approves one rmdir target; recursive/parents and broad forms still ask'} onChange={(enabled) => setDestructiveApproval('shell_rmdir', enabled)} />
                  <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.shell_del_erase} label="shell_del_erase" description={props.locale === 'th' ? 'Auto-approve del/erase แบบ exact target เมื่อ parser พิสูจน์รูปแบบได้; /s และ broad forms ยังถาม' : 'Auto-approves exact del/erase targets when the parser can prove the form; /s and broad forms still ask'} onChange={(enabled) => setDestructiveApproval('shell_del_erase', enabled)} />
                </div>

                {hostPlatform === 'win32' ? (
                  <>
                    <div className="settings-mini-heading"><strong>WSL destructive families</strong><span>{props.locale === 'th' ? 'exact scoped forms เท่านั้น' : 'exact scoped forms only'}</span></div>
                    <div className="setting-grid two-col align-center">
                      <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.wsl_rm_unlink} label="wsl_rm_unlink" description={props.locale === 'th' ? 'Auto-approve WSL rm/unlink target เดียวใน Active Project; recursive/absolute Linux path/broad forms ยังถาม' : 'Auto-approves one WSL rm/unlink target in the Active Project; recursive, absolute Linux paths, and broad forms still ask'} onChange={(enabled) => setDestructiveApproval('wsl_rm_unlink', enabled)} />
                      <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.wsl_rmdir} label="wsl_rmdir" description={props.locale === 'th' ? 'Auto-approve WSL rmdir target เดียว; parents/broad/outside forms ยังถาม' : 'Auto-approves one WSL rmdir target; parents, broad, and outside forms still ask'} onChange={(enabled) => setDestructiveApproval('wsl_rmdir', enabled)} />
                    </div>
                  </>
                ) : null}

                <p className="hint">{props.locale === 'th' ? 'Full: READ / WRITE / EXECUTE และ mutation ปกติไม่ถาม ส่วน destructive family ที่ปิดไว้หรือพิสูจน์ exact scope ไม่ได้จะถามตามปกติ การ auto-approve command family ไม่ได้ทำให้ผลคำสั่งเข้า Recovery Trash' : 'Full: ordinary READ / WRITE / EXECUTE and normal mutations do not prompt. A destructive family still asks when disabled or when exact scope cannot be proven. Auto-approved command-family effects are not covered by Recovery Trash.'}</p>
              </section>

              <section className="panel settings-card settings-card-polished" aria-label="STDIO security policy">
                <SettingsCardHeading icon="▦" title="STDIO Security Policy" subtitle={props.locale === 'th' ? 'Policy สำหรับ standalone/headless stdio; Secure Tunnel ใช้ Desktop MCP และ native approval' : 'Policy for standalone/headless stdio; Secure Tunnel uses Desktop MCP and native approval'} badge={props.dashboard.stdioPermissionProfile.toUpperCase()} />
                <div className="setting-grid two-col align-center">
                  <div className="setting-field">
                    <label className="field-label" htmlFor="stdio-profile">STDIO Permission Profile</label>
                    <select id="stdio-profile" className="settings-select" value={stdioProfile} onChange={(event) => { setStdioProfile(event.target.value as PermissionProfileName); setStdioDirty(true); }}>
                      <option value="safe">Safe</option><option value="balanced">Balanced</option><option value="full">Full</option><option value="custom">Custom</option>
                    </select>
                  </div>
                  <SettingSwitch checked={strictRoots} label="Strict Workspace Roots" description={props.locale === 'th' ? 'บล็อก absolute path นอก Allowed Roots แบบ fail-closed' : 'Reject absolute paths outside Allowed Roots fail-closed'} onChange={(enabled) => { setStrictRoots(enabled); setStdioDirty(true); }} />
                </div>
                <div className="setting-field">
                  <label className="field-label" htmlFor="stdio-roots">{props.locale === 'th' ? 'Allowed Roots — หนึ่ง path ต่อบรรทัด' : 'Allowed Roots — one path per line'}</label>
                  <textarea id="stdio-roots" className="settings-textarea" rows={5} value={allowedRootsText} placeholder={hostPlatform === 'win32' ? 'E:\\Projects\\MyApp\nD:\\Shared\\Source' : '/Users/name/Projects\n/home/name/Source'} onChange={(event) => { setAllowedRootsText(event.target.value); setStdioDirty(true); }} />
                </div>
                <div className="inline-actions"><button type="button" className="btn-save-gold" disabled={!stdioDirty} onClick={() => { void saveStdioPolicy(); }}>{props.locale === 'th' ? 'บันทึก STDIO Policy' : 'Save STDIO Policy'}</button></div>
                {policyError === null ? null : <div className="alert-box-warning" role="alert">⚠️ {policyError}</div>}
                {stdioMessage === null ? null : <div className="toast-success-banner" role="status">✓ {stdioMessage}</div>}
              </section>
            </>
          ) : null}

          {userConfigSection === 'security' ? null : (
            <UserConfigPanel
              locale={props.locale}
              hostPlatform={hostPlatform}
              hostArch={hostArch}
              permissionProfile={props.dashboard.permissionProfile}
              stdioPermissionProfile={props.dashboard.stdioPermissionProfile}
              settings={props.dashboard.settings}
              section={userConfigSection}
              unrestricted={props.dashboard.unrestricted}
              onUnrestrictedChange={props.onUnrestrictedChange}
              onSave={props.onUserSettingsChange}
              onInstallPdfProvider={props.onInstallPdfProvider}
            />
          )}

          {activeSection === 'mcp' ? (
            <section className="panel settings-card settings-card-polished" aria-label="Scoped Ponytail policy" data-settings-focus="ponytail-policy-scopes" tabIndex={-1}>
              <SettingsCardHeading
                icon="P"
                title={props.locale === 'th' ? 'Ponytail Policy ตามขอบเขต' : 'Scoped Ponytail Policy'}
                subtitle={props.locale === 'th' ? 'Current Goal > Workspace > Global โดยเก็บค่าจริงตามขอบเขต' : 'Current Goal > Workspace > Global with persisted scope-specific settings'}
                badge={props.ponytailPolicyContext == null ? 'NO PROJECT' : `EFFECTIVE ${props.ponytailPolicyContext.effectiveWorkspaceMode.toUpperCase()}`}
              />
              {props.ponytailPolicyContext == null ? (
                <div className="empty-setting-state">{props.locale === 'th' ? 'เลือก Active Project ก่อนตั้งค่า Workspace หรือ Current Goal' : 'Select an Active Project before configuring Workspace or Current Goal policy.'}</div>
              ) : (
                <>
                  <div className="setting-field max-field-width">
                    <label className="field-label" htmlFor="ponytail-workspace-mode">{props.locale === 'th' ? 'Workspace override' : 'Workspace override'}</label>
                    <select
                      id="ponytail-workspace-mode"
                      className="settings-select"
                      disabled={props.ponytailPolicyBusy}
                      value={props.ponytailPolicyContext.workspaceMode}
                      onChange={(event) => { void props.onWorkspacePonytailModeChange(event.target.value as PonytailModeOverride).catch(() => undefined); }}
                    >
                      <option value="inherit">{props.locale === 'th' ? 'สืบทอด Global' : 'Inherit Global'}</option>
                      <option value="off">Off</option><option value="lite">Lite</option><option value="full">Full</option><option value="ultra">Ultra</option>
                    </select>
                    <p className="hint">{props.locale === 'th'
                      ? `Effective: ${props.ponytailPolicyContext.effectiveWorkspaceMode.toUpperCase()} · ${ponytailPolicySourceLabel(props.locale, props.ponytailPolicyContext.effectiveWorkspaceSource)}`
                      : `Effective: ${props.ponytailPolicyContext.effectiveWorkspaceMode.toUpperCase()} · ${ponytailPolicySourceLabel(props.locale, props.ponytailPolicyContext.effectiveWorkspaceSource)}`}</p>
                  </div>
                  <div className="settings-mini-heading"><strong>{props.locale === 'th' ? 'Current Goal overrides' : 'Current Goal overrides'}</strong><span>{props.ponytailPolicyContext.activeGoals.length}</span></div>
                  {props.ponytailPolicyContext.activeGoals.length === 0 ? (
                    <div className="empty-setting-state">{props.locale === 'th' ? 'ไม่มี durable goal ที่ active ในโปรเจกต์นี้' : 'No active durable goals in this project.'}</div>
                  ) : (
                    <div className="backup-list settings-backup-list ponytail-goal-list">
                      {props.ponytailPolicyContext.activeGoals.map((goal) => (
                        <div className="backup-item ponytail-goal-item" key={goal.goalId}>
                          <div className="ponytail-goal-copy">
                            <strong>{goal.goalKey}</strong>
                            <p className="hint">Effective: {goal.effectiveMode.toUpperCase()} · {ponytailPolicySourceLabel(props.locale, goal.effectiveSource)} · rev {goal.revision}</p>
                            {goal.editBlockedReason === null ? null : <p className="hint">{ponytailGoalEditBlockedLabel(props.locale, goal.editBlockedReason)}</p>}
                          </div>
                          <select
                            aria-label={`${goal.goalKey} Ponytail mode`}
                            className="settings-select ponytail-goal-select"
                            disabled={props.ponytailPolicyBusy || !goal.editable}
                            value={goal.mode}
                            onChange={(event) => { void props.onGoalPonytailModeChange(goal.goalId, goal.revision, event.target.value as PonytailModeOverride).catch(() => undefined); }}
                          >
                            <option value="inherit">{props.locale === 'th' ? 'สืบทอด Workspace' : 'Inherit Workspace'}</option>
                            <option value="off">Off</option><option value="lite">Lite</option><option value="full">Full</option><option value="ultra">Ultra</option>
                          </select>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
              {props.ponytailPolicyError == null ? null : <div className="alert-box-warning" role="alert">⚠️ {props.ponytailPolicyError}</div>}
            </section>
          ) : null}

          {activeSection === 'tunnel' ? (
            <>
              <div className="connection-choice-intro" role="note">
                <div>
                  <strong>{props.locale === 'th' ? 'เลือกวิธีเชื่อมต่อหลัก 1 วิธี' : 'Choose one primary connection method'}</strong>
                  <p>{props.locale === 'th'
                    ? 'สำหรับผู้ใช้ทั่วไป แนะนำ Remote MCP OAuth ด้านล่าง ส่วน Secure MCP Tunnel เป็นตัวเลือกทางเลือก/ขั้นสูง แต่ผู้ใช้ที่ต้องการสามารถเปิดทั้งสองพร้อมกันได้'
                    : 'For most users, Remote MCP OAuth is recommended. Secure MCP Tunnel remains an alternative/advanced option, and both may run at the same time when needed.'}</p>
                </div>
                <span className={`connection-count-chip ${activeRemoteConnections > 1 ? 'is-dual' : activeRemoteConnections === 1 ? 'is-online' : ''}`}>{activeRemoteConnections} {props.locale === 'th' ? 'ช่องทางออนไลน์' : 'online'}</span>
              </div>

              <details
                className="connection-method-stack is-recommended"
                open={remoteMethodOpen}
                onToggle={(event) => setRemoteMethodOpen(event.currentTarget.open)}
              >
                <summary className="connection-method-summary">
                  <div className="connection-method-summary-copy">
                    <span className="connection-method-kicker">{props.locale === 'th' ? 'แนะนำ · OAuth' : 'Recommended · OAuth'}</span>
                    <strong>Remote MCP — ngrok + OAuth</strong>
                    <span>{props.locale === 'th' ? 'เชื่อม ChatGPT ผ่าน HTTPS /mcp — กด Connect ได้เลย ไม่ต้องกรอก PIN สำหรับ ChatGPT' : 'Connect ChatGPT through HTTPS /mcp — press Connect with no PIN for supported ChatGPT clients.'}</span>
                  </div>
                  <div className="connection-method-summary-status">
                    <span className={`connection-method-live-dot ${remoteMcpOnline ? 'is-online' : ''}`} aria-hidden="true" />
                    <span>{remoteMcpOnline ? 'ONLINE' : ngrokReady && remoteMcp.hasAuthtoken ? 'READY' : 'SETUP'}</span>
                    <span className="connection-method-chevron" aria-hidden="true">⌄</span>
                  </div>
                </summary>
                <section className="panel settings-card settings-card-polished guided-tunnel-launch-card connection-method-panel" aria-label="Remote MCP with ngrok and OAuth">
                <SettingsCardHeading
                  icon="◎"
                  title={props.locale === 'th' ? 'Remote MCP — ngrok + OAuth' : 'Remote MCP — ngrok + OAuth'}
                  subtitle={props.locale === 'th' ? 'แนะนำ: Admin Publish Custom App ครั้งเดียว จากนั้นสมาชิกกด Connect ใน ChatGPT ได้เลย; lnwjud จำ OAuth trust และ reconnect อัตโนมัติ' : 'Recommended: an admin publishes the Custom App once, then members simply press Connect in ChatGPT; lnwjud remembers OAuth trust and reconnects automatically.'}
                  badge={remoteMcp.state === 'running' ? 'RUNNING' : remoteMcp.installed && remoteMcp.hasAuthtoken ? 'READY' : 'SETUP'}
                />
                <div className="setting-grid two-col">
                  <div className="setting-field">
                    <span className="field-label">Local MCP</span>
                    <code className="settings-path-display">{remoteMcp.localMcpUrl ?? props.dashboard.mcp.url ?? 'http://127.0.0.1:18765/mcp'}</code>
                    <p className="hint">{props.locale === 'th' ? 'คงเป็น loopback บนเครื่อง ไม่เปิดพอร์ตนี้สู่ Internet โดยตรง' : 'Remains loopback-only; this port is never exposed directly to the Internet.'}</p>
                  </div>
                  <div className="setting-field">
                    <span className="field-label">Public MCP URL</span>
                    <code className="settings-path-display">{remoteMcp.publicMcpUrl ?? '—'}</code>
                    <p className="hint">{props.locale === 'th' ? 'URL นี้ลงท้าย /mcp และเป็น URL ที่นำไปใส่ใน ChatGPT; ngrok มี development domain ที่กำหนดให้ และ lnwjud จะจำ URL ครั้งแรกแล้วส่ง origin เดิมให้ ngrok ในรอบถัดไปเพื่อให้ endpoint คงเดิม ไม่ต้องซื้อโดเมนเอง ส่วน custom domain ยังใช้ได้แบบ optional หากตั้งใจเปลี่ยนบัญชี/โดเมน ngrok ให้บันทึก Authtoken ใหม่เพื่อเรียนรู้ URL ใหม่' : 'This /mcp URL is the one to add in ChatGPT. ngrok provides an assigned development domain, and lnwjud remembers the first URL and reuses that origin on later starts so the endpoint stays stable. You do not need to buy a domain; a custom domain remains optional. If you intentionally change ngrok account/domain, save the authtoken again to learn the new URL.'}</p>
                  </div>
                </div>
                <div className="tunnel-setup-box">
                  <div className="settings-mini-heading"><strong>{props.locale === 'th' ? '1. เตรียม ngrok' : '1. Prepare ngrok'}</strong><span>{ngrokReady ? 'READY' : remoteMcp.state === 'installing' ? 'INSTALLING' : 'NOT READY'}</span></div>
                  <p className="hint">{props.locale === 'th' ? 'lnwjud ตรวจ ngrok จากการรัน `ngrok version` จริง ถ้าขึ้น READY ด้านล่าง แปลว่าติดตั้งแล้วและไม่ต้องกดติดตั้งซ้ำ' : 'lnwjud verifies ngrok by actually running `ngrok version`. When the status below is READY, it is installed and does not need to be installed again.'}</p>
                  <div className={`${ngrokReady ? 'toast-success-banner' : 'alert-box-warning'} ngrok-readiness-banner`} role="status">
                    <strong>{ngrokReady ? (props.locale === 'th' ? '✓ ngrok ติดตั้งแล้วและพร้อมใช้งาน' : '✓ ngrok is installed and ready') : (props.locale === 'th' ? 'ยังไม่พบ ngrok ที่รันได้' : 'No runnable ngrok installation detected')}</strong>
                    {ngrokReady && remoteMcp.ngrokPath !== null ? <code className="ngrok-ready-path">{remoteMcp.ngrokPath}</code> : null}
                  </div>
                  <div className="inline-actions">
                    {ngrokAutoInstallAvailable ? (
                      <button type="button" className="btn-save-gold" disabled={remoteMcpBusy || remoteMcp.state === 'running' || ngrokReady} onClick={() => { void runRemoteMcpAction('install'); }}>
                        {ngrokReady
                          ? (props.locale === 'th' ? '✓ ngrok พร้อมใช้งาน' : '✓ ngrok ready')
                          : remoteMcp.state === 'installing'
                            ? (props.locale === 'th' ? 'กำลังติดตั้ง/ซ่อม…' : 'Installing/repairing…')
                            : remoteMcp.automaticInstallMethod === 'homebrew'
                              ? (props.locale === 'th' ? 'ติดตั้ง ngrok ผ่าน Homebrew' : 'Install ngrok with Homebrew')
                              : remoteMcp.state === 'error'
                                ? (props.locale === 'th' ? 'ติดตั้ง/ซ่อม ngrok อัตโนมัติ' : 'Install/repair ngrok automatically')
                                : (props.locale === 'th' ? 'ติดตั้ง ngrok อัตโนมัติ' : 'Install ngrok automatically')}
                      </button>
                    ) : null}
                    {!ngrokReady && !ngrokAutoInstallAvailable ? <button type="button" disabled={remoteMcpBusy} onClick={() => { void props.onOpenExternalSetupPage('ngrok_download'); }}>{props.locale === 'th' ? 'เปิดหน้าดาวน์โหลด ngrok ทางการ' : 'Open official ngrok download'}</button> : null}
                    <button type="button" disabled={remoteMcpBusy} onClick={() => { void openNgrokAuthtokenPage(); }}>{props.locale === 'th' ? 'เปิดหน้า ngrok Authtoken' : 'Open ngrok authtoken'}</button>
                  </div>
                  <label className="field-label" htmlFor="remote-mcp-authtoken">{props.locale === 'th' ? 'ngrok Authtoken (ใส่ครั้งเดียว)' : 'ngrok authtoken (one time)'}</label>
                  <div className="form-row"><input id="remote-mcp-authtoken" type="password" autoComplete="off" placeholder={remoteMcp.hasAuthtoken ? '••••••••••••••••' : '2abc...'} value={remoteMcpAuthtoken} onChange={(event) => setRemoteMcpAuthtoken(event.target.value)} /><button type="button" className="btn-save-gold" disabled={remoteMcpBusy || remoteMcpAuthtoken.trim().length === 0} onClick={() => { void runRemoteMcpAction('save'); }}>{props.locale === 'th' ? 'บันทึกอย่างปลอดภัย' : 'Save securely'}</button></div>
                  <p className="hint">{remoteMcp.hasAuthtoken ? (props.locale === 'th' ? `✓ เก็บด้วย ${secureStorageLabel} แล้ว` : `✓ Stored with ${secureStorageLabel}`) : (props.locale === 'th' ? 'Authtoken ไม่ถูกส่งผ่าน command line หรือบันทึกลง config แบบ plaintext' : 'The authtoken is not passed on the command line or stored in plaintext config.')}</p>
                </div>
                <div className="tunnel-setup-box">
                  <div className="settings-mini-heading"><strong>{props.locale === 'th' ? '2. เปิด Remote MCP' : '2. Start Remote MCP'}</strong><span>{remoteMcp.oauthConnected ? 'CHATGPT LINKED' : remoteMcp.pairingRequired ? 'FALLBACK PIN' : remoteMcp.oauthProtected ? 'CHATGPT READY' : 'AUTH REQUIRED'}</span></div>
                  <div className="inline-actions">
                    <button type="button" className="btn-save-gold" disabled={remoteMcpBusy || !remoteMcp.hasAuthtoken || remoteMcp.state === 'running'} onClick={() => { void runRemoteMcpAction('start'); }}>{remoteMcpBusy && remoteMcp.state !== 'running' ? (props.locale === 'th' ? 'กำลังทำงาน…' : 'Working…') : (props.locale === 'th' ? 'Start Remote MCP' : 'Start Remote MCP')}</button>
                    <button type="button" disabled={remoteMcpBusy || remoteMcp.state !== 'running'} onClick={() => { void runRemoteMcpAction('stop'); }}>{props.locale === 'th' ? 'หยุด' : 'Stop'}</button>
                    <button type="button" disabled={remoteMcp.publicMcpUrl === null} onClick={() => { void copyRemoteMcpUrl(); }}>{props.locale === 'th' ? 'Copy MCP URL' : 'Copy MCP URL'}</button>
                    <button type="button" disabled={remoteMcpBusy || !remoteMcp.oauthConnected} onClick={() => { void runRemoteMcpAction('regenerate'); }}>{props.locale === 'th' ? 'เชื่อม ChatGPT ใหม่' : 'Reconnect ChatGPT'}</button>
                  </div>
                  {remoteMcp.oauthConnected ? <div className="toast-success-banner remote-mcp-auth-banner" role="status"><strong>{props.locale === 'th' ? '✓ ChatGPT เชื่อมแล้ว' : '✓ ChatGPT connected'}</strong><span>{remoteMcp.autoStartEnabled ? (props.locale === 'th' ? 'จำ OAuth ไว้แล้ว · เปิด lnwjud ครั้งถัดไป Remote MCP จะ Start อัตโนมัติ' : 'OAuth trust is remembered · Remote MCP will auto-start on the next lnwjud launch.') : (props.locale === 'th' ? 'จำ OAuth ไว้แล้ว · Auto-start ปิดอยู่เพราะ Remote MCP ถูกหยุดด้วยผู้ใช้' : 'OAuth trust is remembered · auto-start is off because Remote MCP was stopped manually.')}</span></div> : null}
                  {remoteMcp.pairingCode === null ? null : <div className="alert-box-warning remote-mcp-auth-banner" role="status"><strong className="remote-mcp-pairing-line"><span>{props.locale === 'th' ? 'PIN สำรองสำหรับ OAuth client อื่น' : 'Fallback PIN for another OAuth client'}:</span><span className="remote-mcp-pairing-pin" aria-label={`${props.locale === 'th' ? 'Fallback pairing PIN' : 'Fallback pairing PIN'} ${remoteMcp.pairingCode}`}>{remoteMcp.pairingCode}</span></strong><span>{remoteMcp.pairingCodeExpiresAt === null ? (props.locale === 'th' ? 'ChatGPT ปกติไม่ต้องใช้ PIN นี้' : 'Normal ChatGPT connections do not need this PIN.') : `${props.locale === 'th' ? 'ChatGPT ปกติไม่ต้องใช้ · PIN หมดอายุ' : 'Not needed for ChatGPT · PIN expires'} ${formatDateTime(remoteMcp.pairingCodeExpiresAt, '—', props.locale)}`}</span></div>}
                  <p className="hint">{props.locale === 'th' ? 'ครั้งแรก: กด Start → Admin เพิ่ม Public MCP URL เป็น Custom App แบบ OAuth และ Publish → สมาชิกกด Connect ใน ChatGPT ได้เลย ไม่ต้องกรอก PIN; browser จะ handoff อัตโนมัติผ่าน one-time 127.0.0.1 ของ lnwjud Desktop แล้วกลับ ChatGPT หลังเชื่อม lnwjud จะจำ OAuth trust/refresh grant แบบเข้ารหัสและ reconnect อัตโนมัติ PIN จะแสดงเฉพาะ fallback สำหรับ OAuth client อื่น' : 'First time: Start → an admin adds the Public MCP URL as an OAuth Custom App and publishes it → members simply press Connect in ChatGPT with no PIN. The browser automatically hands off through a one-time 127.0.0.1 lnwjud Desktop approval and returns to ChatGPT. lnwjud stores OAuth trust/refresh grants encrypted for automatic reconnect; a PIN appears only as a fallback for other OAuth clients.'}</p>
                  {remoteMcp.message === null ? null : <div className={remoteMcp.state === 'error' ? 'alert-box-warning' : 'hint'} role="status">{remoteMcp.message}{remoteMcp.ngrokPath === null ? '' : ` · ngrok: ${remoteMcp.ngrokPath}`}</div>}
                  {remoteMcpMessage === null ? null : <div className={remoteMcp.state === 'error' || /failed|error|exit|stopped unexpectedly/i.test(remoteMcpMessage) ? 'alert-box-warning' : 'toast-success-banner'} role="status">{remoteMcpMessage}</div>}
                </div>
              </section>

              </details>

              <details
                className={`connection-method-stack ${remoteMcpOnline ? 'is-secondary' : ''}`}
                open={secureMethodOpen}
                onToggle={(event) => setSecureMethodOpen(event.currentTarget.open)}
              >
                <summary className="connection-method-summary">
                  <div className="connection-method-summary-copy">
                    <span className="connection-method-kicker">{remoteMcpOnline ? (props.locale === 'th' ? 'ทางเลือก / ขั้นสูง' : 'Alternative / advanced') : (props.locale === 'th' ? 'ทางเลือก' : 'Alternative')}</span>
                    <strong>OpenAI Secure MCP Tunnel</strong>
                    <span>{props.locale === 'th'
                      ? 'Tunnel ID + Runtime API key เป็นโหมดตรงแบบเดิม; OAuth ภายใน Secure Tunnel (ถ้ามี) เป็นคนละระบบกับ Remote MCP OAuth ด้านบน'
                      : 'Tunnel ID + Runtime API key is the original direct mode. Secure Tunnel OAuth, when available, is separate from Remote MCP OAuth above.'}</span>
                  </div>
                  <div className="connection-method-summary-status">
                    <span className={`connection-method-live-dot ${secureTunnelOnline ? 'is-online' : ''}`} aria-hidden="true" />
                    <span>{secureTunnelOnline ? 'ONLINE' : guidedTunnelConfigured ? 'READY' : 'SETUP'}</span>
                    <span className="active-project-count">{props.dashboard.tunnel.auth?.mode === 'oauth' ? 'OAUTH' : 'API KEY'}</span>
                    <span className="connection-method-chevron" aria-hidden="true">⌄</span>
                  </div>
                </summary>

              <section className="panel settings-card settings-card-polished connection-method-panel" aria-label="Tunnel authentication">
                <SettingsCardHeading
                  icon="◎"
                  title={props.locale === 'th' ? 'OpenAI Secure MCP Tunnel' : 'OpenAI Secure MCP Tunnel'}
                  subtitle={props.locale === 'th' ? 'โหมดเดิมสำหรับ OpenAI Tunnel transport; Runtime API key ยังรองรับเต็มรูปแบบ และ OAuth ส่วนนี้เป็นคนละระบบกับ Remote MCP OAuth ด้านบน' : 'Existing OpenAI Tunnel transport. Runtime API key remains fully supported; OAuth here is separate from the working Remote MCP OAuth above.'}
                  badge={props.dashboard.tunnel.auth?.mode === 'oauth' ? 'OAUTH' : 'API KEY'}
                />
                <div className="setting-grid two-col">
                  <div className="setting-field">
                    <span className="field-label">{props.locale === 'th' ? 'วิธีที่ใช้อยู่' : 'Active method'}</span>
                    <strong>{props.dashboard.tunnel.auth?.mode === 'oauth' ? 'OAuth Sign-in' : 'Runtime API key'}</strong>
                    <p className="hint">{props.dashboard.tunnel.auth?.mode === 'oauth'
                      ? (props.dashboard.tunnel.auth.accountLabel ?? (props.locale === 'th' ? 'ลงชื่อเข้าใช้แล้ว' : 'Signed in'))
                      : (props.locale === 'th' ? 'วิธีเดิมยังรองรับเต็มรูปแบบและไม่บังคับย้าย' : 'The original method remains fully supported; migration is never forced.')}</p>
                  </div>
                  <div className="setting-field">
                    <span className="field-label">OAuth provisioning</span>
                    <strong>{props.dashboard.tunnel.oauth?.available ? (props.locale === 'th' ? 'พร้อมใช้งาน' : 'Available') : (props.locale === 'th' ? 'ยังไม่พร้อม' : 'Unavailable')}</strong>
                    {props.dashboard.tunnel.oauth?.reason === null || props.dashboard.tunnel.oauth?.reason === undefined ? null : <p className="hint">{props.dashboard.tunnel.oauth.reason}</p>}
                  </div>
                </div>
                <div className="inline-actions">
                  {props.dashboard.tunnel.auth?.mode === 'oauth' ? (
                    <>
                      <button type="button" disabled={oauthBusy || !props.dashboard.tunnel.auth.hasLegacyApiKey} onClick={() => { void rollbackToLegacyAuth(); }}>{props.locale === 'th' ? 'กลับไปใช้ Runtime API key' : 'Switch back to Runtime API key'}</button>
                      <button type="button" disabled={oauthBusy} onClick={() => { void logoutOAuth(); }}>{props.locale === 'th' ? 'ออกจากระบบ OAuth' : 'Sign out OAuth'}</button>
                    </>
                  ) : (
                    <button type="button" className="btn-save-gold" disabled={oauthBusy || props.dashboard.tunnel.oauth?.available !== true} onClick={() => { void beginOAuthLogin(); }}>
                      {oauthBusy ? (props.locale === 'th' ? 'กำลังเริ่ม…' : 'Starting…') : (props.locale === 'th' ? 'ลงชื่อเข้าใช้ด้วย OAuth' : 'Sign in with OAuth')}
                    </button>
                  )}
                  {oauthLogin?.state === 'waiting_for_browser' || oauthLogin?.state === 'exchanging' ? <button type="button" onClick={() => { void props.onCancelTunnelOAuthLogin().then(setOauthLogin); }}>{props.locale === 'th' ? 'ยกเลิกการลงชื่อเข้าใช้' : 'Cancel sign-in'}</button> : null}
                </div>
                {oauthLogin === null ? null : <p className="hint" role="status">OAuth: {oauthLogin.state}{oauthLogin.message === null ? '' : ` — ${oauthLogin.message}`}</p>}
              </section>

              {tunnelPresentation.isOAuth ? (
                <section className="panel settings-card settings-card-polished guided-tunnel-launch-card connection-method-followup-card" aria-label="OAuth connection status">
                  <SettingsCardHeading icon="◎" title={props.locale === 'th' ? 'การเชื่อมต่อด้วย OAuth' : 'OAuth connection'} subtitle={props.locale === 'th' ? 'โหมดนี้ใช้ OAuth เป็นวิธียืนยันตัวตน ส่วนการขนส่งยังเป็น Secure MCP Tunnel' : 'OAuth is the active authentication method; transport still uses Secure MCP Tunnel.'} badge={guidedTunnelRunning ? 'RUNNING' : guidedTunnelConfigured ? 'READY' : 'OAUTH'} />
                  <p className="hint">{props.dashboard.tunnel.auth?.accountLabel ?? (props.dashboard.tunnel.auth?.authReady ? (props.locale === 'th' ? 'OAuth พร้อมใช้งาน' : 'OAuth is ready') : (props.locale === 'th' ? 'OAuth ต้องการให้ผู้ใช้ดำเนินการ' : 'OAuth requires user action'))}</p>
                  {props.dashboard.tunnel.auth?.message === null || props.dashboard.tunnel.auth?.message === undefined ? null : <p className="hint">{props.dashboard.tunnel.auth.message}</p>}
                  <div className="inline-actions">
                    {!props.dashboard.tunnel.auth?.authReady ? <button type="button" className="btn-save-gold" disabled={oauthBusy || props.dashboard.tunnel.oauth?.available !== true} onClick={() => { void beginOAuthLogin(); }}>{props.locale === 'th' ? 'ลงชื่อเข้าใช้ OAuth' : 'Sign in with OAuth'}</button> : null}
                    <button type="button" disabled={tunnelBusy || !guidedTunnelConfigured || props.dashboard.tunnel.state === 'running'} onClick={() => { void props.onStartTunnel(); }}>{t(tunnelPresentation.startKey)}</button>
                    <button type="button" disabled={tunnelBusy || props.dashboard.tunnel.state === 'stopped'} onClick={() => { void props.onStopTunnel(); }}>{t(tunnelPresentation.stopKey)}</button>
                  </div>
                </section>
              ) : (
                <>
                  <section className="panel settings-card settings-card-polished guided-tunnel-launch-card connection-method-followup-card" aria-label={t('guidedTunnel.openGuide')}>
                    <SettingsCardHeading icon="↗" title={t('guidedTunnel.openGuide')} subtitle={t('guidedTunnel.privacy')} badge={guidedTunnelRunning ? 'RUNNING' : guidedTunnelConfigured ? 'READY' : 'SETUP'} />
                    <p className="hint">{guidedTunnelRunning ? t('guidedTunnel.localComplete') : guidedTunnelConfigured ? t('guidedTunnel.configured') : t('guidedTunnel.dismissedHint')}</p>
                    <button type="button" className="btn-save-gold" onClick={() => props.onGuidedTunnelSetupOpenChange(true)}>{t('guidedTunnel.openGuide')}</button>
                  </section>

                  <GuidedTunnelSetup
                    locale={props.locale}
                    tunnel={props.dashboard.tunnel}
                    open={props.guidedTunnelSetupOpen}
                    onOpenChange={props.onGuidedTunnelSetupOpenChange}
                    onOpenExternal={props.onOpenExternalSetupPage}
                    onSaveApiKey={props.onSaveTunnelApiKey}
                    onConfigureProfile={props.onConfigureTunnelProfile}
                    onStartTunnel={props.onStartTunnel}
                    onRefresh={props.onRefresh}
                    onLocalComplete={props.onGuidedTunnelLocalComplete}
                  />
                </>
              )}

              <details className="guided-tunnel-advanced">
                <summary>{tunnelPresentation.isOAuth ? (props.locale === 'th' ? 'การตั้งค่าขั้นสูง / Runtime API key สำรอง' : 'Advanced / Runtime API key fallback') : t('guidedTunnel.advanced')}</summary>
                <section className="panel settings-card settings-card-polished" aria-label={t('settings.tunnelTitle')}>
              <SettingsCardHeading icon="↗" title={tunnelPresentation.isOAuth ? (props.locale === 'th' ? 'Secure Tunnel — Legacy fallback' : 'Secure Tunnel — Legacy fallback') : t('settings.tunnelTitle')} subtitle={tunnelPresentation.isOAuth ? (props.locale === 'th' ? 'ตัวเลือก Runtime API key สำหรับสลับกลับหรือแก้ปัญหา ไม่ใช่วิธียืนยันตัวตนที่กำลังใช้อยู่' : 'Runtime API key controls are fallback/troubleshooting only and are not the active authentication method.') : (props.locale === 'th' ? 'Credential, tunnel-client และ Setup Wizard' : 'Credentials, tunnel-client, and setup wizard')} badge={tunnelPresentation.isOAuth ? 'LEGACY' : props.dashboard.tunnel.profileExists ? (props.locale === 'th' ? 'พร้อมใช้งาน' : 'READY') : (props.locale === 'th' ? 'ต้องตั้งค่า' : 'SETUP')} />
              <div className="setting-grid two-col">
                <div className="setting-field">
                  <label className="field-label" htmlFor="tunnel-key">{t('settings.tunnelKey')}</label>
                  <div className="form-row"><div className="password-input-wrapper"><input id="tunnel-key" type={showApiKey ? 'text' : 'password'} placeholder={props.dashboard.tunnel.hasApiKey ? '••••••••••••••••' : 'sk-...'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" /><button type="button" className="toggle-pw-btn" onClick={() => setShowApiKey((value) => !value)}>{showApiKey ? 'Hide' : 'Show'}</button></div><button type="button" className="btn-save-gold" onClick={() => { void props.onSaveTunnelApiKey(apiKey).then(() => { setApiKey(''); setSavedMessage(t('settings.saved')); }); }}>{t('settings.saveKey')}</button></div>
                  <p className="hint">{props.dashboard.tunnel.hasApiKey ? (props.locale === 'th' ? 'ป้องกันด้วย secure storage ของระบบ' : 'Protected with operating system secure storage') : t('tunnel.needKey')}</p>
                </div>
                <div className="setting-field">
                  <label className="field-label" htmlFor="tunnel-client-path">{props.locale === 'th' ? 'tunnel-client (รวมมากับโปรแกรมแล้ว)' : 'tunnel-client (bundled)'}</label>
                  <div className="form-row"><input id="tunnel-client-path" placeholder={props.locale === 'th' ? 'ใช้ v0.0.14 ที่มากับ lnwjud อัตโนมัติ' : 'Bundled v0.0.14 is used automatically'} value={clientPath} onChange={(event) => setClientPath(event.target.value)} /><button type="button" onClick={() => { void browseTunnelClient(); }}>{props.locale === 'th' ? 'เลือกไฟล์…' : 'Browse…'}</button><button type="button" className="btn-save-gold" onClick={() => { void props.onSetTunnelClientPath(clientPath).then(() => setSavedMessage(clientPath.trim().length === 0 ? (props.locale === 'th' ? 'กลับมาใช้ tunnel-client ที่มากับโปรแกรมแล้ว' : 'Using the bundled tunnel-client again.') : t('settings.saved'))); }}>{clientPath.trim().length === 0 ? (props.locale === 'th' ? 'ใช้ตัวที่มากับโปรแกรม' : 'Use bundled') : (props.locale === 'th' ? 'บันทึก Override' : 'Save override')}</button></div>
                  <p className="hint">{props.locale === 'th' ? 'ช่องว่าง = ใช้ OpenAI tunnel-client v0.0.14 แบบ native ตาม target ที่มากับโปรแกรม หากบันทึก custom override แล้ว path นั้นจะเป็นตัวเลือกหลัก: ถ้าไฟล์หาย lnwjud จะแจ้ง error และจะไม่สลับกลับ bundled เอง การเปลี่ยน client ขณะ runtime ทำงานจะหยุด/ยืนยัน owner เดิมก่อนจึงค่อยสลับ' : 'Blank = use the bundled target-native OpenAI tunnel-client v0.0.14. A saved custom override is authoritative: if it is missing, lnwjud reports an error and never silently falls back to bundled. Switching clients while running stops and verifies the recorded owner before committing the new selection.'}</p>
                </div>
              </div>
              <div className="tunnel-setup-box">
                <div className="settings-mini-heading"><strong>Setup Wizard</strong><span>{props.locale === 'th' ? 'ไม่ต้องเปิดคำสั่งระบบเอง' : 'No manual platform-specific init'}</span></div>
                <label className="field-label" htmlFor="tunnel-id">OpenAI Tunnel ID</label>
                <div className="form-row"><input id="tunnel-id" placeholder="tunnel_0123456789abcdef..." value={tunnelId} onChange={(event) => setTunnelId(event.target.value)} /><button type="button" className="btn-save-gold" disabled={tunnelBusy} onClick={() => { void configureTunnel(); }}>{tunnelBusy ? (props.locale === 'th' ? 'กำลังตั้งค่า…' : 'Configuring…') : (props.locale === 'th' ? 'Configure Tunnel' : 'Configure Tunnel')}</button></div>
                <p className="hint">{props.locale === 'th' ? 'หลาย ChatGPT chats บน lnwjud เครื่องนี้ใช้ Tunnel ID เดียวกันได้ ไม่ต้องแยก profile ต่อแชท · ถ้ารัน lnwjud หลายเครื่อง เช่น Mac + Windows และต้องให้แต่ละแชทเลือกเครื่องได้แน่นอน ให้ใช้ Tunnel ID แยกต่อเครื่อง เพราะ replicas ที่แชร์ Tunnel ID เดียวรับงานแบบเครื่องไหน poll ได้ก่อน' : 'Multiple ChatGPT chats on this lnwjud machine can share one Tunnel ID; do not create a profile per chat. If you run lnwjud on multiple machines such as Mac + Windows and need deterministic host selection, use a distinct Tunnel ID per machine because replicas sharing one Tunnel ID receive work from whichever replica polls first.'}</p>
              </div>
              {savedMessage === null ? null : <div className="toast-success-banner" role="status">✓ {savedMessage}</div>}
              {tunnelMessage === null ? null : <div className="alert-box-warning" role="status">{tunnelMessage}</div>}
              {props.dashboard.tunnel.persistent === null ? null : (
                <div className="tunnel-setup-box persistent-runtime-card">
                  <div className="settings-mini-heading"><strong>Persistent Tunnel Identity</strong><span>{props.dashboard.tunnel.persistent.runtimeAlias}</span></div>
                  <div className="setting-grid two-col">
                    <div className="setting-field"><span className="field-label">Tunnel ID</span><code className="settings-path-display">{props.dashboard.tunnel.persistent.tunnelIdMasked ?? '—'}</code></div>
                    <div className="setting-field"><span className="field-label">Runtime mode</span><strong>{props.dashboard.tunnel.persistent.mode}</strong></div>
                    <div className="setting-field"><span className="field-label">Status</span><strong>{props.dashboard.tunnel.persistent.state}</strong></div>
                    <div className="setting-field"><span className="field-label">Reconnect count</span><strong>{props.dashboard.tunnel.persistent.reconnectCount}</strong></div>
                    <div className="setting-field"><span className="field-label">Health / Ready / Poll</span><strong>{formatTunnelTriState(props.dashboard.tunnel.persistent.healthy)} / {formatTunnelTriState(props.dashboard.tunnel.persistent.ready)} / {formatTunnelTriState(props.dashboard.tunnel.persistent.pollHealthy)}</strong></div>
                    <div className="setting-field"><span className="field-label">Local MCP</span><code className="settings-path-display">{props.dashboard.tunnel.persistent.localMcpUrl ?? '—'}</code></div>
                  </div>
                  <div className={props.dashboard.tunnel.persistent.strictZeroDowntime ? 'toast-success-banner' : 'alert-box-warning'}>
                    {props.dashboard.tunnel.persistent.strictZeroDowntime
                      ? (props.locale === 'th' ? '✓ Capability gate: strict zero-downtime handoff ผ่านการพิสูจน์' : '✓ Capability gate: strict zero-downtime handoff is proven')
                      : (props.locale === 'th' ? 'ℹ ยังไม่อ้าง strict zero-downtime: tunnel-client รุ่นนี้ยังไม่มีหลักฐาน ready-before-retire overlap ที่พิสูจน์ได้' : 'ℹ Strict zero-downtime is not claimed: this tunnel-client has no proven ready-before-retire overlap primitive.')}
                  </div>
                  <div className="inline-actions"><button type="button" className="btn-save-gold" disabled={tunnelBusy} onClick={() => { void reconnectSameTunnel(); }}>{props.locale === 'th' ? 'Reconnect Tunnel เดิม' : 'Reconnect same tunnel'}</button><button type="button" disabled={tunnelBusy || props.dashboard.tunnel.state === 'stopped'} onClick={() => { void stopPersistentTunnel(); }}>{props.locale === 'th' ? 'หยุด Tunnel' : 'Stop tunnel'}</button></div>
                  {props.dashboard.tunnel.persistent.capabilityEvidence === null ? null : <p className="hint">{props.dashboard.tunnel.persistent.capabilityEvidence}</p>}
                </div>
              )}
                </section>
              </details>
              </details>
            </>
          ) : null}

          {activeSection === 'backup' ? (
            <>
              <section className="panel settings-card settings-card-polished" aria-label="Recovery Center">
                <SettingsCardHeading
                  icon="↶"
                  title={props.locale === 'th' ? 'Recovery Center' : 'Recovery Center'}
                  subtitle={props.locale === 'th' ? 'ไฟล์ที่ลบ สำเนาก่อนไฟล์ไบนารีถูกเขียนทับ และ checkpoint ของโปรเจกต์หลัก (Primary)' : 'Deleted items, binary pre-replacement backups, and checkpoints for the Primary Project'}
                  badge={`${props.dashboard.recovery.trashItems.length + props.dashboard.recovery.checkpoints.length} ITEMS`}
                />
                <div className="setting-field">
                  <span className="field-label">{props.locale === 'th' ? 'ตำแหน่ง Recovery Trash บนเครื่อง' : 'Local Recovery Trash location'}</span>
                  <code className="settings-path-display">{props.dashboard.recovery.trashRoot ?? (props.locale === 'th' ? 'ยังไม่ได้ตั้งค่า' : 'Not configured')}</code>
                </div>
                <div className="recovery-retention-row">
                  <div>
                    <strong>{props.locale === 'th' ? 'ลบข้อมูลกู้คืนอัตโนมัติ' : 'Automatic recovery cleanup'}</strong>
                    <p className="hint">{props.locale === 'th' ? 'เลือกอายุที่ต้องการเก็บ Recovery Trash และ Checkpoint; ค่าเริ่มต้นคือไม่ลบอัตโนมัติ' : 'Choose how long to keep Recovery Trash and checkpoints. The default is never delete automatically.'}</p>
                  </div>
                  <select aria-label={props.locale === 'th' ? 'อายุข้อมูลกู้คืน' : 'Recovery retention'} disabled={retentionBusy} value={props.dashboard.settings.recoveryRetentionDays} onChange={(event) => { void setRecoveryRetentionDays(Number(event.target.value)); }}>
                    <option value={0}>{props.locale === 'th' ? 'ไม่ลบอัตโนมัติ' : 'Never'}</option>
                    {[7, 14, 30, 60, 90, 180, 365].map((days) => <option key={days} value={days}>{days} {props.locale === 'th' ? 'วัน' : 'days'}</option>)}
                  </select>
                </div>
                <div className="settings-mini-heading"><strong>{props.locale === 'th' ? 'ไฟล์ที่ลบ / สำเนาก่อนเขียนทับ' : 'Deleted / pre-replacement backups'}</strong><span>{props.dashboard.recovery.trashItems.length}</span></div>
                {props.dashboard.recovery.trashItems.length === 0 ? <div className="empty-setting-state">{props.locale === 'th' ? 'Recovery Trash ยังว่าง' : 'Recovery Trash is empty'}</div> : (
                  <div className="backup-list settings-backup-list recovery-scroll-list">{props.dashboard.recovery.trashItems.map((item) => (
                    <div key={item.recoveryId} className="backup-item">
                      <div><strong>{item.relativePath}</strong><p className="hint">{formatDateTime(item.deletedAt, '—', props.locale)} · {item.kind === 'replacement_backup' ? (props.locale === 'th' ? 'สำเนาก่อนเขียนทับ' : 'pre-replacement') : item.isDirectory ? 'folder' : 'file'} · {item.payloadAvailable ? (props.locale === 'th' ? 'พร้อมกู้คืน' : 'ready') : (props.locale === 'th' ? 'payload ไม่ครบ' : 'payload missing')}</p></div>
                      <button type="button" disabled={!item.payloadAvailable || recoveryBusyId !== null} onClick={() => { void restoreTrashItem(item.workspaceId, item.recoveryId, item.relativePath, item.kind); }}>{recoveryBusyId === item.recoveryId ? (props.locale === 'th' ? 'กำลังกู้…' : 'Restoring…') : (props.locale === 'th' ? 'กู้คืน' : 'Restore')}</button>
                    </div>
                  ))}</div>
                )}
                <div className="settings-mini-heading"><strong>{props.locale === 'th' ? 'Checkpoint ก่อนแก้/เขียนทับ' : 'Pre-change checkpoints'}</strong><span>{props.dashboard.recovery.checkpoints.length}</span></div>
                {props.dashboard.recovery.checkpoints.length === 0 ? <div className="empty-setting-state">{props.locale === 'th' ? 'ยังไม่มี checkpoint' : 'No checkpoints yet'}</div> : (
                  <div className="backup-list settings-backup-list recovery-scroll-list">{props.dashboard.recovery.checkpoints.map((checkpoint) => {
                    const paths = checkpoint.files.map((file) => file.path);
                    return <div key={checkpoint.id} className="backup-item"><div><strong>{formatDateTime(checkpoint.createdAt, '—', props.locale)}</strong><p className="hint">{paths.join(', ')} · {formatBytes(checkpoint.files.reduce((total, file) => total + file.size, 0))}</p></div><button type="button" disabled={recoveryBusyId !== null} onClick={() => { void restoreCheckpoint(checkpoint.workspaceId, checkpoint.id, paths); }}>{recoveryBusyId === checkpoint.id ? (props.locale === 'th' ? 'กำลังกู้…' : 'Restoring…') : (props.locale === 'th' ? 'ย้อนกลับจุดนี้' : 'Restore point')}</button></div>;
                  })}</div>
                )}
                {recoveryError === null ? null : <div className="alert-box-warning" role="alert">⚠️ {recoveryError}</div>}
                {recoveryMessage === null ? null : <div className="toast-success-banner" role="status">✓ {recoveryMessage}</div>}
              </section>

              <section className="panel settings-card settings-card-polished" aria-label="Backup and restore">
                {props.dashboard.restoreNotice?.hostCompatibility === 'cross_host' ? (
                  <div className="alert-box-warning" role="status">
                    ⚠️ {t('backup.crossHostNotice')} {props.dashboard.restoreNotice.relinkRequired ? t('backup.crossHostRelink') : null} {props.dashboard.restoreNotice.incomplete ? t('backup.crossHostSecret') : null}
                  </div>
                ) : null}
                <SettingsCardHeading icon="▣" title={props.locale === 'th' ? 'สำรองฐานข้อมูลโปรแกรม' : 'Application Database Backup'} subtitle="SQLite consistent snapshots" action={<button type="button" className="btn-save-gold" disabled={backupBusy} onClick={() => { void createBackupNow(); }}>{backupBusy ? (props.locale === 'th' ? 'กำลังทำงาน…' : 'Working…') : (props.locale === 'th' ? 'Backup ตอนนี้' : 'Backup Now')}</button>} />
                {props.dashboard.backups.length === 0 ? <div className="empty-setting-state">{props.locale === 'th' ? 'ยังไม่มี Backup' : 'No backups yet'}</div> : (
                  <div className="backup-list settings-backup-list">{props.dashboard.backups.slice(0, 5).map((backup) => (
                    <div key={backup.id} className="backup-item"><div><strong>{formatDateTime(backup.createdAt, '—', props.locale)}</strong><p className="hint">{backup.reason} · {formatBytes(backup.sizeBytes)}{backup.hostCompatibility === 'cross_host' ? ` · ${t('backup.crossHostLabel')}` : ''}</p></div><button type="button" disabled={backupBusy || props.dashboard.tunnel.state === 'running' || props.dashboard.mcp.running} onClick={() => { void scheduleRestore(backup.id); }}>{props.locale === 'th' ? 'Restore ชุดนี้' : 'Restore'}</button></div>
                  ))}</div>
                )}
                {(props.dashboard.tunnel.state === 'running' || props.dashboard.mcp.running) ? <div className="alert-box-warning">⚠️ {props.locale === 'th' ? 'หยุด Tunnel และ Local MCP ก่อน Restore ฐานข้อมูล' : 'Stop Tunnel and local MCP before scheduling a database restore.'}</div> : null}
                {backupError === null ? null : <div className="alert-box-warning" role="alert">⚠️ {backupError}</div>}
                {backupMessage === null ? null : <div className="toast-success-banner" role="status">✓ {backupMessage}</div>}
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SettingsCardHeading({ icon, title, subtitle, badge, action }: { readonly icon: string; readonly title: string; readonly subtitle: string; readonly badge?: string; readonly action?: ReactElement }): ReactElement {
  return (
    <div className="section-heading settings-card-heading">
      <div className="settings-heading-copy"><span className="settings-card-icon" aria-hidden="true">{icon}</span><div><h2 className="settings-card-title">{title}</h2><span className="page-subtitle">{subtitle}</span></div></div>
      {action ?? (badge === undefined ? null : <span className="pill-badge gold">{badge}</span>)}
    </div>
  );
}

function ponytailPolicySourceLabel(locale: UiLocale, source: PonytailPolicyContext['effectiveWorkspaceSource']): string {
  if (source === 'goal') return locale === 'th' ? 'Current Goal' : 'Current Goal';
  if (source === 'workspace') return 'Workspace';
  if (source === 'global') return 'Global';
  return locale === 'th' ? 'ค่าเริ่มต้น' : 'Default';
}

function ponytailGoalEditBlockedLabel(locale: UiLocale, reason: 'live_lease' | 'live_continuation' | 'live_mutation'): string {
  const th = {
    live_lease: 'ล็อกการแก้ไข: มี worker/lease กำลังทำงาน ให้เปลี่ยน mode ผ่าน goal owner เพื่อรักษา fencing',
    live_continuation: 'ล็อกการแก้ไข: มี scheduled continuation ที่ยัง active',
    live_mutation: 'ล็อกการแก้ไข: มี mutation ที่กำลังทำงาน',
  } as const;
  const en = {
    live_lease: 'Editing locked: a worker lease is active. Change the mode through the goal owner to preserve fencing.',
    live_continuation: 'Editing locked: a scheduled continuation is still active.',
    live_mutation: 'Editing locked: a mutation is still running.',
  } as const;
  return (locale === 'th' ? th : en)[reason];
}

function splitList(value: string): readonly string[] {
  const seen = new Set<string>();
  return value.split(/[;\r\n]+/).map((entry) => entry.trim()).filter((entry) => { if (entry.length === 0) return false; const key = entry.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
}

function profileHint(locale: UiLocale, profile: PermissionProfileName): string {
  const th = { safe: 'ปลอดภัยสูงสุด: งานเขียนและรันคำสั่งต้องขออนุญาต', balanced: 'สมดุล: งานทั่วไปใน workspace ทำได้คล่องขึ้น', full: 'เต็มสิทธิ์สำหรับงานปกติ; เปิด Full Bypass แยกต่างหากหากต้องการข้ามทุก approval/scope ของ lnwjud', custom: 'ใช้กฎ READ / WRITE / EXECUTE / DANGEROUS และ executable ที่กำหนดเอง' } as const;
  const en = { safe: 'Maximum safety: writes and execution require approval.', balanced: 'Balanced: common workspace work is less restrictive.', full: 'Full access for ordinary work; enable Full Bypass separately to skip every lnwjud approval and scope check.', custom: 'Uses your READ / WRITE / EXECUTE / DANGEROUS rules and custom executables.' } as const;
  return (locale === 'th' ? th : en)[profile];
}

function formatTunnelTriState(value: boolean | null): string {
  return value === null ? '—' : value ? 'OK' : 'FAIL';
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0 B';
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / (1024 * 1024)).toFixed(1) + ' MB';
}
