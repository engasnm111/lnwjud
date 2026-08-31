import { describe, expect, it, vi } from 'vitest';
import { WebFetchCapabilityBackend } from './web-fetch-backend.js';

function textResponse(body: string, status = 200, contentType = 'text/plain'): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': contentType },
  });
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

const PUBLIC_ADDRESS = '93.184.216.34';
const publicLookup = async (): Promise<readonly string[]> => [PUBLIC_ADDRESS];

function createBackend(fetchImpl: typeof fetch, addressLookup = publicLookup): WebFetchCapabilityBackend {
  return new WebFetchCapabilityBackend({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...(addressLookup === undefined ? {} : { addressLookup }),
  });
}

describe('WebFetchCapabilityBackend', () => {
  it('fetches a text URL and returns status and body', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => textResponse('hello world'));
    const backend = createBackend(fetchImpl);

    const result = await backend.execute({ url: 'https://example.com/docs', method: 'GET' });

    expect(result).toMatchObject({ ok: true, value: { status: 200, text: 'hello world', byte_length: 11, truncated: false } });
  });

  it('returns a dry-run preview without issuing the request', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => textResponse('should not be fetched'));
    const backend = createBackend(fetchImpl);

    const result = await backend.execute({
      url: 'https://example.com/item/1',
      method: 'DELETE',
      dry_run: true,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { dry_run: true, url: 'https://example.com/item/1', method: 'DELETE' },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PUT', 'DELETE'] as const)('requires confirmation before a %s request', async (method) => {
    const fetchImpl = vi.fn(async (): Promise<Response> => textResponse('mutated'));
    const backend = createBackend(fetchImpl);

    await expect(backend.execute({ url: 'https://example.com/item/1', method }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(backend.execute({ url: 'https://example.com/item/1', method, userConfirmed: true }))
      .resolves.toMatchObject({ ok: true, value: { status: 200, text: 'mutated' } });
  });

  it('rejects non-http protocols', async () => {
    const backend = createBackend(vi.fn());

    const result = await backend.execute({ url: 'file:///C:/Windows/system.ini' });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('rejects bodies on GET requests', async () => {
    const backend = createBackend(vi.fn());

    const result = await backend.execute({ url: 'https://example.com', method: 'GET', body: 'x' });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('returns base64 for binary content types', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetchImpl = vi.fn(async (): Promise<Response> => new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }));
    const backend = createBackend(fetchImpl);

    const result = await backend.execute({ url: 'https://example.com/a.png' });

    expect(result).toMatchObject({ ok: true, value: { status: 200, data_base64: 'iVBORw==', byte_length: 4 } });
  });

  it('truncates large responses at max_bytes', async () => {
    const big = 'a'.repeat(10_000);
    const fetchImpl = vi.fn(async (): Promise<Response> => textResponse(big));
    const backend = createBackend(fetchImpl);

    const result = await backend.execute({ url: 'https://example.com/big', max_bytes: 100 });

    expect(result).toMatchObject({ ok: true, value: { truncated: true, byte_length: 100 } });
  });

  it('reports a timeout as a recoverable error', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      const error = new Error('aborted');
      error.name = 'TimeoutError';
      throw error;
    });
    const backend = createBackend(fetchImpl);

    const result = await backend.execute({ url: 'https://example.com/slow', timeout_seconds: 1 });

    expect(result).toMatchObject({ ok: false, error: { recoverable: true } });
  });

  it('warns that a failed HTTP mutation may already have completed and never retries the request automatically', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      const error = new Error('timed out after dispatch');
      error.name = 'TimeoutError';
      throw error;
    });
    const backend = createBackend(fetchImpl);

    const result = await backend.execute({
      url: 'https://example.com/item/1',
      method: 'POST',
      body: '{"name":"updated"}',
      timeout_seconds: 1,
      userConfirmed: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        recoverable: true,
        message: expect.stringMatching(/outcome may be unknown.*do not retry automatically/i),
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('combines caller cancellation with the request timeout signal', async () => {
    let observedSignal: AbortSignal | null = null;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      observedSignal = init?.signal ?? null;
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (observedSignal?.aborted === true) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      return textResponse('late');
    });
    const backend = createBackend(fetchImpl);
    const controller = new AbortController();

    const pending = backend.execute({ url: 'https://example.com/cancelled', timeout_seconds: 10 }, controller.signal);
    controller.abort();

    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT', recoverable: true } });
    expect(observedSignal?.aborted).toBe(true);
  });

  it.each([
    'http://127.0.0.1:8080/admin',
    'http://localhost/health',
    'http://10.1.2.3/config',
    'http://192.168.1.1/router',
    'http://172.20.3.4/internal',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/metrics',
    'http://[fe80::1]/',
  ])('blocks SSRF destinations (%s) before dispatch', async (url) => {
    const fetchImpl = vi.fn(async (): Promise<Response> => textResponse('should not be fetched'));
    const backend = createBackend(fetchImpl, async (hostname: string) => (hostname === 'localhost' ? ['127.0.0.1'] : [PUBLIC_ADDRESS]));

    const result = await backend.execute({ url, method: 'GET', userConfirmed: true });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks a hostname that resolves to a private address', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => textResponse('should not be fetched'));
    const backend = createBackend(fetchImpl, async (): Promise<readonly string[]> => ['203.0.113.9', '10.0.0.5']);

    const result = await backend.execute({ url: 'https://internal.example.corp/keys', method: 'GET' });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('follows redirects to public destinations and re-validates every hop', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url === 'https://example.com/hop1') return redirectResponse('https://cdn.example.net/final');
      return textResponse('arrived');
    });
    const backend = createBackend(fetchImpl);

    const result = await backend.execute({ url: 'https://example.com/hop1', method: 'GET' });

    expect(result).toMatchObject({ ok: true, value: { status: 200, text: 'arrived' } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('blocks a redirect that points at a loopback address', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url === 'https://example.com/open-redirect') return redirectResponse('http://127.0.0.1:9100/admin');
      throw new Error('unexpected second hop');
    });
    const backend = createBackend(fetchImpl);

    const result = await backend.execute({ url: 'https://example.com/open-redirect', method: 'GET' });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('blocks a redirect whose target hostname resolves privately', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url === 'https://example.com/hop') return redirectResponse('https://intranet.example.internal/secret');
      throw new Error('unexpected second hop');
    });
    const backend = createBackend(fetchImpl, async (hostname: string) => (hostname.endsWith('.internal') ? ['192.168.0.10'] : [PUBLIC_ADDRESS]));

    const result = await backend.execute({ url: 'https://example.com/hop', method: 'GET' });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops after too many redirects', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      return redirectResponse(`https://example.com/loop${Number(url.pathname.replace('/loop', '')) + 1}`);
    });
    const backend = createBackend(fetchImpl);

    const result = await backend.execute({ url: 'https://example.com/loop0', method: 'GET' });

    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', recoverable: true } });
  });

  it('switches a confirmed POST to GET and drops the body across a 303 redirect', async () => {
    const calls: Array<{ url: string; method?: string; body?: BodyInit | null }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), method: init?.method, body: init?.body });
      if (String(input) === 'https://example.com/submit') return redirectResponse('https://cdn.example.net/done', 303);
      return textResponse('arrived');
    });
    const backend = createBackend(fetchImpl);

    const result = await backend.execute({ url: 'https://example.com/submit', method: 'POST', body: 'payload', userConfirmed: true });

    expect(result).toMatchObject({ ok: true, value: { status: 200, text: 'arrived' } });
    expect(calls).toEqual([
      { url: 'https://example.com/submit', method: 'POST', body: 'payload' },
      { url: 'https://cdn.example.net/done', method: 'GET', body: undefined },
    ]);
  });

  it('switches a POST to GET across a 302 redirect', async () => {
    const calls: Array<{ method?: string }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ method: init?.method });
      if (String(input) === 'https://example.com/legacy') return redirectResponse('https://cdn.example.net/final', 302);
      return textResponse('arrived');
    });
    const backend = createBackend(fetchImpl);

    const result = await backend.execute({ url: 'https://example.com/legacy', method: 'POST', body: 'x', userConfirmed: true });

    expect(result).toMatchObject({ ok: true, value: { status: 200 } });
    expect(calls.map((call) => call.method)).toEqual(['POST', 'GET']);
  });

  it('preserves the method and body across a 307 redirect', async () => {
    const calls: Array<{ method?: string; body?: BodyInit | null }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ method: init?.method, body: init?.body });
      if (String(input) === 'https://example.com/moved') return redirectResponse('https://cdn.example.net/moved', 307);
      return textResponse('arrived');
    });
    const backend = createBackend(fetchImpl);

    const result = await backend.execute({ url: 'https://example.com/moved', method: 'PUT', body: 'payload', userConfirmed: true });

    expect(result).toMatchObject({ ok: true, value: { status: 200 } });
    expect(calls).toEqual([
      { method: 'PUT', body: 'payload' },
      { method: 'PUT', body: 'payload' },
    ]);
  });

  it('strips authorization and cookie headers on a cross-origin redirect hop', async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), headers: init?.headers as Record<string, string> | undefined });
      if (String(input) === 'https://example.com/hop') return redirectResponse('https://cdn.example.net/final');
      return textResponse('arrived');
    });
    const backend = createBackend(fetchImpl);

    const result = await backend.execute({
      url: 'https://example.com/hop',
      method: 'GET',
      headers: [
        { name: 'Authorization', value: 'Bearer secret-token' },
        { name: 'Cookie', value: 'session=1' },
        { name: 'X-Custom', value: 'keep-me' },
      ],
    });

    expect(result).toMatchObject({ ok: true, value: { status: 200 } });
    expect(calls[0]?.headers).toMatchObject({ Authorization: 'Bearer secret-token', Cookie: 'session=1', 'X-Custom': 'keep-me' });
    expect(calls[1]?.headers).toEqual({ 'X-Custom': 'keep-me' });
  });

  it.each([
    'http://100.64.1.1/carrier-internal',
    'http://224.0.0.9/multicast',
    'http://240.0.0.1/reserved',
    'http://255.255.255.255/broadcast',
  ])('blocks additional non-public ranges (%s) before dispatch', async (url) => {
    const fetchImpl = vi.fn(async (): Promise<Response> => textResponse('should not be fetched'));
    const backend = createBackend(fetchImpl);

    const result = await backend.execute({ url, method: 'GET', userConfirmed: true });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
