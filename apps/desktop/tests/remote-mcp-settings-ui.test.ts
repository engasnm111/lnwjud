import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const settingsSource = readFileSync(new URL('../src/renderer/features/settings/SettingsPage.tsx', import.meta.url), 'utf8');
const homeSource = readFileSync(new URL('../src/renderer/features/home/ControlCenterPage.tsx', import.meta.url), 'utf8');
const messagesSource = readFileSync(new URL('../src/renderer/i18n/messages.ts', import.meta.url), 'utf8');
const settingsCssSource = readFileSync(new URL('../src/renderer/settings-extra.css', import.meta.url), 'utf8');

describe('Remote MCP ngrok settings UI', () => {
  it('treats a verified executable as ready and disables redundant reinstall', () => {
    expect(settingsSource).toContain("const ngrokReady = remoteMcp.installed && remoteMcp.ngrokPath !== null;");
    expect(settingsSource).toContain("remoteMcp.state === 'running' || ngrokReady");
    expect(settingsSource).toContain("t('settingsPage.ngrokReady')");
    expect(settingsSource).toContain("t('settingsPage.ngrokReadyButton')");
    expect(settingsSource).toContain("t('settingsPage.ngrokVerifyHint')");
    expect(settingsSource).toContain('ngrok-readiness-banner');
    expect(settingsSource).toContain('ngrok-ready-path');
    expect(messagesSource).toContain('Without an explicit static domain, ngrok may provide a new URL on each start.');
    expect(settingsSource).toContain('id="remote-mcp-domain"');
    expect(settingsSource).toContain('setRemoteMcpPublicOrigin');
    expect(messagesSource).not.toContain('save the authtoken again to learn the new URL');
  });

  it('separates recommended OAuth from the optional Secure Tunnel method', () => {
    expect(settingsSource).toContain("t('settingsPage.chooseConnection')");
    expect(settingsSource).toContain('connection-method-stack is-recommended');
    expect(settingsSource).toContain('setSecureMethodOpen(false)');
    expect(messagesSource).toContain('Secure MCP Tunnel remains an advanced alternative, and both may run at the same time when needed.');
    expect(homeSource).toContain('setSecureTunnelExpanded(!remoteMcpOnline)');
    expect(homeSource).toContain("t('home.advancedOption')");
  });

  it('explains Secure Tunnel multi-chat and multi-host topology without recommending one profile per chat', () => {
    expect(settingsSource).toContain("t('settingsPage.tunnelIdentityHint')");
    expect(messagesSource).toContain('Multiple ChatGPT chats on this lnwjud machine can share one Tunnel ID.');
    expect(messagesSource).toContain('use a distinct Tunnel ID per machine');
  });

  it('adds direct setup links for both ChatGPT connection methods', () => {
    expect(settingsSource).toContain("props.onOpenExternalSetupPage('chatgpt_plugins')");
    expect(settingsSource).toContain("props.onOpenExternalSetupPage('openai_tunnels')");
    expect(settingsSource).toContain("props.onOpenExternalSetupPage('openai_api_keys')");
    expect(settingsSource).toContain("t('settingsPage.openChatgptPlugins')");
  });

  it('adds an explicit 10px follow-up gap because Chromium details content does not honor the parent grid gap between sections', () => {
    expect(settingsSource.match(/connection-method-followup-card/g)?.length).toBe(2);
    expect(settingsCssSource).toContain('.connection-method-followup-card {');
    expect(settingsCssSource).toContain('margin-top: 10px;');
    expect(settingsCssSource).toContain('margin-bottom: 10px;');
  });

  it('uses zero-click ChatGPT OAuth handoff and contains no legacy PIN or pairing UI', () => {
    expect(settingsSource).toContain("t('settingsPage.remoteFirstTimeHint')");
    expect(messagesSource).toContain('The browser hands off through a one-time 127.0.0.1 lnwjud Desktop approval and returns to ChatGPT automatically.');
    expect(settingsSource).toContain("runRemoteMcpAction('resetOauth')");
    expect(settingsSource).not.toMatch(/pairingCode|pairing_code|pairingRequired|remote-mcp-pairing/i);
    expect(homeSource).not.toMatch(/pairingCode|pairing_code|remote-mcp-pairing/i);
  });
});
