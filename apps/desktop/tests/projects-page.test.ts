import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkspaceSummary } from '@lnwjud/ipc-contracts';
import { ProjectsPage, settleWorkspaceAdd } from '../src/renderer/features/projects/ProjectsPage.js';

const noop = async (): Promise<void> => undefined;
const added = async (): Promise<boolean> => true;
const workspace = (id: string, overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  id,
  displayName: id,
  rootPath: `E:\\${id}`,
  realRootPath: `E:\\${id}`,
  createdAt: '2026-08-24T00:00:00.000Z',
  kind: 'project',
  archivedAt: null,
  ...overrides,
});

describe('Projects page lifecycle controls', () => {
  it('separates active, archived, and system workspaces with safe actions', () => {
    const markup = renderToStaticMarkup(createElement(ProjectsPage, {
      locale: 'en',
      workspaces: [
        workspace('active-project'),
        workspace('archived-project', { archivedAt: '2026-08-24T00:01:00.000Z' }),
        workspace('system-root', { rootPath: 'E:\\', realRootPath: 'E:\\', kind: 'machine_root' }),
      ],
      selectedWorkspaceId: 'active-project',
      activeWorkspaceIds: ['active-project'],
      onSelectWorkspace: noop,
      onSetWorkspaceActive: noop,
      onAddWorkspace: added,
      onSetWorkspaceArchived: async (): Promise<void> => undefined,
      onDeleteWorkspace: noop,
    }));

    expect(markup).toContain('>Projects</h2>');
    expect(markup).toContain('Archived projects');
    expect(markup).toContain('System workspaces');
    expect(markup).toContain('Archive</button>');
    expect(markup).toContain('Restore</button>');
    expect(markup).toContain('Remove</button>');
    expect(markup).toContain('managed automatically by lnwjud');
    expect(markup.match(/>Remove<\/button>/g)?.length).toBe(2);
    expect(markup).toContain('title="At least one Active Project is required"');
  });

  it('explains that registration removal never deletes project files', () => {
    const source = renderToStaticMarkup(createElement(ProjectsPage, {
      locale: 'th',
      workspaces: [workspace('project-a')],
      selectedWorkspaceId: null,
      activeWorkspaceIds: [],
      onSelectWorkspace: noop,
      onSetWorkspaceActive: noop,
      onAddWorkspace: added,
      onSetWorkspaceArchived: async (): Promise<void> => undefined,
      onDeleteWorkspace: noop,
    }));
    expect(source).toContain('ลบรายการ');
  });

  it('clears the path only after a successful Add Project and keeps failures handled', async () => {
    await expect(settleWorkspaceAdd('E:\\good', async () => true)).resolves.toBe('');
    await expect(settleWorkspaceAdd('E:\\rejected', async () => false)).resolves.toBe('E:\\rejected');
    await expect(settleWorkspaceAdd('E:\\failed', async () => { throw new Error('failed'); })).resolves.toBe('E:\\failed');
  });
});
