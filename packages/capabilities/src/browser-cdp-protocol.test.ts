import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeBrowserCdpProtocol } from './browser-cdp-protocol.js';

describe('NodeBrowserCdpProtocol readiness', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('distinguishes a missing browser executable from a stopped browser', async (): Promise<void> => {
    const missing = new NodeBrowserCdpProtocol({
      platform: 'linux',
      chromeExecutable: '/opt/chromium',
      executableExists: (): boolean => false,
    });
    await expect(missing.status()).resolves.toMatchObject({
      ready: false,
      browserInstalled: false,
      readinessReason: 'browser_not_installed',
    });

    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response('', { status: 503 })));
    const stopped = new NodeBrowserCdpProtocol({
      platform: 'linux',
      chromeExecutable: '/opt/chromium',
      executableExists: (): boolean => true,
    });
    await expect(stopped.status()).resolves.toMatchObject({
      ready: false,
      browserInstalled: true,
      readinessReason: 'browser_not_running',
    });
  });

  it('reports a ready local CDP endpoint separately from installation state', async (): Promise<void> => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response('{}', { status: 200 })));
    const browser = new NodeBrowserCdpProtocol({
      platform: 'darwin',
      chromeExecutable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      executableExists: (): boolean => true,
      port: 9223,
    });
    await expect(browser.status()).resolves.toEqual({
      ready: true,
      port: 9223,
      browserInstalled: true,
      readinessReason: 'browser_ready',
    });
  });
});
