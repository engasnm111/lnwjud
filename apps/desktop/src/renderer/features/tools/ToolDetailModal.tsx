import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { ResolvedRemediation, ToolCatalogItem, UiLocale } from '@lnwjud/ipc-contracts';
import { formatDateTime } from '../../date-time.js';

interface ToolDetailModalProps {
  readonly locale: UiLocale;
  readonly item: ToolCatalogItem;
  readonly remediations: readonly ResolvedRemediation[];
  readonly onClose: () => void;
  readonly onRemediation: (action: ResolvedRemediation['actions'][number]) => Promise<void>;
}

export function ToolDetailModal({ locale, item, remediations, onClose, onRemediation }: ToolDetailModalProps): ReactElement {
  const dialogRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [busyActionKey, setBusyActionKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    titleRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (dialog === null) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.hasAttribute('hidden'));
      if (focusable.length === 0) { event.preventDefault(); titleRef.current?.focus(); return; }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return (): void => { document.removeEventListener('keydown', onKeyDown); previous?.focus(); };
  }, [onClose]);

  const runRemediation = async (action: ResolvedRemediation['actions'][number], key: string): Promise<void> => {
    if (busyActionKey !== null) return;
    setBusyActionKey(key);
    setActionError(null);
    try {
      await onRemediation(action);
    } catch (cause: unknown) {
      setActionError(cause instanceof Error ? cause.message : (locale === 'th' ? 'ดำเนินการไม่สำเร็จ โปรดลองอีกครั้ง' : 'The action failed. Please try again.'));
    } finally {
      setBusyActionKey(null);
    }
  };

  const relevantRemediations = remediations.filter((remediation) => item.remediationIds.includes(remediation.id));
  const notChecked = locale === 'th' ? 'ยังไม่มีผลตรวจ' : 'Not checked';
  const modal = (
    <div className="tool-modal-backdrop" role="presentation" onMouseDown={(event): void => { if (event.currentTarget === event.target) onClose(); }}>
      <section ref={dialogRef} className="tool-modal" role="dialog" aria-modal="true" aria-labelledby="tool-detail-title">
        <header className="tool-modal-header">
          <div className="tool-modal-title-copy">
            <p className="eyebrow">{item.origin === 'external_mcp' ? `MCP · ${item.serverName ?? ''}` : 'lnwjud'}</p>
            <div className="tool-modal-title-line">
              <h2 ref={titleRef} tabIndex={-1} id="tool-detail-title">{item.title}</h2>
              <span className={`tool-readiness-badge tool-readiness-${item.readiness}`}>{readinessLabel(locale, item.readiness)}</span>
            </div>
            <code>{item.name}</code>
          </div>
          <button ref={closeRef} className="tool-modal-close" type="button" onClick={onClose} aria-label={locale === 'th' ? 'ปิดรายละเอียดเครื่องมือ' : 'Close tool details'}>×</button>
        </header>
        <div className="tool-modal-scroll">
          <p className="tool-modal-description">{item.longDescription}</p>
          <dl className="tool-facts">
            <div><dt>{locale === 'th' ? 'สถานะ' : 'Status'}</dt><dd><span className={`tool-readiness-badge tool-readiness-${item.readiness}`}>{readinessLabel(locale, item.readiness)}</span></dd></div>
            <div><dt>{locale === 'th' ? 'สิทธิ์ที่ประกาศ' : 'Declared permission'}</dt><dd>{item.declaredPermission}</dd></div>
            <div><dt>{locale === 'th' ? 'ผลจากโปรไฟล์' : 'Profile decision'}</dt><dd>{item.profileDecision}</dd></div>
            <div><dt>{locale === 'th' ? 'ความเสี่ยง' : 'Risk mode'}</dt><dd>{item.riskMode}</dd></div>
            <div><dt>{locale === 'th' ? 'ตรวจล่าสุด' : 'Checked at'}</dt><dd>{formatDateTime(item.checkedAt, notChecked)}</dd></div>
            <div><dt>{locale === 'th' ? 'ข้อมูลเก่า' : 'Stale'}</dt><dd>{booleanLabel(locale, item.stale)}</dd></div>
            <div><dt>{locale === 'th' ? 'ยกเลิกได้' : 'Cancelable'}</dt><dd>{nullableBooleanLabel(locale, item.supportsCancel)}</dd></div>
            <div><dt>Dry run</dt><dd>{nullableBooleanLabel(locale, item.supportsDryRun)}</dd></div>
          </dl>
          {item.riskMode === 'input_dependent' ? <p role="note" className="tool-risk-caveat">{locale === 'th' ? 'ระดับความเสี่ยงและการขออนุมัติอาจเปลี่ยนตาม operation และ arguments ที่ระบุ ไม่ได้หมายความว่าทุก operation มีระดับเดียวกัน' : 'Risk and approval requirements can change with the selected operation and arguments; not every operation has the same risk level.'}</p> : null}
          {item.stale ? <p role="status" className="tool-stale-caveat">{locale === 'th' ? 'ผล readiness นี้เกินอายุ cache แล้ว ควรตรวจใหม่ก่อนพึ่งพาสถานะ' : 'This readiness result is stale; recheck before relying on it.'}</p> : null}
          {item.requirements.length > 0 ? <section className="tool-modal-section"><h3>{locale === 'th' ? 'ข้อกำหนด' : 'Requirements'}</h3><ul className="tool-requirement-list">{item.requirements.map((requirement) => <li key={requirement.id}><div><strong>{requirement.id}</strong><span className={`doctor-status-badge doctor-status-${requirement.status}`}>{requirement.status}</span></div>{requirement.detail ? <p>{requirement.detail}</p> : null}</li>)}</ul></section> : null}
          {item.inputSchema !== null ? <details className="tool-schema-details"><summary>{locale === 'th' ? 'Input schema' : 'Input schema'}</summary><pre>{JSON.stringify(item.inputSchema, null, 2)}</pre></details> : null}
          {actionError === null ? null : <p className="tool-action-error" role="alert">{actionError}</p>}
          {relevantRemediations.map((remediation) => <section key={remediation.id} className="tool-remediation"><h3>{remediation.title}</h3><p>{remediation.explanation}</p><ol>{remediation.steps.map((step) => <li key={step}>{step}</li>)}</ol><div className="tool-action-row">{remediation.actions.map((action, index) => { const key = `${remediation.id}-${index}`; return <button type="button" key={key} disabled={busyActionKey !== null} onClick={() => { void runRemediation(action, key); }}>{busyActionKey === key ? busyActionLabel(locale, action) : actionLabel(locale, action)}</button>; })}</div></section>)}
          {item.readiness !== 'ready' && relevantRemediations.length === 0 ? <section className="tool-remediation tool-remediation-fallback" role="note"><h3>{locale === 'th' ? 'รายการนี้ยังไม่มีปุ่มแก้อัตโนมัติ' : 'No automatic repair is available for this item'}</h3><p>{locale === 'th' ? 'ดูรายละเอียดในข้อกำหนดด้านบน สถานะนี้ไม่ได้หมายความว่ามีสวิตช์ซ่อนอยู่ใน Settings หาก runtime ยังไม่มี remediation ที่ปลอดภัย lnwjud จะไม่พาไปตั้งค่าที่ไม่เกี่ยวข้อง' : 'Use the requirement details above. This status does not imply there is a hidden Settings switch; when no safe remediation exists, lnwjud will not send you to an unrelated setting.'}</p></section> : null}
        </div>
      </section>
    </div>
  );
  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}

