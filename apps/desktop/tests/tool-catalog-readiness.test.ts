import { describe, expect, it, vi } from 'vitest';
import { RequirementRegistry } from '../src/main/tool-catalog/requirement-registry.js';
import { RemediationRegistry } from '../src/main/tool-catalog/remediation-registry.js';
import { ToolCatalogService } from '../src/main/tool-catalog/tool-catalog-service.js';

function service(statuses: Readonly<Record<string, 'pass' | 'warn' | 'fail' | 'unknown'>>, options: { profileDecision?: 'ALLOW' | 'ASK' | 'DENY' | 'UNKNOWN'; codexEnabled?: boolean } = {}): { registry: RequirementRegistry; catalog: ToolCatalogService; probes: Record<string, ReturnType<typeof vi.fn>> } {
  const ids = [
    'platform_windows', 'registered_workspace', 'active_project', 'executable_git', 'executable_ripgrep', 'codex_runtime', 'wsl_runtime',
    'local_mcp_listener', 'browser_cdp', 'windows_ui_automation', 'windows_input', 'windows_window', 'windows_ocr', 'office_desktop',
    'network_access', 'scheduler_runtime', 'tunnel_runtime', 'external_mcp_connection', 'local_pdf_provider', 'configured_lsp',
    'database_target', 'windows_sandbox', 'browser_event_stream', 'feature_delivery',
  ];
  const probes = Object.fromEntries(ids.map((id) => [id, vi.fn(async () => ({ status: statuses[id] ?? 'pass' as const }))]));
  const registry = new RequirementRegistry(ids.map((id) => ({
    id,
    required: id !== 'codex_runtime' && id !== 'external_mcp_connection' && id !== 'feature_delivery',
    summaryKey: `requirement.${id}`,
    ...(id === 'executable_git'
      ? { remediationId: 'install_git' }
      : id === 'executable_ripgrep'
        ? { remediationId: 'install_ripgrep' }
        : id === 'browser_cdp'
          ? { remediationId: 'configure_browser_cdp' }
          : id.startsWith('windows_')
            ? {}
            : { remediationId: 'recheck_runtime' }),
    probe: probes[id]!,
  })), { ttlMs: 60_000 });
  const catalog = new ToolCatalogService(registry, new RemediationRegistry(), {
    profileDecision: (): 'ALLOW' | 'ASK' | 'DENY' | 'UNKNOWN' => options.profileDecision ?? 'ALLOW',
    codexEnabled: (): boolean => options.codexEnabled ?? false,
  });
  return { registry, catalog, probes };
}

