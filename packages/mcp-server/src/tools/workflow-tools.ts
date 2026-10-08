import { z } from 'zod';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';

const templateId = z.enum(['project-check','code-review','release-readiness','connection-check','data-audit','template-report']);
const inputs = z.record(z.string().min(1).max(100), z.string().max(1024));
const prepare = z.object({ workspaceId: z.string().min(1).max(128), templateId, inputs }).strict();
const draft = prepare.extend({
  schemaVersion: z.literal(1),
  templateRevision: z.number().int().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  objective: z.string().min(1).max(4096),
  steps: z.array(z.object({ id: z.string().min(1).max(128), title: z.string().min(1).max(512) }).strict()).max(100),
  acceptance: z.array(z.object({ id: z.string().min(1).max(128), title: z.string().min(1).max(512) }).strict()).max(50),
  readiness: z.enum(['ready','needs_setup','unsupported','unknown']),
  blockers: z.array(z.string().max(512)).max(20),
  preparedAt: z.string().datetime(),
}).strict();

export function workflowTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'resource_snapshot',
      description: 'Show sampled resources scoped to registered workspace/owned Goal. Unknown ownership and context metrics remain unknown; shared tasks are never cancellable.',
      permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: z.object({ workspaceId: z.string().min(1).max(128), goalId: z.string().min(1).max(128).optional() }).strict(),
      handler: (input) => context.services.resourceSnapshot?.get(context.actor, {
        workspaceId: input.workspaceId,
        ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
      }) ?? Promise.resolve(missingService()),
    }),
    defineTool({
      name: 'call_history',
      description: 'Read server-observed correlated MCP calls from bounded SQLite audit records. Values without measured transport spans remain null/unknown; supports filters and opaque keyset pagination.',
      permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: z.object({
        workspaceId: z.string().min(1).max(128),
        goalId: z.string().min(1).max(128).optional(),
        toolName: z.string().min(1).max(128).optional(),
        transport: z.enum(['local_stdio','loopback_http','secure_tunnel','external_mcp','unknown']).optional(),
        since: z.string().datetime().optional(), until: z.string().datetime().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().min(1).max(1024).optional(),
      }).strict(),
      handler: (input) => context.services.callHistory?.history(context.actor, {
        workspaceId: input.workspaceId,
        ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
        ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
        ...(input.transport === undefined ? {} : { transport: input.transport }),
        ...(input.since === undefined ? {} : { since: input.since }),
        ...(input.until === undefined ? {} : { until: input.until }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      }) ?? Promise.resolve(missingService()),
    }),
    defineTool({
      name: 'goal_result',
      description: 'Read evidence-limited Durable Goal results. Never attributes legacy operations without a server-verified Goal lease.',
      permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: z.object({ workspaceId: z.string().min(1).max(128), goalId: z.string().min(1).max(128) }).strict(),
      handler: (input) => context.services.taskResults?.get(context.actor, input.workspaceId, input.goalId) ?? Promise.resolve(missingService()),
    }),
    defineTool({
      name: 'workflow_templates',
      description: 'List six built-in Thai/English workflows for a registered workspace. Read-only; does not create a Goal.',
      permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: z.object({ workspaceId: z.string().min(1).max(128) }).strict(),
      handler: (input) => context.services.workflowTemplates?.list(context.actor, input.workspaceId) ?? Promise.resolve(missingService()),
    }),
    defineTool({
      name: 'workflow_prepare',
      description: 'Validate bounded inputs, workspace paths, provider readiness, and return a deterministic preview. No side effects.',
      permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: prepare,
      handler: (input) => context.services.workflowTemplates?.prepare(context.actor, input) ?? Promise.resolve(missingService()),
    }),
    defineTool({
      name: 'workflow_start',
      description: 'Start or attach the selected validated workflow to an existing Durable Goal contract with hashed idempotency key. Never creates any scheduled task; caller must hold returned Goal lease to execute.',
      permission: 'WRITE', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({ draft, idempotencyKey: z.string().min(1).max(256) }).strict(),
      handler: (input) => context.services.workflowStart?.start(context.actor, input) ?? Promise.resolve(missingService()),
    }),
  ];
}
