import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('first-run recovery flow contract', () => {
  it('keeps partial bootstrap failures visible after Dashboard itself has loaded', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const appShell = source.indexOf('<AppShell');
    const partialError = source.indexOf('boot-partial-error');

    expect(source).toContain('Promise.allSettled');
    expect(appShell).toBeGreaterThan(0);
    expect(partialError).toBeGreaterThan(appShell);
  });

  it('does not rethrow a handled Add Project failure into a floating click promise', () => {
    const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const projects = readFileSync(new URL('../src/renderer/features/projects/ProjectsPage.tsx', import.meta.url), 'utf8');
    const home = readFileSync(new URL('../src/renderer/features/home/ControlCenterPage.tsx', import.meta.url), 'utf8');

    const addWorkspace = app.slice(app.indexOf('async function addWorkspace'), app.indexOf('async function selectWorkspace'));
    expect(addWorkspace).not.toContain('throw cause');
    expect(projects).not.toContain('onAddWorkspace(rootPath).then');
    expect(home).not.toContain('onAddWorkspace(projectPath).then');
  });
});
