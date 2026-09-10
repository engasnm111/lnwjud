/* global AbortSignal, fetch, setTimeout */

const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_DESTROYED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNREFUSED',
  'EPIPE',
]);
const MAX_ATTEMPTS = 4;

const sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

function isRetryableFetchError(error) {
  const code = error?.code ?? error?.cause?.code;
  const name = error?.name;
  const causeName = error?.cause?.name;
  return name === 'TimeoutError'
    || causeName === 'TimeoutError'
    || causeName === 'ConnectTimeoutError'
    || causeName === 'HeadersTimeoutError'
    || causeName === 'BodyTimeoutError'
    || causeName === 'SocketError'
    || RETRYABLE_ERROR_CODES.has(code);
}

export async function fetchWithRetry(url, timeoutMs, fetchFn = fetch, sleepFn = sleep) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok || !RETRYABLE_HTTP_STATUS.has(response.status) || attempt === MAX_ATTEMPTS) return response;
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      if (attempt === MAX_ATTEMPTS || !isRetryableFetchError(error)) throw error;
    }
    await sleepFn(1_000 * 2 ** (attempt - 1));
  }
  throw new Error('Download retry loop exhausted unexpectedly');
}