function readinessLabel(locale: UiLocale, readiness: ToolCatalogItem['readiness']): string {
  const labels: Record<ToolCatalogItem['readiness'], readonly [string, string]> = {
    ready: ['พร้อม', 'Ready'],
    needs_setup: ['ต้องตั้งค่า', 'Needs setup'],
    blocked: ['ถูกบล็อก', 'Blocked'],
    disabled: ['ปิดใช้งาน', 'Disabled'],
    unsupported: ['ไม่รองรับ', 'Unsupported'],
    unknown: ['ไม่ทราบ', 'Unknown'],
  };
  return labels[readiness][locale === 'th' ? 0 : 1];
}

function booleanLabel(locale: UiLocale, value: boolean): string {
  return value ? (locale === 'th' ? 'ใช่' : 'Yes') : (locale === 'th' ? 'ไม่' : 'No');
}

function nullableBooleanLabel(locale: UiLocale, value: boolean | null): string {
  return value === null ? (locale === 'th' ? 'ไม่ทราบ' : 'Unknown') : booleanLabel(locale, value);
}

function busyActionLabel(locale: UiLocale, action: ResolvedRemediation['actions'][number]): string {
  if (action.kind === 'launch_managed_browser') return locale === 'th' ? 'กำลังเปิด Managed Browser…' : 'Starting managed browser…';
  if (action.kind === 'install_pdf_provider') return locale === 'th' ? 'กำลังดาวน์โหลดและติดตั้ง…' : 'Downloading and installing…';
  return locale === 'th' ? 'กำลังดำเนินการ…' : 'Working…';
}

function actionLabel(locale: UiLocale, action: ResolvedRemediation['actions'][number]): string {
  if (action.kind === 'recheck') return locale === 'th' ? 'ตรวจใหม่' : 'Recheck';
  if (action.kind === 'launch_managed_browser') return locale === 'th' ? 'เปิด Managed Browser' : 'Start managed browser';
  if (action.kind === 'install_pdf_provider') return locale === 'th' ? 'ดาวน์โหลดและติดตั้ง PDF Provider' : 'Download & install PDF Provider';
  if (action.kind === 'set_user_setting') return locale === 'th' ? 'เปิด codex_* และ Restart MCP' : 'Enable codex_* and restart MCP';
  if (action.kind === 'open_system_settings') return locale === 'th' ? 'เปิด Windows Optional Features' : 'Open Windows Optional Features';
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
  if (action.kind === 'open_official_url') return locale === 'th' ? 'เปิดเว็บทางการ' : 'Open official site';
  return locale === 'th' ? 'คัดลอกคำสั่ง' : 'Copy command';
}
