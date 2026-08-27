import { useEffect, useState, type ReactElement } from 'react';
import type { DashboardSnapshot, DestructiveDeletePolicy, ExternalSetupTarget, PermissionProfileName, TunnelStatus, UiLocale, UserSettings } from '@lnwjud/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';
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
  readonly onChooseTunnelClientPath: () => Promise<string | null>;
  readonly onConfigureTunnelProfile: (tunnelId: string) => Promise<string>;
  readonly onStartTunnel: () => Promise<TunnelStatus>;
  readonly onStopTunnel: () => Promise<void>;
  readonly onOpenExternalSetupPage: (target: ExternalSetupTarget) => Promise<void>;
  readonly onRefresh: () => Promise<void>;
  readonly guidedTunnelSetupOpen: boolean;
  readonly onGuidedTunnelSetupOpenChange: (open: boolean) => void;
  readonly onGuidedTunnelLocalComplete: () => void;
  readonly initialSection?: SettingsSection;
  readonly requestedSection?: { readonly section: SettingsSection; readonly requestId: number } | undefined;
}

export type SettingsSection = 'general' | 'security' | 'tools' | 'mcp' | 'tunnel' | 'backup';
type DestructiveApprovalKey = keyof DestructiveDeletePolicy['approvals'];

export function SettingsPage(props: SettingsPageProps): ReactElement {
  const t = createTranslator(props.locale);
  const guidedTunnelRunning = isTunnelRunning(props.dashboard.tunnel);
  const guidedTunnelConfigured = props.dashboard.tunnel.hasApiKey && props.dashboard.tunnel.profileExists;
  const [activeSection, setActiveSection] = useState<SettingsSection>(props.initialSection ?? 'general');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [clientPath, setClientPath] = useState(props.dashboard.tunnel.clientPath ?? '');
  const [tunnelId, setTunnelId] = useState('');
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [tunnelMessage, setTunnelMessage] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [unrestrictedMessage, setUnrestrictedMessage] = useState<string | null>(null);
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
      setSavedMessage(props.locale === 'th' ? 'บันทึก tunnel-client.exe แล้ว' : 'tunnel-client.exe saved.');
    } catch (cause: unknown) {
      setTunnelMessage(cause instanceof Error ? cause.message : 'Could not select tunnel-client.exe');
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

  const navItems: readonly { id: SettingsSection; icon: string; title: string; description: string }[] = [
    { id: 'general', icon: '⌘', title: props.locale === 'th' ? 'ทั่วไป' : 'General', description: props.locale === 'th' ? 'ภาษา, Startup, Update' : 'Language, startup, updates' },
    { id: 'security', icon: '◇', title: props.locale === 'th' ? 'ความปลอดภัย' : 'Security', description: props.locale === 'th' ? 'สิทธิ์และ Workspace policy' : 'Permissions and workspace policy' },
    { id: 'tools', icon: '◎', title: props.locale === 'th' ? 'Tools' : 'Tools', description: props.locale === 'th' ? 'Codex, Timeout, Roots' : 'Codex, timeouts, roots' },
    { id: 'mcp', icon: '⬡', title: 'MCP & Extensions', description: props.locale === 'th' ? 'Servers, Skills, Allowlist' : 'Servers, skills, allowlist' },
    { id: 'tunnel', icon: '↗', title: 'Secure Tunnel', description: props.locale === 'th' ? 'API Key, Client, Reconnect' : 'API key, client, reconnect' },
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
              <section className="panel settings-card settings-card-polished" aria-label={t('settings.securityTitle')}>
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

              <section className="panel settings-card settings-card-polished" aria-label={t('settings.unrestricted')}>
                <SettingsCardHeading icon="⚡" title={t('settings.unrestricted')} subtitle={props.locale === 'th' ? 'ปลดข้อจำกัด machine roots สำหรับงานที่ต้องการสิทธิ์เต็ม' : 'Remove machine-root restrictions for full-power workflows'} badge={props.dashboard.unrestricted ? 'ON' : 'OFF'} />
                <SettingSwitch checked={props.dashboard.unrestricted} label={props.locale === 'th' ? 'Unrestricted mode' : 'Unrestricted mode'} description={t('settings.unrestrictedHint')} onChange={(enabled) => { void props.onUnrestrictedChange(enabled).then((restartRequired) => setUnrestrictedMessage(restartRequired ? t('settings.restartRequired') : null)); }} />
                {unrestrictedMessage === null ? null : <div className="alert-box-warning" role="status">⚠️ {unrestrictedMessage}</div>}
              </section>

              <section className="panel settings-card settings-card-polished" aria-label="AI destructive action policy">
                <SettingsCardHeading
                  icon="⌫"
                  title={props.locale === 'th' ? 'ความปลอดภัยการลบ / ทำข้อมูลหาย' : 'Delete & Data-Loss Safety'}
                  subtitle={props.locale === 'th' ? 'Full จะถามเฉพาะ destructive family ที่ยังไม่ได้อนุญาต หรือพิสูจน์ขอบเขตไม่ได้' : 'Full prompts only for destructive families that are not safely auto-approved by these settings'}
                  badge={`${Object.values(props.dashboard.destructiveDeletePolicy.approvals).filter(Boolean).length}/9`}
                />
                <div className="alert-box-warning" role="note">
                  ⚠️ {props.locale === 'th'
                    ? 'Full Access ไม่ถามงานปกติ การเปิด auto-approval ด้านล่างมีผลเฉพาะคำสั่งลบ/ทำข้อมูลหายที่แยก target ได้ชัดและอยู่ใน Active Project เท่านั้น; root, critical path, wildcard, recursive/broad และคำสั่งที่วิเคราะห์ไม่ได้ยังถาม ส่วนคำสั่งระดับเครื่องอันตรายยังถูกบล็อก'
                    : 'Full Access does not prompt for ordinary work. Auto-approval below applies only to destructive actions with an exact target proven inside the Active Project; roots, critical paths, wildcards, recursive/broad or unparseable actions still ask, and dangerous machine-level commands remain blocked.'}
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

                <div className="settings-mini-heading"><strong>WSL destructive families</strong><span>{props.locale === 'th' ? 'exact scoped forms เท่านั้น' : 'exact scoped forms only'}</span></div>
                <div className="setting-grid two-col align-center">
                  <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.wsl_rm_unlink} label="wsl_rm_unlink" description={props.locale === 'th' ? 'Auto-approve WSL rm/unlink target เดียวใน Active Project; recursive/absolute Linux path/broad forms ยังถาม' : 'Auto-approves one WSL rm/unlink target in the Active Project; recursive, absolute Linux paths, and broad forms still ask'} onChange={(enabled) => setDestructiveApproval('wsl_rm_unlink', enabled)} />
                  <SettingSwitch checked={props.dashboard.destructiveDeletePolicy.approvals.wsl_rmdir} label="wsl_rmdir" description={props.locale === 'th' ? 'Auto-approve WSL rmdir target เดียว; parents/broad/outside forms ยังถาม' : 'Auto-approves one WSL rmdir target; parents, broad, and outside forms still ask'} onChange={(enabled) => setDestructiveApproval('wsl_rmdir', enabled)} />
                </div>

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
                  <textarea id="stdio-roots" className="settings-textarea" rows={5} value={allowedRootsText} placeholder={'E:\\Projects\\MyApp\nD:\\Shared\\Source'} onChange={(event) => { setAllowedRootsText(event.target.value); setStdioDirty(true); }} />
                </div>
                <div className="inline-actions"><button type="button" className="btn-save-gold" disabled={!stdioDirty} onClick={() => { void saveStdioPolicy(); }}>{props.locale === 'th' ? 'บันทึก STDIO Policy' : 'Save STDIO Policy'}</button></div>
                {policyError === null ? null : <div className="alert-box-warning" role="alert">⚠️ {policyError}</div>}
                {stdioMessage === null ? null : <div className="toast-success-banner" role="status">✓ {stdioMessage}</div>}
              </section>
            </>
          ) : null}

          <UserConfigPanel locale={props.locale} settings={props.dashboard.settings} section={userConfigSection} onSave={props.onUserSettingsChange} />

          {activeSection === 'tunnel' ? (
            <>
              <section className="panel settings-card settings-card-polished guided-tunnel-launch-card" aria-label={t('guidedTunnel.openGuide')}>
                <SettingsCardHeading icon="↗" title={t('guidedTunnel.openGuide')} subtitle={t('guidedTunnel.privacy')} badge={guidedTunnelRunning ? 'RUNNING' : guidedTunnelConfigured ? 'READY' : 'SETUP'} />
                <p className="hint">{guidedTunnelRunning ? t('guidedTunnel.localComplete') : t('guidedTunnel.dismissedHint')}</p>
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

              <details className="guided-tunnel-advanced">
                <summary>{t('guidedTunnel.advanced')}</summary>
                <section className="panel settings-card settings-card-polished" aria-label={t('settings.tunnelTitle')}>
              <SettingsCardHeading icon="↗" title={t('settings.tunnelTitle')} subtitle={props.locale === 'th' ? 'Credential, tunnel-client และ Setup Wizard' : 'Credentials, tunnel-client, and setup wizard'} badge={props.dashboard.tunnel.profileExists ? (props.locale === 'th' ? 'พร้อมใช้งาน' : 'READY') : (props.locale === 'th' ? 'ต้องตั้งค่า' : 'SETUP')} />
              <div className="setting-grid two-col">
                <div className="setting-field">
                  <label className="field-label" htmlFor="tunnel-key">{t('settings.tunnelKey')}</label>
                  <div className="form-row"><div className="password-input-wrapper"><input id="tunnel-key" type={showApiKey ? 'text' : 'password'} placeholder={props.dashboard.tunnel.hasApiKey ? '••••••••••••••••' : 'sk-...'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" /><button type="button" className="toggle-pw-btn" onClick={() => setShowApiKey((value) => !value)}>{showApiKey ? 'Hide' : 'Show'}</button></div><button type="button" className="btn-save-gold" onClick={() => { void props.onSaveTunnelApiKey(apiKey).then(() => { setApiKey(''); setSavedMessage(t('settings.saved')); }); }}>{t('settings.saveKey')}</button></div>
                  <p className="hint">{props.dashboard.tunnel.hasApiKey ? 'Protected with Windows DPAPI' : t('tunnel.needKey')}</p>
                </div>
                <div className="setting-field">
                  <label className="field-label" htmlFor="tunnel-client-path">{props.locale === 'th' ? 'tunnel-client (รวมมากับโปรแกรมแล้ว)' : 'tunnel-client (bundled)'}</label>
                  <div className="form-row"><input id="tunnel-client-path" placeholder={props.locale === 'th' ? 'ใช้ v0.0.12 ที่มากับ lnwjud อัตโนมัติ' : 'Bundled v0.0.12 is used automatically'} value={clientPath} onChange={(event) => setClientPath(event.target.value)} /><button type="button" onClick={() => { void browseTunnelClient(); }}>{props.locale === 'th' ? 'เลือกไฟล์…' : 'Browse…'}</button><button type="button" className="btn-save-gold" onClick={() => { void props.onSetTunnelClientPath(clientPath).then(() => setSavedMessage(clientPath.trim().length === 0 ? (props.locale === 'th' ? 'กลับมาใช้ tunnel-client ที่มากับโปรแกรมแล้ว' : 'Using the bundled tunnel-client again.') : t('settings.saved'))); }}>{clientPath.trim().length === 0 ? (props.locale === 'th' ? 'ใช้ตัวที่มากับโปรแกรม' : 'Use bundled') : (props.locale === 'th' ? 'บันทึก Override' : 'Save override')}</button></div>
                  <p className="hint">{props.locale === 'th' ? 'lnwjud ฝัง OpenAI tunnel-client v0.0.12 (Windows x64) ใน installer และเลือกให้เองอัตโนมัติ ช่องนี้ใช้เฉพาะกรณีต้องการ override/troubleshoot' : 'lnwjud bundles OpenAI tunnel-client v0.0.12 (Windows x64) in the installer and selects it automatically. Use this field only to override it for troubleshooting.'}</p>
                </div>
              </div>
              <div className="tunnel-setup-box">
                <div className="settings-mini-heading"><strong>Setup Wizard</strong><span>{props.locale === 'th' ? 'ไม่ต้องเปิด PowerShell init เอง' : 'No manual PowerShell init'}</span></div>
                <label className="field-label" htmlFor="tunnel-id">OpenAI Tunnel ID</label>
                <div className="form-row"><input id="tunnel-id" placeholder="tunnel_0123456789abcdef..." value={tunnelId} onChange={(event) => setTunnelId(event.target.value)} /><button type="button" className="btn-save-gold" disabled={tunnelBusy} onClick={() => { void configureTunnel(); }}>{tunnelBusy ? (props.locale === 'th' ? 'กำลังตั้งค่า…' : 'Configuring…') : (props.locale === 'th' ? 'Configure Tunnel' : 'Configure Tunnel')}</button></div>
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
                      <div><strong>{item.relativePath}</strong><p className="hint">{new Date(item.deletedAt).toLocaleString(props.locale === 'th' ? 'th-TH' : 'en-US')} · {item.kind === 'replacement_backup' ? (props.locale === 'th' ? 'สำเนาก่อนเขียนทับ' : 'pre-replacement') : item.isDirectory ? 'folder' : 'file'} · {item.payloadAvailable ? (props.locale === 'th' ? 'พร้อมกู้คืน' : 'ready') : (props.locale === 'th' ? 'payload ไม่ครบ' : 'payload missing')}</p></div>
                      <button type="button" disabled={!item.payloadAvailable || recoveryBusyId !== null} onClick={() => { void restoreTrashItem(item.workspaceId, item.recoveryId, item.relativePath, item.kind); }}>{recoveryBusyId === item.recoveryId ? (props.locale === 'th' ? 'กำลังกู้…' : 'Restoring…') : (props.locale === 'th' ? 'กู้คืน' : 'Restore')}</button>
                    </div>
                  ))}</div>
                )}
                <div className="settings-mini-heading"><strong>{props.locale === 'th' ? 'Checkpoint ก่อนแก้/เขียนทับ' : 'Pre-change checkpoints'}</strong><span>{props.dashboard.recovery.checkpoints.length}</span></div>
                {props.dashboard.recovery.checkpoints.length === 0 ? <div className="empty-setting-state">{props.locale === 'th' ? 'ยังไม่มี checkpoint' : 'No checkpoints yet'}</div> : (
                  <div className="backup-list settings-backup-list recovery-scroll-list">{props.dashboard.recovery.checkpoints.map((checkpoint) => {
                    const paths = checkpoint.files.map((file) => file.path);
                    return <div key={checkpoint.id} className="backup-item"><div><strong>{new Date(checkpoint.createdAt).toLocaleString(props.locale === 'th' ? 'th-TH' : 'en-US')}</strong><p className="hint">{paths.join(', ')} · {formatBytes(checkpoint.files.reduce((total, file) => total + file.size, 0))}</p></div><button type="button" disabled={recoveryBusyId !== null} onClick={() => { void restoreCheckpoint(checkpoint.workspaceId, checkpoint.id, paths); }}>{recoveryBusyId === checkpoint.id ? (props.locale === 'th' ? 'กำลังกู้…' : 'Restoring…') : (props.locale === 'th' ? 'ย้อนกลับจุดนี้' : 'Restore point')}</button></div>;
                  })}</div>
                )}
                {recoveryError === null ? null : <div className="alert-box-warning" role="alert">⚠️ {recoveryError}</div>}
                {recoveryMessage === null ? null : <div className="toast-success-banner" role="status">✓ {recoveryMessage}</div>}
              </section>

              <section className="panel settings-card settings-card-polished" aria-label="Backup and restore">
                <SettingsCardHeading icon="▣" title={props.locale === 'th' ? 'สำรองฐานข้อมูลโปรแกรม' : 'Application Database Backup'} subtitle="SQLite consistent snapshots" action={<button type="button" className="btn-save-gold" disabled={backupBusy} onClick={() => { void createBackupNow(); }}>{backupBusy ? (props.locale === 'th' ? 'กำลังทำงาน…' : 'Working…') : (props.locale === 'th' ? 'Backup ตอนนี้' : 'Backup Now')}</button>} />
                {props.dashboard.backups.length === 0 ? <div className="empty-setting-state">{props.locale === 'th' ? 'ยังไม่มี Backup' : 'No backups yet'}</div> : (
                  <div className="backup-list settings-backup-list">{props.dashboard.backups.slice(0, 5).map((backup) => (
                    <div key={backup.id} className="backup-item"><div><strong>{new Date(backup.createdAt).toLocaleString(props.locale === 'th' ? 'th-TH' : 'en-US')}</strong><p className="hint">{backup.reason} · {formatBytes(backup.sizeBytes)}</p></div><button type="button" disabled={backupBusy || props.dashboard.tunnel.state === 'running' || props.dashboard.mcp.running} onClick={() => { void scheduleRestore(backup.id); }}>{props.locale === 'th' ? 'Restore ชุดนี้' : 'Restore'}</button></div>
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

function splitList(value: string): readonly string[] {
  const seen = new Set<string>();
  return value.split(/[;\r\n]+/).map((entry) => entry.trim()).filter((entry) => { if (entry.length === 0) return false; const key = entry.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
}

function profileHint(locale: UiLocale, profile: PermissionProfileName): string {
  const th = { safe: 'ปลอดภัยสูงสุด: งานเขียนและรันคำสั่งต้องขออนุญาต', balanced: 'สมดุล: งานทั่วไปใน workspace ทำได้คล่องขึ้น', full: 'เต็มสิทธิ์ตาม policy ที่ยังคงบล็อก operation อันตรายระดับระบบ', custom: 'ใช้กฎ READ / WRITE / EXECUTE / DANGEROUS และ executable ที่กำหนดเอง' } as const;
  const en = { safe: 'Maximum safety: writes and execution require approval.', balanced: 'Balanced: common workspace work is less restrictive.', full: 'Full access within policy; machine-destructive operations remain blocked.', custom: 'Uses your READ / WRITE / EXECUTE / DANGEROUS rules and custom executables.' } as const;
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
