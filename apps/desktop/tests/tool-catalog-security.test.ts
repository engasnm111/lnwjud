import { describe, expect, it } from 'vitest';
import { OFFICIAL_URL_TARGETS, COPY_COMMANDS, RemediationRegistry } from '../src/main/tool-catalog/remediation-registry.js';
import { RequirementRegistry } from '../src/main/tool-catalog/requirement-registry.js';


describe('tool catalog security boundaries', () => {
  it('exposes only typed allowlisted remediation actions', () => {
    const registry = new RemediationRegistry();
    const resolved = registry.resolve('en');
    for (const remediation of resolved) {
      for (const action of remediation.actions) {
        expect(['open_settings', 'open_official_url', 'open_system_settings', 'copy_command', 'launch_managed_browser', 'install_pdf_provider', 'set_user_setting', 'recheck']).toContain(action.kind);
        if (action.kind === 'open_official_url') expect(action.target in OFFICIAL_URL_TARGETS).toBe(true);
        if (action.kind === 'open_system_settings') expect(action.target).toBe('windows_optional_features');
        if (action.kind === 'copy_command') expect(action.commandId in COPY_COMMANDS).toBe(true);
        if (action.kind === 'set_user_setting') expect(action).toMatchObject({ setting: 'codexToolsEnabled', value: true });
        if (action.kind === 'open_settings') expect(action.target).not.toMatch(/^https?:/i);
      }
    }
  });

  it('keeps system and runtime remediations explicit instead of sending users to unrelated app settings', () => {
    const registry = new RemediationRegistry();
    const sandbox = registry.resolve('th', ['configure_windows_sandbox'])[0]!;
    expect(sandbox.actions).toContainEqual({ kind: 'open_system_settings', target: 'windows_optional_features' });
    expect(sandbox.actions).not.toContainEqual({ kind: 'open_settings', target: 'tools' });
    expect(sandbox.steps.join(' ')).toContain('Windows Sandbox');

    const browser = registry.resolve('th', ['configure_browser_cdp'])[0]!;
    expect(browser.actions).toContainEqual({ kind: 'launch_managed_browser' });

    const pdf = registry.resolve('th', ['configure_pdf_provider'])[0]!;
    expect(pdf.actions).toContainEqual({ kind: 'install_pdf_provider' });
    expect(pdf.explanation).toContain('SHA-256');

    const codex = registry.resolve('th', ['configure_codex'])[0]!;
    expect(codex.actions).toContainEqual({ kind: 'set_user_setting', setting: 'codexToolsEnabled', value: true });
    expect(codex.actions).toContainEqual({ kind: 'open_settings', target: 'tools_codex' });
  });

  it('rejects unknown remediation ids instead of trusting renderer text', () => {
    expect(() => new RemediationRegistry().resolve('en', ['https://evil.example'])).toThrow(/Unknown remediation id/);
  });

  it('bounds probe detail and isolates thrown probes as unknown', async () => {
    const registry = new RequirementRegistry([{
      id: 'probe', required: true, summaryKey: 'probe', remediationId: 'recheck_runtime',
      probe: async (): Promise<never> => { throw new Error('x'.repeat(10_000)); },
    }]);
    const result = (await registry.probe()).get('probe');
    expect(result?.status).toBe('unknown');
    expect(result?.detail?.length).toBeLessThanOrEqual(2_048);
  });
});
