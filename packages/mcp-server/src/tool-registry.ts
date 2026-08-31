import path from 'node:path';
import {
  appError,
  err,
  ok,
  type CommandSpec,
  type GoalLeaseProof,
  type InvocationAuthorization,
  type InvocationAuthorizationMode,
  type InvocationAuthorizationSource,
} from '@lnwjud/domain';
import { z } from 'zod';
import { sanitizeException, type DiagnosticLogger, type FileActor } from '@lnwjud/application';
import { CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY } from '@lnwjud/capabilities';
import { DefaultPermissionEngine, permissionProfiles, type PermissionProfile } from '@lnwjud/permissions';
import { DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY, prohibitedAgentCommandReason, prohibitedAgentGitInvocationReason, type DestructiveAutoApprovalPolicy } from '@lnwjud/shared';
import { ActivityTracker, summarizeStructuredResultTarget, summarizeToolTarget, type ActivitySink, type TraceContext } from './activity-tracker.js';
import { ContextEngine } from './context-engine.js';
import { ContextEconomyRuntime } from './context-economy.js';
import { hasExplicitUserConfirmation } from './destructive-policy.js';
import { isScopedAutoApprovalAllowed, type WorkspaceScope } from './destructive-scope.js';
import { FilePageEngine } from './file-page-engine.js';
import { IncrementalVerifier } from './incremental-verifier.js';
import { inspectMutationOperation, permissionLevelForMutationDecision, requiresMutationConfirmation, type MutationPolicyDecision } from './mutation-policy.js';
import { mapError, mapResult, type McpToolResponse } from './result-mapper.js';
import { batchTools } from './tools/batch-tools.js';
import { contextTools } from './tools/context-tools.js';
import { filePageTools } from './tools/file-page-tools.js';
import { workspaceIndexTools } from './tools/workspace-index-tools.js';
import { upgradeTools } from './tools/upgrade-tools.js';
import { ToolSchemaRegistry } from './tool-schema-registry.js';
import { isAdvertisedDeliveryState } from './tool-delivery-contract.js';
import { upgradeCatalogEntry } from './upgrade-catalog.js';
import type { SetOfMarksObservationStore } from './set-of-marks-service.js';
import { codexTools } from './tools/codex-tools.js';
import { capabilityTools } from './tools/capability-tools.js';
import { fileTools } from './tools/file-tools.js';
import { gitTools } from './tools/git-tools.js';
import { goalTools } from './tools/goal-tools.js';
import { mcpBridgeTools } from './tools/mcp-bridge-tools.js';
import { processTools } from './tools/process-tools.js';
import { sessionTools } from './tools/session-tools.js';
import { searchTools } from './tools/search-tools.js';
import { scheduledContinuationTools } from './tools/scheduled-continuation-tools.js';
import { skillTools } from './tools/skill-tools.js';
import { workspaceTools } from './tools/workspace-tools.js';
import type { McpApplicationServices, McpToolContext, McpToolDefinition } from './tools/tool-types.js';

export type { McpApplicationServices } from './tools/tool-types.js';
export type { ActiveProjectScope, WorkspaceScope } from './destructive-scope.js';
export type AuthorizationMode = InvocationAuthorizationMode;

export interface ToolRegistryOptions {
  readonly diagnostic?: DiagnosticLogger;
  readonly activity?: ActivitySink;
  readonly activityTracker?: ActivityTracker;
  readonly sessionId?: string;
  readonly profileProvider?: () => PermissionProfile;
  /** Explicit transport-scoped authorization override. Effective only while the active profile is Full. */
  readonly authorizationModeProvider?: () => AuthorizationMode;
  /** Legacy compatibility. New callers should supply destructivePolicyProvider. */
  readonly allowAiDeleteProvider?: () => boolean;
  /** Fine-grained local destructive auto-approval policy. */
  readonly destructivePolicyProvider?: () => DestructiveAutoApprovalPolicy;
  /** @deprecated Request-selected workspace lookup is not an authorization boundary. */
  readonly workspaceScopeResolver?: (workspaceId: string) => WorkspaceScope | null | Promise<WorkspaceScope | null>;
  /** Host-owned active workspace used as the mutation authorization boundary. */
  readonly activeWorkspaceScopeProvider?: () => WorkspaceScope | null | Promise<WorkspaceScope | null>;
  /** Host-owned active project set; first entry is the primary/default project. */
  readonly activeWorkspaceScopesProvider?: () => readonly WorkspaceScope[] | Promise<readonly WorkspaceScope[]>;
  /** @deprecated Compatibility alias for activeWorkspaceScopeProvider. */
  readonly activeProjectProvider?: () => WorkspaceScope | null;
  /** Host-owned exact-action approval boundary, such as a native desktop confirmation dialog. */
  readonly hostMutationApprovalProvider?: (request: HostMutationApprovalRequest) => boolean | Promise<boolean>;
  /** Exposes quota-consuming Codex delegation tools. Disabled unless explicitly enabled. */
  readonly codexToolsEnabled?: boolean;
  readonly incrementalVerifier?: IncrementalVerifier;
  readonly setOfMarksStore?: SetOfMarksObservationStore;
  readonly maxToolDurationMs?: number;
}

export interface HostMutationApprovalRequest {
  readonly toolName: string;
  readonly mutationKind: MutationPolicyDecision['kind'];
  readonly reason: string;
  readonly summary: string;
  readonly workspaceId?: string;
  readonly workspaceRoot?: string;
}

const DEFAULT_MCP_TOOL_RESPONSE_BUDGET_MS: number | null = null;
const MAX_APPROVAL_SUMMARY_LENGTH = 8_192;
const MAX_REMEMBERED_SHELL_TASKS = 512;
const MAX_REMEMBERED_ACTIVITY_HANDLES = 512;

interface BudgetedToolExecution {
  readonly response: McpToolResponse;
  readonly deferredSettlement?: Promise<void>;
}

type ProjectCommandKind = 'dev' | 'test' | 'lint' | 'typecheck' | 'build';

type ApprovalPreparation =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly response: McpToolResponse; readonly code: string; readonly message: string };

export class ToolRegistry {
  private readonly allTools: readonly McpToolDefinition[];
  private readonly tools: readonly McpToolDefinition[];
  private readonly services: McpApplicationServices;
  private readonly actor: FileActor;
  private readonly diagnostic: DiagnosticLogger | undefined;
  private readonly activity: ActivityTracker;
  private readonly schemaRegistry: ToolSchemaRegistry;
  private readonly sessionId: string | undefined;
  private readonly permissionEngine = new DefaultPermissionEngine();
  private readonly profileProvider: () => PermissionProfile;
  private readonly authorizationModeProvider: () => AuthorizationMode;
  private readonly destructivePolicyProvider: () => DestructiveAutoApprovalPolicy;
  private readonly activeWorkspaceScopeProvider: () => Promise<WorkspaceScope | null>;
  private readonly activeWorkspaceScopesProvider: (() => Promise<readonly WorkspaceScope[]>) | undefined;
  private readonly enforceActiveWorkspaceScope: boolean;
  private readonly hostMutationApprovalProvider: ToolRegistryOptions['hostMutationApprovalProvider'];
  private readonly activityWorkspaceResolver: (cwd: string) => Promise<string | undefined>;
  private readonly shellTaskWorkspaces = new Map<string, string>();
  private readonly shellTaskTargets = new Map<string, string>();
  private readonly processTargets = new Map<string, string>();
  private readonly codexTaskTargets = new Map<string, string>();
  private readonly maxToolDurationMs: number | null;

