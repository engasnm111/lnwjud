import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const desktopRoot = path.join(repositoryRoot, 'apps', 'desktop');

describe('M8 native automation packaging isolation', () => {
  it('ships automation as compiled runtime code without packaging mutable user state', async () => {
    const config = await readFile(
      path.join(desktopRoot, 'electron-builder.yml'),
      'utf8',
    );
    const normalized = config.replaceAll('\\', '/').toLowerCase();

    expect(normalized).toContain('- dist/main/**/*');
    expect(normalized).toContain('- dist/preload/**/*');
    expect(normalized).toContain('- dist/renderer/**/*');
    expect(normalized).not.toMatch(/(?:^|\s)(?:from:\s*)?[^\r\n]*\.sqlite(?:\s|$)/m);
    expect(normalized).not.toMatch(/(?:^|\/)backups(?:\/|\s|$)/m);
    expect(normalized).not.toContain('upgrade-runtime.json');
    expect(normalized).not.toContain('automation-state');
    expect(normalized).not.toContain('automation_runs');
  });

  it('keeps automation persistence under runtime data roots instead of installation resources', async () => {
    const desktopServices = await readFile(
      path.join(desktopRoot, 'src', 'main', 'desktop-services.ts'),
      'utf8',
    );
    const desktopMain = await readFile(
      path.join(desktopRoot, 'src', 'main', 'main.ts'),
      'utf8',
    );
    const stdioRuntime = await readFile(
      path.join(repositoryRoot, 'apps', 'cli', 'src', 'runtime', 'stdio-mcp-runtime.ts'),
      'utf8',
    );

    expect(desktopServices).toContain("path.join(dataPath, 'lnwjud.sqlite')");
    expect(stdioRuntime).toContain("path.join(dataPath, 'lnwjud.sqlite')");
    expect(desktopMain).toContain("app.setPath('userData', dataPath)");
    expect(desktopMain).toContain("path.join(dataPath, 'backups')");
    expect(desktopServices).not.toMatch(/resourcesPath[^\n]*lnwjud\.sqlite/);
    expect(stdioRuntime).not.toMatch(/resourcesPath[^\n]*lnwjud\.sqlite/);
  });

  it('bundles the native automation engine and its additive migrations into Desktop main', async () => {
    const mainBundle = await readFile(
      path.join(desktopRoot, 'dist', 'main', 'main.js'),
      'utf8',
    );

    expect(mainBundle).toContain('automation_create');
    expect(mainBundle).toContain('automation_status');
    expect(mainBundle).toContain('019_native_automation_engine');
    expect(mainBundle).toContain('020_automation_task_supervisor');
    expect(mainBundle).toContain('coding_guarded');
    expect(mainBundle).not.toContain('C:\\AI-Workspace\\lnwjud');
  });
});
