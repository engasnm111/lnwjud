import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

describe('MVP release verification gate', () => {
  it('prepares verifiable Windows bridge metadata on a fresh release checkout without building packages', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-release-checkout-'));
    try {
      for (const file of [
        'apps/desktop/scripts/write-capability-integrity.mjs',
        'packages/capabilities/src/windows-capability-bridge.ps1',
      ]) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await copyFile(path.join(repositoryRoot, file), path.join(root, file));
      }
      const workflow = await readFile(path.join(repositoryRoot, '.github/workflows/release.yml'), 'utf8');
      const preparation = workflow.split('- name: Verify each downloaded release evidence bundle')[0] ?? '';
      // This isolated checkout exercises only the bridge generator; policy checks
      // run against a complete, exact-version release checkout in their own gate.
      expect(preparation).toContain('run: node apps/desktop/scripts/write-capability-integrity.mjs');
      await promisify(execFile)(process.execPath, [path.join(root, 'apps/desktop/scripts/write-capability-integrity.mjs')], { cwd: root, windowsHide: true });
      const { verifyCapabilityBridgeArtifacts } = await import('../../apps/desktop/scripts/verify-capability-bridge-artifacts.mjs');
      const identity = await verifyCapabilityBridgeArtifacts({
        sourcePath: path.join(root, 'packages/capabilities/src/windows-capability-bridge.ps1'),
        stageDirectory: path.join(root, 'apps/desktop/build/capability-bridge'),
        generatedOutput: path.join(root, 'packages/capabilities/src/windows-capability-integrity.generated.ts'),
      });
      expect(identity.fileName).toBe('windows-capability-bridge.ps1');
      expect(identity.sizeBytes).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

    expect(workflow).toContain('uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4');
    expect(workflow).toContain('version: 10.15.0');
    expect(workflow).not.toContain('corepack prepare pnpm@10.15.0 --activate');
    expect(script).toContain('[switch]$SkipWindowsPackaging');
    expect(script).toContain("if ($SkipWindowsPackaging)");
    expect(script).toContain("package:windows (skipped for non-main CI)");
    expect(script).toContain('[switch]$SkipWorkspaceTests');
    expect(script).toContain("if ($SkipWorkspaceTests)");
    expect(script).toContain("Invoke-ReleaseStage 'test:release' @('test:release')");
    expect(workflow).toContain('name: Authoritative Release Verification (Windows)');
    expect(workflow).toContain('Run pull-request verification gate');
    expect(workflow).toContain('scripts/verify-release.ps1 -SkipWindowsPackaging -SkipWorkspaceTests');
    expect(workflow).toContain("github.ref != 'refs/heads/main'");
    expect(workflow).toContain('Run authoritative release verification gate');
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main'");
  });

  it('requires both parallel Windows jobs before the protected release check succeeds', async () => {
    const workflow = (await readFile(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8')).replaceAll('\r\n', '\n');
    const testJob = workflow.slice(workflow.indexOf('  windows-release-tests:\n'), workflow.indexOf('  windows-release-build:\n'));
    const buildJob = workflow.slice(workflow.indexOf('  windows-release-build:\n'), workflow.indexOf('  verify:\n'));
    const requiredJob = workflow.slice(workflow.indexOf('  verify:\n'));

    expect(testJob).toContain('run: pnpm test:release');
    expect(testJob.indexOf('Build workspace type declarations')).toBeGreaterThan(testJob.indexOf('Install dependencies'));
    expect(testJob).toContain('run: pnpm typecheck');
    expect(testJob.indexOf('Build workspace type declarations')).toBeLessThan(testJob.indexOf('Run complete Windows workspace release suite'));
    expect(testJob).toContain("if: github.event_name == 'pull_request' || github.ref == 'refs/heads/main' || github.event_name == 'workflow_dispatch'");
    expect(buildJob).toContain('scripts/verify-release.ps1 -SkipWorkspaceTests');
    expect(buildJob).toContain("if: github.event_name == 'pull_request' || github.ref == 'refs/heads/main' || github.event_name == 'workflow_dispatch'");
    expect(buildJob).toContain('windows-release-${{ github.sha }}');
    expect(requiredJob).toContain('name: Authoritative Release Verification (Windows)');
    expect(requiredJob).toContain('needs: [windows-release-tests, windows-release-build]');
    expect(requiredJob).toContain('WORKSPACE_TESTS_RESULT: ${{ needs.windows-release-tests.result }}');
    expect(requiredJob).toContain('BUILD_RESULT: ${{ needs.windows-release-build.result }}');
    expect(requiredJob).toContain('test "$WORKSPACE_TESTS_RESULT" = success');
    expect(requiredJob).toContain('test "$BUILD_RESULT" = success');
  });

  it('does not repeat the full Windows verification gate on direct non-main pushes', async () => {
    const workflow = (await readFile(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8')).replaceAll('\r\n', '\n');
    const verifyStart = workflow.indexOf('  verify:\n');
    expect(verifyStart).toBeGreaterThan(-1);
    const verifyJob = workflow.slice(verifyStart, workflow.indexOf('\n\n', verifyStart));
    expect(verifyJob).toContain("if: always() && (github.event_name == 'pull_request' || github.ref == 'refs/heads/main' || github.event_name == 'workflow_dispatch')");
  });

  it('splits desktop tests into isolated native shards for the contract matrix', async () => {
    const workflow = (await readFile(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8')).replaceAll('\r\n', '\n');
    expect(workflow).toContain('desktop-test-shards:');
    expect(workflow).toContain('max-parallel: 6');
    expect(workflow).toContain('--shard=${{ matrix.shard_index }}/${{ matrix.shard_total }}');
    expect(workflow).toContain("--filter '!@lnwjud/desktop' --if-present test");
    expect(workflow).toContain("--filter '@lnwjud/cli...' build");
  });

  it('installs the pinned Sigstore verifier before authoritative Windows packaging', async () => {
    const workflow = (await readFile(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8')).replaceAll('\r\n', '\n');
    const authoritativeStart = workflow.indexOf('  windows-release-build:');
    expect(authoritativeStart).toBeGreaterThan(-1);
    const authoritativeJob = workflow.slice(authoritativeStart, workflow.indexOf('  verify:', authoritativeStart));
    const cosign = authoritativeJob.indexOf('Install cosign for tunnel provenance verification');
    const authoritative = authoritativeJob.indexOf('Run authoritative release verification gate');
    expect(cosign).toBeGreaterThan(-1);
    expect(authoritativeJob).toContain("cosign-release: 'v3.1.3'");
    expect(authoritativeJob).toContain('continue-on-error: true');
    expect(authoritativeJob).toContain('Install checksum-pinned cosign fallback');
    expect(authoritativeJob).toContain('9fe59be0eca1271873ce019061335eb1ac419b7059202e797828467ddabe33be');
    expect(authoritativeJob).toContain('Verify cosign release verifier');
    expect(cosign).toBeLessThan(authoritative);
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
    for (const heading of ['## Features', '## Bug Fixes', '## Other Changes', '**Full Changelog**']) {
      expect(releaseProcess).toContain(heading);
    }
    expect(releaseProcess).toContain('scripts/release-notes.mjs');
  });

  it('uploads every verified target-native package once in CI and reuses exact SHA artifacts for releases', async () => {
    const ci = (await readFile(path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8')).replaceAll('\r\n', '\n');
    const release = (await readFile(path.join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8')).replaceAll('\r\n', '\n');
    const releaseNotes = await readFile(path.join(repositoryRoot, 'scripts', 'release-notes.mjs'), 'utf8');

    expect(ci).toContain('actions/upload-artifact@v7');
    expect(ci).toContain('apps/desktop/dist/installers/latest.yml');
    expect(ci).toContain('windows-release-${{ github.sha }}');
    expect(ci).toContain('apps/desktop/dist/installers/*.exe');
    expect(ci.indexOf('Run authoritative release verification gate')).toBeLessThan(ci.indexOf('Upload verified Windows release artifact'));
    expect(ci).toContain('name: native-${{ matrix.platform }}-${{ matrix.arch }}-${{ github.sha }}');
    for (const target of ['platform: darwin', 'arch: arm64', 'arch: x64', 'platform: linux']) expect(ci).toContain(target);

    expect(release).toContain('actions: read');
    expect(release).toContain('timeout-minutes: 120');
    expect(release).toContain('gh run list');
    expect(release).toContain('--workflow ci.yml');
    expect(release).toContain('--commit "$sha"');
    expect((release.match(/--branch main/g) ?? []).length).toBe(1);
    expect(release).toContain('candidate="$(find_ci_run push)"');
    expect(release).toContain('candidate="$(find_ci_run workflow_dispatch)"');
    expect(release).toContain('gh run download');
    expect(release).toContain('windows-release-$sha');
    expect(release).not.toContain('native-darwin-arm64-$sha');
    expect(release).not.toContain('native-darwin-x64-$sha');
    expect(release).toContain('native-linux-x64-$sha');
    expect(release).toContain('native-linux-arm64-$sha');
    expect(release).toContain('ci_wait_deadline=$((SECONDS + 3600))');
    expect(release).toContain('while [[ -z "$run_id" ]]');
    expect(release).toContain('Waiting for main CI to appear for exact commit');
    expect(release).toContain('Exact-commit CI run $candidate_id completed with conclusion');
    expect(release).toContain('sleep 20');
    expect(release).toContain('LNWJUD_RELEASE_INSTALLER_DIRECTORY');
    expect(release).toContain('node scripts/collect-release-assets.mjs');
    expect(release).toContain('release-assets/*');
    expect(releaseNotes).toContain('`RELEASE_MANIFEST.json`');
    expect(release).toContain('Generate and validate user-facing release notes');
    expect(release).toContain('node scripts/release-notes.mjs');
    expect(release).toContain('generate_release_notes: false');
    expect(release).toContain('body_path: release-notes.md');
    expect(release).not.toContain('generate_release_notes: true');
    expect(release).toContain("LNWJUD_RELEASE_ARTIFACT_ONLY: '1'");
    expect(release.indexOf('Download verified target-native CI artifacts')).toBeLessThan(release.indexOf('Verify each downloaded release evidence bundle'));
    expect(release.indexOf('Generate and validate user-facing release notes')).toBeLessThan(release.indexOf('Download verified target-native CI artifacts'));
    expect(release.indexOf('Verify each downloaded release evidence bundle')).toBeLessThan(release.indexOf('Aggregate target-native artifacts and update feeds'));
    expect(release).not.toContain('verify-release.ps1');
    expect(release).not.toContain('package:windows');
    expect(release).not.toContain('Install ripgrep for E2E search');
  });

  it('keeps release asset aggregation target-aware and architecture-aware', async () => {
    const collector = await readFile(path.join(repositoryRoot, 'scripts', 'collect-release-assets.mjs'), 'utf8');
    const verifier = await readFile(path.join(repositoryRoot, 'apps', 'desktop', 'scripts', 'verify-release-evidence.mjs'), 'utf8');
    expect(collector).toContain('LNWJUD_RELEASE_STAGING_DIRECTORY');
    expect(collector).toContain('LNWJUD_RELEASE_ASSETS_DIRECTORY');
    expect(collector).toContain('win32-x64');
    expect(collector).toContain('darwin-arm64');
    expect(collector).toContain('darwin-x64');
    expect(collector).toContain('linux-x64');
    expect(collector).toContain('linux-arm64');
    expect(collector).toContain('latest-linux-${arch}.yml');
    expect(collector).toContain('latest-mac.yml');
    expect(collector).toContain('RELEASE_MANIFEST.json');
    expect(collector).toContain('sourceProvenanceSha256');
    expect(verifier).toContain('LNWJUD_RELEASE_INSTALLER_DIRECTORY');
    expect(verifier).toContain('latest-linux-${normalizeArtifactArch(arch)}.yml');
  });

  it('binds observed macOS signing policy to normal and artifact-only provenance verification', async () => {
    const writer = await readFile(path.join(repositoryRoot, 'apps', 'desktop', 'scripts', 'write-release-evidence.mjs'), 'utf8');
    const verifier = await readFile(path.join(repositoryRoot, 'apps', 'desktop', 'scripts', 'verify-release-evidence.mjs'), 'utf8');
    const capture = await readFile(path.join(repositoryRoot, 'apps', 'desktop', 'scripts', 'capture-packaged-runtime-evidence.mjs'), 'utf8');
    const signer = await readFile(path.join(repositoryRoot, 'apps', 'desktop', 'scripts', 'sign-macos-runtime.mjs'), 'utf8');

    for (const source of [writer, verifier, capture]) expect(source).toContain('validateMacosSigningPolicyEvidence');
    expect(writer).toContain('rootExecutableSha256');
    expect(verifier).toContain('rootExecutableSha256');
    expect(capture).toContain('readMacosSigningPolicyEvidence');
    expect(signer).toContain('invalidateMacosSigningPolicyEvidence');
    expect(signer.indexOf('inspectSigningPolicy(app')).toBeGreaterThan(signer.indexOf("run(['--verify', '--deep', '--strict', app])"));
  });

  it('pins the macOS signer binary detector to the protobuf-safe release', async () => {
    const workspace = await readFile(path.join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8');
    expect(workspace).toContain('"@electron/osx-sign>isbinaryfile": 5.0.7');
  });

  it('rejects release tags that do not match the packaged application version', async () => {
    const workflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(workflow).toMatch(/GITHUB_REF_NAME|github\.ref_name/);
    expect(workflow).toContain('package.json');
    expect(workflow).toMatch(/tag.*match|match.*tag/i);
  });

  it('keeps the parallel multi-workspace acceptance in the authoritative acceptance script', async () => {
    const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const acceptance = rootPackage.scripts?.['test:acceptance'] ?? '';
    expect(acceptance).toContain('tests/multi-workspace-concurrency-acceptance.test.ts');
    for (const scriptName of ['test:integration', 'test:packaging', 'test:release-gate']) {
      const script = rootPackage.scripts?.[scriptName] ?? '';
      expect(script).toContain('--exclude=.local-artifacts/**');
      expect(script).toContain('--exclude=.worktrees/**');
      expect(script).toContain('--exclude=.superpowers/**');
    }

    const platformVerifier = await readFile(path.join(repositoryRoot, 'scripts', 'verify-platform-release.mjs'), 'utf8');
    expect(platformVerifier).toContain("'--exclude=.worktrees/**'");
    expect(platformVerifier).toContain("'--exclude=.superpowers/**'");
  });

  it('keeps Secure Tunnel on the Desktop HTTP runtime instead of headless stdio', async () => {
    const controller = await readFile(path.join(repositoryRoot, 'apps', 'desktop', 'src', 'main', 'tunnel-controller.ts'), 'utf8');
    const services = await readFile(path.join(repositoryRoot, 'apps', 'desktop', 'src', 'main', 'desktop-services.ts'), 'utf8');
    const readme = await readFile(path.join(repositoryRoot, 'FULL_README.md'), 'utf8');

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
