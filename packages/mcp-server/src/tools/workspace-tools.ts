import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import {
  projectSnapshotSchema,
  workspaceInfoSchema,
  workspaceListSchema,
  workspaceRegisterSchema,
  workspaceTreeSchema,
} from './schemas.js';

export function workspaceTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'workspace_list',
      description: 'List all registered workspaces/drive roots available to lnwjud. Call this first to discover workspace IDs. Entries include kind=machine_root|project.',
      permission: 'DANGEROUS',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: workspaceListSchema,
      handler: async () => context.services.workspaceInfo === undefined
        ? missingService()
        : context.services.workspaceInfo.list === undefined
          ? missingService()
          : context.services.workspaceInfo.list(context.actor),
    }),
    defineTool({
      name: 'workspace_register',
      description: 'Register an existing project directory under the E:\\ machine root. parentWorkspaceId must be the E:\\ machine root from workspace_list. Idempotent for the same path.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: workspaceRegisterSchema,
      handler: async (input) => context.services.workspaceInfo === undefined
        ? missingService()
        : context.services.workspaceInfo.register === undefined
          ? missingService()
          : context.services.workspaceInfo.register(context.actor, {
            parentWorkspaceId: input.parentWorkspaceId,
            path: input.path,
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          }),
    }),
    defineTool({
      name: 'workspace_info',
      description: 'Return the configured workspace summary.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceInfoSchema,
      handler: async (input) => context.services.workspaceInfo === undefined
        ? missingService()
        : context.services.workspaceInfo.info(context.actor, input.workspaceId),
    }),
    defineTool({
      name: 'workspace_tree',
      description: 'List a bounded workspace tree.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceTreeSchema,
      handler: async (input) => context.services.workspaceQuery === undefined
        ? missingService()
        : context.services.workspaceQuery.tree(context.actor, input.workspaceId, {
          ...(input.path === undefined ? {} : { path: input.path }),
          ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
          ...(input.maxEntries === undefined ? {} : { maxEntries: input.maxEntries }),
        }),
    }),
    defineTool({
      name: 'project_snapshot',
      description: 'Return a bounded project snapshot without source contents.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: projectSnapshotSchema,
      handler: async (input) => context.services.projectSnapshot === undefined
        ? missingService()
        : context.services.projectSnapshot.snapshot(context.actor, input.workspaceId),
    }),
  ];
}
