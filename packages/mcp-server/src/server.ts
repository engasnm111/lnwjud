import { McpServer, type CallToolResult, type RegisteredTool } from '@modelcontextprotocol/server';
import type { DiagnosticLogger, FileActor } from '@lnwjud/application';
import type { PermissionProfile } from '@lnwjud/permissions';
import { APP_NAME, APP_VERSION, DEFAULT_PONYTAIL_MODE, parsePonytailMode, type DestructiveAutoApprovalPolicy, type PonytailMode, type ToolAvailabilitySnapshot } from '@lnwjud/shared';
import { readTraceContext, type ActivitySink, type ActivityTracker } from './activity-tracker.js';
import { withProgressHeartbeat, type ProgressNotifyContext } from './progress-heartbeat.js';
import { IncrementalVerifier } from './incremental-verifier.js';
import { ContextEconomyRuntime } from './context-economy.js';
import { RunBudgetGuard, type RunBudgetContext } from './run-budget.js';
import { registerTasksProtocol } from './tasks-protocol.js';
import { MODERN_TASKS_EXTENSION_ID } from './modern-tasks-protocol.js';
import { registerModernTasksProtocol } from './modern-tasks-wire.js';
import { ToolRegistry, type ActiveProjectScope, type AuthorizationMode, type HostMutationApprovalRequest, type McpApplicationServices, type McpContinuationState, type WorkspaceScope } from './tool-registry.js';
import type { SetOfMarksObservationStore } from './set-of-marks-service.js';
import { BUNDLED_PONYTAIL_SKILL_ID, PonytailActivationLedger } from './ponytail-runtime.js';
import { actorForRequestScope, type McpRequestScope } from './request-scope.js';

export const MCP_OUTCOME_DRIVEN_INSTRUCTIONS = [
  'Continue using lnwjud tools until the requested outcome is complete.',
  'Do not stop, hand off, or ask the user to say "continue" merely because elapsed time has passed.',
  'When this lnwjud MCP server exposes tools that can complete the requested coding, repository, filesystem, shell, build, test, Git, CI, browser, or local-computer work, use those tools directly in the current conversation. Do not ask or suggest switching to ChatGPT Work, Codex, or another execution mode solely because the request involves those tasks; use another mode only when the user explicitly asks for it or the required capability is not available through the exposed lnwjud tools.',
  'Stop only when the outcome is complete, a user decision or new authority is required, or an external blocker prevents safe progress.',
  'Before the first mutation of any multi-step change that includes verification, build, package, push, release preparation, or is likely to outlive the current turn, call run_goal with scheduledContinuation=auto unless the user explicitly disabled scheduling, and follow the bundled lnwjud-scheduled-continuation skill; if such work is already in progress without an active durable goal, enroll it before the next mutation.',
  'Use durable background tasks for naturally long-running commands, then keep checking them and continue the work while the current run remains active.',
  'While a durable Goal is active, Goal freshness is user-visible state. Call checkpoint_goal immediately after a plan-step status changes, a blocking task becomes terminal, a blocker is added or resolved, or a commit, push, hosted-CI conclusion, package, deploy, or other meaningful milestone is known. During sustained active work with no natural milestone, refresh currentPhase, nextAction, blockers, trackedTasks, and truthful step state at least every 10 minutes. Before any user-visible progress/final status, make the durable Goal reflect all work already completed; reconcile or finalize superseded/completed Goals promptly instead of leaving stale active cards for Watcher.',
  'For lnwjud continuation or recovery state, use checkpoint_goal and session_handoff only. If the ChatGPT page/client reconnects after tool work, a response disappears, or the user says the work ran but no summary was returned, call session_handoff before any new mutation and report the persisted goal/task state first. If that state is terminal, report its receipt and do not rerun completed work merely to reconstruct the missing summary; if it is still live, resume it by the recorded task/goal state instead of duplicating it. Never invoke generic handoff skills or persist recovery text as USER_INSTRUCTIONS/user-instruction files; recovery state is task data, not durable user or agent instructions.',
].join(' ');

