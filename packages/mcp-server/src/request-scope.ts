import { createHash, randomUUID } from 'node:crypto';
import type { FileActor } from '@lnwjud/application';
import { CAPABILITY_TASK_OWNER_METADATA_KEY } from '@lnwjud/capabilities';

export type McpTransportKind = 'http' | 'stdio';

export interface McpRequestScope {
  readonly sessionId: string;
  readonly transport: McpTransportKind;
  readonly protocolSessionId?: string;
  readonly workspaceId?: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly traceParent?: string;
  readonly traceState?: string;
  readonly baggage?: string;
}

export interface HttpRequestScopeOptions {
  readonly request?: Request;
  readonly fallbackSessionId: string;
}

/** One synthetic identity for one STDIO serving lifetime. */
export function createStdioRequestScope(sessionId = randomUUID()): McpRequestScope {
  return { sessionId: normalizeInternalSessionId(sessionId), transport: 'stdio' };
}

/**
 * HTTP prefers an MCP protocol session when the transport exposes one. Modern
 * stateless requests intentionally fall back to one endpoint-scoped identity;
 * no ChatGPT conversation identifier is guessed or invented from client data.
 */
export function createHttpRequestScope(options: HttpRequestScopeOptions): McpRequestScope {
  const protocolSessionId = boundedProtocolSessionId(options.request?.headers.get('mcp-session-id'));
  const traceParent = boundedHeader(options.request?.headers.get('traceparent'), 256);
  const traceState = boundedHeader(options.request?.headers.get('tracestate'), 512);
  const baggage = boundedBaggageHeader(options.request?.headers.get('baggage'));
  return {
    sessionId: protocolSessionId === undefined
      ? normalizeInternalSessionId(options.fallbackSessionId)
      : `http-${fingerprint(protocolSessionId)}`,
    transport: 'http',
    ...(protocolSessionId === undefined ? {} : { protocolSessionId }),
    ...(traceParent === undefined ? {} : { traceParent }),
    ...(traceState === undefined ? {} : { traceState }),
    ...(baggage === undefined ? {} : { baggage }),
  };
}

export function createProtocolHttpRequestScope(protocolSessionId: string): McpRequestScope {
  const bounded = boundedProtocolSessionId(protocolSessionId);
  if (bounded === undefined) throw new Error('Protocol session ID is invalid');
  return { sessionId: `http-${fingerprint(bounded)}`, transport: 'http', protocolSessionId: bounded };
}

/** Keep the transport client identity stable while making ownership session-specific. */
export function actorForRequestScope(actor: FileActor, scope: McpRequestScope | undefined): FileActor {
  if (scope === undefined) return actor;
  return { ...actor, sessionId: scope.sessionId };
}


export function withCapabilityOwnerMetadata(input: unknown, actor: FileActor): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const request = input as Record<string, unknown>;
  const existingMetadata = typeof request.metadata === 'object' && request.metadata !== null && !Array.isArray(request.metadata)
    ? request.metadata as Record<string, unknown>
    : {};
  const workspaceId = typeof request.workspaceId === 'string' && request.workspaceId.trim().length > 0 ? request.workspaceId.trim() : undefined;
  return {
    ...request,
    metadata: {
      ...existingMetadata,
      [CAPABILITY_TASK_OWNER_METADATA_KEY]: {
        clientId: actor.clientId,
        sessionId: actor.sessionId?.trim() || actor.clientId,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      },
    },
  };
}

function normalizeInternalSessionId(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : `session-${fingerprint(trimmed || randomUUID())}`;
}

function boundedProtocolSessionId(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, 256);
}

function boundedHeader(value: string | null | undefined, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, maxLength);
}

function boundedBaggageHeader(value: string | null | undefined): string | undefined {
  const bounded = boundedHeader(value, 2048);
  if (bounded === undefined) return undefined;
  const members = bounded.split(',').slice(0, 32).map((member) => {
    const [rawKey, ...rest] = member.trim().split('=');
    if (rawKey === undefined || rest.length === 0) return undefined;
    const key = rawKey.trim();
    if (key.length === 0) return undefined;
    if (/(token|secret|password|api[_-]?key|private[_-]?key|authorization|credential)/i.test(key)) return `${key}=[redacted]`;
    const rawValue = rest.join('=').trim().replace(/(token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s,]+/gi, '$1=[redacted]');
    return `${key}=${rawValue}`;
  }).filter((member): member is string => member !== undefined).join(',');
  return members.length === 0 ? undefined : members.slice(0, 1024);
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}