  public constructor(services: McpApplicationServices, actor: FileActor, options: ToolRegistryOptions = {}) {
    this.services = services;
    this.actor = actor;
    this.diagnostic = options.diagnostic;
    this.activity = options.activityTracker ?? new ActivityTracker(options.activity);
    this.sessionId = options.sessionId;
    this.profileProvider = options.profileProvider ?? ((): PermissionProfile => permissionProfiles.full);
    this.authorizationModeProvider = options.authorizationModeProvider ?? ((): AuthorizationMode => 'standard');
    this.destructivePolicyProvider = options.destructivePolicyProvider ?? ((): DestructiveAutoApprovalPolicy => legacyDeletePolicy(options.allowAiDeleteProvider?.() === true));
    this.activeWorkspaceScopeProvider = normalizeActiveWorkspaceScopeProvider(options);
    this.activeWorkspaceScopesProvider = normalizeActiveWorkspaceScopesProvider(options);
    this.enforceActiveWorkspaceScope = options.activeWorkspaceScopesProvider !== undefined || options.activeWorkspaceScopeProvider !== undefined || options.activeProjectProvider !== undefined;
    this.hostMutationApprovalProvider = options.hostMutationApprovalProvider;
    this.activityWorkspaceResolver = normalizeActivityWorkspaceResolver(services, actor);
    this.maxToolDurationMs = normalizeToolResponseBudget(options.maxToolDurationMs);
    const contextEconomy = new ContextEconomyRuntime();
    const context: McpToolContext = { services, actor, contextEconomy };
    const contextEngine = new ContextEngine(services, actor, contextEconomy);
    const filePageEngine = new FilePageEngine(services, actor);
    const incrementalVerifier = options.incrementalVerifier ?? new IncrementalVerifier();
    const workspace = workspaceTools(context);
    const files = fileTools(context);
    const allBaseTools: readonly McpToolDefinition[] = [
      ...workspace,
      ...files.slice(0, 2),
      ...searchTools(context),
      ...gitTools(context),
      ...files.slice(2),
      ...processTools(context),
      ...codexTools(context),
      ...capabilityTools(context, options.setOfMarksStore),
      ...skillTools(context),
      ...mcpBridgeTools(context),
      ...contextTools(context, contextEngine),
      ...filePageTools(filePageEngine),
      ...workspaceIndexTools(context),
      ...sessionTools(context, incrementalVerifier),
      ...goalTools(context),
      ...scheduledContinuationTools(context),
      ...upgradeTools(context),
    ];
    const exposedAllBaseTools = allBaseTools.map((tool) => withToolEnvelopes(tool));
    const exposedBaseTools = exposedAllBaseTools.filter((tool) => {
      if (tool.name.startsWith('codex_') && options.codexToolsEnabled !== true) return false;
      const catalogEntry = upgradeCatalogEntry(tool.name);
      return catalogEntry === undefined || isAdvertisedDeliveryState(catalogEntry.deliveryState);
    });
    const exposedBatchTools = batchTools({
      invoke: (name, input, signal) => this.invoke(name, input, undefined, signal),
      describe: (name) => exposedBaseTools.find((tool) => tool.name === name),
    }).map((tool) => withToolEnvelopes(tool));
    this.allTools = [...exposedAllBaseTools, ...exposedBatchTools];
    this.tools = [...exposedBaseTools, ...exposedBatchTools];
    this.schemaRegistry = new ToolSchemaRegistry();
    for (const tool of this.tools) this.schemaRegistry.register(tool);
  }

