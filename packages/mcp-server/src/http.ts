import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  isLegacyRequest,
  localhostAllowedHostnames,
  WebStandardStreamableHTTPServerTransport,
  type McpHttpHandler,
  type McpServer,
} from '@modelcontextprotocol/server';
import { createMcpServer, type McpServerOptions } from './server.js';
import { SetOfMarksObservationStore } from './set-of-marks-service.js';
import { createHttpRequestScope, createProtocolHttpRequestScope } from './request-scope.js';
import { IncrementalVerifier } from './incremental-verifier.js';
import { RunBudgetGuard } from './run-budget.js';
import { createOriginPolicy, type OriginPolicy } from './origin-policy.js';
import { APP_NAME, APP_VERSION } from '@lnwjud/shared';

export const MAX_MCP_HTTP_BODY_BYTES = 1_048_576;
export const LNWJUD_MCP_IDENTITY_PATH = '/_lnwjud/identity';

export interface McpHttpServerOptions extends McpServerOptions {
  readonly port: number;
  readonly maxBodyBytes?: number;
  readonly originPolicy?: OriginPolicy;
}

export interface McpHttpServerAddress {
  readonly host: '127.0.0.1';
  readonly port: number;
}

export interface McpHttpServerHandle {
  readonly address: McpHttpServerAddress;
  readonly endpoint: URL;
  close(): Promise<void>;
}

interface BodyReadResult {
  readonly tooLarge: boolean;
  readonly body: Buffer;
}

interface LegacySession {
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;
}

function writeDiagnostic(error: Error): void {
  process.stderr.write(`lnwjud MCP HTTP error: ${error.message}\n`);
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 0 && port <= 65_535;
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<BodyReadResult> {
  const declaredLength = Number(request.headers['content-length']);
  let tooLarge = Number.isFinite(declaredLength) && declaredLength > maxBytes;
  let size = 0;
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (!tooLarge && size <= maxBytes) chunks.push(buffer);
    if (size > maxBytes) tooLarge = true;
  }

  return { tooLarge, body: Buffer.concat(chunks) };
}

function toFetchRequest(request: IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) headers.set(name, value.join(', '));
    else if (value !== undefined) headers.set(name, value);
  }

  const requestedPath = new URL(request.url ?? '/', 'http://127.0.0.1');
  const init: RequestInit = { method: request.method ?? 'GET', headers };
  if (init.method !== 'GET' && init.method !== 'HEAD' && body.length > 0) {
    init.body = new Uint8Array(body);
  }
  return new Request(`http://127.0.0.1${requestedPath.pathname}${requestedPath.search}`, init);
}

function sendStatus(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.end(message);
}

function waitForDrainOrClose(response: ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    const cleanup = (): void => {
      response.off('drain', onDrain);
      response.off('close', onClose);
    };
    const onDrain = (): void => {
      cleanup();
      resolve(true);
    };
    const onClose = (): void => {
      cleanup();
      resolve(false);
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
  });
}

async function writeFetchResponse(response: ServerResponse, result: Response): Promise<void> {
  response.statusCode = result.status;
  result.headers.forEach((value, name) => response.setHeader(name, value));
  if (result.body === null) {
    response.end();
    return;
  }

  const reader = result.body.getReader();
  let clientDisconnected = false;
  const onClose = (): void => {
    if (response.writableEnded) return;
    clientDisconnected = true;
    void reader.cancel(new Error('MCP HTTP client disconnected')).catch(() => undefined);
  };
  response.once('close', onClose);
  response.flushHeaders();

  try {
    while (!clientDisconnected) {
      const next = await reader.read();
      if (next.done) break;
      if (response.destroyed) {
        clientDisconnected = true;
        break;
      }
      if (!response.write(next.value) && !(await waitForDrainOrClose(response))) {
        clientDisconnected = true;
        break;
      }
    }
    if (clientDisconnected) await reader.cancel().catch(() => undefined);
  } finally {
    response.off('close', onClose);
    reader.releaseLock();
  }

  if (!clientDisconnected && !response.destroyed && !response.writableEnded) response.end();
}

function sessionNotFoundResponse(): Response {
  return Response.json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Session not found' },
    id: null,
  }, { status: 404 });
}

