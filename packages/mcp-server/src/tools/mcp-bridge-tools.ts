import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { mcpCallSchema, mcpDescribeSchema, mcpListSchema } from './schemas.js';

const fullAccess = {
  permission: 'DANGEROUS' as const,
  annotations: { readOnlyHint: false, destructiveHint: true },
};

export function mcpBridgeTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'mcp_list',
      description: 'List local MCP servers discovered from Cursor, Claude Desktop, and lnwjud settings. Does not flatten child tools into the lnwjud catalog.',
      ...fullAccess,
      inputSchema: mcpListSchema,
      handler: async () => context.services.extensions === undefined
        ? missingService()
        : context.services.extensions.listMcpServers(),
    }),
    defineTool({
      name: 'mcp_describe',
      description: 'Connect to one local MCP server (if needed) and return its tool names, descriptions, and input schemas.',
      ...fullAccess,
      inputSchema: mcpDescribeSchema,
      handler: async (input) => context.services.extensions === undefined
        ? missingService()
        : context.services.extensions.describeMcpServer({ server: input.server }),
    }),
    defineTool({
      name: 'mcp_call',
      description: 'Call a tool on a discovered local MCP server. Pass server, tool, and arguments. Child tools may write, execute, or control the desktop according to that server.',
      ...fullAccess,
      inputSchema: mcpCallSchema,
      handler: async (input) => context.services.extensions === undefined
        ? missingService()
        : context.services.extensions.callMcpTool({
          server: input.server,
          tool: input.tool,
          ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
        }),
    }),
  ];
}
