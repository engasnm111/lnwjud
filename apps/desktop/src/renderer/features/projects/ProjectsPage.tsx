import { useMemo, useState, type ReactElement } from 'react';
import type { UiLocale, WorkspaceSummary } from '@lnwjud/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';
import { settleWorkspaceAdd, type AddWorkspaceAction } from '../workspaces/workspace-add.js';

export { settleWorkspaceAdd } from '../workspaces/workspace-add.js';

interface ProjectsPageProps {
  readonly locale: UiLocale;
  readonly workspaces: readonly WorkspaceSummary[];
  readonly selectedWorkspaceId: string | null;
  readonly activeWorkspaceIds: readonly string[];
  readonly onSelectWorkspace: (workspaceId: string) => Promise<void>;
  readonly onSetWorkspaceActive: (workspaceId: string, active: boolean) => Promise<void>;
  readonly onAddWorkspace: AddWorkspaceAction;
  readonly onSetWorkspaceArchived: (workspaceId: string, archived: boolean) => Promise<void>;
  readonly onDeleteWorkspace: (workspaceId: string) => Promise<void>;
}

export function ProjectsPage(props: ProjectsPageProps): ReactElement {
  const t = createTranslator(props.locale);
  const [rootPath, setRootPath] = useState('');
  const [busyWorkspaceId, setBusyWorkspaceId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const groups = useMemo(() => groupWorkspaces(props.workspaces), [props.workspaces]);

  async function runWorkspaceAction(workspaceId: string, action: () => Promise<void>): Promise<void> {
    setBusyWorkspaceId(workspaceId);
    try {
      await action();
      setConfirmingDeleteId((current) => current === workspaceId ? null : current);
    } finally {
      setBusyWorkspaceId(null);
    }
  }

  async function addCurrentWorkspace(): Promise<void> {
    setRootPath(await settleWorkspaceAdd(rootPath, props.onAddWorkspace));
  }

  function renderProjectRow(workspace: WorkspaceSummary, archived: boolean): ReactElement {
    const selected = workspace.id === props.selectedWorkspaceId;
    const active = props.activeWorkspaceIds.includes(workspace.id);
    const lastActive = active && props.activeWorkspaceIds.length <= 1;
    const busy = workspace.id === busyWorkspaceId;
    const confirmingDelete = workspace.id === confirmingDeleteId;
    return (
      <li key={workspace.id} className={active ? 'active' : archived ? 'archived' : undefined}>
        <div className="project-row-main">
          <div className="project-row-title">
            <strong>{workspace.displayName}</strong>
            {active ? <span className="project-status-badge current">{t('project.active')}</span> : null}
            {selected ? <span className="project-status-badge system">PRIMARY</span> : null}

            {archived ? <span className="project-status-badge archived">{t('project.archivedBadge')}</span> : null}
          </div>
          <p>{workspace.realRootPath}</p>
          {confirmingDelete ? <p className="project-delete-hint">{t('project.deleteHint')}</p> : null}
        </div>
        <div className="project-actions">
          {archived ? (
            <button type="button" disabled={busy} onClick={() => { void runWorkspaceAction(workspace.id, () => props.onSetWorkspaceArchived(workspace.id, false)); }}>
              {t('project.restore')}
            </button>
          ) : (
            <>
              <button type="button" disabled={busy || lastActive} title={lastActive ? (props.locale === 'th' ? 'ต้องมี Active Project อย่างน้อย 1 โปรเจกต์' : 'At least one Active Project is required') : undefined} onClick={() => { void runWorkspaceAction(workspace.id, () => props.onSetWorkspaceActive(workspace.id, !active)); }}>
                {active ? (props.locale === 'th' ? 'ปิด Active' : 'Deactivate') : (props.locale === 'th' ? 'เปิด Active' : 'Activate')}
              </button>
              <button type="button" disabled={busy || selected} onClick={() => { void runWorkspaceAction(workspace.id, () => props.onSelectWorkspace(workspace.id)); }}>
                {selected ? 'PRIMARY' : t('project.setMain')}

              </button>
              <button type="button" className="project-archive-button" disabled={busy} onClick={() => { void runWorkspaceAction(workspace.id, () => props.onSetWorkspaceArchived(workspace.id, true)); }}>
                {t('project.archive')}
              </button>
            </>
          )}
          {confirmingDelete ? (
            <>
              <button type="button" className="project-delete-button confirm" disabled={busy} onClick={() => { void runWorkspaceAction(workspace.id, () => props.onDeleteWorkspace(workspace.id)); }}>
                {t('project.confirmDelete')}
              </button>
              <button type="button" className="project-cancel-button" disabled={busy} onClick={() => setConfirmingDeleteId(null)}>
                {t('project.cancel')}
              </button>
            </>
          ) : (
            <button type="button" className="project-delete-button" disabled={busy} onClick={() => setConfirmingDeleteId(workspace.id)}>
              {t('project.delete')}
            </button>
          )}
        </div>
      </li>
    );
  }

  return (
    <div className="page-content viewport-list-page projects-page">
      <h1>{t('nav.projects')}</h1>
      <section className="panel">
        <label className="field-label" htmlFor="workspace-root">{t('project.add')}</label>
        <div className="form-row">
          <input
            id="workspace-root"
            aria-label="Workspace root"
            value={rootPath}
            onChange={(event) => setRootPath(event.target.value)}
          />
          <button type="button" disabled={rootPath.trim().length === 0} onClick={() => { void addCurrentWorkspace(); }}>
            {t('project.add')}
          </button>
        </div>
        <p className="project-add-hint">{t('project.addHint')}</p>
      </section>
      <section className="panel project-list-panel">
        <div className="project-list-scroll">
          <ProjectSection title={props.locale === 'th' ? 'โปรเจกต์' : 'Projects'} count={groups.active.length} emptyText={props.locale === 'th' ? 'ยังไม่มีโปรเจกต์' : 'No projects yet'}>

            {groups.active.map((workspace) => renderProjectRow(workspace, false))}
          </ProjectSection>
          <ProjectSection title={t('project.archivedList')} count={groups.archived.length} emptyText={t('project.emptyArchived')}>
            {groups.archived.map((workspace) => renderProjectRow(workspace, true))}
          </ProjectSection>
          {groups.system.length === 0 ? null : (
            <ProjectSection title={t('project.systemList')} count={groups.system.length} emptyText="">
              {groups.system.map((workspace) => (
                <li key={workspace.id} className="system-workspace">
                  <div className="project-row-main">
                    <div className="project-row-title">
                      <strong>{workspace.displayName}</strong>
                      <span className="project-status-badge system">{t('project.systemBadge')}</span>
                    </div>
                    <p>{workspace.realRootPath}</p>
                    <p className="project-system-hint">{t('project.systemHint')}</p>
                  </div>
                </li>
              ))}
            </ProjectSection>
          )}
        </div>
      </section>
    </div>
  );
}

function ProjectSection(props: { readonly title: string; readonly count: number; readonly emptyText: string; readonly children: ReactElement | readonly ReactElement[] }): ReactElement {
  return (
    <section className="project-list-section">
      <div className="project-list-heading"><h2>{props.title}</h2><span>{props.count}</span></div>
      {props.count === 0 ? <p className="project-empty">{props.emptyText}</p> : <ul className="project-list">{props.children}</ul>}
    </section>
  );
}

function groupWorkspaces(workspaces: readonly WorkspaceSummary[]): {
  readonly active: readonly WorkspaceSummary[];
  readonly archived: readonly WorkspaceSummary[];
  readonly system: readonly WorkspaceSummary[];
} {
  const system = workspaces.filter((workspace) => workspace.kind === 'machine_root');
  const projects = workspaces.filter((workspace) => workspace.kind !== 'machine_root');
  return {
    active: projects.filter((workspace) => workspace.archivedAt === undefined || workspace.archivedAt === null),
    archived: projects.filter((workspace) => workspace.archivedAt !== undefined && workspace.archivedAt !== null),
    system,
  };
}
