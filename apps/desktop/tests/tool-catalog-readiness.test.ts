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
    remediationId: id === 'executable_git' ? 'install_git' : id === 'executable_ripgrep' ? 'install_ripgrep' : 'recheck_runtime',
    probe: probes[id]!,
  })), { ttlMs: 60_000 });
  const catalog = new ToolCatalogService(registry, new RemediationRegistry(), {
    profileDecision: (): 'ALLOW' | 'ASK' | 'DENY' | 'UNKNOWN' => options.profileDecision ?? 'ALLOW',
    codexEnabled: (): boolean => options.codexEnabled ?? false,
  });
  return { registry, catalog, probes };
}

describe('tool catalog readiness aggregation', () => {
  it('projects required fail, unknown, unsupported, permission deny, and feature disable truthfully', async () => {
    const failed = service({ executable_git: 'fail' });
    const snapshot = await failed.catalog.getSnapshot('en');
    expect(snapshot.items.find((item) => item.name === 'git')?.readiness).toBe('needs_setup');

    const unknown = service({ executable_git: 'unknown' });
    expect((await unknown.catalog.getSnapshot('en')).items.find((item) => item.name === 'git')?.readiness).toBe('unknown');

    const unsupported = service({ platform_windows: 'fail' });
    expect((await unsupported.catalog.getSnapshot('en')).items.find((item) => item.name === 'accessibility')?.readiness).toBe('unsupported');

    const blocked = service({}, { profileDecision: 'DENY' });
    const blockedItem = (await blocked.catalog.getSnapshot('en')).items.find((item) => item.name === 'read_file');
    expect(blockedItem?.readiness).toBe('blocked');
    expect(blockedItem?.remediationIds).toContain('configure_permissions');

    const disabled = service({}, { codexEnabled: false });
    const disabledCodex = (await disabled.catalog.getSnapshot('en')).items.find((item) => item.name === 'codex_run');
    expect(disabledCodex?.readiness).toBe('disabled');
    expect(disabledCodex?.remediationIds).toContain('configure_codex');

    const featureDisabled = service({}, { codexEnabled: true });
    const delegateStatus = (await featureDisabled.catalog.getSnapshot('en')).items.find((item) => item.name === 'delegate_status');
    expect(delegateStatus?.readiness).toBe('disabled');
    expect(delegateStatus?.remediationIds).toContain('feature_not_available');
    expect(delegateStatus?.requirements.find((requirement) => requirement.id === 'feature_delivery')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('subagent provider'),
    });
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

  it('required unknown makes Doctor exit 1 while optional warning does not', async () => {
    const requiredUnknown = service({ executable_git: 'unknown' });
    expect((await requiredUnknown.catalog.runDoctor(undefined, 'en')).exitCode).toBe(1);
    const optionalWarn = service({ codex_runtime: 'warn' });
    expect((await optionalWarn.catalog.runDoctor(undefined, 'en')).exitCode).toBe(0);
  });
});
