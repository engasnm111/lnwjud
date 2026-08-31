import { useEffect, useState, type ReactElement } from 'react';
import type {
  ExtraMcpServerSettings,
  PermissionDecisionSetting,
  PermissionProfileName,
  PdfProviderInstallResult,
  UiLocale,
  UserSettings,
} from '@lnwjud/ipc-contracts';
import { SettingSwitch } from './SettingSwitch.js';

export type UserConfigSection = 'general' | 'security' | 'tools' | 'mcp' | 'tunnel';

interface UserConfigPanelProps {
  readonly locale: UiLocale;
  readonly permissionProfile: PermissionProfileName;
  readonly stdioPermissionProfile: PermissionProfileName;
  readonly settings?: UserSettings;
  readonly section: UserConfigSection | null;
  readonly unrestricted: boolean;
  readonly onUnrestrictedChange: (enabled: boolean) => Promise<boolean>;
  readonly onSave: (settings: UserSettings) => Promise<boolean>;
  readonly onInstallPdfProvider: () => Promise<PdfProviderInstallResult>;
}

const DEFAULT_USER_SETTINGS: UserSettings = {
  customPermission: { read: 'ALLOW', write: 'ASK', execute: 'ASK', dangerous: 'DENY', allowedExecutables: [] },
  desktopFullBypassAll: false,
  stdioFullBypassAll: false,
  mcpCallTimeoutMs: 60_000,
  mcpIdleTimeoutMs: 5 * 60_000,
  processTimeoutMs: 60 * 60_000,
  mcpPollWaitSeconds: 5,
  shellSynchronousWaitSeconds: 60,
  capabilityRoots: [],
  pdfProviderPath: '',
  lspCommands: {},
  mcpHttpPort: 18_765,
  codexToolsEnabled: false,
  updateAutoCheck: true,
  updateCheckOnStartup: true,
  updateIntervalMinutes: 30,
  updateAutoDownload: true,
  closeBehavior: 'tray',
  launchAtStartup: false,
  startMinimized: false,
  tunnelAutoReconnect: true,
  tunnelMaxAutoRestarts: 5,
  recoveryRetentionDays: 0,
  extensions: { mode: 'enable_all', disabledServers: [], enabledServers: [], disabledSkillRoots: [], extraSkillRoots: [], extraMcpServers: [] },
};

