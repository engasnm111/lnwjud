import type { ReactElement } from 'react';
import type { DoctorCheck, DoctorReport, RemediationAction, ResolvedRemediation, UiLocale } from '@lnwjud/ipc-contracts';
import { formatDateTime } from '../../date-time.js';
import { createTranslator } from '../../i18n/index.js';

interface DoctorPanelProps {
  readonly locale?: UiLocale;
  readonly report: DoctorReport | null;
  readonly remediations?: readonly ResolvedRemediation[];
  readonly onRunDoctor: () => Promise<void>;
  readonly onRecheck?: (requirementIds: readonly string[]) => Promise<void>;
  readonly onRemediation?: (action: RemediationAction) => Promise<void>;
  readonly onOpenProjects: () => void;
}

function issueRank(check: DoctorCheck): number {
  if (check.status === 'pass') return 6;
  if (check.required && check.status === 'fail') return 0;
  if (check.required && check.status === 'unknown') return 1;
  if (!check.required && check.status === 'fail') return 2;
  if (check.status === 'unknown') return 3;
  if (check.status === 'warn') return 4;
  return 5;
}

export function DoctorPanel({
  locale = 'th', report, remediations = [], onRunDoctor, onRecheck, onRemediation, onOpenProjects,
}: DoctorPanelProps): ReactElement {
  const t = createTranslator(locale);
  const checks = [...(report?.checks ?? [])].sort((left, right) => issueRank(left) - issueRank(right) || left.title.localeCompare(right.title));
  const issues = checks.filter((check) => check.status !== 'pass');
  const passed = checks.filter((check) => check.status === 'pass');
  const remediationById = new Map(remediations.map((entry) => [entry.id, entry] as const));
  const projectSetupRequired = checks.some((check) => ['workspaces', 'registered_workspace', 'active_project'].includes(check.id) && check.status !== 'pass');

  const renderCheck = (check: DoctorCheck): ReactElement => {
    const remediation = check.remediationId === undefined ? undefined : remediationById.get(check.remediationId);
    return (
      <article key={check.id} data-testid={`doctor-check-${check.id}`} className={`doctor-check doctor-${check.status}`}>
        <div className="doctor-check-heading">
          <div className="doctor-check-title-copy"><strong>{check.title || check.id}</strong>{check.title.includes(check.id) ? null : <code>{check.id}</code>}</div>
          <span className={`doctor-status-badge doctor-status-${check.status}`}>{statusLabel(locale, check.status)}</span>
        </div>
        <p className="doctor-check-summary">{check.summary || check.message}</p>
        {check.detail === undefined ? null : <p className="doctor-check-detail">{check.detail}</p>}
        {check.affectedToolNames.length === 0 ? null : <p className="doctor-affected-tools"><strong>{locale === 'th' ? 'กระทบเครื่องมือ:' : 'Affected tools:'}</strong> {check.affectedToolNames.join(', ')}</p>}
        {remediation === undefined ? (check.status === 'pass' ? null : (
          <div className="doctor-remediation doctor-remediation-fallback" role="note">
            <div className="doctor-remediation-copy">
              <strong>{locale === 'th' ? 'รายการนี้ไม่มีการตั้งค่าอัตโนมัติที่ปลอดภัย' : 'No safe automatic remediation is available'}</strong>
              <p>{locale === 'th' ? 'ใช้รายละเอียดด้านบนเป็นข้อมูลอ้างอิง รายการนี้อาจขึ้นกับ Windows, hardware, runtime input หรือ capability ที่ยังไม่สามารถแก้ด้วยสวิตช์ใน lnwjud ได้ จึงจะไม่พาไปหน้า Settings ที่ไม่เกี่ยวข้อง' : 'Use the detail above as the source of truth. This check may depend on Windows, hardware, runtime input, or a capability that cannot be repaired by an lnwjud toggle, so the app will not send you to an unrelated Settings page.'}</p>
            </div>
          </div>
        )) : (
          <div className="doctor-remediation">
            <div className="doctor-remediation-copy"><strong>{remediation.title}</strong><p>{remediation.explanation}</p></div>
            {remediation.steps.length === 0 ? null : <ol>{remediation.steps.map((step) => <li key={step}>{step}</li>)}</ol>}
            <div className="doctor-remediation-actions">{remediation.actions.map((action, index) => <button type="button" key={`${remediation.id}:${index}`} onClick={() => { void onRemediation?.(action); }}>{actionLabel(locale, action)}</button>)}</div>
          </div>
        )}
        <div className="doctor-check-footer">
          {onRecheck === undefined ? null : <button type="button" className="doctor-recheck" onClick={() => { void onRecheck([check.id]); }}>{locale === 'th' ? 'ตรวจรายการนี้ใหม่' : 'Recheck this issue'}</button>}
          <small>{locale === 'th' ? 'ตรวจเมื่อ' : 'Checked'} {formatDateTime(check.checkedAt, check.checkedAt)} · {check.durationMs} ms</small>
        </div>
      </article>
    );
  };

  return (
    <section className="panel doctor-panel">
      <div className="section-heading">
        <div><p className="page-subtitle" style={{ margin: 0 }}>{locale === 'th' ? 'แก้ปัญหาที่มีผลก่อน แล้วค่อยดูรายการที่ผ่าน' : 'Fix actionable issues first, then review passed checks.'}</p>{report === null ? null : <small>{report.exitCode === 0 ? (locale === 'th' ? 'Core startup checks ผ่าน' : 'Core startup checks passed') : (locale === 'th' ? 'มี required check ที่ยังยืนยันไม่ได้' : 'A required check still needs attention')}</small>}</div>
        <button type="button" onClick={() => { void onRunDoctor(); }}>{t('doctor.run')}</button>
      </div>
      {report === null ? <div className="doctor-empty-state"><p>{t('doctor.noReport')}</p></div> : (
        <>
          {issues.length === 0 ? <div className="doctor-empty-state"><p>{locale === 'th' ? 'ไม่พบปัญหาที่ต้องแก้' : 'No issues need attention.'}</p></div> : <div className="doctor-list doctor-issues">{issues.map(renderCheck)}</div>}
          {passed.length === 0 ? null : <details className="doctor-passed"><summary>{locale === 'th' ? `ผ่านแล้ว ${passed.length} รายการ` : `${passed.length} checks passed`}</summary><div className="doctor-list">{passed.map(renderCheck)}</div></details>}
        </>
      )}
      {projectSetupRequired ? <div className="doctor-recovery-actions"><p>{locale === 'th' ? 'เพิ่มโปรเจกต์แรกเพื่อเริ่มทำงาน แล้วกลับมาตรวจอีกครั้ง' : 'Add your first project to begin, then run Doctor again.'}</p><button type="button" onClick={onOpenProjects}>{locale === 'th' ? 'เพิ่มโปรเจกต์' : 'Add Project'}</button></div> : null}
    </section>
  );
}

