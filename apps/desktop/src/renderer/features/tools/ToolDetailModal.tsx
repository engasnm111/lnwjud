import { ActionButton } from '../ui/UiPrimitives.js';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { ResolvedRemediation, ToolCatalogItem, UiLocale } from '@lnwjud/ipc-contracts';
import { formatDateTime } from '../../date-time.js';
import { createTranslator, type Translator } from '../../i18n/index.js';
import { toolReadinessLabel } from './tool-readiness-copy.js';
import { effectiveExposureLabel, toolAvailabilityLabel } from './tool-availability-copy.js';
import { toolControlCanEnable, toolControlEnabled } from './tool-catalog-view.js';
import { ToolAvailabilitySwitch } from './ToolAvailabilitySwitch.js';

interface ToolDetailModalProps {
  readonly locale: UiLocale;
  readonly item: ToolCatalogItem;
  readonly remediations: readonly ResolvedRemediation[];
  readonly onClose: () => void;
  readonly onRemediation: (action: ResolvedRemediation['actions'][number]) => Promise<void>;
  readonly availabilityBusy?: boolean;
  readonly onSetAvailability?: (enabled: boolean) => Promise<void>;
  readonly onResetAvailability?: () => Promise<void>;
}

export function ToolDetailModal({ locale, item, remediations, onClose, onRemediation, availabilityBusy = false, onSetAvailability, onResetAvailability }: ToolDetailModalProps): ReactElement {
  const t = createTranslator(locale);
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
      setActionError(cause instanceof Error ? cause.message : t('tools.detail.actionFailed'));
    } finally {
      setBusyActionKey(null);
    }
  };

  const relevantRemediations = remediations.filter((remediation) => item.remediationIds.includes(remediation.id));
  const notChecked = t('tools.detail.notChecked');
  const modal = (
    <div className="tool-modal-backdrop" role="presentation" onMouseDown={(event): void => { if (event.currentTarget === event.target) onClose(); }}>
      <section ref={dialogRef} className="tool-modal" role="dialog" aria-modal="true" aria-labelledby="tool-detail-title">
        <header className="tool-modal-header">
          <div className="tool-modal-title-copy">
            <p className="eyebrow">{item.origin === 'external_mcp' ? `MCP · ${item.serverName ?? ''}` : 'lnwjud'}</p>
            <div className="tool-modal-title-line">
              <h2 ref={titleRef} tabIndex={-1} id="tool-detail-title">{item.title}</h2>
              <span className={`tool-readiness-badge tool-readiness-${item.readiness}`}>{toolReadinessLabel(locale, item)}</span>
            </div>
            <code>{item.name}</code>
          </div>
          <ActionButton ref={closeRef} className="tool-modal-close" type="button" onClick={onClose} aria-label={t('tools.detail.close')}>×</ActionButton>
        </header>
        <div className="tool-modal-scroll">
          <p className="tool-modal-description">{item.longDescription}</p>
          <dl className="tool-facts">
            <div><dt>{t('tools.detail.status')}</dt><dd><span className={`tool-readiness-badge tool-readiness-${item.readiness}`}>{toolReadinessLabel(locale, item)}</span></dd></div>
            {item.deliveryState === undefined ? null : <div><dt>{t('tools.detail.deliveryState')}</dt><dd>{deliveryStateLabel(t, item)}</dd></div>}
            {item.available === undefined ? null : <div><dt>{t('tools.detail.runtimeAvailable')}</dt><dd>{booleanLabel(t, item.available)}</dd></div>}
            {item.origin === 'lnwjud' ? <div><dt>{t('tools.detail.userAvailability')}</dt><dd>{toolAvailabilityLabel(locale, item)}</dd></div> : null}
            {item.origin === 'lnwjud' ? <div><dt>{t('tools.detail.mcpExposure')}</dt><dd>{effectiveExposureLabel(locale, item)}</dd></div> : null}
            <div><dt>{t('tools.detail.declaredPermission')}</dt><dd>{declaredPermissionLabel(t, item)}</dd></div>
            <div><dt>{t('tools.detail.profileDecision')}</dt><dd>{profileDecisionLabel(t, item)}</dd></div>
            <div><dt>{t('tools.detail.riskMode')}</dt><dd>{riskModeLabel(t, item)}</dd></div>
            <div><dt>{t('tools.detail.checkedAt')}</dt><dd>{formatDateTime(item.checkedAt, notChecked, locale)}</dd></div>
            <div><dt>{t('tools.detail.stale')}</dt><dd>{booleanLabel(t, item.stale)}</dd></div>
            <div><dt>{t('tools.detail.cancelable')}</dt><dd>{nullableBooleanLabel(t, item.supportsCancel, item.origin === 'external_mcp')}</dd></div>
            <div><dt>{t('tools.detail.dryRun')}</dt><dd>{nullableBooleanLabel(t, item.supportsDryRun, item.origin === 'external_mcp')}</dd></div>
          </dl>
          {item.origin === 'lnwjud' ? <section className="tool-availability-panel"><div><strong>{toolAvailabilityLabel(locale, item)}</strong><small>{effectiveExposureLabel(locale, item)}</small></div><ToolAvailabilitySwitch locale={locale} checked={toolControlEnabled(item)} busy={availabilityBusy} disabled={onSetAvailability === undefined || (!toolControlEnabled(item) && !toolControlCanEnable(item))} blockedLabel={!toolControlEnabled(item) && !toolControlCanEnable(item) ? t('tools.setupFirst') : undefined} label={item.title} onChange={(enabled) => { void onSetAvailability?.(enabled); }} />{item.userPreference === 'default' ? null : <ActionButton type="button" disabled={availabilityBusy || onResetAvailability === undefined} onClick={() => { void onResetAvailability?.(); }}>{t('tools.useDefault')}</ActionButton>}</section> : null}
          {item.riskMode === 'input_dependent' ? <p role="note" className="tool-risk-caveat">{t('tools.detail.inputDependentRisk')}</p> : null}
          {item.origin === 'external_mcp' && item.readiness === 'ready' ? <p role="note" className="tool-risk-caveat">{t('tools.detail.externalDiscoveryCaveat')}</p> : null}
          {item.stale ? <p role="status" className="tool-stale-caveat">{t('tools.detail.staleCaveat')}</p> : null}
          {item.requirements.length > 0 ? <section className="tool-modal-section"><h3>{t('tools.detail.requirements')}</h3><ul className="tool-requirement-list">{item.requirements.map((requirement) => <li key={requirement.id}><div><strong>{requirement.id}</strong><span className={`doctor-status-badge doctor-status-${requirement.status}`}>{requirement.status}</span></div>{requirement.detail ? <p>{requirement.detail}</p> : null}</li>)}</ul></section> : null}
          {item.inputSchema !== null ? <details className="tool-schema-details"><summary>{t('tools.detail.inputSchema')}</summary><pre>{JSON.stringify(item.inputSchema, null, 2)}</pre></details> : null}
          {actionError === null ? null : <p className="tool-action-error" role="alert">{actionError}</p>}
          {relevantRemediations.map((remediation) => <section key={remediation.id} className="tool-remediation"><h3>{remediation.title}</h3><p>{remediation.explanation}</p><ol>{remediation.steps.map((step) => <li key={step}>{step}</li>)}</ol><div className="tool-action-row">{remediation.actions.map((action, index) => { const key = `${remediation.id}-${index}`; return <ActionButton type="button" key={key} disabled={busyActionKey !== null} onClick={() => { void runRemediation(action, key); }}>{busyActionKey === key ? busyActionLabel(t, action) : actionLabel(t, action)}</ActionButton>; })}</div></section>)}
          {item.readiness !== 'ready' && relevantRemediations.length === 0 ? <section className="tool-remediation tool-remediation-fallback" role="note"><h3>{t('tools.detail.noAutomaticRepair')}</h3><p>{t('tools.detail.noAutomaticRepairBody')}</p></section> : null}
        </div>
      </section>
    </div>
  );
  return typeof document === 'undefined' ? modal : createPortal(modal, document.body);
}

