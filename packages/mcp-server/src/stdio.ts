import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { createMcpServer, type McpServerOptions } from './server.js';

export interface McpStdioOptions extends McpServerOptions {
  readonly onError?: (error: Error) => void;
}

export function isBenignStdioPipeError(error: Error): boolean {
  return /EPIPE|ECONNRESET|broken pipe/i.test(error.message);
}

function writeStdioDiagnostic(error: Error): void {
  if (isBenignStdioPipeError(error)) {
    process.stderr.write(`lnwjud MCP stdio: peer closed (${error.message})\n`);
    return;
  }
  process.stderr.write(`lnwjud MCP stdio error: ${error.message}\n`);
}

export function startMcpStdio(options: McpStdioOptions): StdioServerHandle {
  return serveStdio(
    () => createMcpServer(options),
    { legacy: 'reject', onerror: options.onError ?? writeStdioDiagnostic },
  );
}