  public list(): readonly McpToolDefinition[] { return this.tools; }
  public listAll(): readonly McpToolDefinition[] { return this.allTools; }
  public listInFlight(): ReturnType<ActivityTracker['listInFlight']> { return this.activity.listInFlight(); }
  public listSchemas(): ReturnType<ToolSchemaRegistry['list']> { return this.schemaRegistry.list(); }
  public describeSchema(name: string): ReturnType<ToolSchemaRegistry['describe']> { return this.schemaRegistry.describe(name); }
  public describeInputJsonSchema(name: string): Record<string, unknown> | undefined {
    const inputSchema = this.schemaRegistry.describe(name)?.inputSchema;
    if (!(inputSchema instanceof z.ZodType)) return undefined;
    try {
      const jsonSchema = z.toJSONSchema(inputSchema);
      return typeof jsonSchema === 'object' && jsonSchema !== null && !Array.isArray(jsonSchema)
        ? jsonSchema as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  }

  public async invoke(name: string, input: unknown, traceContext?: TraceContext, parentSignal?: AbortSignal): Promise<McpToolResponse> {
    const profile = this.profileProvider();
    const fullBypass = profile.name === 'full' && this.authorizationModeProvider() === 'full_bypass';
    const authorizationMode: AuthorizationMode = fullBypass ? 'full_bypass' : 'standard';
    const activityWorkspaceId = await this.resolveActivityWorkspaceId(name, input);
    const workspaceActivityInput = withActivityWorkspaceId(stripGoalLeaseEnvelope(input), activityWorkspaceId);
    const activityInput = this.withRememberedActivityTarget(name, workspaceActivityInput);
    const callId = await this.activity.begin(
      name,
      activityInput,
      { ...(traceContext ?? {}), ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }) },
      authorizationMode,
    );
    const started = Date.now();
    let fencedMutationEnd: (() => Promise<void>) | undefined;
    try {
      const tool = this.tools.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        const response = mapError(appError('INVALID_INPUT', 'Unknown MCP tool'));
        await this.activity.end(callId, 'INVALID_INPUT', Date.now() - started, 'Unknown MCP tool');
        return response;
      }
      const parsed = tool.parse(input);
      if (!parsed.ok) {
        const response = mapError(parsed.error);
        await this.activity.end(callId, parsed.error.code, Date.now() - started, parsed.error.message);
        return response;
      }
      const goalLease = readGoalLeaseProof(parsed.value);
      const parsedInput = stripGoalLeaseEnvelope(parsed.value);
      const activeRoutedInput = await this.routeInputToActiveWorkspace(parsedInput);
      const prohibitedReason = fullBypass ? undefined : prohibitedInvocationReason(tool.name, activeRoutedInput);
      if (prohibitedReason !== undefined) {
        const response = mapError(appError('PERMISSION_DENIED', prohibitedReason));
        await this.activity.end(callId, 'PERMISSION_DENIED', Date.now() - started, prohibitedReason);
        return response;
      }
      let mutationDecision = inspectMutationOperation(tool.name, activeRoutedInput, tool.permission);
      const policy = this.destructivePolicyProvider();
      const mutationWorkspaceId = readExplicitWorkspaceId(activeRoutedInput);
      const nativePathScopeRequired = requiresNativePathScope(tool.name, activeRoutedInput);
      const activeWorkspaceScope = !this.enforceActiveWorkspaceScope
        || (mutationDecision.kind === 'read' && !nativePathScopeRequired)
        ? null
        : await this.resolveActiveWorkspaceScope(mutationWorkspaceId);
      if (!fullBypass && mutationDecision.kind === 'execute' && commandExecutionLeavesActiveWorkspace(tool.name, activeRoutedInput, activeWorkspaceScope)) {
        mutationDecision = { kind: 'opaque_mutation', reason: 'Command execution explicitly targets a working directory outside the host Active Project' };
      }
      const mutationScopeMismatch = mutationDecision.kind !== 'read'
        && !COMMAND_EXECUTION_TOOLS.has(tool.name)
        && (mutationWorkspaceId !== undefined || requiresActiveWorkspaceScope(tool.name, mutationDecision))
        && (activeWorkspaceScope === null || mutationWorkspaceId === undefined || mutationWorkspaceId !== activeWorkspaceScope.workspaceId);
      const nativePathScopeMismatch = nativePathScopeRequired
        && (activeWorkspaceScope === null || (mutationWorkspaceId !== undefined && mutationWorkspaceId !== activeWorkspaceScope.workspaceId));
      if (!fullBypass && this.enforceActiveWorkspaceScope && (mutationScopeMismatch || nativePathScopeMismatch)) {
        const message = nativePathScopeMismatch
          ? 'Path-bearing native target does not match the host active workspace'
          : 'Mutation target does not match the host active workspace';
        const response = mapError(appError('PERMISSION_DENIED', message));
        await this.activity.end(callId, 'PERMISSION_DENIED', Date.now() - started, message);
        return response;
      }
      const mutationFenceWorkspaceId = mutationWorkspaceId ?? activeWorkspaceScope?.workspaceId ?? activityWorkspaceId;
      let mutationFenceProof: GoalLeaseProof | undefined;
      if (
        !fullBypass
        && mutationDecision.kind !== 'read'
        && mutationFenceWorkspaceId !== undefined
        && SCHEDULED_CONTINUATION_FENCED_TOOLS.has(tool.name)
        && this.services.goalMutationFence !== undefined
      ) {
        const fence = await this.services.goalMutationFence.inspectWorkspaceFence(this.actor, mutationFenceWorkspaceId);
        if (!fence.ok) {
          const response = mapError(fence.error);
          await this.activity.end(callId, fence.error.code, Date.now() - started, fence.error.message);
          return response;
        }
        if (fence.value !== null) {
          if (goalLease === undefined) {
            const message = 'This rolling scheduled goal requires the current goalLease proof before workspace mutation';
            const response = mapError(appError('CONFLICT', message, true));
            await this.activity.end(callId, 'CONFLICT', Date.now() - started, message);
            return response;
          }
          mutationFenceProof = goalLease;
        }
      }
      const policyAllowsScopedDestructive = !fullBypass && mutationWorkspaceId !== undefined
        && isScopedAutoApprovalAllowed(tool.name, activeRoutedInput, mutationDecision, policy, activeWorkspaceScope);
      const hostApprovalRequired = !fullBypass && requiresProfileMutationConfirmation(tool.name, mutationDecision, profile);
      const effectivePermission = permissionLevelForMutationDecision(mutationDecision);
      const permissionDecision = fullBypass ? 'ALLOW' : this.permissionEngine.decide(profile, {
        action: 'mcp:' + tool.name,
        level: policyAllowsScopedDestructive ? 'WRITE' : effectivePermission,
        workspaceId: readWorkspaceId(activeRoutedInput),
        target: tool.name,
        destructive: isDestructiveMutation(mutationDecision),
      });
      const chatConfirmationRequired = permissionDecision !== 'DENY'
        && !policyAllowsScopedDestructive
        && (permissionDecision === 'ASK' || hostApprovalRequired);
      if (chatConfirmationRequired && !hasExplicitUserConfirmation(activeRoutedInput)) {
        const message = `Mutation requires explicit user confirmation: ${mutationDecision.reason}. Ask the user in chat first, then retry with userConfirmed: true`;
        const response = mapError(appError('PERMISSION_REQUIRED', message, true));
        await this.activity.end(callId, 'PERMISSION_REQUIRED', Date.now() - started, message);
        return response;
      }
      const permissionApproved = permissionDecision === 'ALLOW'
        || (permissionDecision === 'ASK' && (hasExplicitUserConfirmation(activeRoutedInput) || policyAllowsScopedDestructive));
      if (!permissionApproved) {
        const code = permissionDecision === 'DENY' ? 'PERMISSION_DENIED' : 'PERMISSION_REQUIRED';
        const message = permissionDecision === 'DENY'
          ? 'MCP tool ' + tool.name + ' is denied by the active permission profile'
          : 'MCP tool ' + tool.name + ' requires permission approval';
        const response = mapError(appError(code, message, permissionDecision === 'ASK'));
        await this.activity.end(callId, code, Date.now() - started, message);
        return response;
      }
      const scopedExecutionInput = fullBypass
        ? { ok: true as const, value: activeRoutedInput }
        : bindCommandExecutionToActiveWorkspace(tool.name, activeRoutedInput, activeWorkspaceScope);
      if (!scopedExecutionInput.ok) {
        const response = mapError(appError('PERMISSION_DENIED', scopedExecutionInput.message));
        await this.activity.end(callId, 'PERMISSION_DENIED', Date.now() - started, scopedExecutionInput.message);
        return response;
      }
      const approvalPreparation = await this.prepareApprovalInput(tool.name, scopedExecutionInput.value);
      if (!approvalPreparation.ok) {
        await this.activity.end(callId, approvalPreparation.code, Date.now() - started, approvalPreparation.message);
        return approvalPreparation.response;
      }
      const approvalExecutionInput = approvalPreparation.value;
      if (hostApprovalRequired && !policyAllowsScopedDestructive) {
        if (this.hostMutationApprovalProvider === undefined) {
          const message = 'Host exact-action approval is unavailable for this mutation; use Desktop or a trusted host approval adapter';
          const response = mapError(appError('PERMISSION_DENIED', message));
          await this.activity.end(callId, 'PERMISSION_DENIED', Date.now() - started, message);
          return response;
        }
        let hostApproved = false;
        try {
          hostApproved = await this.hostMutationApprovalProvider({
            toolName: tool.name,
            mutationKind: mutationDecision.kind,
            reason: mutationDecision.reason,
            summary: summarizeMutationForApproval(tool.name, approvalExecutionInput, activeWorkspaceScope),
            ...(mutationWorkspaceId === undefined ? {} : { workspaceId: mutationWorkspaceId }),
            ...(activeWorkspaceScope === null ? {} : { workspaceRoot: activeWorkspaceScope.rootPath }),
          });
        } catch {
          hostApproved = false;
        }
        if (!hostApproved) {
          const message = 'The host denied or could not verify exact-action approval for this mutation';
          const response = mapError(appError('PERMISSION_DENIED', message));
          await this.activity.end(callId, 'PERMISSION_DENIED', Date.now() - started, message);
          return response;
        }
      }
      if (
        mutationFenceProof !== undefined
        && mutationFenceWorkspaceId !== undefined
        && this.services.goalMutationFence !== undefined
      ) {
        const admitted = await this.services.goalMutationFence.begin(
          this.actor,
          mutationFenceWorkspaceId,
          callId,
          mutationFenceProof,
        );
        if (!admitted.ok) {
          const response = mapError(admitted.error);
          await this.activity.end(callId, admitted.error.code, Date.now() - started, admitted.error.message);
          return response;
        }
        fencedMutationEnd = startGoalMutationFenceHeartbeat(
          this.services.goalMutationFence,
          callId,
          admitted.value.leaseGeneration,
        );
      }
      const resolvedActivityInput = this.withRememberedActivityTarget(
        name,
        withActivityWorkspaceId(approvalExecutionInput, activityWorkspaceId),
      );
      const rawTargetSummary = summarizeToolTarget(name, resolvedActivityInput);
      const resolvedTargetSummary = fullBypass ? `FULL BYPASS ON — ${rawTargetSummary}` : rawTargetSummary;
      this.activity.updateTarget(callId, resolvedTargetSummary);
      const invocationAuthorization = createInvocationAuthorization({
        fullBypass,
        hostApprovalRequired,
        policyAllowsScopedDestructive,
        explicitUserConfirmation: hasExplicitUserConfirmation(activeRoutedInput),
      });
      const execution = await this.executeWithinResponseBudget(
        tool,
        approvalExecutionInput,
        invocationAuthorization,
        parentSignal,
        goalLease === undefined ? undefined : goalLease.goalId,
        callId,
      );
      const response = execution.response;
      const rawResultTargetSummary = summarizeStructuredResultTarget(response.structuredContent);
      const resultTargetSummary = rawResultTargetSummary === undefined
        ? undefined
        : fullBypass ? `FULL BYPASS ON — ${rawResultTargetSummary}` : rawResultTargetSummary;
      if (resultTargetSummary !== undefined) this.activity.updateTarget(callId, resultTargetSummary);
      this.rememberActivityContext(name, response, activityWorkspaceId, resultTargetSummary ?? resolvedTargetSummary);

