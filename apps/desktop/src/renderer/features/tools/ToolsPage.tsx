import { ActionButton, FormInput, FilterBar } from '../ui/UiPrimitives.js';
import { useMemo, useState, type ReactElement } from 'react';
import type { ResolvedRemediation, ToolCatalogItem, ToolCatalogSnapshot, ToolCategory, ToolDeclaredPermission, ToolOrigin, ToolProfileDecision, ToolReadinessStatus, UiLocale } from '@lnwjud/ipc-contracts';
import { createTranslator, type Translator } from '../../i18n/index.js';
import { ToolAvailabilitySwitch } from './ToolAvailabilitySwitch.js';
import { SearchableSelect } from '../../components/ui/SearchableSelect.js';
import { ToolDetailModal } from './ToolDetailModal.js';
import { catalogStatusCounts, filterAndSortTools, toolControlCanEnable, toolControlEnabled, type ToolCatalogFilters } from './tool-catalog-view.js';
import { toolAvailabilityLabel } from './tool-availability-copy.js';
import { coarseReadinessLabel, toolReadinessLabel } from './tool-readiness-copy.js';

interface ToolsPageProps {
  readonly locale: UiLocale;
  readonly snapshot: ToolCatalogSnapshot | null;
  readonly loading: boolean;
  readonly hostSyncNotice?: string | null;
  readonly onRefresh: () => Promise<void>;
  readonly onRemediation: (action: ResolvedRemediation['actions'][number]) => Promise<void>;
  readonly onSetAvailability?: (name: string, enabled: boolean) => Promise<void>;
  readonly onResetAvailability?: (name: string) => Promise<void>;
}

const categories: readonly ToolCategory[] = ['workspace','files','search_context','git','process','browser_desktop','system','office_media','automation','agent_goals','extensions'];
const statuses: readonly ToolReadinessStatus[] = ['ready','needs_setup','blocked','disabled','unsupported','unknown'];
const permissions: readonly ToolDeclaredPermission[] = ['READ','WRITE','EXECUTE','DANGEROUS','UNKNOWN'];
const decisions: readonly ToolProfileDecision[] = ['ALLOW','ASK','DENY','UNKNOWN'];