function createSessionfulMcpHandler(options: McpHttpServerOptions): McpHttpHandler {
  const runBudgetGuard = options.runBudgetGuard ?? new RunBudgetGuard();
  const incrementalVerifier = options.incrementalVerifier ?? new IncrementalVerifier();
  const setOfMarksStore = options.setOfMarksStore ?? new SetOfMarksObservationStore();
  const endpointFallbackSessionId = randomUUID();
  const factory = (request?: Request): McpServer => createMcpServer({
    ...options,
    runBudgetGuard,
    incrementalVerifier,
    setOfMarksStore,
    requestScope: createHttpRequestScope({ ...(request === undefined ? {} : { request }), fallbackSessionId: endpointFallbackSessionId }),
  });
  const modernHandler = createMcpHandler((context) => factory(context.requestInfo), { legacy: 'reject', onerror: writeDiagnostic });
  const sessions = new Map<string, LegacySession>();
  let closed = false;

  const closeLegacySession = async (sessionId: string, session: LegacySession): Promise<void> => {
    if (sessions.get(sessionId) === session) sessions.delete(sessionId);
    await session.server.close();
  };

  const createLegacySession = async (request: Request): Promise<Response> => {
    if (closed) return sessionNotFoundResponse();

    const protocolSessionId = randomUUID();
    const server = createMcpServer({
      ...options,
      runBudgetGuard,
      incrementalVerifier,
      setOfMarksStore,
      requestScope: createProtocolHttpRequestScope(protocolSessionId),
    });
    let registeredSessionId: string | undefined;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: (): string => protocolSessionId,
      onsessioninitialized(sessionId): void {
        registeredSessionId = sessionId;
        sessions.set(sessionId, { server, transport });
      },
      onsessionclosed(sessionId): void {
        if (sessions.get(sessionId)?.transport === transport) sessions.delete(sessionId);
      },
    });

    try {
      await server.connect(transport);
      const result = await transport.handleRequest(request);
      if (registeredSessionId === undefined) await server.close();
      return result;
    } catch (error: unknown) {
      if (registeredSessionId !== undefined && sessions.get(registeredSessionId)?.transport === transport) {
        sessions.delete(registeredSessionId);
      }
      await server.close().catch(() => undefined);
      throw error;
    }
  };

  return {
    bus: modernHandler.bus,
    notify: modernHandler.notify,
    async fetch(request, requestOptions): Promise<Response> {
      if (!(await isLegacyRequest(request))) return modernHandler.fetch(request, requestOptions);

      const sessionId = request.headers.get('mcp-session-id')?.trim();
      if (sessionId === undefined || sessionId.length === 0) {
        return createLegacySession(request);
      }

      const session = sessions.get(sessionId);
      if (session === undefined) return sessionNotFoundResponse();

      const result = await session.transport.handleRequest(request, requestOptions);
      if (request.method === 'DELETE') await closeLegacySession(sessionId, session);
      return result;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await modernHandler.close();
      const activeSessions = [...sessions.entries()];
      sessions.clear();
      await Promise.allSettled(activeSessions.map(([, session]) => session.server.close()));
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handler: McpHttpHandler,
  originPolicy: OriginPolicy,
  maxBodyBytes: number,
): Promise<void> {
  const requestedPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (requestedPath !== '/mcp' && requestedPath !== LNWJUD_MCP_IDENTITY_PATH) {
    sendStatus(response, 404, 'Not found');
    return;
  }

  const read = await readBody(request, maxBodyBytes);
  if (read.tooLarge) {
    sendStatus(response, 413, 'Request body too large');
    return;
  }

  const fetchRequest = toFetchRequest(request, read.body);
  const rejected = hostHeaderValidationResponse(fetchRequest, localhostAllowedHostnames())
    ?? originPolicy.validate(fetchRequest);
  if (rejected !== undefined) {
    await writeFetchResponse(response, rejected);
    return;
  }

  if (requestedPath === LNWJUD_MCP_IDENTITY_PATH) {
    if (fetchRequest.method !== 'GET') {
      sendStatus(response, 405, 'Method not allowed');
      return;
    }
    await writeFetchResponse(response, Response.json({
      product: APP_NAME,
      service: 'desktop-mcp',
      protocol: 1,
      version: APP_VERSION,
    }, {
      headers: {
        'cache-control': 'no-store',
        'x-lnwjud-service': 'desktop-mcp',
      },
    }));
    return;
  }

  await writeFetchResponse(response, await handler.fetch(fetchRequest));
}

function listen(server: HttpServer, port: number): Promise<McpHttpServerAddress> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string' || address.address !== '127.0.0.1') {
        reject(new Error('MCP HTTP server did not bind to loopback'));
        return;
      }
      resolve({ host: '127.0.0.1', port: address.port });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: '127.0.0.1', port });
  });
}

export async function startMcpHttp(options: McpHttpServerOptions): Promise<McpHttpServerHandle> {
  if (!isValidPort(options.port)) throw new Error('MCP HTTP port must be an integer from 0 to 65535');
  const maxBodyBytes = options.maxBodyBytes ?? MAX_MCP_HTTP_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) throw new Error('MCP HTTP body limit must be positive');

  const handler = createSessionfulMcpHandler(options);
  const originPolicy = options.originPolicy ?? createOriginPolicy();
  const server = createServer((request, response) => {
    void handleRequest(request, response, handler, originPolicy, maxBodyBytes).catch((error: unknown) => {
      writeDiagnostic(error instanceof Error ? error : new Error('Unhandled MCP HTTP request error'));
      if (!response.headersSent) sendStatus(response, 500, 'Internal server error');
      else response.destroy();
    });
  });
  let address: McpHttpServerAddress;
  try {
    address = await listen(server, options.port);
  } catch (error: unknown) {
    // Preferred fixed ports (e.g. 18765) may already be taken — fall back to ephemeral.
    if (options.port !== 0 && isAddressInUse(error)) {
      address = await listen(server, 0);
    } else {
      throw error;
    }
  }
  const endpoint = new URL(`http://${address.host}:${address.port}/mcp`);

  return {
    address,
    endpoint,
    async close(): Promise<void> {
      await handler.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => error === undefined ? resolve() : reject(error));
      });
    },
  };
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'EADDRINUSE';
}
