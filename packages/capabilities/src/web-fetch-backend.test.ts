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

  it('returns a dry-run preview without issuing the request', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => textResponse('should not be fetched'));
    const backend = new WebFetchCapabilityBackend({ fetchImpl: fetchImpl as unknown as typeof fetch });

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
    const backend = new WebFetchCapabilityBackend({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(backend.execute({ url: 'https://example.com/item/1', method }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(backend.execute({ url: 'https://example.com/item/1', method, userConfirmed: true }))
      .resolves.toMatchObject({ ok: true, value: { status: 200, text: 'mutated' } });
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

  it('warns that a failed HTTP mutation may already have completed and never retries the request automatically', async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      const error = new Error('timed out after dispatch');
      error.name = 'TimeoutError';
      throw error;
    });
    const backend = new WebFetchCapabilityBackend({ fetchImpl: fetchImpl as unknown as typeof fetch });

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
    const backend = new WebFetchCapabilityBackend({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const controller = new AbortController();

    const pending = backend.execute({ url: 'https://example.com/cancelled', timeout_seconds: 10 }, controller.signal);
    controller.abort();

    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT', recoverable: true } });
    expect(observedSignal?.aborted).toBe(true);
  });
});
