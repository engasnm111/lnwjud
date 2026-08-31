import type { ReactElement } from 'react';
import type { DashboardSnapshot, PermissionProfileName, ProcessSummary, WorkspaceSummary } from '@lnwjud/ipc-contracts';
import { PermissionPanel } from '../permissions/PermissionPanel.js';
import { ProcessPanel } from '../processes/ProcessPanel.js';
import { McpPanel } from '../mcp/McpPanel.js';
import { WorkspacePanel } from '../workspaces/WorkspacePanel.js';
import { CapabilityPanel } from '../capabilities/CapabilityPanel.js';
import type { AddWorkspaceAction } from '../workspaces/workspace-add.js';

interface DashboardPageProps {
  readonly dashboard: DashboardSnapshot;
  readonly workspaces: readonly WorkspaceSummary[];
  readonly processes: readonly ProcessSummary[];
  readonly selectedProcess: ProcessSummary | null;
  readonly onAddWorkspace: AddWorkspaceAction;
  readonly onPermissionProfileChange: (profile: PermissionProfileName) => Promise<void>;
  readonly onStartFixtureProcess: () => Promise<void>;
  readonly onStopProcess: (processId: string) => Promise<void>;
  readonly onStartMcp: () => Promise<void>;
  readonly onStopMcp: () => Promise<void>;
  readonly onLaunchManagedBrowser: () => Promise<void>;
  readonly browserBusy: boolean;
  readonly mcpBusy: boolean;
}

export function DashboardPage(props: DashboardPageProps): ReactElement {
  const { dashboard } = props;
  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">OVERVIEW</p>
          <h1>Gateway dashboard</h1>
        </div>
        <span className="status-pill">Local only</span>
      </div>
      <WorkspacePanel
        selectedWorkspace={dashboard.selectedWorkspace}
        workspaces={props.workspaces}
        onAddWorkspace={props.onAddWorkspace}
      />
      <McpPanel
        status={dashboard.mcp}
        selectedWorkspace={dashboard.selectedWorkspace}
        onStart={props.onStartMcp}
        onStop={props.onStopMcp}
        busy={props.mcpBusy}
      />
      <CapabilityPanel
        capabilities={dashboard.capabilities}
        onLaunchManagedBrowser={props.onLaunchManagedBrowser}
        browserBusy={props.browserBusy}
      />
      <section className="card-grid" aria-label="Gateway status">
        <article className="card">
          <p className="card-label">Git</p>
          <strong data-testid="git-summary">{dashboard.gitSummary.message}</strong>
          <p>{dashboard.gitSummary.branch === null ? 'Branch unavailable' : dashboard.gitSummary.branch}</p>
          <p>{dashboard.gitSummary.changedFiles} changed · {dashboard.gitSummary.stagedFiles} staged</p>
        </article>
        <article className="card">
          <p className="card-label">Codex CLI</p>
          <strong>{dashboard.codex.installed ? 'Available' : 'Not detected'}</strong>
          <p>{dashboard.codex.version ?? 'No version reported'}</p>
        </article>
      </section>
      <section className="card audit-card">
        <div className="section-heading">
          <h2>Recent audit events</h2>
          <span>{dashboard.auditEventCount}</span>
        </div>
        {dashboard.recentAuditEvents.length === 0 ? <p>No recent events.</p> : (
          <ul className="audit-list">
            {dashboard.recentAuditEvents.map((event) => (
              <li key={event.id}><span>{event.action}</span><span>{event.resultCode}</span></li>
            ))}
          </ul>
        )}
      </section>
      <PermissionPanel profile={dashboard.permissionProfile} onChange={props.onPermissionProfileChange} />
      <ProcessPanel
        workspaceId={dashboard.selectedWorkspace?.id ?? null}
        processes={props.processes}
        selectedProcess={props.selectedProcess}
        onStartFixtureProcess={props.onStartFixtureProcess}
        onStopProcess={props.onStopProcess}
      />
    </div>
  );
}
