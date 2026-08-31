import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { COPY_COMMANDS, OFFICIAL_URL_TARGETS, RemediationRegistry, resolveToolSetupTargetAction } from '../src/main/tool-catalog/remediation-registry.js';
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

  it.skipIf(process.platform !== 'win32')('keeps Windows-shaped remediations explicit instead of sending users to unrelated app settings', () => {
    const registry = new RemediationRegistry();
    const sandbox = registry.resolve('th', ['configure_windows_sandbox'])[0]!;
    expect(sandbox.actions).toContainEqual({ kind: 'open_system_settings', target: 'windows_optional_features' });
    expect(sandbox.actions).not.toContainEqual({ kind: 'open_settings', target: 'tools' });
    expect(sandbox.steps.join(' ')).toContain('Windows Sandbox');
  });

  it('keeps runtime remediations explicit instead of sending users to unrelated app settings', () => {
    const registry = new RemediationRegistry();
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

describe.skipIf(process.platform !== 'darwin')('Windows-shaped remediations on macOS', () => {
  it('suppresses Windows Sandbox and WSL remediations from the offered set', () => {
    const registry = new RemediationRegistry();
    expect(registry.ids()).not.toContain('configure_windows_sandbox');
    expect(registry.ids()).not.toContain('configure_wsl');
    expect(registry.has('configure_windows_sandbox')).toBe(false);
    expect(registry.has('configure_wsl')).toBe(false);
    expect(registry.resolve('en')).not.toContainEqual(expect.objectContaining({ id: 'configure_windows_sandbox' }));
    expect(registry.resolve('en')).not.toContainEqual(expect.objectContaining({ id: 'configure_wsl' }));
    expect(() => registry.resolve('en', ['configure_wsl'])).toThrow(/Unknown remediation id/);
    expect(() => registry.resolve('en', ['configure_windows_sandbox'])).toThrow(/Unknown remediation id/);
  });

  it('never constructs the Windows Optional Features open target on this platform', () => {
    const blocked = resolveToolSetupTargetAction('windows_optional_features', 'darwin');
    expect(blocked).toMatchObject({ kind: 'blocked' });
    if (blocked.kind === 'blocked') expect(blocked.reason).toMatch(/Windows/);

    // Injected win32 platform proves the resolver still shapes the real
    // Windows target without depending on the host platform.
    const windows = resolveToolSetupTargetAction('windows_optional_features', 'win32', 'C:\\Windows');
    expect(windows).toEqual({ kind: 'windows_optional_features', executablePath: path.win32.join('C:\\Windows', 'System32', 'OptionalFeatures.exe') });

    expect(resolveToolSetupTargetAction('git_download', 'darwin')).toEqual({ kind: 'official_url', url: OFFICIAL_URL_TARGETS.git_download });
    expect(resolveToolSetupTargetAction('not-a-target', 'darwin')).toEqual({ kind: 'blocked', reason: 'Unknown tool setup target' });
  });
});
