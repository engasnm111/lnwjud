import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { mcpCallSchema, mcpDescribeSchema, mcpListSchema } from './schemas.js';

const readOnlyInspection = {
  permission: 'READ' as const,
  annotations: { readOnlyHint: true, destructiveHint: false },
};

const opaqueChildMutation = {
  permission: 'DANGEROUS' as const,
  annotations: { readOnlyHint: false, destructiveHint: true },
};

export function mcpBridgeTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'mcp_list',
      description: 'List local MCP servers discovered from Cursor, Claude Desktop, and lnwjud settings. This inspection is read-only and does not flatten child tools into the lnwjud catalog.',
      ...readOnlyInspection,
      inputSchema: mcpListSchema,
      handler: async () => context.services.extensions === undefined
        ? missingService()
        : context.services.extensions.listMcpServers(),
    }),
    defineTool({
      name: 'mcp_describe',
      description: 'Connect to one local MCP server (if needed) and return its tool names, descriptions, and input schemas. This operation only inspects the child tool catalog.',
      ...readOnlyInspection,
      inputSchema: mcpDescribeSchema,
      handler: async (input, signal) => context.services.extensions === undefined
        ? missingService()
        : context.services.extensions.describeMcpServer({ server: input.server }, signal),
    }),
    defineTool({
      name: 'mcp_call',
      description: 'Call a tool on a discovered local MCP server. Child side effects and filesystem/network scope are controlled by that child server, so standard mode treats every mcp_call as opaque mutation and requires explicit chat plus host exact-action approval. Trusted Full Bypass skips lnwjud application approval; the child server still enforces its own policy.',
      ...opaqueChildMutation,
      inputSchema: mcpCallSchema,
      handler: async (input, signal) => context.services.extensions === undefined
        ? missingService()
        : context.services.extensions.callMcpTool({
          server: input.server,
          tool: input.tool,
          ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
        }, signal),
    }),
  ];
}
