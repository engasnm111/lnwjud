import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { appError, err, isApplicationAuthorized, ok, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 600;
const MAX_REDIRECTS = 5;
const TEXT_SAFE_CTYPES = new Set(['application/json', 'application/javascript', 'application/xml', 'application/x-www-form-urlencoded']);

export interface WebFetchOptions {
  readonly fetchImpl?: typeof fetch;
  /** Resolves a hostname to its addresses; injectable to keep tests hermetic. */
  readonly addressLookup?: (hostname: string) => Promise<readonly string[]>;
}

export class WebFetchCapabilityBackend implements CapabilityBackend {
  private readonly fetchImpl: typeof fetch;
  private readonly addressLookup: (hostname: string) => Promise<readonly string[]>;

  public constructor(options: WebFetchOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.addressLookup = options.addressLookup ?? (async (hostname: string): Promise<readonly string[]> => {
      const addresses = await dnsLookup(hostname, { all: true });
      return addresses.map((entry) => entry.address);
    });
  }

  public async execute(input: unknown, parentSignal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
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
    if (request.method !== 'GET' && request.method !== 'HEAD' && !isApplicationAuthorized(authorization, request.userConfirmed)) {
      return err(appError('PERMISSION_REQUIRED', 'HTTP mutation requests require explicit user confirmation'));
    }

    if (parentSignal?.aborted === true) return cancelledRequest(request.method, 'Web request was cancelled before dispatch');
    const timeoutSignal = AbortSignal.timeout(request.timeoutSeconds * 1000);
    const signal = parentSignal === undefined ? timeoutSignal : AbortSignal.any([parentSignal, timeoutSignal]);
    let response: Response;
    try {
      response = await this.fetchWithRedirectValidation(url, request.method, headers, body, signal);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === WEB_DESTINATION_BLOCKED) {
        return err(appError('INVALID_INPUT', 'Web request destination is a private, loopback, or link-local address; only public http(s) destinations are allowed'));
      }
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

  /**
   * Fetch with SSRF containment: every hop (initial URL and each redirect) must
   * resolve to a public address. Redirects are followed manually because the
   * initial-URL check alone is bypassable via an open redirector. Hop semantics
   * mirror what stock fetch's `redirect: 'follow'` does, so replacing it with
   * manual following never changes request shape: 303 (and 301/302 after a
   * non-GET/HEAD method) switch to GET and drop the body, and credentials are
   * stripped when the hop crosses origins.
   */
  private async fetchWithRedirectValidation(
    url: URL,
    method: WebFetchRequest['method'],
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    let current = url;
    let currentMethod = method;
    let currentHeaders = headers;
    let currentBody = body;
    for (let hop = 0; ; hop++) {
      await this.assertPublicDestination(current);
      const response = await this.fetchImpl(current.toString(), {
        method: currentMethod,
        headers: currentHeaders,
        ...(currentBody === undefined ? {} : { body: currentBody }),
        redirect: 'manual',
        signal,
      });
      if (response.status < 300 || response.status > 399) return response;
      const location = response.headers.get('location');
      if (location === null) return response;
      if (hop >= MAX_REDIRECTS) throw new Error('Web request exceeded the maximum number of redirects');
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error('Web request redirect target is invalid');
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('Web request redirect target is not http(s)');
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod !== 'GET' && currentMethod !== 'HEAD')) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
      if (next.origin !== current.origin) currentHeaders = stripCredentialHeaders(currentHeaders);
      void response.body?.cancel().catch(() => undefined);
      current = next;
    }
  }

  private async assertPublicDestination(url: URL): Promise<void> {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (hostname.length === 0) throw new WebDestinationBlockedError();
    if (isIP(hostname) !== 0) {
      if (isBlockedAddress(hostname)) throw new WebDestinationBlockedError();
      return;
    }
    let addresses: readonly string[];
    try {
      addresses = await this.addressLookup(hostname);
    } catch {
      // Resolution failure is a normal fetch failure, not a policy verdict.
      return;
    }
    if (addresses.some((address) => isBlockedAddress(address))) throw new WebDestinationBlockedError();
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

const WEB_DESTINATION_BLOCKED = 'lnwjud-web-destination-blocked';

class WebDestinationBlockedError extends Error {
  public constructor() {
    super(WEB_DESTINATION_BLOCKED);
    this.name = 'WebDestinationBlockedError';
  }
}

function isPrivateIPv4(octets: readonly number[]): boolean {
  const a = octets[0];
  const b = octets[1];
  if (a === undefined || b === undefined) return true;
  return a === 0 // unspecified
    || a === 10 // private
    || a === 127 // loopback
    || (a === 169 && b === 254) // link-local (includes cloud metadata 169.254.169.254)
    || (a === 172 && b >= 16 && b <= 31) // private
    || (a === 192 && b === 168) // private
    || (a === 100 && b >= 64 && b <= 127) // CGNAT 100.64.0.0/10 (carrier-internal services)
    || a >= 224; // multicast 224.0.0.0/4, reserved 240.0.0.0/4, broadcast
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    return octets.length === 4 && isPrivateIPv4(octets);
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true; // unspecified / loopback
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
    if (mapped !== null) return isBlockedAddress(mapped[1]!);
    const first = parseInt(lower.split(':')[0]!, 16);
    if (Number.isNaN(first)) return true;
    return (first & 0xfe00) === 0xfc00 // unique-local fc00::/7
      || (first & 0xffc0) === 0xfe80; // link-local fe80::/10
  }
  return true; // not an IP literal at all: treated as blocked by callers that expect literals
}

function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  const stripped: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'authorization' || lower === 'cookie') continue;
    stripped[name] = value;
  }
  return stripped;
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