      const resultCode = response.isError === true ? readErrorCode(response) ?? 'ERROR' : 'SUCCESS';
      const resultMessage = readErrorMessage(response);
      if (execution.deferredSettlement !== undefined) {
        const endFence = fencedMutationEnd;
        fencedMutationEnd = undefined;
        void execution.deferredSettlement.then(async () => {
          await endFence?.();
          await this.activity.end(callId, resultCode, Date.now() - started, resultMessage);
        });
      } else {
        await fencedMutationEnd?.();
        fencedMutationEnd = undefined;
        await this.activity.end(callId, resultCode, Date.now() - started, resultMessage);
      }
      return response;
    } catch (error: unknown) {
      await fencedMutationEnd?.().catch(() => undefined);
      fencedMutationEnd = undefined;
      const response = mapError(sanitizeException(error, this.diagnostic));
      await this.activity.end(callId, 'INTERNAL_ERROR', Date.now() - started, 'Operation failed');
      return response;
    }
  }

  private async prepareApprovalInput(toolName: string, input: unknown): Promise<ApprovalPreparation> {
    const kind = projectCommandKind(toolName);
    if (kind === undefined) return { ok: true, value: input };
    if (!isRecord(input)) {
      const message = 'Project command input is invalid';
      return { ok: false, response: mapError(appError('PERMISSION_DENIED', message)), code: 'PERMISSION_DENIED', message };
    }
    const workspaceId = readExplicitWorkspaceId(input);
    if (workspaceId === undefined || this.services.process?.previewProjectCommand === undefined) {
      const message = 'Project command preview is unavailable; exact-action approval cannot be verified';
      return { ok: false, response: mapError(appError('PERMISSION_DENIED', message)), code: 'PERMISSION_DENIED', message };
    }
    const preview = await this.services.process.previewProjectCommand(workspaceId, kind);
    if (!preview.ok) {
      return { ok: false, response: mapError(preview.error), code: preview.error.code, message: preview.error.message };
    }
    return { ok: true, value: { ...input, __lnwjudApprovedProjectCommand: preview.value } };
  }

  private async resolveActivityWorkspaceId(name: string, input: unknown): Promise<string | undefined> {
    if (!isRecord(input)) return readExplicitWorkspaceId(input);
    if (name === 'shell') {
      const taskId = readTrimmedString(input.task_id);
      if (taskId !== undefined) {
        const remembered = this.shellTaskWorkspaces.get(taskId);
        if (remembered !== undefined) return remembered;
      }
    }
    const candidatePath = firstAbsoluteActivityPath(input);
    if (candidatePath !== undefined && this.activeWorkspaceScopesProvider !== undefined) {
      try {
        const matched = commonActiveWorkspaceScope(await this.activeWorkspaceScopesProvider(), [candidatePath]);
        if (matched !== null) return matched.workspaceId;
      } catch {
        // Fall through to the existing activity resolver / explicit workspace fallback.
      }
    }
    const explicitWorkspaceId = readExplicitWorkspaceId(input);
    if (explicitWorkspaceId !== undefined) return explicitWorkspaceId;
    return candidatePath === undefined ? undefined : this.activityWorkspaceResolver(candidatePath);
  }

  private withRememberedActivityTarget(name: string, input: unknown): unknown {
    if (!isRecord(input)) return input;
    if (name === 'shell') {
      const taskId = readTrimmedString(input.task_id);
      const target = taskId === undefined ? undefined : this.shellTaskTargets.get(taskId);
      if (target !== undefined) return { ...input, command: target };
    }
    const processId = readTrimmedString(input.processId);
    const processTarget = processId === undefined ? undefined : this.processTargets.get(processId);
    if (processTarget !== undefined) return { ...input, command: processTarget };
    const codexTaskId = readTrimmedString(input.codexTaskId);
    const codexTarget = codexTaskId === undefined ? undefined : this.codexTaskTargets.get(codexTaskId);
    if (codexTarget !== undefined) return { ...input, command: codexTarget };
    return input;
  }

  private rememberActivityContext(name: string, response: McpToolResponse, workspaceId: string | undefined, targetSummary: string | undefined): void {
    if (response.isError === true) return;
    const structured = response.structuredContent;
    const processId = readTrimmedString(structured?.processId);
    if (processId !== undefined && targetSummary !== undefined) rememberBounded(this.processTargets, processId, targetSummary, MAX_REMEMBERED_ACTIVITY_HANDLES);
    const codexTaskId = readTrimmedString(structured?.codexTaskId);
    if (codexTaskId !== undefined && targetSummary !== undefined) rememberBounded(this.codexTaskTargets, codexTaskId, targetSummary, MAX_REMEMBERED_ACTIVITY_HANDLES);
    if (name !== 'shell') return;
    const taskId = readTrimmedString(structured?.task_id);
    if (taskId === undefined) return;
    if (workspaceId !== undefined) this.shellTaskWorkspaces.set(taskId, workspaceId);
    if (targetSummary !== undefined) this.shellTaskTargets.set(taskId, targetSummary);
    while (this.shellTaskTargets.size > MAX_REMEMBERED_SHELL_TASKS || this.shellTaskWorkspaces.size > MAX_REMEMBERED_SHELL_TASKS) {
      const oldestTaskId = this.shellTaskTargets.keys().next().value ?? this.shellTaskWorkspaces.keys().next().value;
      if (typeof oldestTaskId !== 'string') break;
      this.shellTaskTargets.delete(oldestTaskId);
      this.shellTaskWorkspaces.delete(oldestTaskId);
    }
  }

  private async routeInputToActiveWorkspace(input: unknown): Promise<unknown> {
    if (!isRecord(input) || this.activeWorkspaceScopesProvider === undefined) return input;
    const absolutePaths = absoluteWorkspaceScopePaths(input);
    if (absolutePaths.length === 0) return input;
    try {
      const scopes = await this.activeWorkspaceScopesProvider();
      const matched = commonActiveWorkspaceScope(scopes, absolutePaths);
      if (matched === null || readExplicitWorkspaceId(input) === matched.workspaceId) return input;
      return { ...input, workspaceId: matched.workspaceId };
    } catch {
      return input;
    }
  }

  private async resolveActiveWorkspaceScope(workspaceId?: string): Promise<WorkspaceScope | null> {
    try {
      if (this.activeWorkspaceScopesProvider !== undefined) {
        const scopes = await this.activeWorkspaceScopesProvider();
        if (workspaceId === undefined) return scopes[0] ?? null;
        return scopes.find((scope) => scope.workspaceId === workspaceId) ?? null;
      }
      return await this.activeWorkspaceScopeProvider();
    } catch { return null; }
  }

  private async executeWithinResponseBudget(
    tool: McpToolDefinition,
    input: unknown,
    authorization: InvocationAuthorization,
    parentSignal?: AbortSignal,
    goalId?: string,
    callId?: string,
  ): Promise<BudgetedToolExecution> {
    const controller = new AbortController();
    const registration = goalId === undefined || callId === undefined || this.services.goalRequestCancellation === undefined
      ? undefined
      : this.services.goalRequestCancellation.register(goalId, callId, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let deadlineExceeded = false;
    let onParentAbort: (() => void) | undefined;
    let operation: Promise<McpToolResponse> | undefined;
    let registrationReleased = false;
    const releaseRegistration = (): void => {
      if (registrationReleased) return;
      registrationReleased = true;
      registration?.release();
    };
    try {
      const response = await new Promise<McpToolResponse>((resolve, reject) => {
        const finish = (response: McpToolResponse): void => {
          if (settled) return;
          settled = true;
          resolve(response);
        };
        onParentAbort = (): void => {
          deadlineExceeded = true;
          controller.abort();
          finish(mapError(appError('PROCESS_TIMEOUT', `MCP tool ${tool.name} was cancelled because its parent request ended; cancellation was requested, but an underlying operation may still be finishing. Check task/process status before retrying.`, true)));
        };
        if (parentSignal?.aborted) {
          onParentAbort();
          return;
        }
        if (registration?.accepted === false) {
          finish(mapError(appError('CONFLICT', `MCP tool ${tool.name} was cancelled because its durable goal is already cancelled`, true)));
          releaseRegistration();
          return;
        }
        parentSignal?.addEventListener('abort', onParentAbort, { once: true });
        const responseBudgetMs = this.maxToolDurationMs;
        if (responseBudgetMs !== null) {
          timer = setTimeout(() => {
            deadlineExceeded = true;
            controller.abort();
            finish(mapError(appError('PROCESS_TIMEOUT', `MCP tool ${tool.name} exceeded the ${Math.ceil(responseBudgetMs / 1000)}s response budget; cancellation was requested, but an underlying operation may still be finishing. Check task/process status before retrying.`, true)));
          }, responseBudgetMs);
        }
        try {
          operation = tool.execute(input, controller.signal, authorization).then(mapResult);
        } catch (error: unknown) {
          releaseRegistration();
          reject(error);
          return;
        }
        void operation.then(releaseRegistration, releaseRegistration);
        void operation.then(finish, reject);
      });
      return {
        response,
        ...(deadlineExceeded && operation !== undefined ? { deferredSettlement: operation.then(() => undefined, () => undefined) } : {}),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onParentAbort !== undefined) parentSignal?.removeEventListener('abort', onParentAbort);
      if (operation === undefined) releaseRegistration();
    }
  }
}

