import { appError, err, ok, type Result } from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 600;
const TEXT_SAFE_CTYPES = new Set(['application/json', 'application/javascript', 'application/xml', 'application/x-www-form-urlencoded']);

export interface WebFetchOptions {
  readonly fetchImpl?: typeof fetch;
}

export class WebFetchCapabilityBackend implements CapabilityBackend {
  private readonly fetchImpl: typeof fetch;

  public constructor(options: WebFetchOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async execute(input: unknown, parentSignal?: AbortSignal): Promise<Result<unknown>> {
    const parsed = parseRequest(input);
    if (!parsed.ok) return parsed;
    const request = parsed.value;

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return err(appError('INVALID_INPUT', 'URL is invalid'));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return err(appError('INVALID_INPUT', 'Only http and https URLs are supported'));
    }

    const headers: Record<string, string> = {};
    for (const entry of request.headers ?? []) {
      if (typeof entry.name !== 'string' || typeof entry.value !== 'string') {
        return err(appError('INVALID_INPUT', 'Header entries must be name/value strings'));
      }
      headers[entry.name] = entry.value;
    }

    let body: string | undefined;
    if (request.body !== undefined) {
      if (request.method === 'GET' || request.method === 'HEAD') {
        return err(appError('INVALID_INPUT', 'GET and HEAD requests cannot have a body'));
      }
      body = request.body;
    }

    if (request.dryRun) {
      return ok({ dry_run: true, url: url.toString(), method: request.method });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.userConfirmed !== true) {
      return err(appError('PERMISSION_REQUIRED', 'HTTP mutation requests require explicit user confirmation'));
    }

    if (parentSignal?.aborted === true) return cancelledRequest(request.method, 'Web request was cancelled before dispatch');
    const timeoutSignal = AbortSignal.timeout(request.timeoutSeconds * 1000);
    const signal = parentSignal === undefined ? timeoutSignal : AbortSignal.any([parentSignal, timeoutSignal]);
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'follow',
        signal,
      });
    } catch (error: unknown) {
      const timedOutOrCancelled = signal.aborted || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'));
      const reason = timedOutOrCancelled
        ? 'Web request was cancelled or timed out after dispatch'
        : 'Web request failed after dispatch';
      return timedOutOrCancelled
        ? cancelledRequest(request.method, reason)
        : requestFailure(request.method, reason);
    }

    let bytes: Buffer;
    let truncated = false;
    try {
      if (response.body === null) {
        bytes = Buffer.alloc(0);
      } else {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const remaining = request.maxBytes - total;
          if (remaining <= 0) {
            truncated = true;
            await reader.cancel().catch(() => undefined);
            break;
          }
          const slice = chunk.value.subarray(0, remaining);
          chunks.push(slice);
          total += slice.byteLength;
          if (slice.byteLength < chunk.value.byteLength) {
            truncated = true;
            await reader.cancel().catch(() => undefined);
            break;
          }
        }
        bytes = Buffer.concat(chunks);
      }
    } catch {
      const reason = signal.aborted ? 'Web response reading was cancelled or timed out' : 'Web response body could not be read';
      return signal.aborted
        ? cancelledRequest(request.method, reason)
        : requestFailure(request.method, reason);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const isText = contentType.startsWith('text/') || TEXT_SAFE_CTYPES.has(contentType.split(';')[0]?.trim().toLowerCase() ?? '');

    const value: Record<string, unknown> = {
      status: response.status,
      status_text: response.statusText,
      url: response.url,
      content_type: contentType,
      byte_length: bytes.byteLength,
      truncated,
      ...(isText ? { text: bytes.toString('utf8') } : { data_base64: bytes.toString('base64') }),
    };
    return ok(value);
  }
}

interface WebFetchRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';
  readonly headers: readonly { readonly name: string; readonly value: string }[];
  readonly body?: string;
  readonly maxBytes: number;
  readonly timeoutSeconds: number;
  readonly dryRun: boolean;
  readonly userConfirmed: boolean;
}

function isMutationMethod(method: WebFetchRequest['method']): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

function cancelledRequest(method: WebFetchRequest['method'], reason: string): Result<never> {
  if (isMutationMethod(method)) return uncertainMutationRequest(reason);
  return err(appError('PROCESS_TIMEOUT', reason, true));
}

function requestFailure(method: WebFetchRequest['method'], reason: string): Result<never> {
  if (isMutationMethod(method)) return uncertainMutationRequest(reason);
  return err(appError('INTERNAL_ERROR', reason, true));
}

function uncertainMutationRequest(reason: string): Result<never> {
  return err(appError(
    'PROCESS_TIMEOUT',
    `${reason}. HTTP mutation outcome may be unknown after dispatch; inspect the remote resource before any manual retry. Do not retry automatically.`,
    true,
  ));
}

function parseRequest(value: unknown): Result<WebFetchRequest> {
  if (!isRecord(value)) return err(appError('INVALID_INPUT', 'web_fetch input must be an object'));
  const url = value.url;
  if (typeof url !== 'string' || url.trim().length === 0) return err(appError('INVALID_INPUT', 'URL is required'));
  const methodValue = value.method === undefined ? 'GET' : value.method;
  if (methodValue !== 'GET' && methodValue !== 'POST' && methodValue !== 'PUT' && methodValue !== 'DELETE' && methodValue !== 'HEAD') {
    return err(appError('INVALID_INPUT', 'Method is invalid'));
  }
  const headers = value.headers === undefined ? [] : value.headers;
  if (!Array.isArray(headers) || headers.length > 64) return err(appError('INVALID_INPUT', 'Headers are invalid'));
  const body = value.body === undefined ? undefined : value.body;
  if (body !== undefined && typeof body !== 'string') return err(appError('INVALID_INPUT', 'Body must be a string'));
  const maxBytes = value.max_bytes === undefined ? DEFAULT_MAX_BYTES : value.max_bytes;
  if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MAX_BYTES) {
    return err(appError('INVALID_INPUT', 'max_bytes is invalid'));
  }
  const timeoutSeconds = value.timeout_seconds === undefined ? DEFAULT_TIMEOUT_SECONDS : value.timeout_seconds;
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    return err(appError('INVALID_INPUT', 'timeout_seconds is invalid'));
  }
  const dryRun = value.dry_run === undefined ? false : value.dry_run;
  if (typeof dryRun !== 'boolean') return err(appError('INVALID_INPUT', 'dry_run is invalid'));
  const userConfirmed = value.userConfirmed === true;
  return ok({
    url: url.trim(),
    method: methodValue,
    headers,
    ...(body === undefined ? {} : { body }),
    maxBytes,
    timeoutSeconds,
    dryRun,
    userConfirmed,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