describe('tool catalog readiness aggregation', () => {
  it('separates setup, probe, permission, platform, delivery, and safety-policy reasons', async () => {
    const failed = service({ executable_git: 'fail' });
    const snapshot = await failed.catalog.getSnapshot('en');
    expect(snapshot.items.find((item) => item.name === 'git')).toMatchObject({
      readiness: 'needs_setup', readinessReason: 'setup_required', deliveryState: 'dependency_gated', available: false,
    });

    const unknown = service({ executable_git: 'unknown' });
    const unknownGit = (await unknown.catalog.getSnapshot('en')).items.find((item) => item.name === 'git');
    expect(unknownGit).toMatchObject({
      readiness: 'unknown', readinessReason: 'probe_failed', deliveryState: 'dependency_gated',
    });
    expect(unknownGit?.available).toBeUndefined();

    const unsupported = service({ platform_windows: 'fail' });
    expect((await unsupported.catalog.getSnapshot('en')).items.find((item) => item.name === 'accessibility')).toMatchObject({
      readiness: 'unsupported', readinessReason: 'unsupported_platform', deliveryState: 'unsupported', available: false,
    });

    const blocked = service({}, { profileDecision: 'DENY' });
    const blockedItem = (await blocked.catalog.getSnapshot('en')).items.find((item) => item.name === 'read_file');
    expect(blockedItem).toMatchObject({
      readiness: 'blocked', readinessReason: 'permission_denied', deliveryState: 'blocked_by_safety_policy', available: true,
    });
    expect(blockedItem?.remediationIds).toContain('configure_permissions');

    const blockedMissingRuntime = service({ executable_git: 'fail' }, { profileDecision: 'DENY' });
    expect((await blockedMissingRuntime.catalog.getSnapshot('en')).items.find((item) => item.name === 'git')).toMatchObject({
      readiness: 'blocked', readinessReason: 'permission_denied', deliveryState: 'blocked_by_safety_policy', available: false,
    });

    const disabled = service({}, { codexEnabled: false });
    const disabledCodex = (await disabled.catalog.getSnapshot('en')).items.find((item) => item.name === 'codex_run');
    expect(disabledCodex).toMatchObject({
      readiness: 'disabled', readinessReason: 'feature_disabled', deliveryState: 'feature_disabled', available: false,
    });
    expect(disabledCodex?.remediationIds).toContain('configure_codex');

    const enabledRuntime = service({}, { codexEnabled: true });
    const delegateStatus = (await enabledRuntime.catalog.getSnapshot('en')).items.find((item) => item.name === 'delegate_status');
    expect(delegateStatus).toMatchObject({
      readiness: 'ready', deliveryState: 'dependency_gated', available: true,
    });
    expect(delegateStatus?.remediationIds).not.toContain('feature_not_available');

    const disabledSwarm = (await disabled.catalog.getSnapshot('en')).items.find((item) => item.name === 'agent_swarm_run');
    expect(disabledSwarm).toMatchObject({
      readiness: 'disabled', readinessReason: 'feature_disabled', deliveryState: 'feature_disabled', available: false,
    });
    expect(disabledSwarm?.remediationIds).toContain('configure_codex');

    const readySwarm = (await enabledRuntime.catalog.getSnapshot('en')).items.find((item) => item.name === 'agent_swarm_run');
    expect(readySwarm).toMatchObject({ readiness: 'ready', deliveryState: 'dependency_gated', available: true });
  });

  it('treats a stopped managed browser as available runtime that must be started, not installed', async () => {
    const stopped = service({ browser_cdp: 'fail' }, { codexEnabled: true });
    const browser = (await stopped.catalog.getSnapshot('th')).items.find((item) => item.name === 'dom_cdp');

    expect(browser).toMatchObject({
      readiness: 'needs_setup', readinessReason: 'runtime_not_ready', deliveryState: 'operational', available: true,
      remediationIds: ['configure_browser_cdp'],
    });
  });

  it('lists each failed backing requirement for composite desktop automation tools', async () => {
    const composites = service({ windows_ui_automation: 'fail', windows_input: 'fail', windows_window: 'fail', windows_ocr: 'fail' }, { codexEnabled: true });
    const snapshot = await composites.catalog.getSnapshot('en');
    const requirements = (name: string): readonly string[] => snapshot.items.find((item) => item.name === name)?.requirements
      .filter((requirement) => requirement.status !== 'pass')
      .map((requirement) => requirement.id) ?? [];

    expect(requirements('accessibility')).toEqual(['windows_ui_automation']);
    expect(requirements('computer_use')).toEqual(['windows_ui_automation', 'windows_input', 'windows_window', 'windows_ocr']);
    expect(requirements('ui_target_action')).toEqual(['windows_ui_automation', 'windows_ocr']);

    const computerUse = snapshot.items.find((item) => item.name === 'computer_use');
    expect(computerUse?.remediationIds).toEqual([
      'repair_windows_ui_automation', 'repair_windows_input', 'repair_windows_window', 'repair_windows_ocr',
    ]);
    const remediationTitles = snapshot.remediations
      .filter((remediation) => computerUse?.remediationIds.includes(remediation.id))
      .map((remediation) => remediation.title);
    expect(remediationTitles).toEqual([
      'Repair Windows UI Automation bridge', 'Restore native input access', 'Restore native window access', 'Restore Windows vision/OCR',
    ]);
    expect(remediationTitles.join(' ')).not.toContain('Chrome');
  });

  it('never reports READY when an optional-for-startup dependency used by the tool is warning', async () => {
    const gitMissing = service({ executable_git: 'warn' });
    expect((await gitMissing.catalog.getSnapshot('en')).items.find((item) => item.name === 'git')?.readiness).toBe('needs_setup');

    const pdfMissing = service({ local_pdf_provider: 'warn' });
    expect((await pdfMissing.catalog.getSnapshot('en')).items.find((item) => item.name === 'inspect_pdf')?.readiness).toBe('needs_setup');

    const lspMissing = service({ configured_lsp: 'warn' });
    expect((await lspMissing.catalog.getSnapshot('en')).items.find((item) => item.name === 'lsp_diagnostics')?.readiness).toBe('needs_setup');
  });

  it('does not offer setup remediation for requirements that already pass', async () => {
    const ready = service({ executable_git: 'pass' });
    const git = (await ready.catalog.getSnapshot('en')).items.find((item) => item.name === 'git');
    expect(git?.readiness).toBe('ready');
    expect(git?.remediationIds).not.toContain('install_git');
  });

  it('shares cached/in-flight probes and locale changes do not reprobe', async () => {
    const { catalog, probes } = service({});
    await Promise.all([catalog.getSnapshot('en'), catalog.getSnapshot('en')]);
    const countAfterEnglish = Object.values(probes).reduce((sum, probe) => sum + probe.mock.calls.length, 0);
    await catalog.getSnapshot('th');
    const countAfterThai = Object.values(probes).reduce((sum, probe) => sum + probe.mock.calls.length, 0);
    expect(countAfterThai).toBe(countAfterEnglish);
  });

  it('rechecks selected requirements and updates Doctor and Catalog from one cache', async () => {
    const { catalog, probes } = service({ executable_git: 'pass' });
    const result = await catalog.recheck(['executable_git'], 'th');
    expect(probes.executable_git).toHaveBeenCalled();
    expect(result.doctor.checks).toHaveLength(24);
    expect(result.catalog.locale).toBe('th');
  });

  it('treats an absent optional external MCP connection as informational Doctor health', async () => {
    const absent = service({ external_mcp_connection: 'warn' });
    const check = (await absent.catalog.runDoctor(undefined, 'en')).checks.find((item) => item.id === 'external_mcp_connection');
    expect(check).toMatchObject({
      required: false,
      status: 'pass',
      summary: 'PASS: requirement.external_mcp_connection',
      message: 'PASS: requirement.external_mcp_connection',
    });
    expect(check?.remediationId).toBeUndefined();
  });

  it('required unknown makes Doctor exit 1 while optional warning does not', async () => {
    const requiredUnknown = service({ executable_git: 'unknown' });
    expect((await requiredUnknown.catalog.runDoctor(undefined, 'en')).exitCode).toBe(1);
    const optionalWarn = service({ codex_runtime: 'warn' });
    expect((await optionalWarn.catalog.runDoctor(undefined, 'en')).exitCode).toBe(0);
  });
});
