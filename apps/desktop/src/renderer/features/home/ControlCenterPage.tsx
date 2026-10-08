import { ActionButton, FormInput } from '../ui/UiPrimitives.js';
import { useEffect, useState, type ReactElement } from 'react';
import { EMPTY_REMOTE_MCP_STATUS, type DashboardSnapshot, type IncidentClassification, type UiLocale, type WorkspaceSummary } from '@lnwjud/ipc-contracts';
import { formatDateTime } from '../../date-time.js';
import { createTranslator } from '../../i18n/index.js';
import { tunnelRuntimeCredentialAvailable } from '../../tunnel-auth-readiness.js';
import { tunnelAuthPresentation } from '../../tunnel-auth-presentation.js';
import { settleWorkspaceAdd, type AddWorkspaceAction } from '../workspaces/workspace-add.js';
import { SearchableSelect } from '../../components/ui/SearchableSelect.js';
import { AgentPrism } from './AgentPrism.js';

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
  readonly onAddWorkspace: AddWorkspaceAction;
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
  const tunnelCredentialAvailable = tunnelRuntimeCredentialAvailable(dashboard.tunnel);
  const tunnelPresentation = tunnelAuthPresentation(dashboard.tunnel);
  const tunnelControlsLocked = props.tunnelBusy || dashboard.tunnel.state === 'starting';
  const remoteMcp = dashboard.remoteMcp ?? { ...EMPTY_REMOTE_MCP_STATUS, localMcpUrl: dashboard.mcp.url };

  const remoteMcpOnline = remoteMcp.state === 'running';
  const [secureTunnelExpanded, setSecureTunnelExpanded] = useState(!remoteMcpOnline);

  useEffect(() => {
    setSecureTunnelExpanded(!remoteMcpOnline);
  }, [remoteMcpOnline]);

  useEffect(() => {
    setSelectedId(dashboard.selectedWorkspace?.id ?? '');
  }, [dashboard.selectedWorkspace?.id]);

  const agentLabel = dashboard.agentState === 'busy'
    ? t('agent.busy')
    : dashboard.agentState === 'idle'
      ? t('agent.ready')
      : t('agent.stopped');

  const tunnelMessage = dashboard.tunnel.state === 'starting' ? null : dashboard.tunnel.message;
  const tunnelMessageIsError = dashboard.tunnel.state === 'error';

  const tunnelLabel = dashboard.tunnel.state === 'running'
    ? dashboard.tunnel.source === 'external'
      ? (!tunnelCredentialAvailable || !dashboard.tunnel.profileExists ? t(tunnelPresentation.incompleteExternalKey) : t(tunnelPresentation.runningExternalKey))
      : t(tunnelPresentation.runningKey)
    : dashboard.tunnel.state === 'starting'
      ? t(tunnelPresentation.startingKey)
      : dashboard.tunnel.state === 'error'
        ? t(tunnelPresentation.errorKey)
        : t(tunnelPresentation.stoppedKey);

  const desktopBypassOn = dashboard.permissionProfile === 'full' && dashboard.settings?.desktopFullBypassAll === true;
  const stdioBypassOn = dashboard.stdioPermissionProfile === 'full' && dashboard.settings?.stdioFullBypassAll === true;
  const stdioBroad = dashboard.stdioPermissionProfile === 'full' && !dashboard.stdioStrictRoots;
  const broadAccess = dashboard.unrestricted || dashboard.allowAiDelete || stdioBroad || desktopBypassOn || stdioBypassOn;
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

  async function addCurrentProject(): Promise<void> {
    setProjectPath(await settleWorkspaceAdd(projectPath, props.onAddWorkspace));
  }

  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <h1>{t('home.title')}</h1>
          <p className="page-subtitle">{t('home.subtitle')}</p>
        </div>
        <div className="heading-actions">
          <ActionButton type="button" onClick={() => { void props.onRefresh(); }}>{t('action.refresh')}</ActionButton>
          <details className="agent-actions-menu">
            <summary aria-label={t('home.agentActions')}>•••</summary>
            <div className="agent-actions-popover">
              <ActionButton type="button" disabled={props.incidentBusy} onClick={() => { void props.onCaptureIncident(); }}>{t('live.captureIncident')}</ActionButton>
              <ActionButton type="button" disabled={props.mcpBusy || dashboard.selectedWorkspace === null} onClick={() => { void props.onRestartMcp(); }}>
                {t('home.restartDesktopAgent')}
              </ActionButton>
              <ActionButton type="button" disabled={props.mcpBusy || !dashboard.mcp.running} onClick={() => { void props.onStopMcp(); }}>
                {t('home.stopDesktopAgent')}
              </ActionButton>
            </div>
          </details>
        </div>
      </div>
      {!props.incidentBusy && props.incidentNotice === null && props.incidentClassification === null ? null : <p role="status" className="hint">{props.incidentBusy ? t('live.incident.capturing') : props.incidentNotice ?? `${incidentLabel(t, props.incidentClassification!)} · ${formatDateTime(props.incidentCapturedAt, '—', props.locale)}`}</p>}

      <section className="panel agent-status-panel" aria-label={agentLabel}>
        <AgentPrism state={dashboard.agentState} />
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
          <SecurityMetric label={t('security.desktopFullBypass')} value={desktopBypassOn ? t('userConfig.fullBypassBadgeOn') : t('userConfig.offBadge')} state={desktopBypassOn ? 'warn' : 'safe'} />
          <SecurityMetric label={t('security.stdioProfile')} value={dashboard.stdioPermissionProfile.toUpperCase()} />
          <SecurityMetric label={t('security.stdioFullBypass')} value={stdioBypassOn ? t('userConfig.fullBypassBadgeOn') : t('userConfig.offBadge')} state={stdioBypassOn ? 'warn' : 'safe'} />
          <SecurityMetric label={t('security.strictRoots')} value={onOff(dashboard.stdioStrictRoots)} state={dashboard.stdioStrictRoots ? 'safe' : 'warn'} />
          <SecurityMetric label={t('security.aiDelete')} value={onOff(dashboard.allowAiDelete)} state={dashboard.allowAiDelete ? 'warn' : 'safe'} />
          <SecurityMetric label={t('security.unrestricted')} value={onOff(dashboard.unrestricted)} state={dashboard.unrestricted ? 'warn' : 'safe'} />
          <SecurityMetric label={t('security.workspaceScope')} value={workspaceScope} state={dashboard.stdioStrictRoots ? 'safe' : 'warn'} />
          <SecurityMetric label={t('security.tunnelAccess')} value={tunnelLabel} state={dashboard.tunnel.state === 'running' ? 'active' : 'neutral'} />
          <SecurityMetric label={t('security.remoteMcpOauth')} value={remoteMcp.state === 'running' ? t('status.online') : remoteMcp.oauthConnected ? (remoteMcp.autoStartEnabled ? t('status.linkedAuto') : t('status.linked')) : remoteMcp.installed && remoteMcp.hasAuthtoken ? t('status.ready') : t('status.setup')} state={remoteMcp.state === 'running' || remoteMcp.oauthConnected ? 'active' : 'neutral'} />
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
          {dashboard.mcp.lastStartError === null || dashboard.mcp.lastStartError === undefined ? null : <p className="hint error-text" role="alert">{t('home.mcpStartError', { detail: dashboard.mcp.lastStartError })}</p>}
          <div className="inline-actions">
            <ActionButton
              type="button"
              disabled={dashboard.connectionModes.httpUrl === null}
              onClick={() => {
                if (dashboard.connectionModes.httpUrl !== null) void copyText(dashboard.connectionModes.httpUrl);
              }}
            >
              {t('mcp.copy')}
            </ActionButton>
            {copyStatus === null ? null : <span data-testid="mcp-copy-status" role="status">{copyStatus}</span>}
          </div>
          <p className="hint">{t('mcp.stdioCommand')}</p>
          <code className="endpoint">{dashboard.connectionModes.stdioCommand}</code>
        </section>

        <section className="panel chatgpt-connection-panel" aria-label={t('home.chatgptConnection')}>
          <div className="section-heading">
            <div>
              <h2>{t('home.chatgptConnection')}</h2>
              <p className="hint">{t('home.chatgptHint')}</p>
            </div>
            <span className={`connection-count-chip ${remoteMcpOnline || dashboard.tunnel.state === 'running' ? 'is-online' : ''}`}>{remoteMcpOnline || dashboard.tunnel.state === 'running' ? t('home.connected') : t('home.notConnected')}</span>
          </div>

          <div className="home-remote-mcp-block chatgpt-primary-connection">
            <div className="settings-mini-heading"><strong>{t('home.remoteMcpOauth')}</strong><span>{remoteMcp.state === 'running' ? t('status.online') : remoteMcp.oauthConnected ? (remoteMcp.autoStartEnabled ? t('status.linkedAuto') : t('status.linked')) : remoteMcp.installed && remoteMcp.hasAuthtoken ? t('status.ready') : t('status.setup')}</span></div>
            <code className="endpoint">{remoteMcp.publicMcpUrl ?? '—'}</code>
            <div className="inline-actions">
              <ActionButton type="button" disabled={remoteMcp.publicMcpUrl === null} onClick={() => { if (remoteMcp.publicMcpUrl !== null) void copyText(remoteMcp.publicMcpUrl); }}>{t('home.copyPublicMcp')}</ActionButton>
              <ActionButton type="button" onClick={props.onOpenTunnelSetup}>{t('home.configureChatgpt')}</ActionButton>
            </div>
            {remoteMcp.oauthConnected ? <div className="home-remote-mcp-status is-connected">{remoteMcp.autoStartEnabled ? t('home.chatgptConnectedAuto') : t('home.chatgptConnectedManual')}</div> : null}
          </div>

          <details
            className={`connection-method-stack home-connection-method chatgpt-advanced-connection ${remoteMcpOnline ? 'is-secondary' : ''}`}
            open={secureTunnelExpanded}
            onToggle={(event) => setSecureTunnelExpanded(event.currentTarget.open)}
          >
            <summary className="connection-method-summary">
              <div className="connection-method-summary-copy">
                <span className="connection-method-kicker">{t('home.advancedOption')}</span>
                <strong>{t(tunnelPresentation.titleKey)}</strong>
                <span>{t('home.secureTunnelHint')}</span>
              </div>
              <div className="connection-method-summary-status">
                <span className={`connection-method-live-dot ${dashboard.tunnel.state === 'running' ? 'is-online' : ''}`} aria-hidden="true" />
                <span>{tunnelLabel}</span>
                <span className="connection-method-chevron" aria-hidden="true">⌄</span>
              </div>
            </summary>
            <div className="connection-method-panel chatgpt-tunnel-panel">
              <p data-testid="tunnel-status">{tunnelLabel}</p>
              {tunnelPresentation.isOAuth && dashboard.tunnel.auth?.accountLabel ? <p className="hint">{t('home.oauthAccount')}: {dashboard.tunnel.auth.accountLabel}</p> : null}
              {tunnelMessage ? <p className={tunnelMessageIsError ? 'hint error-text' : 'hint'} role={tunnelMessageIsError ? 'alert' : undefined}>{tunnelMessage}</p> : null}
              {!tunnelCredentialAvailable ? <p className="hint">{t(tunnelPresentation.needCredentialKey)}</p> : null}
              {!dashboard.tunnel.profileExists ? <p className="hint">{t('tunnel.needProfile')}</p> : null}
              {tunnelCredentialAvailable && dashboard.tunnel.profileExists ? null : (
                <div className="guided-tunnel-home-entry">
                  <p className="hint">{tunnelPresentation.isOAuth ? t('home.reviewOauthSettings') : t('guidedTunnel.dismissedHint')}</p>
                  <ActionButton type="button" className="btn-save-gold" onClick={props.onOpenTunnelSetup}>{tunnelPresentation.isOAuth ? t('home.openConnectionSettings') : t('guidedTunnel.openGuide')}</ActionButton>
                </div>
              )}
              <div className="inline-actions">
                <ActionButton type="button" disabled={tunnelControlsLocked || !tunnelCredentialAvailable || dashboard.tunnel.state === 'running'} onClick={() => { void props.onStartTunnel(); }}>
                  {t(tunnelPresentation.startKey)}
                </ActionButton>
                <ActionButton type="button" disabled={tunnelControlsLocked || dashboard.tunnel.state === 'stopped'} onClick={() => { void props.onStopTunnel(); }}>
                  {t(tunnelPresentation.stopKey)}
                </ActionButton>
              </div>
            </div>
          </details>
        </section>
      </div>

      <div className="home-grid">
        <section className="panel active-projects-panel">
          <div className="project-picker-heading">
            <div>
              <h2>{t('home.activeProjectsTitle')}</h2>
              <p className="hint">{t('home.activeProjectsHint')}</p>
            </div>
            <span className="active-project-count">{dashboard.activeWorkspaces.length}/{props.workspaces.length} {t('home.activeCount')}</span>
          </div>

          {props.workspaces.length === 0 ? (
            <div className="active-project-empty">{t('home.noProjects')}</div>
          ) : (
            <div className="active-project-picker" role="group" aria-label={t('home.activeProjectsTitle')}>
              {props.workspaces.map((workspace) => {
                const active = activeWorkspaceIds.has(workspace.id);
                const primary = dashboard.selectedWorkspace?.id === workspace.id;
                const lastActive = active && dashboard.activeWorkspaces.length <= 1;
                const busy = projectBusyId !== null;
                const title = lastActive
                  ? t('project.minActiveRequired')
                  : workspace.realRootPath;
                return (
                  <label
                    key={workspace.id}
                    className={`active-project-option ${active ? 'is-active' : ''} ${primary ? 'is-primary' : ''} ${lastActive ? 'is-locked' : ''}`}
                    title={title}
                  >
                    <FormInput
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
                      {primary ? <em className="primary-project-badge">{t('home.primaryBadge')}</em> : active ? <em className="active-project-badge">{t('home.activeBadge')}</em> : null}
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          <div className="primary-project-control">
            <div className="primary-project-copy">
              <strong>{t('home.primaryProject')}</strong>
              <small>{t('home.primaryProjectHint')}</small>
            </div>
            <div className="form-row primary-project-row">
              <SearchableSelect label={t('home.primaryProject')} value={selectedId}
                disabled={activeProjects.length === 0}
                onChange={setSelectedId}
                options={activeProjects.map((workspace) => ({value:workspace.id,label:workspace.displayName}))} />
              <ActionButton type="button" disabled={selectedId.length === 0 || selectedId === dashboard.selectedWorkspace?.id} onClick={() => { void props.onSelectWorkspace(selectedId); }}>
                {t('project.setMain')}
              </ActionButton>
            </div>
          </div>

          <div className="add-project-control">
            <label className="field-label" htmlFor="add-project-path">{t('project.add')}</label>
            <p className="hint">{t('project.addHint')}</p>
            <div className="form-row">
              <FormInput
                id="add-project-path"
                value={projectPath}
                onChange={(event) => setProjectPath(event.target.value)}
                placeholder="D:\\projects\\app"
              />
              <ActionButton
                type="button"
                disabled={projectPath.trim().length === 0}
                onClick={() => { void addCurrentProject(); }}
              >
                {t('project.add')}
              </ActionButton>
            </div>
          </div>
        </section>

        <section className="info-cards" aria-label={t('home.statusCards')}>
          <article className="info-card">
            <p>{t('info.workspace')}</p>
            <strong data-testid="workspace-real-root">{dashboard.selectedWorkspace?.realRootPath ?? '—'}</strong>
          </article>
          <article className="info-card">
            <p>{t('info.activeProject')}</p>
            <strong>{dashboard.activeWorkspaces.length === 0 ? '—' : dashboard.activeWorkspaces.map((workspace) => workspace.displayName).join(', ')}</strong>
            <span data-testid="workspace-id" hidden>{dashboard.selectedWorkspace?.id ?? ''}</span>
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
  if (classification === 'desktop_session_ended_uncleanly') return t('live.incident.desktopSessionEndedUncleanly');
  if (classification === 'local_tool_failed') return t('live.incident.localToolFailed');
  if (classification === 'tunnel_disconnected') return t('live.incident.tunnelDisconnected');
  if (classification === 'remote_turn_stopped') return t('live.incident.remoteTurnStopped');
  return t('live.incident.healthyOrInconclusive');
}
