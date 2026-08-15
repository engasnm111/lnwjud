import { useState, type ReactElement } from 'react';
import type { UiLocale, WorkspaceSummary } from '@lnwjud/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';

interface ProjectsPageProps {
  readonly locale: UiLocale;
  readonly workspaces: readonly WorkspaceSummary[];
  readonly selectedWorkspaceId: string | null;
  readonly onSelectWorkspace: (workspaceId: string) => Promise<void>;
  readonly onAddWorkspace: (rootPath: string) => Promise<void>;
}

export function ProjectsPage(props: ProjectsPageProps): ReactElement {
  const t = createTranslator(props.locale);
  const [rootPath, setRootPath] = useState('');

  return (
    <div className="page-content">
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
          <button type="button" onClick={() => { void props.onAddWorkspace(rootPath).then(() => setRootPath('')); }}>
            {t('project.add')}
          </button>
        </div>
      </section>
      <section className="panel">
        <ul className="project-list">
          {props.workspaces.map((workspace) => (
            <li key={workspace.id} className={workspace.id === props.selectedWorkspaceId ? 'active' : undefined}>
              <div>
                <strong>{workspace.displayName}</strong>
                <p>{workspace.realRootPath}</p>
              </div>
              <button type="button" onClick={() => { void props.onSelectWorkspace(workspace.id); }}>
                {t('project.setMain')}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