export function UserConfigPanel({ locale, permissionProfile, stdioPermissionProfile, settings, section, unrestricted, onUnrestrictedChange, onSave, onInstallPdfProvider }: UserConfigPanelProps): ReactElement {
  const effectiveSettings = settings ?? DEFAULT_USER_SETTINGS;
  const [draft, setDraft] = useState<UserSettings>(effectiveSettings);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdfInstallBusy, setPdfInstallBusy] = useState(false);
  const [pdfInstallMessage, setPdfInstallMessage] = useState<string | null>(null);
  const [pdfInstallError, setPdfInstallError] = useState<string | null>(null);
  const [unrestrictedMessage, setUnrestrictedMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) setDraft(effectiveSettings);
  }, [effectiveSettings, dirty]);

  function patch(next: Partial<UserSettings>): void {
    setDraft((previous) => ({ ...previous, ...next }));
    markDirty();
  }

  function patchCustom(next: Partial<UserSettings['customPermission']>): void {
    setDraft((previous) => ({ ...previous, customPermission: { ...previous.customPermission, ...next } }));
    markDirty();
  }

  function patchExtensions(next: Partial<UserSettings['extensions']>): void {
    setDraft((previous) => ({ ...previous, extensions: { ...previous.extensions, ...next } }));
    markDirty();
  }

  function markDirty(): void {
    setDirty(true);
    setMessage(null);
    setError(null);
  }

  function changeFullBypass(target: 'desktop' | 'stdio', enabled: boolean): void {
    if (enabled) {
      const confirmed = window.confirm(locale === 'th'
        ? 'ยืนยันเปิด FULL BYPASS ON? lnwjud จะไม่ถามยืนยันอีก รวม tool ที่กำหนดว่าต้องยืนยันเสมอ คำสั่งอันตราย ขอบเขต Active Project, goalLease และ absolute path นอกโปรเจกต์ การแก้ไขหรือลบอาจกู้คืนไม่ได้ แต่การตรวจรูปแบบข้อมูล, Windows ACL/UAC และสิทธิ์บริการภายนอกยังคงมีผล'
        : 'Enable FULL BYPASS ON? lnwjud will stop asking for approval, including always-confirm tools, risky commands, Active Project scope, goalLease, and absolute paths outside projects. Changes or deletes may not be recoverable. Input validation, Windows ACL/UAC, and remote-service authorization still apply.');
      if (!confirmed) return;
    }
    patch(target === 'desktop' ? { desktopFullBypassAll: enabled } : { stdioFullBypassAll: enabled });
  }

  function updateServer(index: number, next: Partial<ExtraMcpServerSettings>): void {
    patchExtensions({
      extraMcpServers: draft.extensions.extraMcpServers.map((server, current) => current === index ? { ...server, ...next } : server),
    });
  }

  function addServer(): void {
    const used = new Set(draft.extensions.extraMcpServers.map((server) => server.name.toLowerCase()));
    let sequence = draft.extensions.extraMcpServers.length + 1;
    while (used.has(`mcp-server-${sequence}`)) sequence += 1;
    patchExtensions({
      extraMcpServers: [...draft.extensions.extraMcpServers, {
        name: `mcp-server-${sequence}`,
        command: '',
        args: [],
        cwd: '',
        type: '',
        env: {},
      }],
    });
  }

  async function installPdf(): Promise<void> {
    if (pdfInstallBusy) return;
    setPdfInstallBusy(true);
    setPdfInstallMessage(null);
    setPdfInstallError(null);
    try {
      const result = await onInstallPdfProvider();
      setDraft((previous) => ({ ...previous, pdfProviderPath: result.providerPath }));
      setPdfInstallMessage(result.reused
        ? (locale === 'th' ? `PDF Provider พร้อมใช้แล้ว: ${result.providerPath}` : `PDF Provider is ready: ${result.providerPath}`)
        : (locale === 'th' ? `ติดตั้ง Poppler ${result.version} และตั้งค่า pdftotext.exe เรียบร้อยแล้ว` : `Installed Poppler ${result.version} and configured pdftotext.exe.`));
    } catch (cause: unknown) {
      setPdfInstallError(cause instanceof Error ? cause.message : (locale === 'th' ? 'ดาวน์โหลดหรือติดตั้ง PDF Provider ไม่สำเร็จ' : 'Could not download or install the PDF Provider.'));
    } finally {
      setPdfInstallBusy(false);
    }
  }

  async function save(): Promise<void> {
    const invalid = draft.extensions.extraMcpServers.find((server) => server.name.trim().length === 0 || server.command.trim().length === 0);
    if (invalid !== undefined) {
      setError(locale === 'th' ? 'MCP Server ที่เพิ่มเองต้องมี Name และ Command' : 'Every custom MCP server needs a Name and Command.');
      return;
    }
    const names = draft.extensions.extraMcpServers.map((server) => server.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) {
      setError(locale === 'th' ? 'ชื่อ MCP Server ห้ามซ้ำกัน' : 'MCP server names must be unique.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const restartRequired = await onSave(draft);
      setDirty(false);
      setMessage(restartRequired
        ? (locale === 'th' ? 'บันทึกแล้ว — ค่าบางส่วนจะใช้หลัง Restart MCP/Tunnel หรือเปิดโปรแกรมใหม่' : 'Saved — some settings apply after MCP/Tunnel or app restart.')
        : (locale === 'th' ? 'บันทึกการตั้งค่าเรียบร้อยแล้ว' : 'Settings saved.'));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : (locale === 'th' ? 'บันทึกการตั้งค่าไม่สำเร็จ' : 'Could not save settings.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {section === 'general' ? (
        <section className="panel settings-card settings-card-polished" aria-label="Application and updates">
          <CardHeading icon="⚙" title={locale === 'th' ? 'พฤติกรรมโปรแกรม' : 'Application behavior'} subtitle={locale === 'th' ? 'การเปิดโปรแกรม, Tray และ Auto Update' : 'Startup, tray behavior, and automatic updates'} />
          <div className="setting-grid two-col">
            <div className="setting-field">
              <label className="field-label" htmlFor="close-behavior">{locale === 'th' ? 'เมื่อกด X ปิดหน้าต่าง' : 'When closing the window'}</label>
              <select id="close-behavior" className="settings-select" value={draft.closeBehavior} onChange={(event) => patch({ closeBehavior: event.target.value === 'quit' ? 'quit' : 'tray' })}>
                <option value="tray">{locale === 'th' ? 'ซ่อนไปที่ System Tray' : 'Hide to system tray'}</option>
                <option value="quit">{locale === 'th' ? 'ออกจาก lnwjud' : 'Quit lnwjud'}</option>
              </select>
            </div>
            <NumberField label={locale === 'th' ? 'ช่วงตรวจอัปเดต (นาที)' : 'Update interval (minutes)'} value={draft.updateIntervalMinutes} min={5} max={1440} onChange={(value) => patch({ updateIntervalMinutes: value })} />
          </div>
          <div className="switch-grid">
            <SettingSwitch checked={draft.launchAtStartup} label={locale === 'th' ? 'เปิดพร้อมระบบ' : 'Start with system'} description={locale === 'th' ? 'เปิด lnwjud อัตโนมัติหลัง Sign in' : 'Launch lnwjud automatically after sign in'} onChange={(value) => patch({ launchAtStartup: value })} />
            <SettingSwitch checked={draft.startMinimized} label={locale === 'th' ? 'เริ่มแบบซ่อนใน Tray' : 'Start minimized'} description={locale === 'th' ? 'ไม่แสดงหน้าต่างหลักตอนเปิดอัตโนมัติ' : 'Keep the main window hidden on startup'} onChange={(value) => patch({ startMinimized: value })} />
            <SettingSwitch checked={draft.updateAutoCheck} label={locale === 'th' ? 'ตรวจอัปเดตอัตโนมัติ' : 'Automatic update checks'} description={locale === 'th' ? 'ตรวจตามช่วงเวลาที่กำหนด' : 'Check periodically using the interval above'} onChange={(value) => patch({ updateAutoCheck: value })} />
            <SettingSwitch checked={draft.updateCheckOnStartup} label={locale === 'th' ? 'ตรวจเมื่อเปิดโปรแกรม' : 'Check on startup'} description={locale === 'th' ? 'ตรวจหลังเปิดโปรแกรมไม่นาน' : 'Check shortly after the app starts'} onChange={(value) => patch({ updateCheckOnStartup: value })} />
            <SettingSwitch checked={draft.updateAutoDownload} label={locale === 'th' ? 'ดาวน์โหลดอัปเดตอัตโนมัติ' : 'Automatic update download'} description={locale === 'th' ? 'ดาวน์โหลดเวอร์ชันใหม่เมื่อพบ' : 'Download a new version when available'} onChange={(value) => patch({ updateAutoDownload: value })} />
          </div>
        </section>
      ) : null}

      {section === 'security' ? (
        <>
          <section className="panel settings-card settings-card-polished full-access-unrestricted-card" aria-label="Full Access (Unrestricted)">
            <CardHeading
              icon="⚡"
              title={locale === 'th' ? 'โหมดเต็มสิทธิ์ (Unrestricted)' : 'Full Access (Unrestricted)'}
              subtitle={locale === 'th' ? 'สิทธิ์ระดับเครื่องและตัวเลือกข้ามการอนุมัติของ lnwjud' : 'Machine-wide access and explicit lnwjud approval bypass controls'}
              badge={(draft.desktopFullBypassAll || draft.stdioFullBypassAll) ? 'FULL BYPASS ON' : unrestricted ? 'UNRESTRICTED' : 'OFF'}
            />
            <SettingSwitch
              checked={unrestricted}
              label="Unrestricted mode"
              description={locale === 'th' ? 'อนุญาต absolute path ที่ผู้ใช้หรือ AI ระบุ โดยไม่สแกนหรือลงทะเบียน drive letter อัตโนมัติ และยังใช้กฎยืนยันตาม Profile ตามปกติ' : 'Allow explicitly requested absolute paths without scanning or registering drive letters, while keeping the active profile approval rules in force.'}
              onChange={(enabled) => { void onUnrestrictedChange(enabled).then((restartRequired) => setUnrestrictedMessage(restartRequired ? (locale === 'th' ? 'ต้อง Restart MCP/Tunnel เพื่อใช้ค่าครบถ้วน' : 'Restart MCP/Tunnel to apply this everywhere.') : null)); }}
            />
            {unrestrictedMessage === null ? null : <div className="alert-box-warning" role="status">⚠️ {unrestrictedMessage}</div>}
            {permissionProfile === 'full' ? (
              <div className="alert-box-warning full-bypass-control" role="group" aria-label="Desktop Full Bypass">
                <strong>{draft.desktopFullBypassAll ? 'DESKTOP FULL BYPASS ON' : (locale === 'th' ? 'Desktop Full Bypass — ปิด' : 'Desktop Full Bypass — Off')}</strong>
                <SettingSwitch
                  checked={draft.desktopFullBypassAll}
                  label={locale === 'th' ? 'ข้าม tool ที่ต้องยืนยันเสมอและทุกขอบเขตของ lnwjud' : 'Bypass always-confirm tools and every lnwjud scope check'}
                  description={locale === 'th' ? 'Desktop HTTP และ Secure Tunnel จะผ่านทันที รวมคำสั่งเสี่ยง, path นอก Active Project และ goalLease โดยไม่ถาม' : 'Desktop HTTP and Secure Tunnel proceed without prompts, including risky commands, paths outside the Active Project, and goalLease.'}
                  onChange={(value) => changeFullBypass('desktop', value)}
                />
              </div>
            ) : <p className="hint">{locale === 'th' ? 'เลือก Desktop Profile = Full เพื่อเปิด Desktop Full Bypass' : 'Select Desktop Profile = Full to enable Desktop Full Bypass.'}</p>}
            {stdioPermissionProfile === 'full' ? (
              <div className="alert-box-warning full-bypass-control" role="group" aria-label="STDIO Full Bypass">
                <strong>{draft.stdioFullBypassAll ? 'STDIO FULL BYPASS ON' : (locale === 'th' ? 'STDIO Full Bypass — ปิด' : 'STDIO Full Bypass — Off')}</strong>
                <SettingSwitch
                  checked={draft.stdioFullBypassAll}
                  label={locale === 'th' ? 'ข้าม tool ที่ต้องยืนยันเสมอและทุกขอบเขตสำหรับ direct STDIO' : 'Bypass always-confirm tools and every scope check for direct STDIO'}
                  description={locale === 'th' ? 'เป็นคนละค่ากับ Desktop/Secure Tunnel และต้องเปิดเอง; direct STDIO จะไม่ถามแม้เป็น path นอกโปรเจกต์' : 'Independent from Desktop/Secure Tunnel; direct STDIO will not prompt even for paths outside projects.'}
                  onChange={(value) => changeFullBypass('stdio', value)}
                />
              </div>
            ) : <p className="hint">{locale === 'th' ? 'เลือก STDIO Profile = Full เพื่อเปิด STDIO Full Bypass' : 'Select STDIO Profile = Full to enable STDIO Full Bypass.'}</p>}
            <p className="hint">{locale === 'th'
              ? 'เครื่องมือไฟล์แบบมีโครงสร้างใช้ Active Project แบบ canonical และ Recovery Trash / checkpoint. เมื่อ Full Bypass ปิด งานปกติของ Full Access จะไม่ถาม แต่ tool ที่ต้องยืนยันเสมอ งานลบ/ทำข้อมูลหาย และงานนอกขอบเขตยังถาม ส่วนคำสั่งระดับเครื่องอันตรายยังถูกบล็อก'
              : 'Structured file tools use canonical Active Project paths and Recovery Trash / checkpoints. With Full Bypass OFF, ordinary Full Access work does not prompt; always-confirm, destructive, and out-of-scope actions still ask, while dangerous machine-level commands remain blocked.'}</p>
            <p className="hint">{locale === 'th' ? 'FULL BYPASS ข้ามเฉพาะ authorization/policy ของ lnwjud การตรวจ input, path ที่ต้องมีอยู่, Windows ACL/UAC และสิทธิ์บริการภายนอกยังทำงานตามจริง' : 'FULL BYPASS skips lnwjud authorization policy only. Input validation, required path existence, Windows ACL/UAC, and remote-service authorization still apply.'}</p>
          </section>

          <section className="panel settings-card settings-card-polished custom-permission-card" aria-label="Custom Permission Profile">
            <CardHeading icon="◇" title="Custom Permission Profile" subtitle={locale === 'th' ? 'กำหนดสิทธิ์ละเอียดเมื่อเลือก Profile = Custom' : 'Fine-grained rules used when Profile = Custom'} badge="CUSTOM" />
            <div className="setting-grid four-col">
              <Decision label="READ" value={draft.customPermission.read} onChange={(value) => patchCustom({ read: value })} />
              <Decision label="WRITE" value={draft.customPermission.write} onChange={(value) => patchCustom({ write: value })} />
              <Decision label="EXECUTE" value={draft.customPermission.execute} onChange={(value) => patchCustom({ execute: value })} />
              <Decision label="DANGEROUS" value={draft.customPermission.dangerous} onChange={(value) => patchCustom({ dangerous: value })} />
            </div>
            <div className="setting-field">
              <label className="field-label" htmlFor="custom-executables">{locale === 'th' ? 'Allowed Executables เพิ่มเติม — หนึ่งรายการต่อบรรทัด' : 'Additional allowed executables — one per line'}</label>
              <textarea id="custom-executables" className="settings-textarea" rows={4} value={draft.customPermission.allowedExecutables.join('\n')} placeholder={'python.exe\ndocker.exe\ndotnet.exe'} onChange={(event) => patchCustom({ allowedExecutables: splitList(event.target.value) })} />
            </div>
          </section>
        </>
      ) : null}

      {section === 'tools' ? (
        <>
          <section className="panel settings-card settings-card-polished" aria-label="Codex delegation tools" data-settings-focus="tools-codex" tabIndex={-1}>
            <CardHeading icon="◎" title={locale === 'th' ? 'Codex Delegation' : 'Codex Delegation'} subtitle={locale === 'th' ? 'ป้องกัน agent ใช้โควต้า Codex โดยไม่ตั้งใจ' : 'Protect Codex quota from accidental agent delegation'} badge={draft.codexToolsEnabled ? 'ENABLED' : 'DEFAULT OFF'} />
            <SettingSwitch
              checked={draft.codexToolsEnabled}
              label={locale === 'th' ? 'เปิดใช้งานกลุ่ม codex_*' : 'Enable codex_* tools'}
              description={locale === 'th'
                ? 'เมื่อปิด agent จะมองไม่เห็น codex_run, codex_status, codex_stop และ codex_task_* ทั้งหมด'
                : 'When off, agents cannot see codex_run, codex_status, codex_stop, or any codex_task_* tools.'}
              onChange={(value) => patch({ codexToolsEnabled: value })}
            />
            <div className="codex-tool-preview" aria-label="Codex tool exposure">
              <span>codex_run</span><span>codex_status</span><span>codex_stop</span><span>codex_task_*</span>
            </div>
            <p className="hint">{locale === 'th' ? 'ค่าเริ่มต้นคือปิด ต้อง Restart Local MCP / Tunnel หลังเปลี่ยนค่า' : 'Disabled by default. Restart local MCP / Tunnel after changing this setting.'}</p>
          </section>

          <section className="panel settings-card settings-card-polished" aria-label="Tools and timeouts">
            <CardHeading icon="⌛" title={locale === 'th' ? 'Timeout และ Local MCP' : 'Timeouts & Local MCP'} subtitle={locale === 'th' ? 'เวลารอสำหรับ external tools และ process ที่จัดการโดย lnwjud' : 'Execution limits for external tools and managed processes'} />
            <div className="setting-grid two-col">
              <NumberField label={locale === 'th' ? 'External MCP Tool Timeout (วินาที)' : 'External MCP Tool Timeout (seconds)'} value={Math.round(draft.mcpCallTimeoutMs / 1000)} min={1} max={3600} onChange={(value) => patch({ mcpCallTimeoutMs: value * 1000 })} />
              <NumberField label={locale === 'th' ? 'External MCP Idle Timeout (นาที)' : 'External MCP Idle Timeout (minutes)'} value={Math.round(draft.mcpIdleTimeoutMs / 60_000)} min={1} max={1440} onChange={(value) => patch({ mcpIdleTimeoutMs: value * 60_000 })} />
              <NumberField label={locale === 'th' ? 'Process Default Timeout (นาที)' : 'Process Default Timeout (minutes)'} value={Math.round(draft.processTimeoutMs / 60_000)} min={1} max={240} onChange={(value) => patch({ processTimeoutMs: value * 60_000 })} />
              <NumberField label={locale === 'th' ? 'MCP Poll / Tool Wait (วินาที)' : 'MCP Poll / Tool Wait (seconds)'} value={draft.mcpPollWaitSeconds} min={5} max={60} onChange={(value) => patch({ mcpPollWaitSeconds: value })} />
              <NumberField label={locale === 'th' ? 'Foreground Shell Wait (วินาที)' : 'Foreground Shell Wait (seconds)'} value={draft.shellSynchronousWaitSeconds} min={5} max={60} onChange={(value) => patch({ shellSynchronousWaitSeconds: value })} />
              <NumberField label="Local MCP HTTP Port" value={draft.mcpHttpPort} min={0} max={65535} onChange={(value) => patch({ mcpHttpPort: value })} />
            </div>
            <p className="hint">{locale === 'th' ? 'ช่วงที่ตั้งได้ 5–60 วินาที ค่าเริ่มต้นคือ MCP Poll 5 วินาที และ Foreground Shell 60 วินาที ค่านี้จำกัดเวลารอต่อครั้งเท่านั้น ไม่ได้หยุดงาน background' : 'Allowed range: 5–60 seconds. Defaults are 5 seconds for MCP polling and 60 seconds for foreground shell waits. These values only bound each wait; background tasks keep running.'}</p>
          </section>

          <section className="panel settings-card settings-card-polished" aria-label="Capability roots">
            <CardHeading icon="⌂" title={locale === 'th' ? 'Capability Roots' : 'Capability Roots'} subtitle={locale === 'th' ? 'เพิ่มพื้นที่ที่ tools สามารถเข้าถึงได้' : 'Additional roots available to local capability tools'} />
            <label className="field-label" htmlFor="capability-roots">{locale === 'th' ? 'หนึ่ง path ต่อบรรทัด' : 'One path per line'}</label>
            <textarea id="capability-roots" className="settings-textarea" rows={5} value={draft.capabilityRoots.join('\n')} placeholder={'/path/to/projects\n/path/to/work'} onChange={(event) => patch({ capabilityRoots: splitList(event.target.value) })} />
            <p className="hint">{locale === 'th' ? 'ใช้กับ Shell, Office, Screen Record และ WSL โดยไม่ต้องแก้ environment variable เอง' : 'Used by Shell, Office, screen recording, and WSL without editing environment variables.'}</p>
          </section>

          <section className="panel settings-card settings-card-polished" aria-label="Local providers" data-settings-focus="tools-local-providers" tabIndex={-1}>
            <CardHeading icon="◫" title={locale === 'th' ? 'Local Providers' : 'Local Providers'} subtitle={locale === 'th' ? 'ตั้งค่า PDF และ Language Server โดยไม่ต้องแก้ Environment Variable' : 'Configure PDF and language-server providers without environment variables'} badge="ADVANCED" />
            <div className="setting-grid two-col">
              <div className="pdf-provider-install-control">
                <Field
                  label={locale === 'th' ? 'PDF Provider (pdftotext.exe)' : 'PDF Provider (pdftotext.exe)'}
                  value={draft.pdfProviderPath}
                  placeholder={locale === 'th' ? 'พาธไปยัง pdftotext.exe (ถ้ามี)' : 'Path to pdftotext.exe (optional)'}
                  onChange={(value) => patch({ pdfProviderPath: value })}
                />
                <div className="inline-actions">
                  <button type="button" className="btn-save-gold" disabled={pdfInstallBusy} onClick={() => { void installPdf(); }}>
                    {pdfInstallBusy
                      ? (locale === 'th' ? 'กำลังดาวน์โหลดและติดตั้ง…' : 'Downloading and installing…')
                      : (locale === 'th' ? 'ดาวน์โหลดและติดตั้งอัตโนมัติ' : 'Download & install automatically')}
                  </button>
                </div>
                <p className="hint">{locale === 'th'
                  ? 'ดาวน์โหลด Poppler for Windows รุ่นที่ lnwjud กำหนดไว้จาก GitHub Release ตรวจ SHA-256 ก่อนแตกไฟล์ แล้วเก็บไว้ในโฟลเดอร์ข้อมูลของ lnwjud โดยไม่ต้องเพิ่ม PATH หรือใช้สิทธิ์ Administrator'
                  : 'Downloads the lnwjud-pinned Poppler for Windows release from GitHub, verifies SHA-256 before extraction, and installs it in the lnwjud data directory without changing PATH or requiring Administrator rights.'}</p>
                {pdfInstallError === null ? null : <div className="alert-box-warning" role="alert">⚠️ {pdfInstallError}</div>}
                {pdfInstallMessage === null ? null : <div className="toast-success-banner" role="status">✓ {pdfInstallMessage}</div>}
              </div>
              <TextArea
                label={locale === 'th' ? 'LSP Commands — LANGUAGE=COMMAND' : 'LSP Commands — LANGUAGE=COMMAND'}
                value={stringMapToText(draft.lspCommands)}
                onChange={(value) => patch({ lspCommands: stringMapFromText(value) })}
              />
            </div>
            <p className="hint">{locale === 'th'
              ? 'ตัวอย่าง: typescript=["typescript-language-server","--stdio"]  |  python=["pyright-langserver","--stdio"] — ต้อง Restart Local MCP / Tunnel หลังเปลี่ยน'
              : 'Example: typescript=["typescript-language-server","--stdio"]  |  python=["pyright-langserver","--stdio"]. Restart Local MCP / Tunnel after changing providers.'}</p>
          </section>
        </>
      ) : null}

      {section === 'mcp' ? (
        <section className="panel settings-card settings-card-polished" aria-label="Extensions and MCP servers" data-settings-focus="mcp-servers" tabIndex={-1}>
          <CardHeading
            icon="⬡"
            title={locale === 'th' ? 'Extensions, Skills และ MCP Servers' : 'Extensions, Skills & MCP Servers'}
            subtitle={locale === 'th' ? 'ตั้งค่า External MCP โดยไม่ต้องแก้ JSON เอง' : 'Configure external MCP without editing JSON'}
            action={<button type="button" className="btn-save-gold" onClick={addServer}>+ {locale === 'th' ? 'เพิ่ม MCP Server' : 'Add MCP Server'}</button>}
          />
          <div className="setting-grid two-col">
            <div className="setting-field">
              <label className="field-label" htmlFor="extension-mode">External MCP mode</label>
              <select id="extension-mode" className="settings-select" value={draft.extensions.mode} onChange={(event) => patchExtensions({ mode: event.target.value === 'allowlist' ? 'allowlist' : 'enable_all' })}>
                <option value="enable_all">Enable all except disabled</option>
                <option value="allowlist">Allowlist only</option>
              </select>
            </div>
            <TextList label="Enabled Servers / Allowlist" value={draft.extensions.enabledServers} onChange={(value) => patchExtensions({ enabledServers: value })} />
            <TextList label="Disabled Servers" value={draft.extensions.disabledServers} onChange={(value) => patchExtensions({ disabledServers: value })} />
            <TextList label="Extra Skill Folders" value={draft.extensions.extraSkillRoots} onChange={(value) => patchExtensions({ extraSkillRoots: value })} />
            <TextList label="Disabled Skill Folders" value={draft.extensions.disabledSkillRoots} onChange={(value) => patchExtensions({ disabledSkillRoots: value })} />
          </div>
          <div className="mcp-server-settings-list">
            {draft.extensions.extraMcpServers.length === 0 ? <div className="empty-setting-state">{locale === 'th' ? 'ยังไม่มี MCP Server ที่เพิ่มเอง — Cursor / Claude Desktop discovery ยังทำงานตามปกติ' : 'No custom MCP servers — Cursor / Claude Desktop discovery still works.'}</div> : null}
            {draft.extensions.extraMcpServers.map((server, index) => (
              <article className="mcp-server-settings-item" key={`${server.name}-${index}`}>
                <div className="section-heading"><strong>{server.name || `MCP Server ${index + 1}`}</strong><button type="button" className="danger-soft-button" onClick={() => patchExtensions({ extraMcpServers: draft.extensions.extraMcpServers.filter((_entry, current) => current !== index) })}>{locale === 'th' ? 'ลบ' : 'Remove'}</button></div>
                <div className="setting-grid two-col">
                  <Field label="Name" value={server.name} onChange={(value) => updateServer(index, { name: value })} />
                  <Field label="Command" value={server.command} placeholder="npx" onChange={(value) => updateServer(index, { command: value })} />
                  <Field label="Working directory" value={server.cwd} placeholder="optional" onChange={(value) => updateServer(index, { cwd: value })} />
                  <Field label="Type" value={server.type} placeholder="optional (for example stdio)" onChange={(value) => updateServer(index, { type: value })} />
                  <TextArea label="Args — one per line" value={server.args.join('\n')} onChange={(value) => updateServer(index, { args: splitLines(value) })} />
                  <TextArea label="Environment — KEY=VALUE" value={envToText(server.env)} onChange={(value) => updateServer(index, { env: envFromText(value) })} />
                </div>
              </article>
            ))}
          </div>
          <p className="hint">{locale === 'th' ? 'Environment ของ MCP Server ถูกเก็บใน local settings — หลีกเลี่ยงการใส่ secret สำคัญในช่องนี้' : 'MCP server environment values are stored in local settings — avoid placing important secrets here.'}</p>
        </section>
      ) : null}

      {section === 'tunnel' ? (
        <section className="panel settings-card settings-card-polished" aria-label="Persistent tunnel runtime">
          <CardHeading icon="↻" title="Persistent Tunnel Runtime" subtitle={locale === 'th' ? 'รักษา Tunnel ID เดิมและเชื่อมต่อใหม่ต่อเนื่องจนกว่าจะปิดเอง' : 'Keep the same tunnel identity and reconnect continuously until disabled'} badge={draft.tunnelAutoReconnect ? 'ON' : 'OFF'} />
          <SettingSwitch checked={draft.tunnelAutoReconnect} label="Persistent runtime" description={locale === 'th' ? 'เมื่อเปิด ระบบจะ retry ต่อเนื่องด้วย backoff สูงสุดประมาณ 60 วินาที โดยไม่หยุดถาวรหลังหลุดหลายครั้ง' : 'Transient failures keep retrying with capped backoff instead of permanently giving up after a fixed number of exits.'} onChange={(value) => patch({ tunnelAutoReconnect: value })} />
          <p className="hint">{locale === 'th' ? 'ค่า Maximum rapid reconnect เดิมยังเก็บไว้เพื่อ compatibility กับ v4.10 แต่ v4.11 ไม่ใช้เป็นจำนวนครั้งสูงสุดอีกต่อไป' : 'The legacy rapid-reconnect value is retained for v4.10 compatibility, but v4.11 no longer treats it as a permanent retry limit.'}</p>
        </section>
      ) : null}

      {section === null ? null : (
        <div className={`settings-save-bar ${dirty ? 'is-dirty' : ''}`}>
          <div>
            {error === null ? null : <div className="alert-box-warning" role="alert">⚠️ {error}</div>}
            {message === null ? <span className="save-state-copy">{dirty ? (locale === 'th' ? 'มีการแก้ไขที่ยังไม่ได้บันทึก' : 'You have unsaved changes') : (locale === 'th' ? 'บันทึกค่าล่าสุดแล้ว' : 'All changes saved')}</span> : <div className="toast-success-banner" role="status">✓ {message}</div>}
          </div>
          <div className="inline-actions">
            <button type="button" disabled={!dirty || busy} onClick={() => { setDraft(effectiveSettings); setDirty(false); setError(null); setMessage(null); }}>{locale === 'th' ? 'ยกเลิก' : 'Discard'}</button>
            <button type="button" className="btn-save-gold" disabled={!dirty || busy} onClick={() => { void save(); }}>{busy ? (locale === 'th' ? 'กำลังบันทึก…' : 'Saving…') : (locale === 'th' ? 'บันทึกการตั้งค่า' : 'Save changes')}</button>
          </div>
        </div>
      )}
    </>
  );
}