function legacyDeletePolicy(enabled: boolean): DestructiveAutoApprovalPolicy {
  if (!enabled) return DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY;
  return { ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY, approvals: { ...DEFAULT_DESTRUCTIVE_AUTO_APPROVAL_POLICY.approvals, delete_file: true } };
}

function normalizeToolResponseBudget(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_MCP_TOOL_RESPONSE_BUDGET_MS;
}

function normalizeActivityWorkspaceResolver(services: McpApplicationServices, actor: FileActor): (cwd: string) => Promise<string | undefined> {
  return async (cwd: string): Promise<string | undefined> => {
    const infoPort = services.workspaceInfo;
    if (infoPort?.list === undefined || !isAbsoluteActivityPath(cwd)) return undefined;
    try {
      const listed = await infoPort.list(actor);
      if (!listed.ok || !Array.isArray(listed.value)) return undefined;
      let best: { readonly workspaceId: string; readonly score: number } | undefined;
      for (const entry of listed.value) {
        if (!isRecord(entry)) continue;
        const workspaceId = readTrimmedString(entry.id);
        if (workspaceId === undefined) continue;
        const roots = [readTrimmedString(entry.realRootPath), readTrimmedString(entry.rootPath)].filter((value): value is string => value !== undefined);
        for (const root of roots) {
          if (!activityPathContains(root, cwd)) continue;
          const score = normalizedActivityPath(root).length;
          if (best === undefined || score > best.score) best = { workspaceId, score };
        }
      }
      return best?.workspaceId;
    } catch { return undefined; }
  };
}

function withActivityWorkspaceId(input: unknown, workspaceId: string | undefined): unknown {
  if (workspaceId === undefined || !isRecord(input) || readExplicitWorkspaceId(input) !== undefined) return input;
  return { ...input, workspaceId };
}

function isAbsoluteActivityPath(value: string): boolean { return path.win32.isAbsolute(value) || path.posix.isAbsolute(value); }

/**
 * Windows-style vs POSIX-style path classification. `path.win32.isAbsolute`
 * also returns true for POSIX-style `/root` paths (current-drive-relative),
 * which misroutes POSIX workspace roots to the win32 API on macOS. Drive
 * letters and UNC paths are unambiguously Windows-style; a leading `/` is
 * POSIX-style on POSIX hosts while keeping upstream Windows behavior intact.
 */
function isWindowsStylePathValue(value: string): boolean {
  if (/^[A-Za-z]:/.test(value) || value.startsWith('\\\\')) return true;
  if (value.startsWith('/') && process.platform !== 'win32') return false;
  return path.win32.isAbsolute(value);
}

function activityPathContains(root: string, candidate: string): boolean {
  const api = isWindowsStylePathValue(root) || isWindowsStylePathValue(candidate) ? path.win32 : path.posix;
  const relative = api.relative(api.resolve(root), api.resolve(candidate));
  return relativePathStaysWithin(api, relative);
}

function normalizedActivityPath(value: string): string {
  const api = isWindowsStylePathValue(value) ? path.win32 : path.posix;
  return api.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}

function readTrimmedString(value: unknown): string | undefined { return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function rememberBounded(map: Map<string, string>, key: string, value: string, max: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (typeof oldest !== 'string') break;
    map.delete(oldest);
  }
}


function firstAbsoluteActivityPath(input: Readonly<Record<string, unknown>>): string | undefined {
  return absoluteWorkspaceScopePaths(input)[0];
}

function absoluteWorkspaceScopePaths(input: Readonly<Record<string, unknown>>): string[] {
  const paths: string[] = [];
  for (const key of [
    'cwd', 'path', 'target', 'database', 'filePath', 'targetPath', 'sourcePath', 'destinationPath',
    'file_path', 'target_path', 'output_path', 'source_path', 'destination_path', 'initial_directory',
  ]) {
    const value = readTrimmedString(input[key]);
    if (value !== undefined && isAbsoluteActivityPath(value)) paths.push(value);
  }
  if (Array.isArray(input.files)) {
    for (const entry of input.files) {
      if (!isRecord(entry)) continue;
      const value = readTrimmedString(entry.path);
      if (value !== undefined && isAbsoluteActivityPath(value)) paths.push(value);
    }
  }
  if (Array.isArray(input.merge_paths)) {
    for (const entry of input.merge_paths) {
      const value = readTrimmedString(entry);
      if (value !== undefined && isAbsoluteActivityPath(value)) paths.push(value);
    }
  }
  return paths;
}