export function ToolsPage({ locale, snapshot, loading, hostSyncNotice = null, onRefresh, onRemediation, onSetAvailability, onResetAvailability }: ToolsPageProps): ReactElement {
  const t = createTranslator(locale);
  const [origin, setOrigin] = useState<ToolOrigin>('lnwjud');
  const [query, setQuery] = useState('');
  const [readiness, setReadiness] = useState<ToolReadinessStatus | 'all'>('all');
  const [availability, setAvailability] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [category, setCategory] = useState<ToolCategory | 'all'>('all');
  const [permission, setPermission] = useState<ToolDeclaredPermission | 'all'>('all');
  const [profileDecision, setProfileDecision] = useState<ToolProfileDecision | 'all'>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [busyToolKey, setBusyToolKey] = useState<string | null>(null);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const items = snapshot?.items ?? [];
  const selected = selectedKey === null ? null : items.find((item) => toolKey(item) === selectedKey) ?? null;
  const filters: ToolCatalogFilters = { origin, query, readiness, availability, category, permission, profileDecision };
  const visible = useMemo(() => filterAndSortTools(items, filters), [items, origin, query, readiness, availability, category, permission, profileDecision]);
  const originItems = items.filter((item) => item.origin === origin);
  const counts = catalogStatusCounts(originItems);
  const remediationById = new Map((snapshot?.remediations ?? []).map((remediation) => [remediation.id, remediation] as const));

  const mutateAvailability = async (item: ToolCatalogItem, enabled: boolean): Promise<void> => {
    if (item.origin !== 'lnwjud' || onSetAvailability === undefined || busyToolKey !== null) return;
    const key = toolKey(item);
    setBusyToolKey(key);
    setAvailabilityError(null);
    try {
      await onSetAvailability(item.name, enabled);
    } catch (cause: unknown) {
      setAvailabilityError(cause instanceof Error ? cause.message : t('app.toolAvailabilityChangeError'));
    } finally {
      setBusyToolKey(null);
    }
  };

  const resetAvailability = async (item: ToolCatalogItem): Promise<void> => {
    if (item.origin !== 'lnwjud' || onResetAvailability === undefined || busyToolKey !== null) return;
    const key = toolKey(item);
    setBusyToolKey(key);
    setAvailabilityError(null);
    try {
      await onResetAvailability(item.name);
    } catch (cause: unknown) {
      setAvailabilityError(cause instanceof Error ? cause.message : t('app.toolAvailabilityResetError'));
    } finally {
      setBusyToolKey(null);
    }
  };

  return (
    <section className="panel tools-page" aria-labelledby="tools-heading">
      <div className="section-heading tools-heading"><div><h1 id="tools-heading">{t('nav.tools')}</h1><p className="page-subtitle">{t('tools.subtitle')}</p></div><ActionButton type="button" disabled={loading} onClick={() => { void onRefresh(); }}>{loading ? t('tools.checking') : t('tools.recheckAll')}</ActionButton></div>
      <div className="tool-origin-tabs" role="tablist" aria-label={t('tools.origin')}>
        <ActionButton type="button" role="tab" aria-selected={origin === 'lnwjud'} className={origin === 'lnwjud' ? 'active' : undefined} onClick={() => setOrigin('lnwjud')}>lnwjud ({items.filter((item) => item.origin === 'lnwjud').length})</ActionButton>
        <ActionButton type="button" role="tab" aria-selected={origin === 'external_mcp'} className={origin === 'external_mcp' ? 'active' : undefined} onClick={() => { setOrigin('external_mcp'); setAvailability('all'); }}>External MCP ({items.filter((item) => item.origin === 'external_mcp').length})</ActionButton>
      </div>
      <div className="tool-status-strip" aria-label={t('tools.statusCounts')}>{statuses.map((status) => <ActionButton type="button" key={status} aria-pressed={readiness === status} className={readiness === status ? 'active' : undefined} onClick={() => setReadiness(readiness === status ? 'all' : status)}><strong>{counts[status]}</strong><span>{coarseReadinessLabel(locale, status)}</span></ActionButton>)}</div>
      <FilterBar className="tool-filters">
        <FormInput value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={t('tools.searchPlaceholder')} aria-label={t('tools.searchAria')} />
        <SearchableSelect value={availability} disabled={origin !== 'lnwjud'} label={t('tools.availability')} onChange={(value) => setAvailability(value as typeof availability)} options={[{value:'all',label:t('tools.allAvailability')},{value:'enabled',label:t('security.enabled')},{value:'disabled',label:t('security.disabled')}]} />
        <SearchableSelect value={category} label={t('tools.category')} onChange={(value) => setCategory(value as typeof category)} options={[{value:'all',label:t('tools.allCategories')},...categories.map(value=>({value,label:value}))]} />
        <SearchableSelect value={permission} label={t('tools.permission')} onChange={(value) => setPermission(value as typeof permission)} options={[{value:'all',label:t('tools.allPermissions')},...permissions.map(value=>({value,label:value}))]} />
        <SearchableSelect value={profileDecision} label={t('tools.profileDecision')} onChange={(value) => setProfileDecision(value as typeof profileDecision)} options={[{value:'all',label:t('tools.allDecisions')},...decisions.map(value=>({value,label:value}))]} />
        <ActionButton type="button" onClick={() => { setQuery(''); setReadiness('all'); setAvailability('all'); setCategory('all'); setPermission('all'); setProfileDecision('all'); }}>{t('tools.clearFilters')}</ActionButton>
      </FilterBar>
      {availabilityError === null ? null : <p className="tool-action-error" role="alert">{availabilityError}</p>}
      {hostSyncNotice === null ? null : <p className="tool-host-sync-notice" role="status">{hostSyncNotice}</p>}
      {snapshot === null ? <div className="doctor-empty-state"><p>{t('tools.catalogNotLoaded')}</p></div> : visible.length === 0 ? <div className="doctor-empty-state"><p>{t('tools.noMatches')}</p></div> : <div className="tool-card-list">{visible.map((item) => {
        const key = toolKey(item);
        const busy = busyToolKey === key;
        return <article className={`tool-card tool-${item.readiness}`} key={key}><ActionButton type="button" className="tool-card-open" onClick={() => setSelectedKey(key)}><span className="tool-status-dot" aria-hidden="true"/><span className="tool-card-main"><span><strong>{item.title}</strong><code>{item.name}</code></span><small>{item.shortDescription}</small>{item.readiness === 'ready' ? null : <small className="tool-card-remediation-hint">↳ {remediationHint(t, item, remediationById)}</small>}</span><span className="tool-card-meta"><span>{toolReadinessLabel(locale, item)}</span>{item.origin === 'lnwjud' ? <span className={item.effectiveExposed ? 'tool-availability-on' : 'tool-availability-off'}>{toolAvailabilityLabel(locale, item)}</span> : null}<span>{permissionLabel(t, item)}</span><span>{profileDecisionLabel(t, item)}</span></span></ActionButton>{item.origin === 'lnwjud' ? <div className="tool-card-availability"><ToolAvailabilitySwitch locale={locale} checked={toolControlEnabled(item)} busy={busy} disabled={onSetAvailability === undefined || (!toolControlEnabled(item) && !toolControlCanEnable(item))} blockedLabel={!toolControlEnabled(item) && !toolControlCanEnable(item) ? t('tools.setupFirst') : undefined} label={item.title} onChange={(enabled) => { void mutateAvailability(item, enabled); }} />{item.userPreference === 'default' ? null : <ActionButton type="button" disabled={busy || onResetAvailability === undefined} onClick={() => { void resetAvailability(item); }}>{t('tools.useDefault')}</ActionButton>}</div> : <div className="tool-card-availability tool-card-availability-readonly">{t('tools.managedExternal')}</div>}</article>;
      })}</div>}
      {selected !== null && snapshot !== null ? <ToolDetailModal locale={locale} item={selected} remediations={snapshot.remediations} onClose={() => setSelectedKey(null)} onRemediation={onRemediation} availabilityBusy={busyToolKey === toolKey(selected)} {...(onSetAvailability === undefined ? {} : { onSetAvailability: (enabled: boolean) => mutateAvailability(selected, enabled) })} {...(onResetAvailability === undefined ? {} : { onResetAvailability: () => resetAvailability(selected) })} /> : null}
    </section>
  );
}

function toolKey(item: ToolCatalogItem): string {
  return `${item.origin}:${item.serverName ?? ''}:${item.name}`;
}

function permissionLabel(t: Translator, item: ToolCatalogItem): string {
  if (item.origin !== 'external_mcp' || item.declaredPermission !== 'UNKNOWN') return item.declaredPermission;
  return t('tools.permissionNotDeclared');
}

function profileDecisionLabel(t: Translator, item: ToolCatalogItem): string {
  if (item.origin !== 'external_mcp' || item.profileDecision !== 'UNKNOWN') return item.profileDecision;
  return t('tools.notClassified');
}

function remediationHint(t: Translator, item: ToolCatalogItem, remediations: ReadonlyMap<string, ResolvedRemediation>): string {
  for (const id of item.remediationIds) {
    const remediation = remediations.get(id);
    if (remediation !== undefined) return remediation.title;
  }
  return t('tools.openDetailsHint');
}
