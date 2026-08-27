import { describe, expect, it } from 'vitest';
import { EXTERNAL_SETUP_URLS } from '@lnwjud/ipc-contracts';
import { parseOpenExternalSetupPageRequest, resolveExternalSetupUrl } from '../src/main/external-setup-links.js';

describe('external setup links', () => {
  it('resolves only the exact allowlisted HTTPS setup pages', () => {
    expect(resolveExternalSetupUrl('openai_tunnels')).toBe(
      'https://platform.openai.com/settings/organization/tunnels',
    );
    expect(resolveExternalSetupUrl('openai_api_keys')).toBe('https://platform.openai.com/api-keys');
    expect(resolveExternalSetupUrl('chatgpt_plugins')).toBe('https://chatgpt.com/plugins');
    expect(Object.values(EXTERNAL_SETUP_URLS).every((value) => new URL(value).protocol === 'https:')).toBe(true);
    expect(new URL(EXTERNAL_SETUP_URLS.openai_tunnels).hostname).toBe('platform.openai.com');
    expect(new URL(EXTERNAL_SETUP_URLS.openai_api_keys).hostname).toBe('platform.openai.com');
    expect(new URL(EXTERNAL_SETUP_URLS.chatgpt_plugins).hostname).toBe('chatgpt.com');
  });

  it('rejects arbitrary targets and payload shapes', () => {
    expect(() => resolveExternalSetupUrl('https://evil.example/' as never)).toThrow(/target/);
    expect(() => parseOpenExternalSetupPageRequest({ target: 'https://evil.example/' })).toThrow(
      'Invalid IPC payload: target',
    );
    expect(() => parseOpenExternalSetupPageRequest({ url: EXTERNAL_SETUP_URLS.openai_tunnels })).toThrow(
      'Invalid IPC payload: target',
    );
    expect(() => parseOpenExternalSetupPageRequest(null)).toThrow('Invalid IPC payload: target');
  });
});