function CardHeading({ icon, title, subtitle, badge, action }: { readonly icon: string; readonly title: string; readonly subtitle: string; readonly badge?: string; readonly action?: ReactElement }): ReactElement {
  return (
    <div className="section-heading settings-card-heading">
      <div className="settings-heading-copy"><span className="settings-card-icon" aria-hidden="true">{icon}</span><div><h2 className="settings-card-title">{title}</h2><span className="page-subtitle">{subtitle}</span></div></div>
      {action ?? (badge === undefined ? null : <span className="pill-badge gold">{badge}</span>)}
    </div>
  );
}

function NumberField({ label, value, min, max, onChange }: { readonly label: string; readonly value: number; readonly min: number; readonly max: number; readonly onChange: (value: number) => void }): ReactElement {
  return <div className="setting-field"><label className="field-label">{label}</label><input type="number" value={value} min={min} max={max} onChange={(event) => onChange(clampNumber(event.target.value, value, min, max))} /></div>;
}

function Decision({ label, value, onChange }: { readonly label: string; readonly value: PermissionDecisionSetting; readonly onChange: (value: PermissionDecisionSetting) => void }): ReactElement {
  return <div className="setting-field"><label className="field-label">{label}</label><select className="settings-select" value={value} onChange={(event) => onChange(event.target.value === 'ALLOW' || event.target.value === 'DENY' ? event.target.value : 'ASK')}><option value="ALLOW">ALLOW</option><option value="ASK">ASK</option><option value="DENY">DENY</option></select></div>;
}

