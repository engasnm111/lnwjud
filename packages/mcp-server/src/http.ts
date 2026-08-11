import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
} from '@modelcontextprotocol/server';
import { createMcpServer, type McpServerOptions } from './server.js';
import { createOriginPolicy, type OriginPolicy } from './origin-policy.js';

export const MAX_MCP_HTTP_BODY_BYTES = 1_048_576;

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

async function writeFetchResponse(response: ServerResponse, result: Response): Promise<void> {
  response.statusCode = result.status;
  result.headers.forEach((value, name) => response.setHeader(name, value));
  if (result.body === null) {
    response.end();
    return;
  }

  const reader = result.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!response.write(next.value)) await once(response, 'drain');
    }
  } finally {
    reader.releaseLock();
  }
  response.end();
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handler: ReturnType<typeof createMcpHandler>,
  originPolicy: OriginPolicy,
  maxBodyBytes: number,
): Promise<void> {
  const requestedPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (requestedPath !== '/mcp') {
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

  const handler = createMcpHandler(
    () => createMcpServer(options),
    { legacy: 'stateless', onerror: writeDiagnostic },
  );
  const originPolicy = options.originPolicy ?? createOriginPolicy();
  const server = createServer((request, response) => {
    void handleRequest(request, response, handler, originPolicy, maxBodyBytes).catch((error: unknown) => {
      writeDiagnostic(error instanceof Error ? error : new Error('Unhandled MCP HTTP request error'));
      if (!response.headersSent) sendStatus(response, 500, 'Internal server error');
      else response.destroy();
    });
  });
  const address = await listen(server, options.port);
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
