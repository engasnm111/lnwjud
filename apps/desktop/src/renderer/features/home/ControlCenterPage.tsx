import { useEffect, useState, type ReactElement } from 'react';
import type { DashboardSnapshot, IncidentClassification, UiLocale, WorkspaceSummary } from '@lnwjud/ipc-contracts';
import { formatDateTime } from '../../date-time.js';
import { createTranslator } from '../../i18n/index.js';
import { tunnelRuntimeCredentialAvailable } from '../../tunnel-auth-readiness.js';
import { tunnelAuthPresentation } from '../../tunnel-auth-presentation.js';
import { settleWorkspaceAdd, type AddWorkspaceAction } from '../workspaces/workspace-add.js';

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
  const remoteMcp = dashboard.remoteMcp ?? {
    state: 'stopped' as const, provider: 'ngrok' as const, installed: false, hasAuthtoken: false, ngrokPath: null,
    localMcpUrl: dashboard.mcp.url, localGatewayUrl: null, publicMcpUrl: null, pairingCode: null, pairingCodeExpiresAt: null,
    oauthProtected: true, oauthConnected: false, pairingRequired: false, autoStartEnabled: false, message: null,
  };
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
      {!props.incidentBusy && props.incidentNotice === null && props.incidentClassification === null ? null : <p role="status" className="hint">{props.incidentBusy ? t('live.incident.capturing') : props.incidentNotice ?? `${incidentLabel(t, props.incidentClassification!)} · ${formatDateTime(props.incidentCapturedAt, '—', props.locale)}`}</p>}

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
          <SecurityMetric label="Desktop Full Bypass" value={desktopBypassOn ? 'FULL BYPASS ON' : 'OFF'} state={desktopBypassOn ? 'warn' : 'safe'} />
          <SecurityMetric label={t('security.stdioProfile')} value={dashboard.stdioPermissionProfile.toUpperCase()} />
          <SecurityMetric label="STDIO Full Bypass" value={stdioBypassOn ? 'FULL BYPASS ON' : 'OFF'} state={stdioBypassOn ? 'warn' : 'safe'} />
          <SecurityMetric label={t('security.strictRoots')} value={onOff(dashboard.stdioStrictRoots)} state={dashboard.stdioStrictRoots ? 'safe' : 'warn'} />
          <SecurityMetric label={t('security.aiDelete')} value={onOff(dashboard.allowAiDelete)} state={dashboard.allowAiDelete ? 'warn' : 'safe'} />
          <SecurityMetric label={t('security.unrestricted')} value={onOff(dashboard.unrestricted)} state={dashboard.unrestricted ? 'warn' : 'safe'} />
          <SecurityMetric label={t('security.workspaceScope')} value={workspaceScope} state={dashboard.stdioStrictRoots ? 'safe' : 'warn'} />
          <SecurityMetric label={t('security.tunnelAccess')} value={tunnelLabel} state={dashboard.tunnel.state === 'running' ? 'active' : 'neutral'} />
          <SecurityMetric label="Remote MCP OAuth" value={remoteMcp.state === 'running' ? 'ONLINE' : remoteMcp.oauthConnected ? (remoteMcp.autoStartEnabled ? 'LINKED · AUTO' : 'LINKED') : remoteMcp.installed && remoteMcp.hasAuthtoken ? 'READY' : 'SETUP'} state={remoteMcp.state === 'running' || remoteMcp.oauthConnected ? 'active' : 'neutral'} />
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
          {dashboard.mcp.lastStartError === null || dashboard.mcp.lastStartError === undefined ? null : <p className="hint error-text" role="alert">MCP start error: {dashboard.mcp.lastStartError}</p>}
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
          <div className="home-remote-mcp-block">
            <div className="settings-mini-heading"><strong>Remote MCP · OAuth</strong><span>{remoteMcp.state === 'running' ? 'ONLINE' : remoteMcp.oauthConnected ? (remoteMcp.autoStartEnabled ? 'LINKED · AUTO' : 'LINKED') : remoteMcp.state.toUpperCase()}</span></div>
            <code className="endpoint">{remoteMcp.publicMcpUrl ?? '—'}</code>
            <div className="inline-actions">
              <button type="button" disabled={remoteMcp.publicMcpUrl === null} onClick={() => { if (remoteMcp.publicMcpUrl !== null) void copyText(remoteMcp.publicMcpUrl); }}>{props.locale === 'th' ? 'Copy Public /mcp' : 'Copy public /mcp'}</button>
              <button type="button" onClick={props.onOpenTunnelSetup}>{props.locale === 'th' ? 'ตั้งค่า OAuth / ngrok' : 'Configure OAuth / ngrok'}</button>
            </div>
            {remoteMcp.oauthConnected ? <div className="home-remote-mcp-status is-connected">{props.locale === 'th' ? (remoteMcp.autoStartEnabled ? '✓ ChatGPT เชื่อมแล้ว · เปิด lnwjud ครั้งถัดไปจะ Start Remote MCP อัตโนมัติ' : '✓ ChatGPT เชื่อมแล้ว · การเชื่อมต่อยังถูกจำไว้ แต่ Auto-start ปิดอยู่') : (remoteMcp.autoStartEnabled ? '✓ ChatGPT connected · Remote MCP will auto-start with lnwjud.' : '✓ ChatGPT connected · authorization is remembered, but auto-start is off.')}</div> : null}
            {remoteMcp.pairingCode === null ? null : <div className="home-remote-mcp-status is-pairing"><strong className="remote-mcp-pairing-line"><span>{props.locale === 'th' ? 'Pairing ครั้งแรก' : 'First-time pairing'}:</span><span className="remote-mcp-pairing-pin" aria-label={`${props.locale === 'th' ? 'Pairing PIN' : 'Pairing PIN'} ${remoteMcp.pairingCode}`}>{remoteMcp.pairingCode}</span></strong></div>}
          </div>
        </section>

        <details
          className={`connection-method-stack home-connection-method ${remoteMcpOnline ? 'is-secondary' : ''}`}
          open={secureTunnelExpanded}
          onToggle={(event) => setSecureTunnelExpanded(event.currentTarget.open)}
        >
          <summary className="connection-method-summary">
            <div className="connection-method-summary-copy">
              <span className="connection-method-kicker">{remoteMcpOnline ? (props.locale === 'th' ? 'ตัวเลือกเสริม / ขั้นสูง' : 'Optional / advanced') : (props.locale === 'th' ? 'วิธีเชื่อมต่อทางเลือก' : 'Alternative connection')}</span>
              <strong>{t(tunnelPresentation.titleKey)}</strong>
              <span>{remoteMcpOnline
                ? (props.locale === 'th' ? 'Remote MCP OAuth ออนไลน์แล้ว จึงพับส่วน Tunnel ไว้เพื่อลดความสับสน — ยังเปิดใช้พร้อมกันได้' : 'Remote MCP OAuth is online, so Tunnel controls are collapsed to reduce clutter. Both may still run together.')
                : (tunnelPresentation.transportHintKey === null ? (props.locale === 'th' ? 'เปิดเพื่อจัดการ Secure MCP Tunnel' : 'Expand to manage Secure MCP Tunnel.') : t(tunnelPresentation.transportHintKey))}</span>
            </div>
            <div className="connection-method-summary-status">
              <span className={`connection-method-live-dot ${dashboard.tunnel.state === 'running' ? 'is-online' : ''}`} aria-hidden="true" />
              <span>{tunnelLabel}</span>
              <span className="active-project-count">{tunnelPresentation.badge}</span>
              <span className="connection-method-chevron" aria-hidden="true">⌄</span>
            </div>
          </summary>
          <section className="panel connection-method-panel">
          <div className="section-heading">
            <div>
              <h2>{t(tunnelPresentation.titleKey)}</h2>
              {tunnelPresentation.transportHintKey === null ? null : <p className="hint">{t(tunnelPresentation.transportHintKey)}</p>}
            </div>
            <span className="active-project-count">{tunnelPresentation.badge}</span>
          </div>
          <p data-testid="tunnel-status">{tunnelLabel}</p>
          {tunnelPresentation.isOAuth && dashboard.tunnel.auth?.accountLabel ? <p className="hint">{props.locale === 'th' ? 'บัญชี OAuth' : 'OAuth account'}: {dashboard.tunnel.auth.accountLabel}</p> : null}
          {dashboard.tunnel.message ? <p className="hint error-text">{dashboard.tunnel.message}</p> : null}
          {!tunnelCredentialAvailable ? <p className="hint">{t(tunnelPresentation.needCredentialKey)}</p> : null}
          {!dashboard.tunnel.profileExists ? <p className="hint">{t('tunnel.needProfile')}</p> : null}
          {tunnelCredentialAvailable && dashboard.tunnel.profileExists ? null : (
            <div className="guided-tunnel-home-entry">
              <p className="hint">{tunnelPresentation.isOAuth ? (props.locale === 'th' ? 'ตรวจ OAuth session และการเชื่อมต่อในหน้าตั้งค่า' : 'Review the OAuth session and connection in Settings.') : t('guidedTunnel.dismissedHint')}</p>
              <button type="button" className="btn-save-gold" onClick={props.onOpenTunnelSetup}>{tunnelPresentation.isOAuth ? (props.locale === 'th' ? 'เปิดการตั้งค่าการเชื่อมต่อ' : 'Open connection settings') : t('guidedTunnel.openGuide')}</button>
            </div>
          )}
          <div className="inline-actions">
            <button
              type="button"
              disabled={props.tunnelBusy || !tunnelCredentialAvailable || dashboard.tunnel.state === 'running'}
              onClick={() => { void props.onStartTunnel(); }}
            >
              {t(tunnelPresentation.startKey)}
            </button>
            <button
              type="button"
              disabled={props.tunnelBusy || dashboard.tunnel.state === 'stopped'}
              onClick={() => { void props.onStopTunnel(); }}
            >
              {t(tunnelPresentation.stopKey)}
            </button>
          </div>
        </section>
        </details>
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
                onClick={() => { void addCurrentProject(); }}
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
