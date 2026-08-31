import { useMemo, useState, type ReactElement } from 'react';
import type { ResolvedRemediation, ToolCatalogItem, ToolCatalogSnapshot, ToolCategory, ToolDeclaredPermission, ToolOrigin, ToolProfileDecision, ToolReadinessStatus, UiLocale } from '@lnwjud/ipc-contracts';
import { ToolDetailModal } from './ToolDetailModal.js';
import { catalogStatusCounts, filterAndSortTools, type ToolCatalogFilters } from './tool-catalog-view.js';

interface ToolsPageProps {
  readonly locale: UiLocale;
  readonly snapshot: ToolCatalogSnapshot | null;
  readonly loading: boolean;
  readonly onRefresh: () => Promise<void>;
  readonly onRemediation: (action: ResolvedRemediation['actions'][number]) => Promise<void>;
}

const categories: readonly ToolCategory[] = ['workspace','files','search_context','git','process','browser_desktop','system','office_media','automation','agent_goals','extensions'];
const statuses: readonly ToolReadinessStatus[] = ['ready','needs_setup','blocked','disabled','unsupported','unknown'];
const permissions: readonly ToolDeclaredPermission[] = ['READ','WRITE','EXECUTE','DANGEROUS','UNKNOWN'];
const decisions: readonly ToolProfileDecision[] = ['ALLOW','ASK','DENY','UNKNOWN'];

