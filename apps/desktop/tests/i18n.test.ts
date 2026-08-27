import { describe, expect, it } from 'vitest';
import { en, th, type MessageKey } from '../src/renderer/i18n/messages.js';
import { createTranslator } from '../src/renderer/i18n/index.js';

describe('i18n translations', () => {
  it('has identical keys in both Thai and English message maps', () => {
    const thKeys = Object.keys(th).sort();
    const enKeys = Object.keys(en).sort();
    expect(thKeys).toEqual(enKeys);
  });

  it('translates all required error, loading, and permission keys', () => {
    const tTh = createTranslator('th');
    const tEn = createTranslator('en');

    const requiredKeys: MessageKey[] = [
      'app.loading',
      'settings.subtitle',
      'settings.generalTitle',
      'settings.securityTitle',
      'settings.tunnelTitle',
      'error.logBufferClear',
      'error.logExport',
      'error.logViewerOpen',
      'error.desktopService',
      'error.workspaceAdd',
      'error.workspaceSelect',
      'error.permissionProfileChange',
      'error.unrestrictedModeChange',
      'error.mcpStop',
      'error.mcpRestart',
      'error.workLogClear',
      'error.tunnelStart',
      'error.tunnelStop',
      'error.doctorRun',
      'git.changed',
      'git.staged',
      'doctor.noReport',
      'permission.safe',
      'permission.balanced',
      'permission.full',
      'permission.custom',
      'settings.saved',
    ];

    for (const key of requiredKeys) {
      expect(tTh(key)).toBeTruthy();
      expect(tEn(key)).toBeTruthy();
      expect(tTh(key)).not.toBe(tEn(key));
    }
  });

  it('provides complete bilingual copy for guided tunnel onboarding', () => {
    const tTh = createTranslator('th');
    const tEn = createTranslator('en');
    const guidedKeys: MessageKey[] = [
      'guidedTunnel.tipTitle',
      'guidedTunnel.tipBody',
      'guidedTunnel.privacy',
      'guidedTunnel.startSetup',
      'guidedTunnel.later',
      'guidedTunnel.openGuide',
      'guidedTunnel.progress',
      'guidedTunnel.stepTunnelTitle',
      'guidedTunnel.stepTunnelBody',
      'guidedTunnel.openTunnelSettings',
      'guidedTunnel.tunnelIdLabel',
      'guidedTunnel.tunnelIdHint',
      'guidedTunnel.tunnelIdInvalid',
      'guidedTunnel.next',
      'guidedTunnel.back',
      'guidedTunnel.stepKeyTitle',
      'guidedTunnel.stepKeyBody',
      'guidedTunnel.openApiKeys',
      'guidedTunnel.apiKeyLabel',
      'guidedTunnel.apiKeyHint',
      'guidedTunnel.apiKeyRequired',
      'guidedTunnel.saveKey',
      'guidedTunnel.keyStored',
      'guidedTunnel.stepConfigureTitle',
      'guidedTunnel.stepConfigureBody',
      'guidedTunnel.configure',
      'guidedTunnel.configuring',
      'guidedTunnel.configured',
      'guidedTunnel.stepStartTitle',
      'guidedTunnel.stepStartBody',
      'guidedTunnel.startTunnel',
      'guidedTunnel.starting',
      'guidedTunnel.running',
      'guidedTunnel.stepChatGptTitle',
      'guidedTunnel.stepChatGptBody',
      'guidedTunnel.openChatGptPlugins',
      'guidedTunnel.localComplete',
      'guidedTunnel.done',
      'guidedTunnel.dismissedHint',
      'guidedTunnel.linkError',
      'guidedTunnel.copyLink',
      'guidedTunnel.retry',
      'guidedTunnel.externalRuntime',
      'guidedTunnel.showApiKey',
      'guidedTunnel.hideApiKey',
      'guidedTunnel.advanced',
    ];
    const intentionallyIdentical = new Set<MessageKey>([
      'guidedTunnel.tunnelIdLabel',
      'guidedTunnel.apiKeyLabel',
      'guidedTunnel.startTunnel',
    ]);

    for (const key of guidedKeys) {
      expect(tTh(key).trim()).not.toBe('');
      expect(tEn(key).trim()).not.toBe('');
      if (!intentionallyIdentical.has(key)) expect(tTh(key)).not.toBe(tEn(key));
    }
  });
});
