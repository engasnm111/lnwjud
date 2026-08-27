import { useEffect, useState, type ReactElement } from 'react';
import type { DashboardSnapshot, IncidentClassification, UiLocale, WorkspaceSummary } from '@lnwjud/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';

interface ControlCenterPageProps {
  readonly dashboard: DashboardSnapshot;
  readonly workspaces: readonly WorkspaceSummary[];
  readonly locale: UiLocale;
  readonly mcpBusy: boolean;
  readonly tunnelBusy: boolean;
  readonly onRefresh: () => Promise<void>;
  readonly onStopMcp: () => Promise<void>;
  readonly onRestartMcp: () => Promise<void>;
  readonly onSelectWorkspace: (workspaceId: string) => Promise<void>;
  readonly onSetWorkspaceActive: (workspaceId: string, active: boolean) => Promise<void>;
  readonly onAddWorkspace: (rootPath: string) => Promise<void>;
  readonly onStartTunnel: () => Promise<void>;
  readonly onStopTunnel: () => Promise<void>;
  readonly onOpenTunnelSetup: () => void;
  readonly onCaptureIncident: () => Promise<void>;
  readonly incidentBusy: boolean;
  readonly incidentClassification: IncidentClassification | null;
  readonly incidentCapturedAt: string | null;
  readonly incidentNotice: string | null;
}

