import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { codexRunSchema, codexStatusSchema, codexStopSchema, codexTaskHandleSchema, codexTaskLogsSchema } from './schemas.js';

export const CODEX_TOOL_NAMES = Object.freeze([
  'codex_status',
  'codex_run',
  'codex_task_list',
  'codex_task_status',
  'codex_task_logs',
  'codex_stop',
] as const);

export function codexTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'codex_status',
      description: 'Report local Codex installation and capabilities without credential inspection.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: codexStatusSchema,
      handler: async () => context.services.codex === undefined ? missingService() : context.services.codex.status(context.actor),
    }),
    defineTool({
      name: 'codex_run',
      description: 'Delegate an instruction to the local Codex CLI in the Active Project. Starting Codex always requires explicit chat confirmation and userConfirmed: true.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: codexRunSchema,
      handler: async (input, signal) => context.services.codex === undefined
        ? missingService()
        : context.services.codex.run(context.actor, input.workspaceId, input.instruction, signal, input.userConfirmed === true),
    }),
    defineTool({
      name: 'codex_task_list',
      description: 'List local Codex task handles owned by this client, including launches whose response was cancelled.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: codexTaskHandleSchema.pick({ workspaceId: true }),
      handler: async (input) => context.services.codex === undefined
        ? missingService()
        : context.services.codex.list(context.actor, input.workspaceId),
    }),
    defineTool({
      name: 'codex_task_status',
      description: 'Read status for an owned Codex task.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: codexTaskHandleSchema,
      handler: async (input) => context.services.codex === undefined
        ? missingService()
        : context.services.codex.taskStatus(context.actor, input.workspaceId, input.codexTaskId),
    }),
    defineTool({
      name: 'codex_task_logs',
      description: 'Read bounded logs for an owned Codex task.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: codexTaskLogsSchema,
      handler: async (input) => context.services.codex === undefined
        ? missingService()
        : context.services.codex.taskLogs(context.actor, input.workspaceId, input.codexTaskId, {
          ...(input.tailLines === undefined ? {} : { tailLines: input.tailLines }),
          ...(input.sinceSequence === undefined ? {} : { sinceSequence: input.sinceSequence }),
        }),
    }),
    defineTool({
      name: 'codex_stop',
      description: 'Stop an owned Codex task process after explicit chat confirmation.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: codexStopSchema,
      handler: async (input) => context.services.codex === undefined
        ? missingService()
        : context.services.codex.stop(context.actor, input.workspaceId, input.codexTaskId, input.userConfirmed === true),
    }),
  ];
}
