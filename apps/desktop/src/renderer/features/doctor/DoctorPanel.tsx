import { ActionButton } from '../ui/UiPrimitives.js';
import type { ReactElement } from 'react';
import type { DoctorCheck, DoctorReport, RemediationAction, ResolvedRemediation, UiLocale } from '@lnwjud/ipc-contracts';
import { formatDateTime } from '../../date-time.js';
import { createTranslator, type Translator } from '../../i18n/index.js';

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
          <span className={`doctor-status-badge doctor-status-${check.status}`}>{statusLabel(t, check.status)}</span>
        </div>
        <p className="doctor-check-summary">{check.summary || check.message}</p>
        {check.detail === undefined ? null : <p className="doctor-check-detail">{check.detail}</p>}
        {check.affectedToolNames.length === 0 ? null : <p className="doctor-affected-tools"><strong>{t('doctor.affectedTools')}</strong> {check.affectedToolNames.join(', ')}</p>}
        {remediation === undefined ? (check.status === 'pass' ? null : (
          <div className="doctor-remediation doctor-remediation-fallback" role="note">
            <div className="doctor-remediation-copy">
              <strong>{t('doctor.manualCheckTitle')}</strong>
              <p>{t('doctor.manualCheckBody')}</p>
            </div>
          </div>
        )) : (
          <div className="doctor-remediation">
            <div className="doctor-remediation-copy"><strong>{remediation.title}</strong><p>{remediation.explanation}</p></div>
            {remediation.steps.length === 0 ? null : <ol>{remediation.steps.map((step) => <li key={step}>{step}</li>)}</ol>}
            <div className="doctor-remediation-actions">{remediation.actions.map((action, index) => <ActionButton type="button" key={`${remediation.id}:${index}`} onClick={() => { void onRemediation?.(action); }}>{actionLabel(t, action)}</ActionButton>)}</div>
          </div>
        )}
        <div className="doctor-check-footer">
          {onRecheck === undefined ? null : <ActionButton type="button" className="doctor-recheck" onClick={() => { void onRecheck([check.id]); }}>{t('doctor.recheckIssue')}</ActionButton>}
          <small>{t('doctor.checked')} {formatDateTime(check.checkedAt, check.checkedAt, locale)} · {check.durationMs} ms</small>
        </div>
      </article>
    );
  };

  return (
    <section className="panel doctor-panel">
      <div className="section-heading">
        <div><p className="page-subtitle" style={{ margin: 0 }}>{t('doctor.subtitle')}</p>{report === null ? null : <small>{report.exitCode === 0 ? t('doctor.corePassed') : t('doctor.requiredAttention')}</small>}</div>
        <ActionButton type="button" onClick={() => { void onRunDoctor(); }}>{t('doctor.run')}</ActionButton>
      </div>
      {report === null ? <div className="doctor-empty-state"><p>{t('doctor.noReport')}</p></div> : (
        <>
          {issues.length === 0 ? <div className="doctor-empty-state"><p>{t('doctor.noIssues')}</p></div> : <div className="doctor-list doctor-issues">{issues.map(renderCheck)}</div>}
          {passed.length === 0 ? null : <details className="doctor-passed"><summary>{t('doctor.checksPassed', { count: passed.length })}</summary><div className="doctor-list">{passed.map(renderCheck)}</div></details>}
        </>
      )}
      {projectSetupRequired ? <div className="doctor-recovery-actions"><p>{t('doctor.addProjectPrompt')}</p><ActionButton type="button" onClick={onOpenProjects}>{t('doctor.addProject')}</ActionButton></div> : null}
    </section>
  );
}

function statusLabel(t: Translator, status: DoctorCheck['status']): string {
  const keys = {
    pass: 'doctor.status.pass',
    warn: 'doctor.status.warn',
    fail: 'doctor.status.fail',
    unknown: 'doctor.status.unknown',
  } as const;
  return t(keys[status]);
}

function actionLabel(t: Translator, action: RemediationAction): string {
  if (action.kind === 'recheck') return t('doctor.action.recheck');
  if (action.kind === 'launch_managed_browser') return t('doctor.action.startManagedBrowser');
  if (action.kind === 'install_pdf_provider') return t('doctor.action.installPdfProvider');
  if (action.kind === 'set_user_setting') return t('doctor.action.enableCodex');
  if (action.kind === 'open_system_settings') return t('doctor.action.openWindowsFeatures');
  if (action.kind === 'copy_command') return t('doctor.action.copyCommand');
  if (action.kind === 'open_official_url') return t('doctor.action.openOfficialSite');
  if (action.kind === 'open_settings') {
    const keys = {
      projects: 'doctor.action.projects',
      tools_codex: 'doctor.action.toolsCodex',
      tools_local_providers: 'doctor.action.localProviders',
      mcp_servers: 'doctor.action.mcpServers',
      tunnel: 'doctor.action.tunnel',
      security_profile: 'doctor.action.securityProfile',
    } as const;
    const key = keys[action.target as keyof typeof keys];
    return key === undefined ? t('doctor.action.openSettings') : t(key);
  }
  return t('doctor.action.apply');
}