function commonActiveWorkspaceScope(scopes: readonly WorkspaceScope[], candidates: readonly string[]): WorkspaceScope | null {
  if (candidates.length === 0) return null;
  let common: WorkspaceScope | null = null;
  for (const candidate of candidates) {
    const matched = mostSpecificActiveWorkspaceScope(scopes, candidate);
    if (matched === null) return null;
    if (common !== null && common.workspaceId !== matched.workspaceId) return null;
    common = matched;
  }
  return common;
}

function mostSpecificActiveWorkspaceScope(scopes: readonly WorkspaceScope[], candidate: string): WorkspaceScope | null {
  const matches = scopes
    .filter((scope) => isAbsoluteActivityPath(scope.rootPath) && activityPathContains(scope.rootPath, candidate))
    .sort((left, right) => normalizedActivityPath(right.rootPath).length - normalizedActivityPath(left.rootPath).length);
  return matches[0] ?? null;
}

type ActiveWorkspaceScopeOptions = Pick<ToolRegistryOptions, 'activeWorkspaceScopeProvider' | 'activeWorkspaceScopesProvider' | 'activeProjectProvider'>;
function normalizeActiveWorkspaceScopeProvider(options: ActiveWorkspaceScopeOptions): () => Promise<WorkspaceScope | null> {
  if (options.activeWorkspaceScopeProvider !== undefined) return async (): Promise<WorkspaceScope | null> => options.activeWorkspaceScopeProvider!();
  if (options.activeProjectProvider !== undefined) return async (): Promise<WorkspaceScope | null> => options.activeProjectProvider!();
  return async (): Promise<WorkspaceScope | null> => null;
}

function normalizeActiveWorkspaceScopesProvider(options: ActiveWorkspaceScopeOptions): (() => Promise<readonly WorkspaceScope[]>) | undefined {
  if (options.activeWorkspaceScopesProvider === undefined) return undefined;
  return async (): Promise<readonly WorkspaceScope[]> => {
    const scopes = await options.activeWorkspaceScopesProvider!();
    const seen = new Set<string>();
    return scopes.filter((scope) => {
      if (scope === null || typeof scope.workspaceId !== 'string' || typeof scope.rootPath !== 'string') return false;
      if (seen.has(scope.workspaceId)) return false;
      seen.add(scope.workspaceId);
      return true;
    });
  };
}

const NATIVE_ACTIVE_SCOPE_TOOLS = new Set(['office', 'audio', 'screen_record']);
const COMMAND_EXECUTION_TOOLS = new Set(['shell', 'wsl_exec', 'process_start']);
export const SCHEDULED_CONTINUATION_FENCED_TOOLS = new Set([
  'write_file', 'apply_patch', 'edit_file', 'move_file', 'copy_file', 'delete_file',
  'restore_deleted_file', 'restore_checkpoint', 'git', 'shell', 'wsl_exec',
  'process_start', 'process_stop', 'project_dev', 'project_test', 'project_lint', 'project_typecheck', 'project_build',
  'verify_incremental', 'codex_run', 'codex_stop', 'git_worktree_spawn', 'git_worktree_remove', 'self_heal_apply',
  'computer_use', 'dom_cdp', 'accessibility', 'input_event', 'ui_target_action', 'window',
  'clipboard', 'file_dialog', 'notification', 'web_fetch', 'scheduler',
  'office', 'audio', 'screen_record', 'docx_merge', 'office_ppt',
]);
const goalLeaseProofSchema = z.object({
  goalId: z.string().min(1).max(128),
  leaseToken: z.string().min(1).max(256),
  leaseGeneration: z.number().int().nonnegative(),
}).strict();
const approvalEnvelopeSchema = z.boolean();
const GOAL_MUTATION_HEARTBEAT_MS = 10_000;

function withToolEnvelopes(tool: McpToolDefinition): McpToolDefinition {
  return withApprovalEnvelope(withGoalLeaseEnvelope(tool));
}

function withApprovalEnvelope(tool: McpToolDefinition): McpToolDefinition {
  const extendObjectSchema = (schema: z.ZodObject): z.ZodObject =>
    schema.safeExtend({ userConfirmed: approvalEnvelopeSchema.optional() });
  const inputSchema = tool.inputSchema instanceof z.ZodObject
    ? extendObjectSchema(tool.inputSchema)
    : tool.inputSchema instanceof z.ZodUnion
      ? z.union(tool.inputSchema.options.map((option) => {
        if (!(option instanceof z.ZodObject)) {
          throw new Error(`Tool ${tool.name} union input branches must use object schemas`);
        }
        return extendObjectSchema(option);
      }) as [z.ZodObject, z.ZodObject, ...z.ZodObject[]])
      : tool.inputSchema;
  if (inputSchema === tool.inputSchema) return tool;
  return {
    ...tool,
    inputSchema,
    parse(input: unknown): ReturnType<McpToolDefinition['parse']> {
      const rawConfirmation = isRecord(input) ? input.userConfirmed : undefined;
      const parsedConfirmation = rawConfirmation === undefined ? undefined : approvalEnvelopeSchema.safeParse(rawConfirmation);
      if (parsedConfirmation !== undefined && !parsedConfirmation.success) {
        return err(appError('INVALID_INPUT', 'userConfirmed is invalid'));
      }
      const parsed = tool.parse(stripUserConfirmationEnvelope(input));
      if (!parsed.ok || parsedConfirmation === undefined) return parsed;
      if (!isRecord(parsed.value)) return err(appError('INVALID_INPUT', 'Tool input must be an object'));
      return ok({ ...parsed.value, userConfirmed: parsedConfirmation.data });
    },
  };
}

function withGoalLeaseEnvelope(tool: McpToolDefinition): McpToolDefinition {
  if (!SCHEDULED_CONTINUATION_FENCED_TOOLS.has(tool.name)) return tool;
  if (!(tool.inputSchema instanceof z.ZodObject)) {
    throw new Error(`Fenced tool ${tool.name} must use an object input schema`);
  }
  return {
    ...tool,
    inputSchema: tool.inputSchema.safeExtend({ goalLease: goalLeaseProofSchema.optional() }),
    parse(input: unknown): ReturnType<McpToolDefinition['parse']> {
      const rawGoalLease = isRecord(input) ? input.goalLease : undefined;
      const parsedGoalLease = rawGoalLease === undefined ? undefined : goalLeaseProofSchema.safeParse(rawGoalLease);
      if (parsedGoalLease !== undefined && !parsedGoalLease.success) {
        return err(appError('INVALID_INPUT', 'goalLease is invalid'));
      }
      const parsed = tool.parse(stripGoalLeaseEnvelope(input));
      if (!parsed.ok || parsedGoalLease === undefined) return parsed;
      if (!isRecord(parsed.value)) return err(appError('INVALID_INPUT', 'Fenced tool input must be an object'));
      return ok({ ...parsed.value, goalLease: parsedGoalLease.data });
    },
  };
}

function readGoalLeaseProof(input: unknown): GoalLeaseProof | undefined {
  if (!isRecord(input) || input.goalLease === undefined) return undefined;
  const parsed = goalLeaseProofSchema.safeParse(input.goalLease);
  return parsed.success ? parsed.data : undefined;
}

function stripGoalLeaseEnvelope(input: unknown): unknown {
  if (!isRecord(input) || !Object.prototype.hasOwnProperty.call(input, 'goalLease')) return input;
  return Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'goalLease'));
}

