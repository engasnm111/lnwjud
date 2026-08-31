import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { DiagnosticLogger, FileActor } from '@lnwjud/application';
import type { PermissionProfile } from '@lnwjud/permissions';
import { APP_NAME, APP_VERSION, type DestructiveAutoApprovalPolicy } from '@lnwjud/shared';
import { readTraceContext, type ActivitySink, type ActivityTracker } from './activity-tracker.js';
import { withProgressHeartbeat, type ProgressNotifyContext } from './progress-heartbeat.js';
import { IncrementalVerifier } from './incremental-verifier.js';
import { RunBudgetGuard, type RunBudgetContext } from './run-budget.js';
import { registerTasksProtocol } from './tasks-protocol.js';
import { ToolRegistry, type ActiveProjectScope, type AuthorizationMode, type HostMutationApprovalRequest, type McpApplicationServices, type WorkspaceScope } from './tool-registry.js';
import type { SetOfMarksObservationStore } from './set-of-marks-service.js';
import { actorForRequestScope, type McpRequestScope } from './request-scope.js';

export const MCP_OUTCOME_DRIVEN_INSTRUCTIONS = [
  'Continue using lnwjud tools until the requested outcome is complete.',
  'Do not stop, hand off, or ask the user to say "continue" merely because elapsed time has passed.',
  'Stop only when the outcome is complete, a user decision or new authority is required, or an external blocker prevents safe progress.',
  'Use durable background tasks for naturally long-running commands, then keep checking them and continue the work while the current run remains active.',
].join(' ');

export interface McpServerOptions {
  readonly services: McpApplicationServices;
  readonly actor: FileActor;
  readonly requestScope?: McpRequestScope;
  readonly diagnostic?: DiagnosticLogger;
  readonly activity?: ActivitySink;
  readonly activityTracker?: ActivityTracker;
  readonly profileProvider?: () => PermissionProfile;
  readonly authorizationModeProvider?: () => AuthorizationMode;
  readonly allowAiDeleteProvider?: () => boolean;
  readonly destructivePolicyProvider?: () => DestructiveAutoApprovalPolicy;
  readonly activeWorkspaceScopeProvider?: () => WorkspaceScope | null | Promise<WorkspaceScope | null>;
  /** Host-owned active project set. The first scope is the primary/default workspace. */
  readonly activeWorkspaceScopesProvider?: () => readonly WorkspaceScope[] | Promise<readonly WorkspaceScope[]>;
  readonly hostMutationApprovalProvider?: (request: HostMutationApprovalRequest) => boolean | Promise<boolean>;
  /** @deprecated Request-selected workspace lookup is not an authorization boundary. */
  readonly workspaceScopeResolver?: (workspaceId: string) => WorkspaceScope | null | Promise<WorkspaceScope | null>;
  /** @deprecated Compatibility alias for activeWorkspaceScopeProvider. */
  readonly activeProjectProvider?: () => ActiveProjectScope | null;
  /** Exposes quota-consuming Codex delegation tools. Disabled unless explicitly enabled. */
  readonly codexToolsEnabled?: boolean;
  /** Shared across per-request server factories so repeated diff fingerprints can hit cache. */
  readonly incrementalVerifier?: IncrementalVerifier;
  /** Shared by transport-scoped server factories so visual observations survive the next MCP request. */
  readonly setOfMarksStore?: SetOfMarksObservationStore;
  /** Compatibility result guard; it must not apply elapsed-time behavior. */
  readonly runBudgetGuard?: RunBudgetGuard;
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const actor = actorForRequestScope(options.actor, options.requestScope);
  const registry = new ToolRegistry(options.services, actor, {
    ...(options.diagnostic === undefined ? {} : { diagnostic: options.diagnostic }),
    ...(options.activity === undefined ? {} : { activity: options.activity }),
    ...(options.activityTracker === undefined ? {} : { activityTracker: options.activityTracker }),
    ...(options.requestScope === undefined ? {} : { sessionId: options.requestScope.sessionId }),
    ...(options.profileProvider === undefined ? {} : { profileProvider: options.profileProvider }),
    ...(options.authorizationModeProvider === undefined ? {} : { authorizationModeProvider: options.authorizationModeProvider }),
    ...(options.allowAiDeleteProvider === undefined ? {} : { allowAiDeleteProvider: options.allowAiDeleteProvider }),
    ...(options.destructivePolicyProvider === undefined ? {} : { destructivePolicyProvider: options.destructivePolicyProvider }),
    ...(options.activeWorkspaceScopeProvider === undefined ? {} : { activeWorkspaceScopeProvider: options.activeWorkspaceScopeProvider }),
    ...(options.activeWorkspaceScopesProvider === undefined ? {} : { activeWorkspaceScopesProvider: options.activeWorkspaceScopesProvider }),
    ...(options.hostMutationApprovalProvider === undefined ? {} : { hostMutationApprovalProvider: options.hostMutationApprovalProvider }),
    ...(options.workspaceScopeResolver === undefined ? {} : { workspaceScopeResolver: options.workspaceScopeResolver }),
    ...(options.activeProjectProvider === undefined ? {} : { activeProjectProvider: options.activeProjectProvider }),
    ...(options.codexToolsEnabled === undefined ? {} : { codexToolsEnabled: options.codexToolsEnabled }),
    ...(options.incrementalVerifier === undefined ? {} : { incrementalVerifier: options.incrementalVerifier }),
    ...(options.setOfMarksStore === undefined ? {} : { setOfMarksStore: options.setOfMarksStore }),
  });
  const runBudgetGuard = options.runBudgetGuard ?? new RunBudgetGuard();
  // tasks capability (MCP spec 2025-11-25) exposes existing durable shell
  // background tasks via tasks/get/result/list/cancel. requests.tools.call is
  // intentionally not declared, so clients will not send task-augmented
  // tool calls.
  const server = new McpServer({ name: APP_NAME, version: APP_VERSION }, {
    capabilities: {
      tools: {},
      tasks: { list: {}, cancel: {} },
    },
    instructions: MCP_OUTCOME_DRIVEN_INSTRUCTIONS,
  });
  registerTasksProtocol(server, options.services, { actor });
  for (const tool of registry.list()) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    }, async (input: unknown, context): Promise<CallToolResult> => {
      const dispatchContext = context as ProgressNotifyContext & RunBudgetContext;
      runBudgetGuard.begin(dispatchContext);
      const result = await withProgressHeartbeat(dispatchContext, tool.name, async () => (
        registry.invoke(tool.name, input, readTraceContext(context)) as unknown as Promise<CallToolResult>
      ));
      return runBudgetGuard.finish(dispatchContext, result);
    });
  }
  return server;
}
