import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { DiagnosticLogger, FileActor } from '@lnwjud/application';
import { ToolRegistry, type McpApplicationServices } from './tool-registry.js';

export interface McpServerOptions {
  readonly services: McpApplicationServices;
  readonly actor: FileActor;
  readonly diagnostic?: DiagnosticLogger;
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const registry = new ToolRegistry(options.services, options.actor, options.diagnostic === undefined ? {} : { diagnostic: options.diagnostic });
  const server = new McpServer({ name: 'lnwjud', version: '0.1.0' }, { capabilities: { tools: {} } });
  for (const tool of registry.list()) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    }, async (input: unknown, context): Promise<CallToolResult> => {
      void context;
      return registry.invoke(tool.name, input) as unknown as CallToolResult;
    });
  }
  return server;
}