function stripUserConfirmationEnvelope(input: unknown): unknown {
  if (!isRecord(input) || !Object.prototype.hasOwnProperty.call(input, 'userConfirmed')) return input;
  return Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'userConfirmed'));
}

function startGoalMutationFenceHeartbeat(
  service: NonNullable<McpApplicationServices['goalMutationFence']>,
  callId: string,
  leaseGeneration: number,
): () => Promise<void> {
  let closed = false;
  let heartbeatInFlight = false;
  const timer = setInterval(() => {
    if (closed || heartbeatInFlight) return;
    heartbeatInFlight = true;
    void service.heartbeat(callId, leaseGeneration)
      .catch(() => undefined)
      .finally(() => { heartbeatInFlight = false; });
  }, GOAL_MUTATION_HEARTBEAT_MS);
  timer.unref?.();
  return async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    await service.end(callId);
  };
}

type CommandScopeBinding = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string };
function bindCommandExecutionToActiveWorkspace(toolName: string, input: unknown, activeWorkspaceScope: WorkspaceScope | null): CommandScopeBinding {
  const commandTool = toolName === 'shell' || toolName === 'wsl_exec' || toolName === 'process_start';
  const nativePathTool = NATIVE_ACTIVE_SCOPE_TOOLS.has(toolName);
  if ((!commandTool && !nativePathTool) || activeWorkspaceScope === null || !isRecord(input)) return { ok: true, value: input };
  if (commandTool && toolName !== 'process_start') {
    const operation = readTrimmedString(input.operation) ?? 'run';
    if (operation !== 'run') return { ok: true, value: input };
  }
  const rawRootPath = readTrimmedString(activeWorkspaceScope.rootPath);
  if (rawRootPath === undefined) return { ok: false, message: 'Host active workspace root is invalid' };
  // Repair records canonicalized with foreign separators (see ShellCapabilityBackend).
  const repaired = /^\\([^\\])/.test(rawRootPath) && !/^[A-Za-z]:/.test(rawRootPath)
    ? { text: rawRootPath.replace(/\\/g, '/'), windowsStyle: false }
    : { text: rawRootPath, windowsStyle: isWindowsStylePathValue(rawRootPath) };
  const rootPath = repaired.text;
  const pathApi = repaired.windowsStyle ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(rootPath)) return { ok: false, message: 'Host active workspace root is invalid' };
  const normalizedRoot = pathApi.resolve(rootPath);
  if (nativePathTool) {
    const metadata = isRecord(input.metadata) ? input.metadata : {};
    return { ok: true, value: { ...input, metadata: { ...metadata, [CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY]: normalizedRoot } } };
  }
  const requestedCwd = input.cwd === undefined ? undefined : readTrimmedString(input.cwd);
  if (input.cwd !== undefined && requestedCwd === undefined) return { ok: false, message: 'Command working directory is invalid' };
  const normalizedCwd = requestedCwd === undefined ? normalizedRoot : pathApi.resolve(normalizedRoot, requestedCwd);
  const insideActiveWorkspace = scopePathContains(pathApi, normalizedRoot, normalizedCwd);
  if (toolName === 'process_start') return { ok: true, value: { ...input, cwd: normalizedCwd } };
  const metadata = isRecord(input.metadata) ? input.metadata : {};
  if (!insideActiveWorkspace) {
    const unscopedMetadata = { ...metadata };
    delete unscopedMetadata[CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY];
    return { ok: true, value: { ...input, cwd: normalizedCwd, metadata: unscopedMetadata } };
  }
  return { ok: true, value: { ...input, cwd: normalizedCwd, metadata: { ...metadata, [CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY]: normalizedRoot } } };
}

function scopePathContains(pathApi: typeof path.win32, root: string, candidate: string): boolean {
  const caseInsensitive = pathApi === path.win32;
  const normalizedRoot = caseInsensitive ? root.toLowerCase() : root;
  const normalizedCandidate = caseInsensitive ? candidate.toLowerCase() : candidate;
  return relativePathStaysWithin(pathApi, pathApi.relative(normalizedRoot, normalizedCandidate));
}

function relativePathStaysWithin(pathApi: typeof path.win32, relative: string): boolean {
  if (relative === '') return true;
  if (pathApi.isAbsolute(relative)) return false;
  const [firstSegment] = relative.split(pathApi.sep);
  return firstSegment !== '..';
}

function summarizeMutationForApproval(toolName: string, input: unknown, activeWorkspaceScope: WorkspaceScope | null): string {
  if (!isRecord(input)) return `tool = ${toolName}`;
  const lines = [`tool = ${toolName}`];
  if (toolName === 'mcp_call') {
    appendApprovalValue(lines, 'server', readTrimmedString(input.server));
    appendApprovalValue(lines, 'childTool', readTrimmedString(input.tool));
    lines.push(`arguments = ${stableRedactedJson(input.arguments ?? {})}`);
    lines.push('WARNING: child server controls its own filesystem/network scope.');
    return boundedApprovalSummary(lines);
  }
  if (toolName === 'codex_run') {
    appendApprovalValue(lines, 'workspaceRoot', activeWorkspaceScope?.rootPath);
    appendApprovalValue(lines, 'instruction', typeof input.instruction === 'string' ? input.instruction : undefined);
    lines.push('WARNING: workspace-write child agent execution is opaque and is not covered by Recovery Trash.');
    return boundedApprovalSummary(lines);
  }
  const projectKind = projectCommandKind(toolName);
  if (projectKind !== undefined) {
    lines.push(`projectCommand = ${projectKind}`);
    const approvedCommand = readApprovedProjectCommand(input);
    appendApprovalValue(lines, 'executable', approvedCommand?.executable);
    if (approvedCommand !== undefined) lines.push(`arguments = ${JSON.stringify(approvedCommand.args)}`);
    lines.push('WARNING: project-owned script body is opaque and is not covered by Recovery Trash.');
    return boundedApprovalSummary(lines);
  }
  appendApprovalValue(lines, 'operation', readTrimmedString(input.operation) ?? readTrimmedString(input.action));
  appendApprovalValue(lines, 'cwd', readTrimmedString(input.cwd));
  appendApprovalValue(lines, 'executable', readTrimmedString(input.executable));
  const argumentsValue = readStringArray(input.arguments) ?? readStringArray(input.args);
  if (argumentsValue !== undefined) lines.push(`arguments = ${JSON.stringify(argumentsValue)}`);
  for (const key of ['path', 'sourcePath', 'destinationPath', 'targetPath', 'file_path', 'output_path'] as const) appendApprovalValue(lines, key, readTrimmedString(input[key]));
  if (Array.isArray(input.files)) {
    const paths = input.files.flatMap((entry) => isRecord(entry) && readTrimmedString(entry.path) !== undefined ? [readTrimmedString(entry.path)!] : []);
    if (paths.length > 0) lines.push(`paths = ${JSON.stringify(paths)}`);
  }
  return boundedApprovalSummary(lines);
}

function boundedApprovalSummary(lines: readonly string[]): string {
  return redactApprovalSummary(lines.join('\n')).slice(0, MAX_APPROVAL_SUMMARY_LENGTH);
}

function appendApprovalValue(lines: string[], label: string, value: string | undefined): void { if (value !== undefined) lines.push(`${label} = ${value}`); }
function readStringArray(value: unknown): readonly string[] | undefined { return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined; }
function redactApprovalSummary(value: string): string {
  return value
    .replace(/(\bauthorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s"']+/gi, '$1=[redacted]');
}

function stableRedactedJson(value: unknown): string {
  return JSON.stringify(stableRedactedValue(value));
}

function stableRedactedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableRedactedValue);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = isSensitiveApprovalKey(key) ? '[redacted]' : stableRedactedValue(value[key]);
  }
  return result;
}

function isSensitiveApprovalKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === 'authorization'
    || normalized === 'token'
    || normalized === 'secret'
    || normalized === 'password'
    || normalized === 'apikey'
    || normalized === 'privatekey';
}

function readApprovedProjectCommand(input: Record<string, unknown>): CommandSpec | undefined {
  const value = input.__lnwjudApprovedProjectCommand;
  if (!isRecord(value)) return undefined;
  const executable = readTrimmedString(value.executable);
  const args = readStringArray(value.args);
  return executable === undefined || args === undefined ? undefined : { executable, args };
}

function projectCommandKind(toolName: string): ProjectCommandKind | undefined {
  if (toolName === 'project_dev') return 'dev';
  if (toolName === 'project_test') return 'test';
  if (toolName === 'project_lint') return 'lint';
  if (toolName === 'project_typecheck') return 'typecheck';
  if (toolName === 'project_build') return 'build';
  return undefined;
}

function prohibitedInvocationReason(toolName: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (toolName === 'git') {
    const args = readStringArray(input.args);
    return args === undefined ? 'Git arguments are invalid' : prohibitedAgentGitInvocationReason(args);
  }
  if (toolName === 'process_start') {
    const executable = readTrimmedString(input.executable);
    const args = readStringArray(input.args);
    if (executable !== undefined && args !== undefined) return prohibitedAgentCommandReason(executable, args);
    return 'Process executable or arguments are invalid';
  }
  if ((toolName === 'shell' || toolName === 'wsl_exec') && (readTrimmedString(input.operation) ?? 'run') === 'run' && input.dry_run !== true) {
    const executable = readTrimmedString(input.executable);
    const args = readStringArray(input.arguments);
    if (executable !== undefined && args !== undefined) return prohibitedAgentCommandReason(executable, args);
  }
  return undefined;
}

const LOCAL_MUTATION_TOOLS = new Set(['write_file', 'apply_patch', 'edit_file', 'move_file', 'copy_file', 'delete_file', 'restore_deleted_file', 'restore_recovery_item', 'restore_checkpoint', 'git', 'shell', 'wsl_exec', 'process_start', 'process_stop', 'codex_run', 'codex_stop', 'office', 'office_ppt', 'docx_merge', 'git_worktree_spawn', 'git_worktree_remove', 'self_heal_apply']);
const LOCAL_OUTPUT_REPLACEMENT_TOOLS = new Set(['audio', 'screen_record']);
function requiresActiveWorkspaceScope(toolName: string, decision: MutationPolicyDecision): boolean {
  return decision.kind !== 'read' && (LOCAL_MUTATION_TOOLS.has(toolName) || (decision.kind === 'replace' && LOCAL_OUTPUT_REPLACEMENT_TOOLS.has(toolName)));
}
function requiresNativePathScope(toolName: string, input: unknown): boolean {
  if (!NATIVE_ACTIVE_SCOPE_TOOLS.has(toolName) || !isRecord(input)) return false;
  for (const key of ['file_path', 'target_path', 'output_path'] as const) {
    if (readTrimmedString(input[key]) !== undefined) return true;
  }
  return Array.isArray(input.merge_paths) && input.merge_paths.some((entry) => readTrimmedString(entry) !== undefined);
}
function commandExecutionLeavesActiveWorkspace(toolName: string, input: unknown, activeWorkspaceScope: WorkspaceScope | null): boolean {
  if (!COMMAND_EXECUTION_TOOLS.has(toolName) || activeWorkspaceScope === null || !isRecord(input)) return false;
  if (toolName !== 'process_start' && (readTrimmedString(input.operation) ?? 'run') !== 'run') return false;
  const cwd = readTrimmedString(input.cwd);
  const root = readTrimmedString(activeWorkspaceScope.rootPath);
  if (cwd === undefined || root === undefined) return false;
  const pathApi = isWindowsStylePathValue(root) ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(cwd)) return false;
  return !scopePathContains(pathApi, pathApi.resolve(root), pathApi.resolve(cwd));
}
function isDestructiveMutation(decision: MutationPolicyDecision): boolean { return decision.kind === 'replace' || decision.kind === 'delete' || decision.kind === 'opaque_mutation'; }
const ALWAYS_CONFIRM_MUTATION_TOOLS = new Set([
  'codex_run', 'codex_stop', 'cancel_goal', 'cancel_scheduled_continuation', 'mcp_call', 'web_fetch', 'scheduler',
  'office', 'office_ppt', 'docx_merge', 'dom_cdp', 'computer_use',
  'accessibility', 'input_event', 'ui_target_action', 'window', 'clipboard',
  'audio', 'screen_record',
]);

function requiresAlwaysConfirmation(toolName: string, decision: MutationPolicyDecision): boolean {
  if (decision.kind === 'read') return false;
  if (decision.kind === 'delete') return true;
  if (ALWAYS_CONFIRM_MUTATION_TOOLS.has(toolName)) return true;
  if (decision.kind !== 'opaque_mutation') return false;
  const reason = decision.reason.toLowerCase();
  if (reason.includes('outside the host active project')) return true;
  if (!reason.startsWith('command-risk:')) return false;
  return /delete|remove|discard|destructive|encoded|dynamically constructed|force|purge|clean|reset|restore|\brm\b|in-place|truncate|shred|overwrite/.test(reason);
}

function requiresProfileMutationConfirmation(toolName: string, decision: MutationPolicyDecision, profile: PermissionProfile): boolean {
  if (profile.name === 'full' || profile.name === 'custom') return requiresAlwaysConfirmation(toolName, decision);
  return requiresMutationConfirmation(decision);
}

function createInvocationAuthorization(input: {
  readonly fullBypass: boolean;
  readonly hostApprovalRequired: boolean;
  readonly policyAllowsScopedDestructive: boolean;
  readonly explicitUserConfirmation: boolean;
}): InvocationAuthorization {
  let source: InvocationAuthorizationSource = 'profile';
  if (input.fullBypass) source = 'full_bypass';
  else if (input.policyAllowsScopedDestructive) source = 'scoped_policy';
  else if (input.hostApprovalRequired) source = 'host_approval';
  else if (input.explicitUserConfirmation) source = 'explicit_user';
  return {
    mode: input.fullBypass ? 'full_bypass' : 'standard',
    applicationApproved: true,
    bypassApplicationAuthorization: input.fullBypass,
    source,
  };
}
function readExplicitWorkspaceId(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('workspaceId' in input)) return undefined;
  const value = (input as { workspaceId?: unknown }).workspaceId;
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
function readWorkspaceId(input: unknown): string {
  if (typeof input === 'object' && input !== null && 'workspaceId' in input) {
    const value = (input as { workspaceId?: unknown }).workspaceId;
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return 'system';
}
function readErrorCode(response: McpToolResponse): string | undefined { return readErrorField(response, 'code'); }
function readErrorMessage(response: McpToolResponse): string | undefined { return readErrorField(response, 'message'); }
function readErrorField(response: McpToolResponse, field: 'code' | 'message'): string | undefined {
  const content = response.structuredContent;
  if (typeof content !== 'object' || content === null || !('error' in content)) return undefined;
  const error = (content as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null || !(field in error)) return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}
