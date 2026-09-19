import { useEffect, useState, type ReactElement, type UIEvent } from 'react';
import { EMPTY_REMOTE_MCP_STATUS, type DashboardSnapshot, type DestructiveDeletePolicy, type ExternalSetupTarget, type PdfProviderInstallResult, type PermissionProfileName, type PonytailModeOverride, type PonytailPolicyContext, type TunnelOAuthLoginStatus, type TunnelStatus, type UiLocale, type UserSettings } from '@lnwjud/ipc-contracts';
import { parseDelimitedList } from '@lnwjud/shared/text-list';
import { formatDateTime } from '../../date-time.js';
import { createTranslator, type Translator } from '../../i18n/index.js';
import { tunnelRuntimeCredentialAvailable } from '../../tunnel-auth-readiness.js';
import { tunnelAuthPresentation } from '../../tunnel-auth-presentation.js';
import { GuidedTunnelSetup } from '../onboarding/GuidedTunnelSetup.js';
import { isTunnelRunning } from '../onboarding/guided-tunnel-setup-state.js';
import { EmptyState, PageHeading, SettingsCardHeading, StatusMessage } from '../ui/UiPrimitives.js';
import { PonytailPolicyEditor } from './PonytailPolicyEditor.js';
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
export type SettingsFocusTarget = 'security-profile' | 'tools-ecc' | 'tools-codex' | 'tools-local-providers' | 'mcp-servers';
type DestructiveApprovalKey = keyof DestructiveDeletePolicy['approvals'];

const RECOVERY_PAGE_SIZE = 40;