export function ControlCenterPage(props: ControlCenterPageProps): ReactElement {
  const t = createTranslator(props.locale);
  const { dashboard } = props;
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState('');
  const [selectedId, setSelectedId] = useState(dashboard.selectedWorkspace?.id ?? '');
  const [projectBusyId, setProjectBusyId] = useState<string | null>(null);
  const activeWorkspaceIds = new Set(dashboard.activeWorkspaces.map((workspace) => workspace.id));
  const activeProjects = props.workspaces.filter((workspace) => activeWorkspaceIds.has(workspace.id));

  useEffect(() => {
    setSelectedId(dashboard.selectedWorkspace?.id ?? '');
  }, [dashboard.selectedWorkspace?.id]);

  const agentLabel = dashboard.agentState === 'busy'
    ? t('agent.busy')
    : dashboard.agentState === 'idle'
      ? t('agent.ready')
      : t('agent.stopped');

  const tunnelLabel = dashboard.tunnel.state === 'running'
    ? dashboard.tunnel.source === 'external'
      ? (!dashboard.tunnel.hasApiKey || !dashboard.tunnel.profileExists ? t('tunnel.incompleteExternal') : t('tunnel.runningExternal'))
      : t('tunnel.running')
    : dashboard.tunnel.state === 'starting'
      ? t('tunnel.starting')
      : dashboard.tunnel.state === 'error'
        ? t('tunnel.error')
        : t('tunnel.stopped');

  const stdioBroad = dashboard.stdioPermissionProfile === 'full' && !dashboard.stdioStrictRoots;
  const broadAccess = dashboard.unrestricted || dashboard.allowAiDelete || stdioBroad;
  const onOff = (enabled: boolean): string => enabled ? t('security.enabled') : t('security.disabled');
  const workspaceScope = dashboard.stdioStrictRoots
    ? `${dashboard.stdioAllowedRoots.length} ${t('security.allowedRoots')}`
    : t('security.machineRoots');

  async function copyText(value: string): Promise<void> {
    await navigator.clipboard.writeText(value);
    setCopyStatus(t('mcp.copied'));
  }

  async function changeProjectActive(workspaceId: string, active: boolean): Promise<void> {
    setProjectBusyId(workspaceId);
    try {
      await props.onSetWorkspaceActive(workspaceId, active);
    } finally {
      setProjectBusyId(null);
    }
  }

  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <h1>{t('home.title')}</h1>
          <p className="page-subtitle">{t('home.subtitle')}</p>
        </div>
        <div className="heading-actions">
          <button type="button" onClick={() => { void props.onRefresh(); }}>{t('action.refresh')}</button>
          <button type="button" disabled={props.incidentBusy} onClick={() => { void props.onCaptureIncident(); }}>{t('live.captureIncident')}</button>
          <button type="button" disabled={props.mcpBusy || !dashboard.mcp.running} onClick={() => { void props.onStopMcp(); }}>
            {t('action.stop')}
          </button>
          <button type="button" disabled={props.mcpBusy || dashboard.selectedWorkspace === null} onClick={() => { void props.onRestartMcp(); }}>
            {t('action.restart')}
          </button>
        </div>
      </div>
      {!props.incidentBusy && props.incidentNotice === null && props.incidentClassification === null ? null : <p role="status" className="hint">{props.incidentBusy ? t('live.incident.capturing') : props.incidentNotice ?? `${incidentLabel(t, props.incidentClassification!)} · ${props.incidentCapturedAt ?? ''}`}</p>}

      <section className="panel agent-status-panel" aria-label={agentLabel}>
        <div className={`agent-orb ${dashboard.agentState}`} data-testid="agent-state" />
        <div>
          <strong data-testid="mcp-status">{agentLabel}</strong>
          <p>
            {t('agent.mode')}
            {dashboard.unrestricted ? ` • ${t('badge.unrestricted')}` : ''}
          </p>
        </div>
      </section>

      <section className={`panel security-overview ${broadAccess ? 'security-risk-broad' : 'security-risk-restricted'}`} aria-label={t('security.title')}>
        <div className="security-overview-header">
          <div>
            <h2>{t('security.title')}</h2>
            <p className="hint">{t('security.strictHint')}</p>
          </div>
          <span className={`security-summary-chip ${broadAccess ? 'broad' : 'restricted'}`} data-testid="security-summary">
            {broadAccess ? t('security.summaryBroad') : t('security.summaryRestricted')}
          </span>
        </div>
        <div className="security-overview-grid">
          <SecurityMetric label={t('security.desktopProfile')} value={dashboard.permissionProfile.toUpperCase()} />
          <SecurityMetric label={t('security.stdioProfile')} value={dashboard.stdioPermissionProfile.toUpperCase()} />
          <SecurityMetric label={t('security.strictRoots')} value={onOff(dashboard.stdioStrictRoots)} state={dashboard.stdioStrictRoots ? 'safe' : 'warn'} />
          <SecurityMetric label={t('security.aiDelete')} value={onOff(dashboard.allowAiDelete)} state={dashboard.allowAiDelete ? 'warn' : 'safe'} />
          <SecurityMetric label={t('security.unrestricted')} value={onOff(dashboard.unrestricted)} state={dashboard.unrestricted ? 'warn' : 'safe'} />
          <SecurityMetric label={t('security.workspaceScope')} value={workspaceScope} state={dashboard.stdioStrictRoots ? 'safe' : 'warn'} />
          <SecurityMetric label={t('security.tunnelAccess')} value={tunnelLabel} state={dashboard.tunnel.state === 'running' ? 'active' : 'neutral'} />
          <SecurityMetric label={t('security.registeredWorkspaces')} value={String(props.workspaces.length)} />
        </div>
        {stdioBroad ? <div className="security-warning" role="status">⚠ {t('security.warningBroad')}</div> : null}
      </section>

      <div className="home-grid">
        <section className="panel">
          <h2>{t('mcp.localUrl')}</h2>
          <code data-testid="mcp-endpoint" className="endpoint">
            {dashboard.connectionModes.httpUrl ?? '—'}
          </code>
          <div className="inline-actions">
            <button
              type="button"
              disabled={dashboard.connectionModes.httpUrl === null}
              onClick={() => {
                if (dashboard.connectionModes.httpUrl !== null) void copyText(dashboard.connectionModes.httpUrl);
              }}
            >
              {t('mcp.copy')}
            </button>
            {copyStatus === null ? null : <span data-testid="mcp-copy-status" role="status">{copyStatus}</span>}
          </div>
          <p className="hint">{t('mcp.stdioCommand')}</p>
          <code className="endpoint">{dashboard.connectionModes.stdioCommand}</code>
        </section>

        <section className="panel">
          <h2>{t('tunnel.title')}</h2>
          <p data-testid="tunnel-status">{tunnelLabel}</p>
          {dashboard.tunnel.message ? <p className="hint error-text">{dashboard.tunnel.message}</p> : null}
          {!dashboard.tunnel.hasApiKey ? <p className="hint">{t('tunnel.needKey')}</p> : null}
          {!dashboard.tunnel.profileExists ? <p className="hint">{t('tunnel.needProfile')}</p> : null}
          {dashboard.tunnel.hasApiKey && dashboard.tunnel.profileExists ? null : (
            <div className="guided-tunnel-home-entry">
              <p className="hint">{t('guidedTunnel.dismissedHint')}</p>
              <button type="button" className="btn-save-gold" onClick={props.onOpenTunnelSetup}>{t('guidedTunnel.openGuide')}</button>
            </div>
          )}
          <div className="inline-actions">
            <button
              type="button"
              disabled={props.tunnelBusy || !dashboard.tunnel.hasApiKey || dashboard.tunnel.state === 'running'}
              onClick={() => { void props.onStartTunnel(); }}
            >
              {t('tunnel.start')}
            </button>
            <button
              type="button"
              disabled={props.tunnelBusy || dashboard.tunnel.state === 'stopped'}
              onClick={() => { void props.onStopTunnel(); }}
            >
              {t('tunnel.stop')}
            </button>
          </div>
        </section>
      </div>

      <div className="home-grid">
        <section className="panel active-projects-panel">
          <div className="project-picker-heading">
            <div>
              <h2>{props.locale === 'th' ? 'โปรเจกต์ที่ใช้งานพร้อมกัน' : 'Active Projects'}</h2>
              <p className="hint">{props.locale === 'th' ? 'เลือกหลายโปรเจกต์สำหรับหลายแชทได้พร้อมกัน โดยโปรเจกต์หลัก (Primary) จะใช้เมื่อ tool call ไม่ได้ระบุ workspaceId' : 'Enable multiple projects for parallel chats. Primary is used only when a tool call does not specify workspaceId.'}</p>
            </div>
            <span className="active-project-count">{dashboard.activeWorkspaces.length}/{props.workspaces.length} {props.locale === 'th' ? 'กำลังใช้งาน' : 'active'}</span>
          </div>

          {props.workspaces.length === 0 ? (
            <div className="active-project-empty">{props.locale === 'th' ? 'ยังไม่มีโปรเจกต์ เพิ่มโฟลเดอร์โปรเจกต์ด้านล่างเพื่อเริ่มใช้งาน' : 'No projects yet. Add a project folder below to get started.'}</div>
          ) : (
            <div className="active-project-picker" role="group" aria-label={props.locale === 'th' ? 'โปรเจกต์ที่ใช้งานพร้อมกัน' : 'Active projects'}>
              {props.workspaces.map((workspace) => {
                const active = activeWorkspaceIds.has(workspace.id);
                const primary = dashboard.selectedWorkspace?.id === workspace.id;
                const lastActive = active && dashboard.activeWorkspaces.length <= 1;
                const busy = projectBusyId !== null;
                const title = lastActive
                  ? (props.locale === 'th' ? 'ต้องมี Active Project อย่างน้อย 1 โปรเจกต์' : 'At least one Active Project is required')
                  : workspace.realRootPath;
                return (
                  <label
                    key={workspace.id}
                    className={`active-project-option ${active ? 'is-active' : ''} ${primary ? 'is-primary' : ''} ${lastActive ? 'is-locked' : ''}`}
                    title={title}
                  >
                    <input
                      className="active-project-checkbox"
                      type="checkbox"
                      checked={active}
                      disabled={busy || lastActive}
                      onChange={(event) => { void changeProjectActive(workspace.id, event.target.checked); }}
                    />
                    <span className="active-project-check" aria-hidden="true">{active ? '✓' : ''}</span>
                    <span className="active-project-copy">
                      <strong>{workspace.displayName}</strong>
                      <small>{workspace.realRootPath}</small>
                    </span>
                    <span className="active-project-state">
                      {primary ? <em className="primary-project-badge">PRIMARY</em> : active ? <em className="active-project-badge">ACTIVE</em> : null}
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          <div className="primary-project-control">
            <div className="primary-project-copy">
              <strong>{props.locale === 'th' ? 'โปรเจกต์หลัก (Primary)' : 'Primary project'}</strong>
              <small>{props.locale === 'th' ? 'ใช้เป็นค่าเริ่มต้นเท่านั้น โปรเจกต์อื่นที่เปิด Active ยังทำงานพร้อมกันได้' : 'Used only as the default; other active projects remain available in parallel.'}</small>
            </div>
            <div className="form-row primary-project-row">
              <select
                aria-label={props.locale === 'th' ? 'โปรเจกต์หลัก' : 'Primary project'}
                value={selectedId}
                disabled={activeProjects.length === 0}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {activeProjects.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.displayName}</option>)}
              </select>
              <button type="button" disabled={selectedId.length === 0 || selectedId === dashboard.selectedWorkspace?.id} onClick={() => { void props.onSelectWorkspace(selectedId); }}>
                {t('project.setMain')}
              </button>
            </div>
          </div>

          <div className="add-project-control">
            <label className="field-label" htmlFor="add-project-path">{t('project.add')}</label>
            <p className="hint">{t('project.addHint')}</p>
            <div className="form-row">
              <input
                id="add-project-path"
                value={projectPath}
                onChange={(event) => setProjectPath(event.target.value)}
                placeholder="D:\\projects\\app"
              />
              <button
                type="button"
                disabled={projectPath.trim().length === 0}
                onClick={() => {
                  void props.onAddWorkspace(projectPath).then(() => setProjectPath(''));
                }}
              >
                {t('project.add')}
              </button>
            </div>
          </div>
        </section>

        <section className="info-cards" aria-label="Status cards">
          <article className="info-card">
            <p>{t('info.workspace')}</p>
            <strong data-testid="workspace-real-root">{dashboard.selectedWorkspace?.realRootPath ?? '—'}</strong>
          </article>
          <article className="info-card">
            <p>{t('info.activeProject')}</p>
            <strong>{dashboard.activeWorkspaces.length === 0 ? '—' : dashboard.activeWorkspaces.map((workspace) => workspace.displayName).join(', ')}</strong>
            <span data-testid="workspace-id" hidden>{dashboard.selectedWorkspace?.id ?? ''}</span>
          </article>
          <article className="info-card">
            <p>{t('info.mode')}</p>
            <strong>{dashboard.mode}</strong>
          </article>
        </section>
      </div>

    </div>
  );
}

function SecurityMetric(props: { readonly label: string; readonly value: string; readonly state?: 'safe' | 'warn' | 'active' | 'neutral' }): ReactElement {
  return (
    <article className={`security-metric ${props.state ?? 'neutral'}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </article>
  );
}

function incidentLabel(t: ReturnType<typeof createTranslator>, classification: IncidentClassification): string {
  if (classification === 'local_tool_failed') return t('live.incident.localToolFailed');
  if (classification === 'tunnel_disconnected') return t('live.incident.tunnelDisconnected');
  if (classification === 'remote_turn_stopped') return t('live.incident.remoteTurnStopped');
  return t('live.incident.healthyOrInconclusive');
}
