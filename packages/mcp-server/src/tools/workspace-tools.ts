import { appError, ok, type AppError } from '@lnwjud/domain';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import {
  projectSnapshotSchema,
  workspaceInfoSchema,
  workspaceListSchema,
  workspaceRegisterSchema,
  workspacePathPreflightSchema,
  workspaceWriterLeaseAcquireSchema,
  workspaceWriterLeaseStatusSchema,
  workspaceWriterLeaseProofActionSchema,
  workspaceTreeSchema,
} from './schemas.js';

type RegistrationIndexState =
  | { readonly status: 'ready' }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'failed'; readonly error: AppError };

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
      name: 'workspace_path_preflight',
      description: 'Read-only exact absolute-path preflight before workspace registration. Requires explicit authorization; probes only the nominated path and ancestors without directory listing, registration, indexing, shell, writes or lease. Windows effective ACL/reparse proof is reported UNVERIFIABLE where the runtime cannot prove it. Registration always revalidates independently.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspacePathPreflightSchema,
      handler: async (input, _signal, authorization) => context.services.workspaceInfo?.preflight === undefined
        ? missingService()
        : context.services.workspaceInfo.preflight(context.actor, { path: input.path, ...(input.userConfirmed === undefined ? {} : { userConfirmed: input.userConfirmed }) }, authorization),
    }),
    defineTool({
      name: 'workspace_writer_lease_acquire',
      description: 'Acquire a durable exclusive writer lease for one registered workspace. The exclusive native-admission probe may reconcile an authenticated native-bound reservation only after a verified newer OS boot and an absent attempt Job; unprovable, active or import-held records stay blocked. Explicit recoverAbandoned with user confirmation may fence an idle previous session of the same client after 60 seconds; unrelated clients and active/unknown writers remain blocked.',
      permission: 'WRITE', annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: workspaceWriterLeaseAcquireSchema,
      handler: async (input) => context.services.workspaceWriterLease === undefined ? missingService()
        : context.services.workspaceWriterLease.acquire(input.workspaceId, context.actor.clientId, context.actor.sessionId ?? context.actor.clientId, input.ttlSeconds ?? 600,
          input.recoverAbandoned === true && input.userConfirmed === true),
    }),
    defineTool({
      name: 'workspace_writer_lease_status',
      description: 'Inspect a registered workspace writer lease without exposing its credential.',
      permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: workspaceWriterLeaseStatusSchema,
      handler: async (input) => context.services.workspaceWriterLease === undefined ? missingService()
        : context.services.workspaceWriterLease.inspect(input.workspaceId),
    }),
    defineTool({
      name: 'workspace_writer_lease_renew',
      description: 'Renew only the exact matching workspace writer lease for this caller session.',
      permission: 'WRITE', annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: workspaceWriterLeaseProofActionSchema,
      handler: async (input) => context.services.workspaceWriterLease === undefined ? missingService()
        : context.services.workspaceWriterLease.renew(input.workspaceId, context.actor.clientId, context.actor.sessionId ?? context.actor.clientId, input.writerLease, input.ttlSeconds ?? 600),
    }),
    defineTool({
      name: 'workspace_writer_lease_release',
      description: 'Release an owned workspace writer lease only when no fenced invocation is active.',
      permission: 'WRITE', annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: workspaceWriterLeaseProofActionSchema,
      handler: async (input) => context.services.workspaceWriterLease === undefined ? missingService()
        : context.services.workspaceWriterLease.release(input.workspaceId, context.actor.clientId, context.actor.sessionId ?? context.actor.clientId, input.writerLease),
    }),
    defineTool({
      name: 'workspace_register',
      description: 'Register an existing project directory by absolute path. parentWorkspaceId is optional and retained only for legacy machine-root-relative registration. Idempotent for the same path.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: workspaceRegisterSchema,
      handler: async (input, signal) => {
        if (context.services.workspaceInfo === undefined || context.services.workspaceInfo.register === undefined) return missingService();
        const registered = await context.services.workspaceInfo.register(context.actor, {
          ...(input.parentWorkspaceId === undefined ? {} : { parentWorkspaceId: input.parentWorkspaceId }),
          path: input.path,
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        });
        if (!registered.ok) return registered;
        const workspaceId = readWorkspaceId(registered.value);
        let indexing: RegistrationIndexState = { status: 'unavailable', reason: 'Workspace indexing service is unavailable' };
        if (workspaceId === undefined) {
          indexing = { status: 'unavailable', reason: 'Registration did not return a workspace ID' };
        } else if (context.services.workspaceIndex !== undefined) {
          try {
            const indexed = await context.services.workspaceIndex.indexWorkspace(workspaceId, { signal });
            indexing = indexed.ok ? { status: 'ready' } : { status: 'failed', error: indexed.error };
          } catch {
            indexing = { status: 'failed', error: appError('INTERNAL_ERROR', 'Workspace registration succeeded but indexing failed', true) };
          }
        }
        const registration = typeof registered.value === 'object' && registered.value !== null && !Array.isArray(registered.value)
          ? registered.value : { registration: registered.value };
        return ok({ ...registration, indexing: {
          ...indexing,
          ...(indexing.status === 'ready' || workspaceId === undefined ? {} : { retry: { tool: 'workspace_index', arguments: { workspaceId } } }),
        } });
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
  const id = value.id;
  return typeof id === 'string' && id.trim().length > 0 ? id : undefined;
}
