import { describe, expect, it } from 'vitest';
import { BrowserCdpBackend, type BrowserCdpProtocol, type BrowserCdpTab } from './browser-cdp-backend.js';

const tab = (id: string, title: string, url: string): BrowserCdpTab => ({
  id,
  title,
  url,
  webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}`,
});

function protocolStub(options: {
  readonly tabs: readonly BrowserCdpTab[];
  readonly onRequest?: (tabId: string, method: string, params: Record<string, unknown>) => void;
  readonly onClose?: (tabId: string) => void;
}): BrowserCdpProtocol {
  return {
    async status(): Promise<{ readonly ready: boolean; readonly port: number }> { return { ready: true, port: 9222 }; },
    async listTabs(): Promise<readonly BrowserCdpTab[]> { return options.tabs; },
    async newTab(url): Promise<BrowserCdpTab> { return tab('new-tab', '', url); },
    async closeTab(tabId): Promise<unknown> { options.onClose?.(tabId); return { closed: true }; },
    async request(tabId, method, params): Promise<unknown> {
      options.onRequest?.(tabId, method, params);
      if (method === 'Page.captureScreenshot') return { result: { data: 'aGVsbG8=' } };
      return { result: { result: { value: method === 'Runtime.evaluate' ? { ok: true, text: 'hello', tag: 'DIV' } : { ok: true } } } };
    },
  };
}

function reorderingProtocolStub(options: {
  readonly first: readonly BrowserCdpTab[];
  readonly later: readonly BrowserCdpTab[];
  readonly onRequest: (tabId: string) => void;
}): BrowserCdpProtocol {
  let listCount = 0;
  const base = protocolStub({ tabs: options.first, onRequest: (tabId) => options.onRequest(tabId) });
  return {
    ...base,
    async listTabs(): Promise<readonly BrowserCdpTab[]> {
      listCount += 1;
      return listCount === 1 ? options.first : options.later;
    },
  };
}

function protectedActionInput(action: 'navigate' | 'close_tab' | 'evaluate' | 'click' | 'type'): Record<string, unknown> {
  const parameters = action === 'navigate'
    ? { url: 'https://example.com/' }
    : action === 'evaluate'
      ? { expression: 'document.title' }
      : action === 'click'
        ? { selector: '#continue' }
        : action === 'type'
          ? { selector: '#prompt', text: 'test' }
          : {};
  return { action, tab_id: 'chatgpt-tab', parameters, userConfirmed: true };
}

describe('BrowserCdpBackend', () => {
  it('runs a DOM query through the Chrome DevTools protocol', async () => {
    const requests: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      onRequest: (_tabId, method, params) => requests.push({ method, params }),
    });
    const backend = new BrowserCdpBackend({ protocol });

    const result = await backend.execute({ action: 'query', tab_id: 'tab-1', parameters: { selector: '#app' } });

    expect(result).toMatchObject({ ok: true, value: { ok: true, text: 'hello', tag: 'DIV' } });
    expect(requests[0]?.method).toBe('Runtime.evaluate');
    expect(requests[0]?.params.expression).toContain('document.querySelector');
  });

  it('does not navigate any tab when tab_id is absent', async () => {
    const requested: string[] = [];
    const protocol = protocolStub({
      tabs: [
        tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example'),
        tab('supabase-tab', 'Supabase', 'https://supabase.com/dashboard/project'),
      ],
      onRequest: (tabId) => requested.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'navigate',
      parameters: { url: 'https://supabase.com/dashboard/project/sql' },
      userConfirmed: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', message: expect.stringContaining('tab_id') },
    });
    expect(requested).toEqual([]);
  });

  it('keeps every step on the explicit tab when list ordering changes', async () => {
    const requested: string[] = [];
    const protocol = reorderingProtocolStub({
      first: [
        tab('supabase-tab', 'Supabase', 'https://supabase.com/dashboard'),
        tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example'),
      ],
      later: [
        tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example'),
        tab('supabase-tab', 'Supabase', 'https://supabase.com/dashboard'),
      ],
      onRequest: (tabId) => requested.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      tab_id: 'supabase-tab',
      steps: [
        { action: 'query', parameters: { selector: '#sql-editor' } },
        { action: 'click', parameters: { selector: '#run' } },
      ],
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true });
    expect(requested).toEqual(['supabase-tab', 'supabase-tab']);
  });

  it('does not dispatch later DOM side effects after the caller aborts', async () => {
    const actions: string[] = [];
    const controller = new AbortController();
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      onRequest: (_tabId, method) => {
        actions.push(method);
        controller.abort();
      },
    });
    const backend = new BrowserCdpBackend({ protocol });

    const result = await backend.execute({
      steps: [
        { action: 'query', parameters: { selector: '#one' } },
        { action: 'click', parameters: { selector: '#one' } },
      ],
      tab_id: 'tab-1',
    }, controller.signal);

    expect(result).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(actions).toEqual(['Runtime.evaluate']);
  });

  it.each(['navigate', 'close_tab', 'evaluate', 'click', 'type'] as const)(
    'blocks %s on a ChatGPT tab without an explicit protected-tab confirmation',
    async (action) => {
      const requests: string[] = [];
      const closes: string[] = [];
      const protocol = protocolStub({
        tabs: [tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example')],
        onRequest: (tabId) => requests.push(tabId),
        onClose: (tabId) => closes.push(tabId),
      });

      const result = await new BrowserCdpBackend({ protocol }).execute(protectedActionInput(action));

      expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      expect(requests).toEqual([]);
      expect(closes).toEqual([]);
    },
  );

  it('does not let Full Bypass imply protected-tab confirmation', async () => {
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example')],
      onRequest: (tabId) => requests.push(tabId),
    });
    const authorization = {
      mode: 'full_bypass',
      applicationApproved: true,
      bypassApplicationAuthorization: true,
      source: 'full_bypass',
    } as const;

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'navigate',
      tab_id: 'chatgpt-tab',
      parameters: { url: 'https://example.com/' },
    }, undefined, authorization);

    expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(requests).toEqual([]);
  });

  it('allows an explicitly confirmed protected-tab action', async () => {
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example')],
      onRequest: (tabId) => requests.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'navigate',
      tab_id: 'chatgpt-tab',
      allow_protected_tab_action: true,
      parameters: { url: 'https://example.com/' },
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true });
    expect(requests).toEqual(['chatgpt-tab']);
  });

  it('rejects an unknown explicit tab without dispatch', async () => {
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [tab('supabase-tab', 'Supabase', 'https://supabase.com/dashboard')],
      onRequest: (tabId) => requests.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'query',
      tab_id: 'missing-tab',
      parameters: { selector: 'body' },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(requests).toEqual([]);
  });

  it('rejects step-level tab switching', async () => {
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [
        tab('supabase-tab', 'Supabase', 'https://supabase.com/dashboard'),
        tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example'),
      ],
      onRequest: (tabId) => requests.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      tab_id: 'supabase-tab',
      steps: [
        { action: 'query', parameters: { selector: 'body' } },
        { action: 'click', parameters: { selector: '#run', tab_id: 'chatgpt-tab' } },
      ],
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(requests).toEqual([]);
  });

  it('normalizes a legacy direct parameters.tab_id once', async () => {
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Legacy', 'https://example.com/')],
      onRequest: (tabId) => requests.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'query',
      parameters: { selector: 'body', tab_id: 'tab-1' },
    });

    expect(result).toMatchObject({ ok: true });
    expect(requests).toEqual(['tab-1']);
  });

  it('rejects conflicting top-level and legacy direct tab IDs', async () => {
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'One', 'https://example.com/'), tab('tab-2', 'Two', 'https://example.org/')],
      onRequest: (tabId) => requests.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'query',
      tab_id: 'tab-1',
      parameters: { selector: 'body', tab_id: 'tab-2' },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(requests).toEqual([]);
  });

  it('does not dispatch a mutating DOM action without confirmation', async () => {
    let dispatched = false;
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      onRequest: () => { dispatched = true; },
    });

    await expect(new BrowserCdpBackend({ protocol }).execute({ action: 'click', tab_id: 'tab-1', parameters: { selector: '#delete' } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(dispatched).toBe(false);
  });

  it('accepts trusted Full Bypass authorization for a mutating non-protected DOM action', async () => {
    let dispatched = false;
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      onRequest: () => { dispatched = true; },
    });
    const authorization = { mode: 'full_bypass', applicationApproved: true, bypassApplicationAuthorization: true, source: 'full_bypass' } as const;

    await expect(new BrowserCdpBackend({ protocol }).execute(
      { action: 'click', tab_id: 'tab-1', parameters: { selector: '#delete' } },
      undefined,
      authorization,
    )).resolves.toMatchObject({ ok: true });
    expect(dispatched).toBe(true);
  });
});