function TextList({ label, value, onChange }: { readonly label: string; readonly value: readonly string[]; readonly onChange: (value: readonly string[]) => void }): ReactElement {
  return <TextArea label={label} value={value.join('\n')} onChange={(text) => onChange(splitList(text))} />;
}

function Field({ label, value, placeholder, onChange }: { readonly label: string; readonly value: string; readonly placeholder?: string; readonly onChange: (value: string) => void }): ReactElement {
  return <div className="setting-field"><label className="field-label">{label}</label><input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></div>;
}

function TextArea({ label, value, onChange }: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void }): ReactElement {
  return <div className="setting-field"><label className="field-label">{label}</label><textarea className="settings-textarea" rows={3} value={value} onChange={(event) => onChange(event.target.value)} /></div>;
}

function splitList(value: string): readonly string[] {
  return [...new Set(value.split(/[;\r\n]+/).map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

function splitLines(value: string): readonly string[] {
  return value.split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function stringMapFromText(value: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const entry = line.slice(separator + 1).trim();
    if (key.length > 0 && entry.length > 0) result[key] = entry;
  }
  return result;
}

function stringMapToText(value: Readonly<Record<string, string>>): string {
  return Object.entries(value).map(([key, entry]) => `${key}=${entry}`).join('\n');
}

function envFromText(value: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (key.length > 0) result[key] = line.slice(separator + 1);
  }
  return result;
}

function envToText(value: Readonly<Record<string, string>>): string {
  return Object.entries(value).map(([key, entry]) => `${key}=${entry}`).join('\n');
}

function clampNumber(raw: string, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}