export function ToolsPage({ locale, snapshot, loading, onRefresh, onRemediation }: ToolsPageProps): ReactElement {
  const [origin, setOrigin] = useState<ToolOrigin>('lnwjud');
  const [query, setQuery] = useState('');
  const [readiness, setReadiness] = useState<ToolReadinessStatus | 'all'>('all');
  const [category, setCategory] = useState<ToolCategory | 'all'>('all');
  const [permission, setPermission] = useState<ToolDeclaredPermission | 'all'>('all');
  const [profileDecision, setProfileDecision] = useState<ToolProfileDecision | 'all'>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const items = snapshot?.items ?? [];
  const selected = selectedKey === null ? null : items.find((item) => toolKey(item) === selectedKey) ?? null;
  const filters: ToolCatalogFilters = { origin, query, readiness, category, permission, profileDecision };
  const visible = useMemo(() => filterAndSortTools(items, filters), [items, origin, query, readiness, category, permission, profileDecision]);
  const originItems = items.filter((item) => item.origin === origin);
  const counts = catalogStatusCounts(originItems);
  const remediationById = new Map((snapshot?.remediations ?? []).map((remediation) => [remediation.id, remediation] as const));

  return (
    <section className="panel tools-page" aria-labelledby="tools-heading">
      <div className="section-heading tools-heading"><div><h1 id="tools-heading">{locale === 'th' ? 'เครื่องมือ' : 'Tools'}</h1><p className="page-subtitle">{locale === 'th' ? 'ดูสิ่งที่พร้อมใช้ สิ่งที่ต้องตั้งค่า และเหตุผลจาก runtime จริง' : 'See what is ready, what needs setup, and why from live runtime evidence.'}</p></div><button type="button" disabled={loading} onClick={() => { void onRefresh(); }}>{loading ? (locale === 'th' ? 'กำลังตรวจ…' : 'Checking…') : (locale === 'th' ? 'ตรวจใหม่ทั้งหมด' : 'Recheck all')}</button></div>
      <div className="tool-origin-tabs" role="tablist" aria-label={locale === 'th' ? 'แหล่งเครื่องมือ' : 'Tool origin'}>
        <button type="button" role="tab" aria-selected={origin === 'lnwjud'} className={origin === 'lnwjud' ? 'active' : undefined} onClick={() => setOrigin('lnwjud')}>lnwjud ({items.filter((item) => item.origin === 'lnwjud').length})</button>
        <button type="button" role="tab" aria-selected={origin === 'external_mcp'} className={origin === 'external_mcp' ? 'active' : undefined} onClick={() => setOrigin('external_mcp')}>External MCP ({items.filter((item) => item.origin === 'external_mcp').length})</button>
      </div>
      <div className="tool-status-strip" aria-label={locale === 'th' ? 'จำนวนตามสถานะ' : 'Status counts'}>{statuses.map((status) => <button type="button" key={status} className={readiness === status ? 'active' : undefined} onClick={() => setReadiness(readiness === status ? 'all' : status)}><strong>{counts[status]}</strong><span>{status}</span></button>)}</div>
      <div className="tool-filters">
        <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={locale === 'th' ? 'ค้นหาชื่อหรือคำอธิบาย…' : 'Search name or description…'} aria-label={locale === 'th' ? 'ค้นหาเครื่องมือ' : 'Search tools'} />
        <select value={category} onChange={(event) => setCategory(event.currentTarget.value as ToolCategory | 'all')} aria-label={locale === 'th' ? 'หมวด' : 'Category'}><option value="all">{locale === 'th' ? 'ทุกหมวด' : 'All categories'}</option>{categories.map((value) => <option key={value} value={value}>{value}</option>)}</select>
        <select value={permission} onChange={(event) => setPermission(event.currentTarget.value as ToolDeclaredPermission | 'all')} aria-label={locale === 'th' ? 'สิทธิ์' : 'Permission'}><option value="all">{locale === 'th' ? 'ทุกสิทธิ์' : 'All permissions'}</option>{permissions.map((value) => <option key={value} value={value}>{value}</option>)}</select>
        <select value={profileDecision} onChange={(event) => setProfileDecision(event.currentTarget.value as ToolProfileDecision | 'all')} aria-label={locale === 'th' ? 'ผลโปรไฟล์' : 'Profile decision'}><option value="all">{locale === 'th' ? 'ทุกผลโปรไฟล์' : 'All decisions'}</option>{decisions.map((value) => <option key={value} value={value}>{value}</option>)}</select>
        <button type="button" onClick={() => { setQuery(''); setReadiness('all'); setCategory('all'); setPermission('all'); setProfileDecision('all'); }}>{locale === 'th' ? 'ล้างตัวกรอง' : 'Clear filters'}</button>
      </div>
      {snapshot === null ? <div className="doctor-empty-state"><p>{locale === 'th' ? 'ยังไม่ได้โหลดข้อมูลเครื่องมือ' : 'Tool catalog has not been loaded yet.'}</p></div> : visible.length === 0 ? <div className="doctor-empty-state"><p>{locale === 'th' ? 'ไม่พบเครื่องมือที่ตรงกับตัวกรอง' : 'No tools match the current filters.'}</p></div> : <div className="tool-card-list">{visible.map((item) => <button type="button" className={`tool-card tool-${item.readiness}`} key={`${item.origin}:${item.serverName ?? ''}:${item.name}`} onClick={() => setSelectedKey(toolKey(item))}><span className="tool-status-dot" aria-hidden="true"/><span className="tool-card-main"><span><strong>{item.title}</strong><code>{item.name}</code></span><small>{item.shortDescription}</small>{item.readiness === 'ready' ? null : <small className="tool-card-remediation-hint">↳ {remediationHint(locale, item, remediationById)}</small>}</span><span className="tool-card-meta"><span>{item.readiness}</span><span>{item.declaredPermission}</span><span>{item.profileDecision}</span></span></button>)}</div>}
      {selected !== null && snapshot !== null ? <ToolDetailModal locale={locale} item={selected} remediations={snapshot.remediations} onClose={() => setSelectedKey(null)} onRemediation={onRemediation} /> : null}
    </section>
  );
}

function toolKey(item: ToolCatalogItem): string {
  return `${item.origin}:${item.serverName ?? ''}:${item.name}`;
}

function remediationHint(locale: UiLocale, item: ToolCatalogItem, remediations: ReadonlyMap<string, ResolvedRemediation>): string {
  for (const id of item.remediationIds) {
    const remediation = remediations.get(id);
    if (remediation !== undefined) return remediation.title;
  }
  return locale === 'th' ? 'เปิดรายละเอียดเพื่อดูเหตุผลและวิธีแก้' : 'Open details for the reason and next step';
}