function statusLabel(locale: UiLocale, status: DoctorCheck['status']): string {
  const labels: Record<DoctorCheck['status'], readonly [string, string]> = {
    pass: ['ผ่าน', 'Pass'],
    warn: ['เตือน', 'Warn'],
    fail: ['ไม่ผ่าน', 'Fail'],
    unknown: ['ไม่ทราบ', 'Unknown'],
  };
  return labels[status][locale === 'th' ? 0 : 1];
}

function actionLabel(locale: UiLocale, action: RemediationAction): string {
  if (action.kind === 'recheck') return locale === 'th' ? 'ตรวจใหม่' : 'Recheck';
  if (action.kind === 'launch_managed_browser') return locale === 'th' ? 'เปิด Managed Browser' : 'Start managed browser';
  if (action.kind === 'install_pdf_provider') return locale === 'th' ? 'ดาวน์โหลดและติดตั้ง PDF Provider' : 'Download & install PDF Provider';
  if (action.kind === 'set_user_setting') return locale === 'th' ? 'เปิด codex_* และ Restart MCP' : 'Enable codex_* and restart MCP';
  if (action.kind === 'open_system_settings') return locale === 'th' ? 'เปิด Windows Optional Features' : 'Open Windows Optional Features';
  if (action.kind === 'copy_command') return locale === 'th' ? 'คัดลอกคำสั่ง' : 'Copy command';
  if (action.kind === 'open_official_url') return locale === 'th' ? 'เปิดเว็บทางการ' : 'Open official site';
  if (action.kind === 'open_settings') {
    const labels: Readonly<Record<string, readonly [string, string]>> = {
      projects: ['ไปหน้าโปรเจกต์', 'Open Projects'],
      tools_codex: ['ไปที่ Codex Delegation', 'Open Codex Delegation'],
      tools_local_providers: ['ไปที่ Local Providers', 'Open Local Providers'],
      mcp_servers: ['ไปที่ MCP Servers', 'Open MCP Servers'],
      tunnel: ['ไปที่ Secure Tunnel', 'Open Secure Tunnel'],
      security_profile: ['ไปที่ Security / Permissions', 'Open Security / Permissions'],
    };
    const label = labels[action.target];
    return label === undefined ? (locale === 'th' ? 'เปิดการตั้งค่า' : 'Open settings') : label[locale === 'th' ? 0 : 1];
  }
  return locale === 'th' ? 'ดำเนินการ' : 'Apply';
}
