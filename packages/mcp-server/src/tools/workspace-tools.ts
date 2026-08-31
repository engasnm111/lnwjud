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
      description: 'List registered project workspaces available to lnwjud. Legacy explicitly registered drive roots may also appear as kind=machine_root.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceListSchema,
      handler: async () => context.services.workspaceInfo === undefined
        ? missingService()
        : context.services.workspaceInfo.list === undefined
          ? missingService()
          : context.services.workspaceInfo.list(context.actor),
    }),
    defineTool({
      name: 'workspace_register',
      description: 'Register an existing project directory by absolute path. parentWorkspaceId is optional and retained only for legacy machine-root-relative registration. Idempotent for the same path.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: workspaceRegisterSchema,
      handler: async (input) => {
        if (context.services.workspaceInfo === undefined || context.services.workspaceInfo.register === undefined) return missingService();
        const registered = await context.services.workspaceInfo.register(context.actor, {
          ...(input.parentWorkspaceId === undefined ? {} : { parentWorkspaceId: input.parentWorkspaceId }),
          path: input.path,
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        });
        if (registered.ok && context.services.workspaceIndex !== undefined) {
          const workspaceId = readWorkspaceId(registered.value);
          if (workspaceId !== undefined) await context.services.workspaceIndex.indexWorkspace(workspaceId);
        }
        return registered;
      },
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
      description: 'List a bounded workspace tree. Absolute path does not require workspaceId.',
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

function readWorkspaceId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('id' in value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && id.trim().length > 0 ? id : undefined;
}
