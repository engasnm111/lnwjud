import type { SettingsFocusTarget, SettingsSection } from '../settings/SettingsPage.js';

export type RemediationNavigation =
  | { readonly screen: 'projects' }
  | { readonly screen: 'settings'; readonly section: SettingsSection; readonly focus?: SettingsFocusTarget };

const SETTINGS_TARGETS: Readonly<Record<string, { readonly section: SettingsSection; readonly focus?: SettingsFocusTarget }>> = Object.freeze({
  general: { section: 'general' },
  security: { section: 'security' },
  security_profile: { section: 'security', focus: 'security-profile' },
  tools: { section: 'tools' },
  tools_codex: { section: 'tools', focus: 'tools-codex' },
  tools_local_providers: { section: 'tools', focus: 'tools-local-providers' },
  mcp: { section: 'mcp' },
  extensions: { section: 'mcp', focus: 'mcp-servers' },
  mcp_servers: { section: 'mcp', focus: 'mcp-servers' },
  tunnel: { section: 'tunnel' },
  backup: { section: 'backup' },
});

export function remediationNavigationForTarget(target: string): RemediationNavigation | null {
  if (target === 'projects') return { screen: 'projects' };
  const destination = SETTINGS_TARGETS[target];
  return destination === undefined ? null : { screen: 'settings', ...destination };
}