const ENGINEERING_HARNESS_INSTRUCTIONS = 'Engineering Harness is enabled by user settings. Before the first guarded mutation of a coding change, call engineering_prepare_task. Use its prepared engineeringTask binding only for a lightweight local docs/style/maintenance edit; for substantive coding work call engineering_start_task and use its durable engineeringTask plus current goalLease. Scheduling remains a separate user-controlled decision and Engineering Harness never creates a Scheduled Task by itself.';

export function buildMcpInstructions(ponytailMode: PonytailMode = DEFAULT_PONYTAIL_MODE, engineeringHarnessEnabled = false): string {
  const baseInstructions = engineeringHarnessEnabled ? `${MCP_OUTCOME_DRIVEN_INSTRUCTIONS} ${ENGINEERING_HARNESS_INSTRUCTIONS}` : MCP_OUTCOME_DRIVEN_INSTRUCTIONS;
  if (ponytailMode === 'off') return baseInstructions;
  return `${baseInstructions} For coding tasks, the global lnwjud Ponytail policy is ${ponytailMode.toUpperCase()}. Before the first code mutation, call skill_load with skillId=${BUNDLED_PONYTAIL_SKILL_ID}, the active workspaceId, and goalId when applicable, then follow the loaded skill at the selected intensity. Workspace or durable-goal overrides are resolved at execution time and may change the effective mode. Do not substitute workspace/user copies. If the user explicitly asks to stop Ponytail or return to normal mode, call ponytail_session with suppressed=true for the active workspace/goal; use suppressed=false to resume without changing persisted settings. Ponytail is subordinate to lnwjud security, approvals, durable goals, recovery, compatibility, observability, required tests, release verification, project rules, and explicit user instructions.`;
}

