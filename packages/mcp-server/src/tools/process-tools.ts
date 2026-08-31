import type { CommandSpec } from '@lnwjud/domain';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { processHandleSchema, processLogsSchema, processStartSchema, processStopSchema, projectCommandSchema } from './schemas.js';

type ProjectCommandKind = 'dev' | 'test' | 'lint' | 'typecheck' | 'build';

export function processTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'process_start',
      description: 'Immediate-return managed process launcher for real executables and long-lived processes. With Full Bypass OFF, inline text-file rewrites must use edit_file/apply_patch/write_file and risky commands, scope changes, or permission-profile ASK decisions require confirmation. Trusted Full Bypass skips lnwjud command/profile/scope approval, including an explicitly absolute cwd outside the Active Project; input validation, executable availability, OS rights, and exact process ownership still apply. Starts one executable with separate arguments and returns processId as soon as the child is spawned; it never waits for command completion. Follow with process_status/process_logs/process_stop. For restart-safe durable work, use shell, whose MCP run mode is forced to background.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: processStartSchema,
      handler: async (input, signal, authorization) => context.services.process === undefined
        ? missingService()
        : context.services.process.start(context.actor, input.workspaceId, {
          executable: input.executable,
          args: input.args,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          ...(input.userConfirmed === undefined ? {} : { userConfirmed: input.userConfirmed }),
        }, signal, authorization),
    }),
    defineTool({
      name: 'process_list',
      description: 'List managed process handles owned by this client in a workspace, including launches whose response was cancelled.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: processHandleSchema.pick({ workspaceId: true }),
      handler: async (input) => context.services.process === undefined
        ? missingService()
        : context.services.process.list(context.actor, input.workspaceId),
    }),
    defineTool({
      name: 'process_status',
      description: 'Read one status snapshot for an owned process handle. Do not tight-poll this tool; use project_* for normal project verification, or shell background + durable task_id for work expected to exceed ~5 minutes.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: processHandleSchema,
      handler: async (input) => context.services.process === undefined
        ? missingService()
        : context.services.process.status(context.actor, input.workspaceId, input.processId),
    }),
    defineTool({
      name: 'process_logs',
      description: 'Read bounded logs for an owned process handle. Prefer one bounded log read after meaningful progress rather than repeated status polling.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: processLogsSchema,
      handler: async (input) => context.services.process === undefined
        ? missingService()
        : context.services.process.logs(context.actor, input.workspaceId, input.processId, {
          ...(input.tailLines === undefined ? {} : { tailLines: input.tailLines }),
          ...(input.sinceSequence === undefined ? {} : { sinceSequence: input.sinceSequence }),
        }),
    }),
    defineTool({
      name: 'process_stop',
      description: 'Stop an owned managed process tree after explicit chat confirmation in standard mode. Trusted Full Bypass skips the lnwjud confirmation gate; exact process ownership still applies.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: processStopSchema,
      handler: async (input, _signal, authorization) => context.services.process === undefined
        ? missingService()
        : context.services.process.stop(context.actor, input.workspaceId, input.processId, input.userConfirmed === true, authorization),
    }),
    ...projectCommandTools(context),
  ];
}

function projectCommandTools(context: McpToolContext): McpToolDefinition[] {
  const definitions: { readonly name: string; readonly kind: ProjectCommandKind }[] = [
    { name: 'project_dev', kind: 'dev' },
    { name: 'project_test', kind: 'test' },
    { name: 'project_lint', kind: 'lint' },
    { name: 'project_typecheck', kind: 'typecheck' },
    { name: 'project_build', kind: 'build' },
  ];
  return definitions.map(({ name, kind }) => defineTool({
    name,
    description: `Immediate-return launcher for the detected project ${kind} command. In standard mode the gateway previews the exact executable/argv for host approval and re-resolves it immediately before spawn; any change requires fresh approval. Trusted Full Bypass skips the lnwjud approval boundary. Project-owned script bodies remain opaque and are not covered by Recovery Trash.`,
    permission: 'EXECUTE',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: projectCommandSchema,
    handler: async (input, signal, authorization) => context.services.process === undefined
      ? missingService()
      : context.services.process.startProjectCommand(
        context.actor,
        input.workspaceId,
        kind,
        signal,
        input.userConfirmed === true,
        readApprovedProjectCommand(input),
        authorization,
      ),
  }));
}

function readApprovedProjectCommand(input: unknown): CommandSpec | undefined {
  if (typeof input !== 'object' || input === null || !('__lnwjudApprovedProjectCommand' in input)) return undefined;
  const value = (input as { __lnwjudApprovedProjectCommand?: unknown }).__lnwjudApprovedProjectCommand;
  if (typeof value !== 'object' || value === null) return undefined;
  const executable = (value as { executable?: unknown }).executable;
  const args = (value as { args?: unknown }).args;
  if (typeof executable !== 'string' || !Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return undefined;
  return { executable, args };
}