export function SettingsPage(props: SettingsPageProps): ReactElement {
  const t = createTranslator(props.locale);
  const hostPlatform = props.dashboard.hostPlatform;
  const hostArch = props.dashboard.hostArch;
  const secureStorageLabel = hostPlatform === 'darwin' ? t('storage.macosKeychain') : hostPlatform === 'linux' ? t('storage.systemKeyring') : t('storage.windowsDpapi');
  const guidedTunnelRunning = isTunnelRunning(props.dashboard.tunnel);
  const guidedTunnelConfigured = tunnelRuntimeCredentialAvailable(props.dashboard.tunnel) && props.dashboard.tunnel.profileExists;
  const tunnelPresentation = tunnelAuthPresentation(props.dashboard.tunnel);
  const remoteMcp = props.dashboard.remoteMcp ?? { ...EMPTY_REMOTE_MCP_STATUS, localMcpUrl: props.dashboard.mcp.url };

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
  const [remoteMcpPublicOrigin, setRemoteMcpPublicOrigin] = useState(remoteMcp.configuredPublicOrigin ?? '');
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
  const [trashVisibleCount, setTrashVisibleCount] = useState(RECOVERY_PAGE_SIZE);
  const [checkpointVisibleCount, setCheckpointVisibleCount] = useState(RECOVERY_PAGE_SIZE);
  const [backupVisibleCount, setBackupVisibleCount] = useState(RECOVERY_PAGE_SIZE);
  const [retentionBusy, setRetentionBusy] = useState(false);
  const [eccBusy, setEccBusy] = useState(false);
  const [eccMessage, setEccMessage] = useState<string | null>(null);

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
    setTrashVisibleCount(RECOVERY_PAGE_SIZE);
    setCheckpointVisibleCount(RECOVERY_PAGE_SIZE);
    setBackupVisibleCount(RECOVERY_PAGE_SIZE);
  }, [props.dashboard.selectedWorkspace?.id]);

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
    const confirmed = window.confirm(t(isReplacementBackup ? 'settingsPage.restoreReplacementConfirm' : 'settingsPage.restoreDeletedConfirm', { path: relativePath }));
    if (!confirmed) return;
    setRecoveryBusyId(recoveryId);
    setRecoveryError(null);
    try {
      await props.onRestoreRecoveryItem(workspaceId, recoveryId);
      setRecoveryMessage(t('settingsPage.restoredPath', { path: relativePath }));
    } catch (cause: unknown) {
      setRecoveryError(cause instanceof Error ? cause.message : t('settingsPage.restoreFailed'));
    } finally {
      setRecoveryBusyId(null);
    }
  }

  async function restoreCheckpoint(workspaceId: string, checkpointId: string, paths: readonly string[]): Promise<void> {
    const confirmed = window.confirm(t('settingsPage.restoreCheckpointConfirm', { count: paths.length }));
    if (!confirmed) return;
    setRecoveryBusyId(checkpointId);
    setRecoveryError(null);
    try {
      await props.onRestoreCheckpoint(workspaceId, checkpointId);
      setRecoveryMessage(t('settingsPage.checkpointRestored'));
    } catch (cause: unknown) {
      setRecoveryError(cause instanceof Error ? cause.message : t('settingsPage.checkpointRestoreFailed'));
    } finally {
      setRecoveryBusyId(null);
    }
  }

  async function saveStdioPolicy(): Promise<void> {
    const roots = parseDelimitedList(allowedRootsText, { caseInsensitive: true });
    if (strictRoots && roots.length === 0) {
      setPolicyError(t('settingsPage.stdioRootsRequired'));
      return;
    }
    setPolicyError(null);
    try {
      const restartRequired = await props.onStdioPolicyChange(stdioProfile, strictRoots, roots);
      setStdioDirty(false);
      setStdioMessage(restartRequired ? t('settingsPage.stdioReconnectRequired') : t('settings.saved'));
    } catch (cause: unknown) {
      setPolicyError(cause instanceof Error ? cause.message : 'Could not save STDIO policy');
    }
  }

  async function setEccEnabled(enabled: boolean): Promise<void> {
    setEccBusy(true);
    setEccMessage(null);
    try {
      await props.onUserSettingsChange({ ...props.dashboard.settings, eccEnabled: enabled });
      setEccMessage(enabled ? t('settingsPage.eccEnabled') : t('settingsPage.eccDisabled'));
    } catch (cause: unknown) {
      setEccMessage(cause instanceof Error ? cause.message : t('settingsPage.eccSaveFailed'));
    } finally {
      setEccBusy(false);
    }
  }

  async function browseTunnelClient(): Promise<void> {
    try {
      const selected = await props.onChooseTunnelClientPath();
      if (selected === null) return;
      setClientPath(selected);
      await props.onSetTunnelClientPath(selected);
      setSavedMessage(t('settingsPage.tunnelClientSaved'));
    } catch (cause: unknown) {
      setTunnelMessage(cause instanceof Error ? cause.message : 'Could not select tunnel-client');
    }
  }

  async function configureTunnel(): Promise<void> {
    if (tunnelId.trim().length === 0) {
      setTunnelMessage(t('settingsPage.tunnelIdRequired'));
      return;
    }
    setTunnelBusy(true);
    setTunnelMessage(null);
    try {
      const profilePath = await props.onConfigureTunnelProfile(tunnelId.trim());
      setTunnelMessage(t('settingsPage.tunnelConfigured', { path: profilePath }));
    } catch (cause: unknown) {
      setTunnelMessage(cause instanceof Error ? cause.message : t('settingsPage.tunnelSetupFailed'));
    } finally {
      setTunnelBusy(false);
    }
  }

  async function reconnectSameTunnel(): Promise<void> {
    setTunnelBusy(true);
    setTunnelMessage(null);
    try {
      await props.onStartTunnel();
      setTunnelMessage(t('settingsPage.reconnectRequested'));
    } catch (cause: unknown) {
      setTunnelMessage(cause instanceof Error ? cause.message : t('settingsPage.reconnectFailed'));
    } finally { setTunnelBusy(false); }
  }

  async function stopPersistentTunnel(): Promise<void> {
    setTunnelBusy(true);
    setTunnelMessage(null);
    try {
      await props.onStopTunnel();
      setTunnelMessage(t('settingsPage.tunnelStopped'));
    } catch (cause: unknown) {
      setTunnelMessage(cause instanceof Error ? cause.message : t('settingsPage.tunnelStopFailed'));
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
      const confirmed = window.confirm(t('settingsPage.retentionConfirm', { days }));
      if (!confirmed) return;
    }
    setRetentionBusy(true);
    setRecoveryError(null);
    try {
      await props.onUserSettingsChange({ ...props.dashboard.settings, recoveryRetentionDays: days });
      setRecoveryMessage(days === 0 ? t('settingsPage.retentionForever') : t('settingsPage.retentionSaved', { days }));
    } catch (cause: unknown) {
      setRecoveryError(cause instanceof Error ? cause.message : t('settingsPage.retentionSaveFailed'));
    } finally {
      setRetentionBusy(false);
    }
  }

  async function createBackupNow(): Promise<void> {
    setBackupBusy(true);
    setBackupError(null);
    try {
      await props.onCreateBackup();
      setBackupMessage(t('settingsPage.backupCompleted'));
    } catch (cause: unknown) {
      setBackupError(cause instanceof Error ? cause.message : 'Backup failed');
    } finally {
      setBackupBusy(false);
    }
  }

  async function scheduleRestore(backupId: string): Promise<void> {
    const confirmed = window.confirm(t('settingsPage.restoreDatabaseConfirm'));
    if (!confirmed) return;
    setBackupBusy(true);
    setBackupError(null);
    try {
      const restartRequired = await props.onScheduleRestoreBackup(backupId);
      setBackupMessage(restartRequired ? t('settingsPage.restoreScheduledRestart') : t('settingsPage.restoreScheduled'));
    } catch (cause: unknown) {
      setBackupError(cause instanceof Error ? cause.message : 'Could not schedule restore');
    } finally {
      setBackupBusy(false);
    }
  }

  async function runRemoteMcpAction(action: 'install' | 'save' | 'domain' | 'start' | 'stop' | 'resetOauth'): Promise<void> {
    if (action === 'resetOauth') {
      const confirmed = window.confirm(t('settingsPage.reconnectChatgptConfirm'));
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
      if (action === 'domain') {
        const status = await window.lnwjud.setRemoteMcpPublicOrigin({ publicOrigin: remoteMcpPublicOrigin });
        setRemoteMcpPublicOrigin(status.configuredPublicOrigin ?? '');
      }
      if (action === 'start') await window.lnwjud.startRemoteMcp();
      if (action === 'stop') await window.lnwjud.stopRemoteMcp();
      if (action === 'resetOauth') await window.lnwjud.resetRemoteMcpOAuth();
      await props.onRefresh();
      setRemoteMcpMessage(t('settingsPage.remoteUpdated'));
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
    setRemoteMcpMessage(t('settingsPage.remoteUrlCopied'));
  }

  async function openNgrokAuthtokenPage(): Promise<void> {
    setRemoteMcpMessage(null);
    try {
      await props.onOpenExternalSetupPage('ngrok_authtoken');
    } catch (cause: unknown) {
      const detail = cause instanceof Error ? cause.message : '';
      setRemoteMcpMessage(`ERROR: ${t('settingsPage.ngrokOpenFailed', { detail: detail.length === 0 ? '' : ` — ${detail}` })}`);
    }
  }

  const navItems: readonly { id: SettingsSection; icon: string; title: string; description: string }[] = [
    { id: 'general', icon: '⌘', title: t('settingsPage.nav.general'), description: t('settingsPage.nav.generalDesc') },
    { id: 'security', icon: '◇', title: t('settingsPage.nav.security'), description: t('settingsPage.nav.securityDesc') },
    { id: 'tools', icon: '◎', title: t('settingsPage.nav.tools'), description: t('settingsPage.nav.toolsDesc') },
    { id: 'mcp', icon: '⬡', title: 'MCP & Extensions', description: t('settingsPage.nav.mcpDesc') },
    { id: 'tunnel', icon: '↗', title: t('settingsPage.nav.tunnel'), description: t('settingsPage.nav.tunnelDesc') },
    { id: 'backup', icon: '▣', title: t('settingsPage.nav.backup'), description: t('settingsPage.nav.backupDesc') },
  ];

  const userConfigSection: UserConfigSection | null = activeSection === 'backup' || activeSection === 'tunnel' ? null : activeSection;
  const currentNav = navItems.find((item) => item.id === activeSection) ?? navItems[0]!;

  return (
    <div className="page-content settings-page-v2">
      <PageHeading
        className="settings-page-heading"
        eyebrow="CONTROL CENTER"
        eyebrowClassName="settings-eyebrow"
        title={t('settings.title')}
        subtitle={t('settingsPage.subtitle')}
        actions={<div className="settings-health-chip"><span className="status-dot online" />{t('settingsPage.localSettings')}</div>}
      />

      <div className="settings-shell-v2">
        <aside className="settings-subnav" aria-label={t('settingsPage.sectionsAria')}>
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
              <SettingsCardHeading icon="A" title={t('settings.generalTitle')} subtitle={t('settingsPage.languageSubtitle')} badge={props.locale.toUpperCase()} />
              <div className="setting-field max-field-width">
                <label className="field-label" htmlFor="locale-select">{t('settings.locale')}</label>
                <select id="locale-select" className="settings-select" value={props.locale} onChange={(event) => { void props.onLocaleChange(event.target.value as UiLocale); }}>
                  <option value="th">🇹🇭 {t('language.th')}</option>
                  <option value="en">🇺🇸 {t('language.en')}</option>
                </select>
              </div>
              <p className="hint">{t('settingsPage.languageHint')}</p>
            </section>
          ) : null}

          {activeSection === 'security' ? (
            <>
              <section className="panel settings-card settings-card-polished" aria-label={t('settings.securityTitle')} data-settings-focus="security-profile" tabIndex={-1}>
                <SettingsCardHeading icon="◇" title={t('settings.securityTitle')} subtitle={profileHint(t, props.dashboard.permissionProfile)} badge={props.dashboard.permissionProfile.toUpperCase()} />
                <div className="setting-field max-field-width">
                  <label className="field-label" htmlFor="permission-profile">{t('settings.permissions')}</label>
                  <select id="permission-profile" aria-label={t('settings.permissions')} className="settings-select" value={props.dashboard.permissionProfile} onChange={(event) => { void props.onPermissionProfileChange(event.target.value as PermissionProfileName); }}>
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

              <section className="panel settings-card settings-card-polished" aria-label={t('settingsPage.destructiveTitle')}>
                <SettingsCardHeading
                  icon="⌫"
                  title={t('settingsPage.destructiveTitle')}
                  subtitle={t('settingsPage.destructiveSubtitle')}
                  badge={`${Object.values(props.dashboard.destructiveDeletePolicy.approvals).filter(Boolean).length}/9`}
                />
                <StatusMessage tone="warning" role="note" prefix="⚠️ ">{t('settingsPage.destructiveBypassNotice')}</StatusMessage>
                <div className="setting-grid two-col align-center">
                  <SettingSwitch checked disabled label={t('settingsPage.criticalFilesLabel')} description={t('settingsPage.criticalFilesDesc')} onChange={() => undefined} />
                  <SettingSwitch checked disabled label={t('settingsPage.recoveryTrashLabel')} description={t('settingsPage.recoveryTrashDesc')} onChange={() => undefined} />
                </div>

                <div className="settings-mini-heading"><strong>{t('settingsPage.structuredDelete')}</strong><span>{t('settingsPage.hostActiveProject')}</span></div>
                <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.delete_file} label="delete_file" description={t('settingsPage.deleteFileDesc')} onChange={(enabled) => setDestructiveApproval('delete_file', enabled)} />

                <div className="settings-mini-heading"><strong>{t('settingsPage.gitDestructiveFamilies')}</strong><span>{t('settingsPage.exactScopedOnly')}</span></div>
                <div className="setting-grid two-col align-center">
                  <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.git_rm} label="git_rm" description={t('settingsPage.gitRmDesc')} onChange={(enabled) => setDestructiveApproval('git_rm', enabled)} />
                  <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.git_clean} label="git_clean" description={t('settingsPage.gitCleanDesc')} onChange={(enabled) => setDestructiveApproval('git_clean', enabled)} />
                  <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.git_reset_restore} label="git_reset_restore" description={t('settingsPage.gitResetDesc')} onChange={(enabled) => setDestructiveApproval('git_reset_restore', enabled)} />
                </div>

                <div className="settings-mini-heading"><strong>{t('settingsPage.shellFamilies')}</strong><span>{t('settingsPage.notRecoveryTrashBacked')}</span></div>
                <div className="setting-grid two-col align-center">
                  <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.shell_rm_unlink} label="shell_rm_unlink" description={t('settingsPage.shellRmDesc')} onChange={(enabled) => setDestructiveApproval('shell_rm_unlink', enabled)} />
                  <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.shell_rmdir} label="shell_rmdir" description={t('settingsPage.shellRmdirDesc')} onChange={(enabled) => setDestructiveApproval('shell_rmdir', enabled)} />
                  <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.shell_del_erase} label="shell_del_erase" description={t('settingsPage.shellDelDesc')} onChange={(enabled) => setDestructiveApproval('shell_del_erase', enabled)} />
                </div>

                {hostPlatform === 'win32' ? (
                  <>
                    <div className="settings-mini-heading"><strong>{t('settingsPage.wslDestructiveFamilies')}</strong><span>{t('settingsPage.exactScopedOnly')}</span></div>
                    <div className="setting-grid two-col align-center">
                      <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.wsl_rm_unlink} label="wsl_rm_unlink" description={t('settingsPage.wslRmDesc')} onChange={(enabled) => setDestructiveApproval('wsl_rm_unlink', enabled)} />
                      <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.wsl_rmdir} label="wsl_rmdir" description={t('settingsPage.wslRmdirDesc')} onChange={(enabled) => setDestructiveApproval('wsl_rmdir', enabled)} />
                    </div>
                  </>
                ) : null}

                <p className="hint">{t('settingsPage.fullProfileHint')}</p>
              </section>

              <section className="panel settings-card settings-card-polished" aria-label={t('settingsPage.stdioTitle')}>
                <SettingsCardHeading icon="▦" title={t('settingsPage.stdioTitle')} subtitle={t('settingsPage.stdioSubtitle')} badge={props.dashboard.stdioPermissionProfile.toUpperCase()} />
                <div className="setting-grid two-col align-center">
                  <div className="setting-field">
                    <label className="field-label" htmlFor="stdio-profile">{t('settingsPage.stdioPermissionProfile')}</label>
                    <select id="stdio-profile" className="settings-select" value={stdioProfile} onChange={(event) => { setStdioProfile(event.target.value as PermissionProfileName); setStdioDirty(true); }}>
                      <option value="safe">{t('profile.safe')}</option><option value="balanced">{t('profile.balanced')}</option><option value="full">{t('profile.full')}</option><option value="custom">{t('profile.custom')}</option>
                    </select>
                  </div>
                  <SettingSwitch checked={strictRoots} label={t('settingsPage.stdioStrictLabel')} description={t('settingsPage.stdioStrictDesc')} onChange={(enabled) => { setStrictRoots(enabled); setStdioDirty(true); }} />
                </div>
                <div className="setting-field">
                  <label className="field-label" htmlFor="stdio-roots">{t('settingsPage.stdioRootsLabel')}</label>
                  <textarea id="stdio-roots" className="settings-textarea" rows={5} value={allowedRootsText} placeholder={hostPlatform === 'win32' ? 'E:\\Projects\\MyApp\nD:\\Shared\\Source' : '/Users/name/Projects\n/home/name/Source'} onChange={(event) => { setAllowedRootsText(event.target.value); setStdioDirty(true); }} />
                </div>
                <div className="inline-actions"><button type="button" className="btn-save-gold" disabled={!stdioDirty} onClick={() => { void saveStdioPolicy(); }}>{t('settingsPage.stdioSave')}</button></div>
                {policyError === null ? null : <StatusMessage tone="warning" role="alert" prefix="⚠️ ">{policyError}</StatusMessage>}
                {stdioMessage === null ? null : <StatusMessage tone="success" prefix="✓ ">{stdioMessage}</StatusMessage>}
              </section>
            </>
          ) : null}

          {activeSection === 'tools' ? (
            <section className="panel settings-card settings-card-polished" aria-label={t('settingsPage.eccTitle')} data-settings-focus="tools-ecc" tabIndex={-1}>
              <SettingsCardHeading
                icon="E"
                title={t('settingsPage.eccTitle')}
                subtitle={t('settingsPage.eccSubtitle')}
                badge={props.dashboard.settings.eccEnabled === true ? t('status.enabled') : t('status.disabled')}
              />
              <SettingSwitch
                checked={props.dashboard.settings.eccEnabled === true}
                disabled={eccBusy}
                label={t('settingsPage.eccEnable')}
                description={t('settingsPage.eccDescription')}
                onChange={(enabled) => { void setEccEnabled(enabled); }}
              />
              {props.dashboard.settings.eccEnabled === true
                ? <StatusMessage tone="success">{t('settingsPage.eccActive')}</StatusMessage>
                : <EmptyState>{t('settingsPage.eccInactive')}</EmptyState>}
              <p className="hint">{t('settingsPage.eccHint')}</p>
              {eccMessage === null ? null : <StatusMessage tone="success">{eccMessage}</StatusMessage>}
            </section>
          ) : null}

          {userConfigSection === null || userConfigSection === 'security' ? null : (
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
            <PonytailPolicyEditor
              locale={props.locale}
              globalMode={props.dashboard.settings.ponytailMode}
              context={props.ponytailPolicyContext}
              busy={props.ponytailPolicyBusy}
              error={props.ponytailPolicyError}
              onGlobalModeChange={async (mode) => {
                await props.onUserSettingsChange({ ...props.dashboard.settings, ponytailMode: mode });
              }}
              onWorkspaceModeChange={props.onWorkspacePonytailModeChange}
              onGoalModeChange={props.onGoalPonytailModeChange}
            />
          ) : null}

          {activeSection === 'tunnel' ? (
            <>
              <div className="connection-choice-intro" role="note">
                <div>
                  <strong>{t('settingsPage.chooseConnection')}</strong>
                  <p>{t('settingsPage.chooseConnectionDesc')}</p>
                </div>
                <span className={`connection-count-chip ${activeRemoteConnections > 1 ? 'is-dual' : activeRemoteConnections === 1 ? 'is-online' : ''}`}>{activeRemoteConnections} {t('settingsPage.onlineConnections')}</span>
              </div>

              <details
                className="connection-method-stack is-recommended"
                open={remoteMethodOpen}
                onToggle={(event) => setRemoteMethodOpen(event.currentTarget.open)}
              >
                <summary className="connection-method-summary">
                  <div className="connection-method-summary-copy">
                    <span className="connection-method-kicker">{t('settingsPage.remoteRecommended')}</span>
                    <strong>{t('settingsPage.remoteMcpTitle')}</strong>
                    <span>{t('settingsPage.remoteSummary')}</span>
                  </div>
                  <div className="connection-method-summary-status">
                    <span className={`connection-method-live-dot ${remoteMcpOnline ? 'is-online' : ''}`} aria-hidden="true" />
                    <span>{remoteMcpOnline ? t('status.online') : ngrokReady && remoteMcp.hasAuthtoken ? t('status.ready') : t('status.setup')}</span>
                    <span className="connection-method-chevron" aria-hidden="true">⌄</span>
                  </div>
                </summary>
                <section className="panel settings-card settings-card-polished guided-tunnel-launch-card connection-method-panel" aria-label={t('settingsPage.remoteMcpAria')}>
                <SettingsCardHeading
                  icon="◎"
                  title={t('settingsPage.remoteMcpTitle')}
                  subtitle={t('settingsPage.remoteSubtitle')}
                  badge={remoteMcp.state === 'running' ? t('status.running') : remoteMcp.installed && remoteMcp.hasAuthtoken ? t('status.ready') : t('status.setup')}
                />
                <div className="setting-grid two-col">
                  <div className="setting-field">
                    <span className="field-label">{t('settingsPage.localMcp')}</span>
                    <code className="settings-path-display">{remoteMcp.localMcpUrl ?? props.dashboard.mcp.url ?? 'http://127.0.0.1:18765/mcp'}</code>
                    <p className="hint">{t('settingsPage.remoteLoopbackHint')}</p>
                  </div>
                  <div className="setting-field">
                    <span className="field-label">{t('settingsPage.publicMcpUrl')}</span>
                    <code className="settings-path-display">{remoteMcp.publicMcpUrl ?? '—'}</code>
                    <p className="hint">{t('settingsPage.remotePublicUrlHint')}</p>
                  </div>
                </div>
                <div className="tunnel-setup-box">
                  <div className="settings-mini-heading"><strong>{t('settingsPage.prepareNgrok')}</strong><span>{ngrokReady ? t('status.ready') : remoteMcp.state === 'installing' ? t('status.installing') : t('status.notReady')}</span></div>
                  <p className="hint">{t('settingsPage.ngrokVerifyHint')}</p>
                  <div className={`${ngrokReady ? 'toast-success-banner' : 'alert-box-warning'} ngrok-readiness-banner`} role="status">
                    <strong>{ngrokReady ? t('settingsPage.ngrokReady') : t('settingsPage.ngrokMissing')}</strong>
                    {ngrokReady && remoteMcp.ngrokPath !== null ? <code className="ngrok-ready-path">{remoteMcp.ngrokPath}</code> : null}
                  </div>
                  <div className="inline-actions">
                    {ngrokAutoInstallAvailable ? (
                      <button type="button" className="btn-save-gold" disabled={remoteMcpBusy || remoteMcp.state === 'running' || ngrokReady} onClick={() => { void runRemoteMcpAction('install'); }}>
                        {ngrokReady
                          ? t('settingsPage.ngrokReadyButton')
                          : remoteMcp.state === 'installing'
                            ? t('settingsPage.ngrokInstalling')
                            : remoteMcp.automaticInstallMethod === 'homebrew'
                              ? t('settingsPage.ngrokInstallHomebrew')
                              : remoteMcp.state === 'error'
                                ? t('settingsPage.ngrokRepair')
                                : t('settingsPage.ngrokInstall')}
                      </button>
                    ) : null}
                    {!ngrokReady && !ngrokAutoInstallAvailable ? <button type="button" disabled={remoteMcpBusy} onClick={() => { void props.onOpenExternalSetupPage('ngrok_download'); }}>{t('settingsPage.ngrokDownload')}</button> : null}
                    <button type="button" disabled={remoteMcpBusy} onClick={() => { void openNgrokAuthtokenPage(); }}>{t('settingsPage.ngrokAuthtokenPage')}</button>
                  </div>
                  <label className="field-label" htmlFor="remote-mcp-domain">{t('settingsPage.ngrokDomainLabel')}</label>
                  <div className="form-row"><input id="remote-mcp-domain" type="text" autoComplete="off" placeholder="example.ngrok-free.app" value={remoteMcpPublicOrigin} onChange={(event) => setRemoteMcpPublicOrigin(event.target.value)} /><button type="button" disabled={remoteMcpBusy || remoteMcpOnline || remoteMcp.state === 'starting'} onClick={() => { void runRemoteMcpAction('domain'); }}>{t('settingsPage.ngrokDomainSave')}</button></div>
                  <p className="hint">{t('settingsPage.ngrokDomainHint')}</p>
                  <label className="field-label" htmlFor="remote-mcp-authtoken">{t('settingsPage.ngrokAuthtokenLabel')}</label>
                  <div className="form-row"><input id="remote-mcp-authtoken" type="password" autoComplete="off" placeholder={remoteMcp.hasAuthtoken ? '••••••••••••••••' : '2abc...'} value={remoteMcpAuthtoken} onChange={(event) => setRemoteMcpAuthtoken(event.target.value)} /><button type="button" className="btn-save-gold" disabled={remoteMcpBusy || remoteMcpAuthtoken.trim().length === 0} onClick={() => { void runRemoteMcpAction('save'); }}>{t('settingsPage.saveSecurely')}</button></div>
                  <p className="hint">{remoteMcp.hasAuthtoken ? t('settingsPage.ngrokStored', { storage: secureStorageLabel }) : t('settingsPage.ngrokPlaintextHint')}</p>
                </div>
                <div className="tunnel-setup-box">
                  <div className="settings-mini-heading"><strong>{t('settingsPage.startRemoteMcp')}</strong><span>{remoteMcp.oauthConnected ? t('status.linked') : remoteMcp.oauthProtected ? t('status.ready') : t('status.authRequired')}</span></div>
                  <div className="inline-actions">
                    <button type="button" className="btn-save-gold" disabled={remoteMcpBusy || !remoteMcp.hasAuthtoken || remoteMcp.state === 'running'} onClick={() => { void runRemoteMcpAction('start'); }}>{remoteMcpBusy && remoteMcp.state !== 'running' ? t('settingsPage.working') : t('settingsPage.startRemoteMcpButton')}</button>
                    <button type="button" disabled={remoteMcpBusy || remoteMcp.state !== 'running'} onClick={() => { void runRemoteMcpAction('stop'); }}>{t('settingsPage.stop')}</button>
                    <button type="button" disabled={remoteMcp.publicMcpUrl === null} onClick={() => { void copyRemoteMcpUrl(); }}>{t('settingsPage.copyMcpUrl')}</button>
                    <button type="button" disabled={remoteMcpBusy || !remoteMcp.oauthConnected} onClick={() => { void runRemoteMcpAction('resetOauth'); }}>{t('settingsPage.reconnectChatgpt')}</button>
                    <button type="button" onClick={() => { void props.onOpenExternalSetupPage('chatgpt_plugins'); }}>{t('settingsPage.openChatgptPlugins')}</button>
                  </div>
                  {remoteMcp.oauthConnected ? (
                    <StatusMessage tone="success" className="remote-mcp-auth-banner">
                      <strong>{t('settingsPage.chatgptConnected')}</strong>
                      <span>{remoteMcp.autoStartEnabled ? t('settingsPage.oauthRememberedAuto') : t('settingsPage.oauthRememberedManual')}</span>
                    </StatusMessage>
                  ) : null}
                  <p className="hint">{t('settingsPage.remoteFirstTimeHint')}</p>
                  {remoteMcp.message === null ? null : <StatusMessage tone={remoteMcp.state === 'error' ? 'warning' : 'neutral'}>{remoteMcp.message}{remoteMcp.ngrokPath === null ? '' : ` · ngrok: ${remoteMcp.ngrokPath}`}</StatusMessage>}
                  {remoteMcpMessage === null ? null : <StatusMessage tone={remoteMcp.state === 'error' || /failed|error|exit|stopped unexpectedly/i.test(remoteMcpMessage) ? 'warning' : 'success'}>{remoteMcpMessage}</StatusMessage>}
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
                    <span className="connection-method-kicker">{remoteMcpOnline ? t('settingsPage.alternativeAdvanced') : t('settingsPage.alternative')}</span>
                    <strong>{t('settingsPage.secureTunnelName')}</strong>
                    <span>{t('settingsPage.secureTunnelSummary')}</span>
                  </div>
                  <div className="connection-method-summary-status">
                    <span className={`connection-method-live-dot ${secureTunnelOnline ? 'is-online' : ''}`} aria-hidden="true" />
                    <span>{secureTunnelOnline ? t('status.online') : guidedTunnelConfigured ? t('status.ready') : t('status.setup')}</span>
                    <span className="active-project-count">{props.dashboard.tunnel.auth?.mode === 'oauth' ? t('status.oauth') : t('status.apiKey')}</span>
                    <span className="connection-method-chevron" aria-hidden="true">⌄</span>
                  </div>
                </summary>

              <section className="panel settings-card settings-card-polished connection-method-panel" aria-label={t('settingsPage.tunnelAuthentication')}>
                <SettingsCardHeading
                  icon="◎"
                  title={t('settingsPage.secureTunnelName')}
                  subtitle={t('settingsPage.secureTunnelSubtitle')}
                  badge={props.dashboard.tunnel.auth?.mode === 'oauth' ? t('status.oauth') : t('status.apiKey')}
                />
                <UserConfigPanel
                  locale={props.locale}
                  hostPlatform={hostPlatform}
                  hostArch={hostArch}
                  permissionProfile={props.dashboard.permissionProfile}
                  stdioPermissionProfile={props.dashboard.stdioPermissionProfile}
                  settings={props.dashboard.settings}
                  section="tunnel"
                  unrestricted={props.dashboard.unrestricted}
                  onUnrestrictedChange={props.onUnrestrictedChange}
                  onSave={props.onUserSettingsChange}
                  onInstallPdfProvider={props.onInstallPdfProvider}
                  embedded
                />
                <div className="setting-grid two-col">
                  <div className="setting-field">
                    <span className="field-label">{t('settingsPage.activeMethod')}</span>
                    <strong>{props.dashboard.tunnel.auth?.mode === 'oauth' ? t('settingsPage.oauthSignInMethod') : t('settingsPage.runtimeApiKeyMethod')}</strong>
                    <p className="hint">{props.dashboard.tunnel.auth?.mode === 'oauth'
                      ? (props.dashboard.tunnel.auth.accountLabel ?? t('settingsPage.signedIn'))
                      : t('settingsPage.legacyStillSupported')}</p>
                  </div>
                  <div className="setting-field">
                    <span className="field-label">{t('settingsPage.oauthProvisioning')}</span>
                    <strong>{props.dashboard.tunnel.oauth?.available ? t('settingsPage.available') : t('settingsPage.unavailable')}</strong>
                    {props.dashboard.tunnel.oauth?.reason === null || props.dashboard.tunnel.oauth?.reason === undefined ? null : <p className="hint">{props.dashboard.tunnel.oauth.reason}</p>}
                  </div>
                </div>
                <div className="inline-actions">
                  {props.dashboard.tunnel.auth?.mode === 'oauth' ? (
                    <>
                      <button type="button" disabled={oauthBusy || !props.dashboard.tunnel.auth.hasLegacyApiKey} onClick={() => { void rollbackToLegacyAuth(); }}>{t('settingsPage.switchToApiKey')}</button>
                      <button type="button" disabled={oauthBusy} onClick={() => { void logoutOAuth(); }}>{t('settingsPage.signOutOauth')}</button>
                    </>
                  ) : (
                    <button type="button" className="btn-save-gold" disabled={oauthBusy || props.dashboard.tunnel.oauth?.available !== true} onClick={() => { void beginOAuthLogin(); }}>
                      {oauthBusy ? t('settingsPage.oauthStarting') : t('settingsPage.signInOauth')}
                    </button>
                  )}
                  {oauthLogin?.state === 'waiting_for_browser' || oauthLogin?.state === 'exchanging' ? <button type="button" onClick={() => { void props.onCancelTunnelOAuthLogin().then(setOauthLogin); }}>{t('settingsPage.cancelSignIn')}</button> : null}
                </div>
                {oauthLogin === null ? null : <p className="hint" role="status">OAuth: {oauthLogin.state}{oauthLogin.message === null ? '' : ` — ${oauthLogin.message}`}</p>}
              </section>

              {tunnelPresentation.isOAuth ? (
                <section className="panel settings-card settings-card-polished guided-tunnel-launch-card connection-method-followup-card" aria-label={t('settingsPage.oauthConnectionStatus')}>
                  <SettingsCardHeading icon="◎" title={t('settingsPage.oauthConnectionTitle')} subtitle={t('settingsPage.oauthConnectionSubtitle')} badge={guidedTunnelRunning ? t('status.running') : guidedTunnelConfigured ? t('status.ready') : t('status.oauth')} />
                  <p className="hint">{props.dashboard.tunnel.auth?.accountLabel ?? (props.dashboard.tunnel.auth?.authReady ? t('settingsPage.oauthReady') : t('settingsPage.oauthNeedsAction'))}</p>
                  {props.dashboard.tunnel.auth?.message === null || props.dashboard.tunnel.auth?.message === undefined ? null : <p className="hint">{props.dashboard.tunnel.auth.message}</p>}
                  <div className="inline-actions">
                    {!props.dashboard.tunnel.auth?.authReady ? <button type="button" className="btn-save-gold" disabled={oauthBusy || props.dashboard.tunnel.oauth?.available !== true} onClick={() => { void beginOAuthLogin(); }}>{t('settingsPage.signInOauth')}</button> : null}
                    <button type="button" disabled={tunnelBusy || !guidedTunnelConfigured || props.dashboard.tunnel.state === 'running'} onClick={() => { void props.onStartTunnel(); }}>{t(tunnelPresentation.startKey)}</button>
                    <button type="button" disabled={tunnelBusy || props.dashboard.tunnel.state === 'stopped'} onClick={() => { void props.onStopTunnel(); }}>{t(tunnelPresentation.stopKey)}</button>
                  </div>
                </section>
              ) : (
                <>
                  <section className="panel settings-card settings-card-polished guided-tunnel-launch-card connection-method-followup-card" aria-label={t('guidedTunnel.openGuide')}>
                    <SettingsCardHeading icon="↗" title={t('guidedTunnel.openGuide')} subtitle={t('guidedTunnel.privacy')} badge={guidedTunnelRunning ? t('status.running') : guidedTunnelConfigured ? t('status.ready') : t('status.setup')} />
                    <p className="hint">{guidedTunnelRunning ? t('guidedTunnel.localComplete') : guidedTunnelConfigured ? t('guidedTunnel.configured') : t('guidedTunnel.dismissedHint')}</p>
                    <div className="inline-actions">
                      <button type="button" className="btn-save-gold" onClick={() => props.onGuidedTunnelSetupOpenChange(true)}>{t('guidedTunnel.openGuide')}</button>
                      <button type="button" onClick={() => { void props.onOpenExternalSetupPage('openai_tunnels'); }}>{t('guidedTunnel.openTunnelSettings')}</button>
                      <button type="button" onClick={() => { void props.onOpenExternalSetupPage('openai_api_keys'); }}>{t('guidedTunnel.openApiKeys')}</button>
                    </div>
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
                <summary>{tunnelPresentation.isOAuth ? t('settingsPage.advancedApiKeyFallback') : t('guidedTunnel.advanced')}</summary>
                <section className="panel settings-card settings-card-polished" aria-label={t('settings.tunnelTitle')}>
              <SettingsCardHeading icon="↗" title={tunnelPresentation.isOAuth ? t('settingsPage.legacyFallbackTitle') : t('settings.tunnelTitle')} subtitle={tunnelPresentation.isOAuth ? t('settingsPage.legacyFallbackSubtitle') : t('settingsPage.credentialsSubtitle')} badge={tunnelPresentation.isOAuth ? 'LEGACY' : props.dashboard.tunnel.profileExists ? t('settingsPage.ready') : t('settingsPage.setup')} />
              <div className="setting-grid two-col">
                <div className="setting-field">
                  <label className="field-label" htmlFor="tunnel-key">{t('settings.tunnelKey')}</label>
                  <div className="form-row"><div className="password-input-wrapper"><input id="tunnel-key" type={showApiKey ? 'text' : 'password'} placeholder={props.dashboard.tunnel.hasApiKey ? '••••••••••••••••' : 'sk-...'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" /><button type="button" className="toggle-pw-btn" onClick={() => setShowApiKey((value) => !value)}>{showApiKey ? t('common.hide') : t('common.show')}</button></div><button type="button" className="btn-save-gold" onClick={() => { void props.onSaveTunnelApiKey(apiKey).then(() => { setApiKey(''); setSavedMessage(t('settings.saved')); }); }}>{t('settings.saveKey')}</button></div>
                  <p className="hint">{props.dashboard.tunnel.hasApiKey ? t('settingsPage.secureStorageProtected') : t('tunnel.needKey')}</p>
                </div>
                <div className="setting-field">
                  <label className="field-label" htmlFor="tunnel-client-path">{t('settingsPage.tunnelClientBundled')}</label>
                  <div className="form-row"><input id="tunnel-client-path" placeholder={t('settingsPage.tunnelClientBundledPlaceholder')} value={clientPath} onChange={(event) => setClientPath(event.target.value)} /><button type="button" onClick={() => { void browseTunnelClient(); }}>{t('settingsPage.browse')}</button><button type="button" className="btn-save-gold" onClick={() => { void props.onSetTunnelClientPath(clientPath).then(() => setSavedMessage(clientPath.trim().length === 0 ? t('settingsPage.usingBundled') : t('settings.saved'))); }}>{clientPath.trim().length === 0 ? t('settingsPage.useBundled') : t('settingsPage.saveOverride')}</button></div>
                  <p className="hint">{t('settingsPage.tunnelClientHint')}</p>
                </div>
              </div>
              <div className="tunnel-setup-box">
                <div className="settings-mini-heading"><strong>{t('settingsPage.setupWizard')}</strong><span>{t('settingsPage.setupWizardNoInit')}</span></div>
                <label className="field-label" htmlFor="tunnel-id">{t('settingsPage.openAiTunnelId')}</label>
                <div className="form-row"><input id="tunnel-id" placeholder="tunnel_0123456789abcdef..." value={tunnelId} onChange={(event) => setTunnelId(event.target.value)} /><button type="button" className="btn-save-gold" disabled={tunnelBusy} onClick={() => { void configureTunnel(); }}>{tunnelBusy ? t('settingsPage.configuring') : t('settingsPage.configureTunnel')}</button></div>
                <p className="hint">{t('settingsPage.tunnelIdentityHint')}</p>
              </div>
              {savedMessage === null ? null : <div className="toast-success-banner" role="status">✓ {savedMessage}</div>}
              {tunnelMessage === null ? null : <div className="alert-box-warning" role="status">{tunnelMessage}</div>}
              {props.dashboard.tunnel.persistent === null ? null : (
                <div className="tunnel-setup-box persistent-runtime-card">
                  <div className="settings-mini-heading"><strong>{t('settingsPage.persistentTunnelIdentity')}</strong><span>{props.dashboard.tunnel.persistent.runtimeAlias}</span></div>
                  <div className="setting-grid two-col">
                    <div className="setting-field"><span className="field-label">{t('settingsPage.tunnelId')}</span><code className="settings-path-display">{props.dashboard.tunnel.persistent.tunnelIdMasked ?? '—'}</code></div>
                    <div className="setting-field"><span className="field-label">{t('settingsPage.runtimeMode')}</span><strong>{props.dashboard.tunnel.persistent.mode}</strong></div>
                    <div className="setting-field"><span className="field-label">{t('common.status')}</span><strong>{props.dashboard.tunnel.persistent.state}</strong></div>
                    <div className="setting-field"><span className="field-label">{t('settingsPage.reconnectCount')}</span><strong>{props.dashboard.tunnel.persistent.reconnectCount}</strong></div>
                    <div className="setting-field"><span className="field-label">{t('settingsPage.healthReadyPoll')}</span><strong>{formatTunnelTriState(t, props.dashboard.tunnel.persistent.healthy)} / {formatTunnelTriState(t, props.dashboard.tunnel.persistent.ready)} / {formatTunnelTriState(t, props.dashboard.tunnel.persistent.pollHealthy)}</strong></div>
                    <div className="setting-field"><span className="field-label">{t('settingsPage.localMcp')}</span><code className="settings-path-display">{props.dashboard.tunnel.persistent.localMcpUrl ?? '—'}</code></div>
                  </div>
                  <div className={props.dashboard.tunnel.persistent.strictZeroDowntime ? 'toast-success-banner' : 'alert-box-warning'}>
                    {props.dashboard.tunnel.persistent.strictZeroDowntime
                      ? t('settingsPage.zeroDowntimeProven')
                      : t('settingsPage.zeroDowntimeUnproven')}
                  </div>
                  <div className="inline-actions"><button type="button" className="btn-save-gold" disabled={tunnelBusy} onClick={() => { void reconnectSameTunnel(); }}>{t('settingsPage.reconnectSameTunnel')}</button><button type="button" disabled={tunnelBusy || props.dashboard.tunnel.state === 'stopped'} onClick={() => { void stopPersistentTunnel(); }}>{t('settingsPage.stopTunnel')}</button></div>
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
              <section className="panel settings-card settings-card-polished" aria-label={t('settingsPage.recoveryTitle')}>
                <SettingsCardHeading
                  icon="↶"
                  title={t('settingsPage.recoveryTitle')}
                  subtitle={t('settingsPage.recoverySubtitle')}
                  badge={`${props.dashboard.recovery.trashItems.length + props.dashboard.recovery.checkpoints.length} ITEMS`}
                />
                <div className="setting-field">
                  <span className="field-label">{t('settingsPage.recoveryLocation')}</span>
                  <code className="settings-path-display">{props.dashboard.recovery.trashRoot ?? t('settingsPage.notConfigured')}</code>
                </div>
                <div className="recovery-retention-row">
                  <div>
                    <strong>{t('settingsPage.recoveryCleanup')}</strong>
                    <p className="hint">{t('settingsPage.recoveryCleanupHint')}</p>
                  </div>
                  <select aria-label={t('settingsPage.recoveryRetention')} disabled={retentionBusy} value={props.dashboard.settings.recoveryRetentionDays} onChange={(event) => { void setRecoveryRetentionDays(Number(event.target.value)); }}>
                    <option value={0}>{t('settingsPage.never')}</option>
                    {[7, 14, 30, 60, 90, 180, 365].map((days) => <option key={days} value={days}>{days} {t('settingsPage.days')}</option>)}
                  </select>
                </div>
                <div className="settings-mini-heading"><strong>{t('settingsPage.deletedBackups')}</strong><span>{props.dashboard.recovery.trashItems.length}</span></div>
                {props.dashboard.recovery.trashItems.length === 0 ? <EmptyState>{t('settingsPage.recoveryEmpty')}</EmptyState> : (
                  <div className="backup-list settings-backup-list recovery-scroll-list" onScroll={(event) => { if (nearScrollEnd(event)) setTrashVisibleCount((current) => Math.min(props.dashboard.recovery.trashItems.length, current + RECOVERY_PAGE_SIZE)); }}>{props.dashboard.recovery.trashItems.slice(0, trashVisibleCount).map((item) => (
                    <div key={item.recoveryId} className="backup-item">
                      <div><strong>{item.relativePath}</strong><p className="hint">{formatDateTime(item.deletedAt, '—', props.locale)} · {item.kind === 'replacement_backup' ? t('settingsPage.preReplacement') : item.isDirectory ? t('common.folder') : t('common.file')} · {item.payloadAvailable ? t('settingsPage.readyState') : t('settingsPage.payloadMissing')}</p></div>
                      <button type="button" disabled={!item.payloadAvailable || recoveryBusyId !== null} onClick={() => { void restoreTrashItem(item.workspaceId, item.recoveryId, item.relativePath, item.kind); }}>{recoveryBusyId === item.recoveryId ? t('settingsPage.restoring') : t('settingsPage.restore')}</button>
                    </div>
                  ))}</div>
                )}
                <div className="settings-mini-heading"><strong>{t('settingsPage.checkpoints')}</strong><span>{props.dashboard.recovery.checkpoints.length}</span></div>
                {props.dashboard.recovery.checkpoints.length === 0 ? <EmptyState>{t('settingsPage.noCheckpoints')}</EmptyState> : (
                  <div className="backup-list settings-backup-list recovery-scroll-list" onScroll={(event) => { if (nearScrollEnd(event)) setCheckpointVisibleCount((current) => Math.min(props.dashboard.recovery.checkpoints.length, current + RECOVERY_PAGE_SIZE)); }}>{props.dashboard.recovery.checkpoints.slice(0, checkpointVisibleCount).map((checkpoint) => {
                    const paths = checkpoint.files.map((file) => file.path);
                    return <div key={checkpoint.id} className="backup-item"><div><strong>{formatDateTime(checkpoint.createdAt, '—', props.locale)}</strong><p className="hint">{paths.join(', ')} · {formatBytes(checkpoint.files.reduce((total, file) => total + file.size, 0))}</p></div><button type="button" disabled={recoveryBusyId !== null} onClick={() => { void restoreCheckpoint(checkpoint.workspaceId, checkpoint.id, paths); }}>{recoveryBusyId === checkpoint.id ? t('settingsPage.restoring') : t('settingsPage.restorePoint')}</button></div>;
                  })}</div>
                )}
                {recoveryError === null ? null : <StatusMessage tone="warning" role="alert" prefix="⚠️ ">{recoveryError}</StatusMessage>}
                {recoveryMessage === null ? null : <StatusMessage tone="success" prefix="✓ ">{recoveryMessage}</StatusMessage>}
              </section>

              <section className="panel settings-card settings-card-polished" aria-label={t('settingsPage.backupRestore')}>
                {props.dashboard.restoreNotice?.hostCompatibility === 'cross_host' ? (
                  <div className="alert-box-warning" role="status">
                    ⚠️ {t('backup.crossHostNotice')} {props.dashboard.restoreNotice.relinkRequired ? t('backup.crossHostRelink') : null} {props.dashboard.restoreNotice.incomplete ? t('backup.crossHostSecret') : null}
                  </div>
                ) : null}
                <SettingsCardHeading icon="▣" title={t('settingsPage.databaseBackup')} subtitle={t('settingsPage.sqliteSnapshots')} action={<button type="button" className="btn-save-gold" disabled={backupBusy} onClick={() => { void createBackupNow(); }}>{backupBusy ? t('settingsPage.working') : t('settingsPage.backupNow')}</button>} />
                {props.dashboard.backups.length === 0 ? <EmptyState>{t('settingsPage.noBackups')}</EmptyState> : (
                  <div className="backup-list settings-backup-list recovery-scroll-list" onScroll={(event) => { if (nearScrollEnd(event)) setBackupVisibleCount((current) => Math.min(props.dashboard.backups.length, current + RECOVERY_PAGE_SIZE)); }}>{props.dashboard.backups.slice(0, backupVisibleCount).map((backup) => (
                    <div key={backup.id} className="backup-item"><div><strong>{formatDateTime(backup.createdAt, '—', props.locale)}</strong><p className="hint">{backup.reason} · {formatBytes(backup.sizeBytes)}{backup.hostCompatibility === 'cross_host' ? ` · ${t('backup.crossHostLabel')}` : ''}</p></div><button type="button" disabled={backupBusy || props.dashboard.tunnel.state === 'running' || props.dashboard.mcp.running} onClick={() => { void scheduleRestore(backup.id); }}>{t('settingsPage.restoreBackup')}</button></div>
                  ))}</div>
                )}
                {(props.dashboard.tunnel.state === 'running' || props.dashboard.mcp.running) ? <StatusMessage tone="warning" prefix="⚠️ ">{t('settingsPage.stopBeforeRestore')}</StatusMessage> : null}
                {backupError === null ? null : <StatusMessage tone="warning" role="alert" prefix="⚠️ ">{backupError}</StatusMessage>}
                {backupMessage === null ? null : <StatusMessage tone="success" prefix="✓ ">{backupMessage}</StatusMessage>}
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function nearScrollEnd(event: UIEvent<HTMLDivElement>): boolean {
  const element = event.currentTarget;
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 320;
}

function profileHint(t: Translator, profile: PermissionProfileName): string {
  if (profile === 'safe') return t('settingsPage.profile.safe');
  if (profile === 'balanced') return t('settingsPage.profile.balanced');
  if (profile === 'full') return t('settingsPage.profile.full');
  return t('settingsPage.profile.custom');
}

function formatTunnelTriState(t: Translator, value: boolean | null): string {
  return value === null ? '—' : value ? t('status.ok') : t('status.fail');
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0 B';
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / (1024 * 1024)).toFixed(1) + ' MB';
}