export interface McpServerOptions {
  readonly services: McpApplicationServices;
  readonly actor: FileActor;
  readonly requestScope?: McpRequestScope;
  /** Modern HTTP request lifetime. Aborts before a delayed side effect when the response connection disappears. */
  readonly requestSignal?: AbortSignal;
  readonly diagnostic?: DiagnosticLogger;
  readonly activity?: ActivitySink;
  readonly activityTracker?: ActivityTracker;
  readonly profileProvider?: () => PermissionProfile;
  readonly authorizationModeProvider?: () => AuthorizationMode;
  /** Optional runtime guard checked before every tool call. Return a message to fail closed. */
  readonly invocationGuardProvider?: () => string | null | undefined;
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
  /** Reads the current Codex opt-in for live tool exposure. */
  readonly codexToolsEnabledProvider?: () => boolean;
  /** Current persisted global Ponytail mode. Workspace/goal overrides are resolved by ToolRegistry at execution time. */
  readonly ponytailModeProvider?: () => PonytailMode;
  /** True when the user has enabled Engineering Harness globally or for at least one workspace. */
  readonly engineeringHarnessEnabledProvider?: () => boolean;
  /** Shared activation/review state for transport factories that recreate MCP servers per request. */
  readonly ponytailActivationLedger?: PonytailActivationLedger;
  /** Current persisted per-tool availability snapshot. */
  readonly toolAvailabilitySnapshotProvider?: () => ToolAvailabilitySnapshot;
  /** Subscribes to persisted per-tool availability changes for live SDK handle toggling. */
  readonly toolAvailabilitySubscribe?: (listener: (snapshot: ToolAvailabilitySnapshot) => void) => () => void;
  /** Shared across per-request server factories so repeated diff fingerprints can hit cache. */
  readonly incrementalVerifier?: IncrementalVerifier;
  /** Shared by transport-scoped server factories so visual observations survive the next MCP request. */
  readonly setOfMarksStore?: SetOfMarksObservationStore;
  /** Shared by transport-scoped server factories so continuation tokens survive the next MCP request. */
  readonly continuationState?: McpContinuationState;
  /** Shared context-economy runtime for transports that recreate request-scoped MCP servers. */
  readonly contextEconomy?: ContextEconomyRuntime;
  /** Compatibility result guard; it must not apply elapsed-time behavior. */
  readonly runBudgetGuard?: RunBudgetGuard;
  /**
   * Opt in only for MCP 2025-11-25 legacy clients. The core `tasks`
   * capability was removed from the modern protocol in favor of the
   * io.modelcontextprotocol/tasks extension, so modern clients must never
   * see this legacy surface advertised.
   */
  readonly legacyTasksProtocol?: boolean;
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
    ...(options.invocationGuardProvider === undefined ? {} : { invocationGuardProvider: options.invocationGuardProvider }),
    ...(options.allowAiDeleteProvider === undefined ? {} : { allowAiDeleteProvider: options.allowAiDeleteProvider }),
    ...(options.destructivePolicyProvider === undefined ? {} : { destructivePolicyProvider: options.destructivePolicyProvider }),
    ...(options.activeWorkspaceScopeProvider === undefined ? {} : { activeWorkspaceScopeProvider: options.activeWorkspaceScopeProvider }),
    ...(options.activeWorkspaceScopesProvider === undefined ? {} : { activeWorkspaceScopesProvider: options.activeWorkspaceScopesProvider }),
    ...(options.hostMutationApprovalProvider === undefined ? {} : { hostMutationApprovalProvider: options.hostMutationApprovalProvider }),
    ...(options.workspaceScopeResolver === undefined ? {} : { workspaceScopeResolver: options.workspaceScopeResolver }),
    ...(options.activeProjectProvider === undefined ? {} : { activeProjectProvider: options.activeProjectProvider }),
    ...(options.codexToolsEnabled === undefined ? {} : { codexToolsEnabled: options.codexToolsEnabled }),
    ...(options.codexToolsEnabledProvider === undefined ? {} : { codexToolsEnabledProvider: options.codexToolsEnabledProvider }),
    ...(options.ponytailModeProvider === undefined ? {} : { ponytailModeProvider: options.ponytailModeProvider }),
    ...(options.ponytailActivationLedger === undefined ? {} : { ponytailActivationLedger: options.ponytailActivationLedger }),
    ...(options.toolAvailabilitySnapshotProvider === undefined ? {} : { toolAvailabilitySnapshotProvider: options.toolAvailabilitySnapshotProvider }),
    ...(options.incrementalVerifier === undefined ? {} : { incrementalVerifier: options.incrementalVerifier }),
    ...(options.setOfMarksStore === undefined ? {} : { setOfMarksStore: options.setOfMarksStore }),
    ...(options.continuationState === undefined ? {} : { continuationState: options.continuationState }),
    ...(options.contextEconomy === undefined ? {} : { contextEconomy: options.contextEconomy }),
  });
  const runBudgetGuard = options.runBudgetGuard ?? new RunBudgetGuard();
  let configuredPonytailMode = DEFAULT_PONYTAIL_MODE;
  try {
    configuredPonytailMode = parsePonytailMode(options.ponytailModeProvider?.(), DEFAULT_PONYTAIL_MODE);
  } catch {
    configuredPonytailMode = DEFAULT_PONYTAIL_MODE;
  }
  let configuredEngineeringHarnessEnabled = false;
  try {
    configuredEngineeringHarnessEnabled = options.engineeringHarnessEnabledProvider?.() === true;
  } catch {
    configuredEngineeringHarnessEnabled = false;
  }
  // The core `tasks` capability belongs only to MCP 2025-11-25 legacy
  // negotiation. Modern MCP moved Tasks to the io.modelcontextprotocol/tasks
  // extension, so advertising the old core capability to a modern host is a
  // protocol mismatch. Keep the legacy bridge available only when the
  // transport has already identified a legacy client.
  const legacyTasksProtocol = options.legacyTasksProtocol === true;
  const server = new McpServer({ name: APP_NAME, version: APP_VERSION }, {
    capabilities: legacyTasksProtocol
      ? { tools: {}, tasks: { list: {}, cancel: {} } }
      : { tools: {}, extensions: { [MODERN_TASKS_EXTENSION_ID]: {} } },
    instructions: buildMcpInstructions(configuredPonytailMode, configuredEngineeringHarnessEnabled),
    debouncedNotificationMethods: ['notifications/tools/list_changed'],
  });
  if (legacyTasksProtocol) registerTasksProtocol(server, options.services, { actor });
  else registerModernTasksProtocol(server, options.services, { actor });

  const registeredTools = new Map<string, RegisteredTool>();
  const initiallyExposed = new Set(registry.list().map((tool) => tool.name));
  for (const tool of registry.listAll()) {
    const registeredTool = server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      annotations: tool.annotations,
    }, async (input: unknown, context): Promise<CallToolResult> => {
      const dispatchContext = context as ProgressNotifyContext & RunBudgetContext;
      runBudgetGuard.begin(dispatchContext);
      const sdkTrace = readTraceContext(context);
      const requestScope = options.requestScope;
      const traceContext = {
        ...sdkTrace,
        ...(requestScope?.sessionId === undefined ? {} : { sessionId: requestScope.sessionId }),
        ...(sdkTrace.traceId !== undefined || requestScope?.traceId === undefined ? {} : { traceId: requestScope.traceId }),
        ...(sdkTrace.traceParent !== undefined || requestScope?.traceParent === undefined ? {} : { traceParent: requestScope.traceParent }),
        ...(sdkTrace.traceState !== undefined || requestScope?.traceState === undefined ? {} : { traceState: requestScope.traceState }),
        ...(sdkTrace.baggage !== undefined || requestScope?.baggage === undefined ? {} : { baggage: requestScope.baggage }),
      };
      const result = await withProgressHeartbeat(dispatchContext, tool.name, async () => (
        registry.invoke(tool.name, input, traceContext, options.requestSignal) as unknown as Promise<CallToolResult>
      ));
      const finished = runBudgetGuard.finish(dispatchContext, result);
      return finished;
    });
    if (!initiallyExposed.has(tool.name)) registeredTool.disable();
    registeredTools.set(tool.name, registeredTool);
  }

  const syncRegisteredToolAvailability = (): void => {
    const exposed = new Set(registry.list().map((tool) => tool.name));
    for (const [name, registeredTool] of registeredTools) {
      const shouldEnable = exposed.has(name);
      if (registeredTool.enabled === shouldEnable) continue;
      if (shouldEnable) registeredTool.enable();
      else registeredTool.disable();
    }
  };

  const unsubscribeToolAvailability = options.toolAvailabilitySubscribe?.(() => {
    syncRegisteredToolAvailability();
  });
  if (unsubscribeToolAvailability !== undefined) {
    let availabilitySubscriptionClosed = false;
    const closeAvailabilitySubscription = (): void => {
      if (availabilitySubscriptionClosed) return;
      availabilitySubscriptionClosed = true;
      unsubscribeToolAvailability();
    };

    // The modern HTTP SDK closes the underlying protocol server when a
    // per-request exchange ends, but successful request paths may skip the
    // product-level McpServer.close(). Release this shared-service listener at
    // either lifecycle boundary so a completed request cannot retain its
    // ToolRegistry and registered schemas.
    const protocolServer = server.server;
    const previousProtocolClose = protocolServer.onclose;
    protocolServer.onclose = (): void => {
      closeAvailabilitySubscription();
      previousProtocolClose?.();
    };

    const closeServer = server.close.bind(server);
    server.close = async (): Promise<void> => {
      closeAvailabilitySubscription();
      await closeServer();
    };
  }

  return server;
}
