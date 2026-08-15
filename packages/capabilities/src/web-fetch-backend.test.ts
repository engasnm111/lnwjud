import { describe, expect, it, vi } from 'vitest';
import { WebFetchCapabilityBackend } from './web-fetch-backend.js';

function textResponse(body: string, status = 200, contentType = 'text/plain'): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': contentType },
  });
}

describe('WebFetchCapabilityBackend', () => {
  it('fetches a text URL and returns status and body', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => textResponse('hello world'));
    const backend = new WebFetchCapabilityBackend({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await backend.execute({ url: 'https://example.com/docs', method: 'GET' });

    expect(result).toMatchObject({ ok: true, value: { status: 200, text: 'hello world', byte_length: 11, truncated: false } });
  });

  it('rejects non-http protocols', async () => {
    const backend = new WebFetchCapabilityBackend({});

    const result = await backend.execute({ url: 'file:///C:/Windows/system.ini' });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('rejects bodies on GET requests', async () => {
    const backend = new WebFetchCapabilityBackend({});

    const result = await backend.execute({ url: 'https://example.com', method: 'GET', body: 'x' });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('returns base64 for binary content types', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetchImpl = vi.fn(async (): Promise<Response> => new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }));
    const backend = new WebFetchCapabilityBackend({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await backend.execute({ url: 'https://example.com/a.png' });

    expect(result).toMatchObject({ ok: true, value: { status: 200, data_base64: 'iVBORw==', byte_length: 4 } });
  });

  it('truncates large responses at max_bytes', async () => {
    const big = 'a'.repeat(10_000);
    const fetchImpl = vi.fn(async (): Promise<Response> => textResponse(big));
    const backend = new WebFetchCapabilityBackend({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await backend.execute({ url: 'https://example.com/big', max_bytes: 100 });

    expect(result).toMatchObject({ ok: true, value: { truncated: true, byte_length: 100 } });
  });

  it('reports a timeout as a recoverable error', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      const error = new Error('aborted');
      error.name = 'TimeoutError';
      throw error;
    });
    const backend = new WebFetchCapabilityBackend({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await backend.execute({ url: 'https://example.com/slow', timeout_seconds: 1 });

    expect(result).toMatchObject({ ok: false, error: { recoverable: true } });
  });
});
