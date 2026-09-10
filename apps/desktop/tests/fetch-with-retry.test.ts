import { describe, expect, it, vi } from 'vitest';
import { fetchWithRetry } from '../scripts/fetch-with-retry.mjs';

describe('fetchWithRetry', () => {
  it('retries bounded transient HTTP and network failures before succeeding', async () => {
    const cancel = vi.fn(async () => undefined);
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, body: { cancel } })
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const sleepFn = vi.fn(async () => undefined);

    await expect(fetchWithRetry('https://example.test/asset', 1234, fetchFn, sleepFn)).resolves.toMatchObject({ ok: true, status: 200 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenCalledOnce();
    expect(sleepFn.mock.calls).toEqual([[1000], [2000]]);
    expect(fetchFn.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not retry permanent HTTP failures', async () => {
    const response = { ok: false, status: 404 };
    const fetchFn = vi.fn().mockResolvedValue(response);
    const sleepFn = vi.fn(async () => undefined);

    await expect(fetchWithRetry('https://example.test/missing', 1234, fetchFn, sleepFn)).resolves.toBe(response);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('does not retry non-network exceptions', async () => {
    const error = Object.assign(new TypeError('invalid URL'), { code: 'ERR_INVALID_URL' });
    const fetchFn = vi.fn().mockRejectedValue(error);
    const sleepFn = vi.fn(async () => undefined);

    await expect(fetchWithRetry('bad-url', 1234, fetchFn, sleepFn)).rejects.toBe(error);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('stops after four transient failures', async () => {
    const error = Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    const fetchFn = vi.fn().mockRejectedValue(error);
    const sleepFn = vi.fn(async () => undefined);

    await expect(fetchWithRetry('https://example.test/asset', 1234, fetchFn, sleepFn)).rejects.toBe(error);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(sleepFn.mock.calls).toEqual([[1000], [2000], [4000]]);
  });

  it('retries connect timeout causes without explicit error code', async () => {
    const error = Object.assign(new TypeError('fetch failed'), { cause: { name: 'ConnectTimeoutError' } });
    const fetchFn = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({ ok: true, status: 200 });
    const sleepFn = vi.fn(async () => undefined);

    await expect(fetchWithRetry('https://example.test/asset', 1234, fetchFn, sleepFn)).resolves.toMatchObject({ ok: true, status: 200 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(1000);
  });
});
