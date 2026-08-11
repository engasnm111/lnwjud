import { describe, expect, it } from 'vitest';
import { BrowserCdpBackend, type BrowserCdpProtocol } from './browser-cdp-backend.js';

describe('BrowserCdpBackend', () => {
  it('runs a DOM query through the Chrome DevTools protocol', async () => {
    const requests: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
    const protocol: BrowserCdpProtocol = {
      async status() { return { ready: true, port: 9222 }; },
      async listTabs() { return [{ id: 'tab-1', title: 'Test', url: 'http://127.0.0.1/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-1' }]; },
      async newTab() { return { id: 'tab-2', title: '', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-2' }; },
      async closeTab() { return { closed: true }; },
      async request(_tabId, method, params) {
        requests.push({ method, params });
        return { result: { result: { value: { ok: true, text: 'hello', tag: 'DIV' } } } };
      },
    };
    const backend = new BrowserCdpBackend({ protocol });

    const result = await backend.execute({ action: 'query', tab_id: 'tab-1', parameters: { selector: '#app' } });

    expect(result).toMatchObject({ ok: true, value: { ok: true, text: 'hello', tag: 'DIV' } });
    expect(requests[0]?.method).toBe('Runtime.evaluate');
    expect(requests[0]?.params.expression).toContain('document.querySelector');
  });

  it('executes bounded DOM steps in order', async () => {
    const actions: string[] = [];
    const protocol: BrowserCdpProtocol = {
      async status() { return { ready: true, port: 9222 }; },
      async listTabs() { return [{ id: 'tab-1', title: 'Test', url: 'http://127.0.0.1/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-1' }]; },
      async newTab() { return { id: 'tab-2', title: '', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-2' }; },
      async closeTab() { return { closed: true }; },
      async request(_tabId, method) { actions.push(method); return { result: { result: { value: { ok: true } } } }; },
    };
    const backend = new BrowserCdpBackend({ protocol });

    const result = await backend.execute({
      steps: [
        { action: 'query', parameters: { selector: '#one' } },
        { action: 'click', parameters: { selector: '#one' } },
      ],
      tab_id: 'tab-1',
    });

    expect(result).toMatchObject({ ok: true, value: { steps: [{ ok: true }, { ok: true }] } });
    expect(actions).toEqual(['Runtime.evaluate', 'Runtime.evaluate']);
  });

  it('rejects a DOM action without a target tab', async () => {
    const protocol: BrowserCdpProtocol = {
      async status() { return { ready: false, port: 9222 }; },
      async listTabs() { return []; },
      async newTab() { return { id: 'tab-2', title: '', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-2' }; },
      async closeTab() { return { closed: true }; },
      async request() { return {}; },
    };
    const result = await new BrowserCdpBackend({ protocol }).execute({ action: 'click', parameters: { selector: '#app' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
