import { useState, type FormEvent, type ReactElement } from 'react';
import type { WorkspaceSummary } from '@lnwjud/ipc-contracts';

interface WorkspacePanelProps {
  readonly selectedWorkspace: WorkspaceSummary | null;
  readonly workspaces: readonly WorkspaceSummary[];
  readonly onAddWorkspace: (rootPath: string) => Promise<void>;
}

export function WorkspacePanel({ selectedWorkspace, workspaces, onAddWorkspace }: WorkspacePanelProps): ReactElement {
  const [rootPath, setRootPath] = useState('');
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (rootPath.trim().length === 0) return;
    setPending(true);
    try {
      await onAddWorkspace(rootPath);
      setRootPath('');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card workspace-card">
      <div className="section-heading"><h2>Workspace</h2><span>{workspaces.length} registered</span></div>
      <form onSubmit={(event) => { void submit(event); }} className="workspace-form">
        <label htmlFor="workspace-root">Workspace root</label>
        <div className="form-row">
          <input id="workspace-root" aria-label="Workspace root" value={rootPath} onChange={(event) => setRootPath(event.currentTarget.value)} placeholder="C:\\Projects\\my-app" />
          <button type="submit" disabled={pending}>{pending ? 'Adding…' : 'Add workspace'}</button>
        </div>
      </form>
      {selectedWorkspace === null ? <p>No workspace selected.</p> : (
        <dl className="workspace-details">
          <div><dt>Name</dt><dd>{selectedWorkspace.displayName}</dd></div>
          <div><dt>Workspace ID</dt><dd data-testid="workspace-id">{selectedWorkspace.id}</dd></div>
          <div><dt>Configured path</dt><dd>{selectedWorkspace.rootPath}</dd></div>
          <div><dt>Canonical path</dt><dd data-testid="workspace-real-root">{selectedWorkspace.realRootPath}</dd></div>
        </dl>
      )}
    </section>
  );
}
