import { describe, expect, it } from 'vitest';
import { remediationNavigationForTarget } from '../src/renderer/features/tools/remediation-navigation.js';

describe('Doctor/Tools remediation navigation', () => {
  it('opens each remediation target at the intended screen and settings section', () => {
    expect(remediationNavigationForTarget('projects')).toEqual({ screen: 'projects' });
    expect(remediationNavigationForTarget('tools')).toEqual({ screen: 'settings', section: 'tools' });
    expect(remediationNavigationForTarget('tools_codex')).toEqual({ screen: 'settings', section: 'tools', focus: 'tools-codex' });
    expect(remediationNavigationForTarget('tools_local_providers')).toEqual({ screen: 'settings', section: 'tools', focus: 'tools-local-providers' });
    expect(remediationNavigationForTarget('tunnel')).toEqual({ screen: 'settings', section: 'tunnel' });
    expect(remediationNavigationForTarget('extensions')).toEqual({ screen: 'settings', section: 'mcp', focus: 'mcp-servers' });
    expect(remediationNavigationForTarget('mcp_servers')).toEqual({ screen: 'settings', section: 'mcp', focus: 'mcp-servers' });
    expect(remediationNavigationForTarget('mcp')).toEqual({ screen: 'settings', section: 'mcp' });
    expect(remediationNavigationForTarget('security')).toEqual({ screen: 'settings', section: 'security' });
    expect(remediationNavigationForTarget('security_profile')).toEqual({ screen: 'settings', section: 'security', focus: 'security-profile' });
    expect(remediationNavigationForTarget('backup')).toEqual({ screen: 'settings', section: 'backup' });
    expect(remediationNavigationForTarget('general')).toEqual({ screen: 'settings', section: 'general' });
  });

  it('rejects unknown targets instead of silently opening General settings', () => {
    expect(remediationNavigationForTarget('unknown-section')).toBeNull();
  });
});
