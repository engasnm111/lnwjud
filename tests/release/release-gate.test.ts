import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

describe('MVP release verification gate', () => {
  it('runs the required Windows verification stages in order and fails fast', async () => {
    const script = await readFile(path.join(repositoryRoot, 'scripts', 'verify-release.ps1'), 'utf8');
    const stages = [
      'install --frozen-lockfile',
      'lint',
      'typecheck',
      'test:release',
      'test:acceptance',
      'test:integration',
      'test:e2e',
      'build',
      'test:packaging',
      'test:release-gate',
      'package:windows',
    ];
    let previousIndex = -1;
    for (const stage of stages) {
      const index = script.indexOf(stage);
      expect(index, `missing release stage: ${stage}`).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
    expect(script).toContain('if ($LASTEXITCODE -ne 0)');
    expect(script).toContain("'latest.yml'");
    expect(script).toContain("'portable.yml'");
    expect(script).toContain('git diff --check');
    expect(script).toContain('lnwjud-Setup-$($rootPackage.version).exe');
    expect(script).toContain('lnwjud-Portable-$($rootPackage.version).exe');
  });

  it('documents the acceptance evidence and clean-machine limitations', async () => {
    const checklist = await readFile(path.join(repositoryRoot, '.github', 'RELEASE_CHECKLIST.md'), 'utf8');
    for (const evidence of [
      'traversal',
      'junction',
      'secret',
      'MCP local HTTP',
      'multi-workspace',
      'multi-session',
      'process ownership',
      'output limit',
      'fake Codex',
      'packaged-app smoke',
      'real Codex',
      'git diff --check',
    ]) {
      expect(checklist.toLowerCase()).toContain(evidence.toLowerCase());
    }
  });

  it('keeps public safety copy aligned with the exact mutation policy', async () => {
    const readme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
    const checklist = await readFile(path.join(repositoryRoot, '.github', 'RELEASE_CHECKLIST.md'), 'utf8');
    const publicCopy = `${readme}\n${checklist}`;

    expect(publicCopy).toContain('exact `delete_file`');
    expect(publicCopy).toMatch(/only.*auto-approv|auto-approv.*only/i);
    expect(publicCopy).toContain('Recovery Trash');
    expect(publicCopy).toContain('Active Project');
    expect(publicCopy).toMatch(/host.*approval|native.*approval/i);
    expect(publicCopy).toMatch(/standalone|headless/i);
    expect(publicCopy).not.toMatch(/Git delete\/discard commands.*can be enabled independently/i);
    expect(publicCopy).not.toMatch(/opt in independently to scoped `delete_file`, `git rm`, `git clean`/i);
  });

  it('installs the Electron runtime before clean-machine desktop execution', async () => {
    const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const desktopPackage = JSON.parse(
      await readFile(path.join(repositoryRoot, 'apps', 'desktop', 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(desktopPackage.scripts?.['electron:install']).toBe('node node_modules/electron/install.js');
    expect(desktopPackage.scripts?.['test:e2e']).toMatch(/^node node_modules\/electron\/install\.js && /);
    expect(rootPackage.scripts?.desktop).toContain('--filter @lnwjud/desktop electron:install');
  });

  it('provisions ripgrep on fresh Windows CI before both verification modes', async () => {
    const workflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(workflow).toContain('Install ripgrep for E2E search');
    expect(workflow).toContain('Get-Command rg');
    expect(workflow).toContain('choco install ripgrep -y --no-progress');
    expect(workflow.indexOf('Install ripgrep for E2E search')).toBeLessThan(workflow.indexOf('Run pull-request verification gate'));
    expect(workflow.indexOf('Install ripgrep for E2E search')).toBeLessThan(workflow.indexOf('Run authoritative release verification gate'));
  });

  it('keeps PR verification fast while reserving Windows packaging for exact-main CI', async () => {
    const script = await readFile(path.join(repositoryRoot, 'scripts', 'verify-release.ps1'), 'utf8');
    const workflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

    expect(script).toContain('[switch]$SkipWindowsPackaging');
    expect(script).toContain("if ($SkipWindowsPackaging)");
    expect(script).toContain("package:windows (skipped for non-main CI)");
    expect(workflow).toContain('name: Authoritative Release Verification (Windows)');
    expect(workflow).toContain('Run pull-request verification gate');
    expect(workflow).toContain('scripts/verify-release.ps1 -SkipWindowsPackaging');
    expect(workflow).toContain("github.ref != 'refs/heads/main'");
    expect(workflow).toContain('Run authoritative release verification gate');
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
  });

  it('documents one canonical exact-SHA release sequence', async () => {
    const releaseProcess = await readFile(path.join(repositoryRoot, 'docs', 'development', 'RELEASE_PROCESS.md'), 'utf8');
    const contributing = await readFile(path.join(repositoryRoot, 'CONTRIBUTING.md'), 'utf8');

    for (const required of [
      'dev -> PR -> main CI -> tag -> Release -> dev sync',
      'Never create or push the release tag before',
      'windows-release-<main merge SHA>',
      '-SkipWindowsPackaging',
      'exact `main` SHA',
      'Synchronize branches',
    ]) {
      expect(releaseProcess).toContain(required);
    }
    expect(contributing).toContain('docs/development/RELEASE_PROCESS.md');
  });

  it('uploads the verified Windows installer and portable executable once in CI and reuses that exact SHA artifact for releases', async () => {
    const ci = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const release = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8');

    expect(ci).toContain('actions/upload-artifact@v4');
    expect(ci).toContain('apps/desktop/dist/installers/latest.yml');
    expect(ci).toContain('apps/desktop/dist/installers/portable.yml');
    expect(ci).toContain('apps/desktop/dist/installers/*.blockmap');
    expect(ci).toContain('windows-release-${{ github.sha }}');
    expect(ci).toContain('apps/desktop/dist/installers/*.exe');
    expect(ci.indexOf('Run authoritative release verification gate')).toBeLessThan(ci.indexOf('Upload verified Windows release artifact'));

    expect(release).toContain('actions: read');
    expect(release).toContain('gh run list');
    expect(release).toContain('--workflow ci.yml');
    expect(release).toContain('--commit $sha');
    expect(release).toContain('gh run download');
    expect(release).toContain('windows-release-$sha');
    expect(release).toContain('successful CI run for exact commit');
    expect(release).toContain('lnwjud-Portable-$($package.version).exe');
    expect(release).not.toContain('verify-release.ps1');
    expect(release).toContain('apps/desktop/dist/installers/latest.yml');
    expect(release).toContain('apps/desktop/dist/installers/portable.yml');
    expect(release).not.toContain('Run authoritative verification gate');
    expect(release).not.toContain('package:windows');
    expect(release).not.toContain('Install ripgrep for E2E search');
  });

  it('rejects release tags that do not match the packaged application version', async () => {
    const workflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(workflow).toContain('github.ref_name');
    expect(workflow).toContain('package.json');
    expect(workflow).toMatch(/tag.*match|match.*tag/i);
  });

  it('keeps the parallel multi-workspace acceptance in the authoritative acceptance script', async () => {
    const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const acceptance = rootPackage.scripts?.['test:acceptance'] ?? '';
    expect(acceptance).toContain('tests/multi-workspace-concurrency-acceptance.test.ts');
    expect(rootPackage.scripts?.['test:integration']).toContain('--exclude=.local-artifacts/**');
    expect(rootPackage.scripts?.['test:release-gate']).toContain('--exclude=.local-artifacts/**');
  });

  it('keeps Secure Tunnel on the Desktop HTTP runtime instead of headless stdio', async () => {
    const controller = await readFile(path.join(repositoryRoot, 'apps', 'desktop', 'src', 'main', 'tunnel-controller.ts'), 'utf8');
    const services = await readFile(path.join(repositoryRoot, 'apps', 'desktop', 'src', 'main', 'desktop-services.ts'), 'utf8');
    const readme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');

    expect(controller).toContain("'--sample', 'sample_mcp_remote_no_auth'");
    expect(controller).toContain("'--mcp-server-url'");
    expect(controller).toContain('buildTunnelInitArgs(normalizedTunnelId, mcpServerUrl');
    expect(controller).toContain('repairDesktopTunnelProfile()');
    expect(controller).not.toContain("'--sample', 'sample_mcp_stdio_local'");
    expect(services).toContain('getMcpServerUrl: async ()');
    expect(services).toContain('await mcpLifecycle.start()');
    expect(readme).toContain('Desktop loopback HTTP MCP');
    expect(readme).toContain('sample_mcp_remote_no_auth');
  });
});