function booleanLabel(t: Translator, value: boolean): string {
  return value ? t('tools.detail.yes') : t('tools.detail.no');
}

function nullableBooleanLabel(t: Translator, value: boolean | null, external = false): string {
  if (value !== null) return booleanLabel(t, value);
  if (external) return t('tools.detail.notDeclaredByServer');
  return t('tools.detail.unknown');
}

function declaredPermissionLabel(t: Translator, item: ToolCatalogItem): string {
  if (item.origin === 'external_mcp' && item.declaredPermission === 'UNKNOWN') return t('tools.detail.notSpecifiedByServer');
  return item.declaredPermission;
}

function profileDecisionLabel(t: Translator, item: ToolCatalogItem): string {
  if (item.origin === 'external_mcp' && item.profileDecision === 'UNKNOWN') return t('tools.notClassified');
  return item.profileDecision;
}

function riskModeLabel(t: Translator, item: ToolCatalogItem): string {
  if (item.riskMode === 'external_unknown') return t('tools.detail.externalBoundary');
  return item.riskMode;
}

function deliveryStateLabel(t: Translator, item: ToolCatalogItem): string {
  if (item.deliveryState === 'external_unknown') return t('tools.managedExternal');
  return item.deliveryState ?? '';
}

function busyActionLabel(t: Translator, action: ResolvedRemediation['actions'][number]): string {
  if (action.kind === 'launch_managed_browser') return t('tools.detail.startingManagedBrowser');
  if (action.kind === 'install_pdf_provider') return t('tools.detail.installingPdf');
  return t('tools.detail.working');
}

function actionLabel(t: Translator, action: ResolvedRemediation['actions'][number]): string {
  if (action.kind === 'recheck') return t('doctor.action.recheck');
  if (action.kind === 'launch_managed_browser') return t('doctor.action.startManagedBrowser');
  if (action.kind === 'install_pdf_provider') return t('doctor.action.installPdfProvider');
  if (action.kind === 'set_user_setting') return t('doctor.action.enableCodex');
  if (action.kind === 'open_system_settings') return t('doctor.action.openWindowsFeatures');
  if (action.kind === 'open_settings') {
    const keys = {
      projects: 'doctor.action.projects',
      tools_codex: 'doctor.action.toolsCodex',
      tools_local_providers: 'doctor.action.localProviders',
      mcp_servers: 'doctor.action.mcpServers',
      tunnel: 'tools.detail.openSecureTunnel',
      security_profile: 'doctor.action.securityProfile',
    } as const;
    const key = keys[action.target as keyof typeof keys];
    return key === undefined ? t('doctor.action.openSettings') : t(key);
  }
  if (action.kind === 'open_official_url') return t('doctor.action.openOfficialSite');
  return t('doctor.action.copyCommand');
}
