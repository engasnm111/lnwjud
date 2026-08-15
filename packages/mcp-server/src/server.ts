import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { DiagnosticLogger, FileActor } from '@lnwjud/application';
import type { ActivitySink, ActivityTracker } from './activity-tracker.js';
import { withProgressHeartbeat, type ProgressNotifyContext } from './progress-heartbeat.js';
import { ToolRegistry, type McpApplicationServices } from './tool-registry.js';

export interface McpServerOptions {
  readonly services: McpApplicationServices;
  readonly actor: FileActor;
  readonly diagnostic?: DiagnosticLogger;
  readonly activity?: ActivitySink;
  readonly activityTracker?: ActivityTracker;
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const registry = new ToolRegistry(options.services, options.actor, {
    ...(options.diagnostic === undefined ? {} : { diagnostic: options.diagnostic }),
    ...(options.activity === undefined ? {} : { activity: options.activity }),
    ...(options.activityTracker === undefined ? {} : { activityTracker: options.activityTracker }),
  });
  const server = new McpServer({ name: 'lnwjud', version: '0.1.0' }, { capabilities: { tools: {} } });
  for (const tool of registry.list()) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    }, async (input: unknown, context): Promise<CallToolResult> => {
      return withProgressHeartbeat(context as ProgressNotifyContext, tool.name, async () => (
        registry.invoke(tool.name, input) as unknown as Promise<CallToolResult>
      ));
    });
  }
  return server;
}
