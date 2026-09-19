import { randomUUID } from 'node:crypto';
import {
  AutomationExecutionPolicyService,
  AutomationTaskSupervisorService,
  type AutomationAuthorityCursor,
  type AutomationTaskExecution,
} from '@lnwjud/application';
import {
  AutomationStateError,
  appError,
  err,
  ok,
  type AutomationMilestoneSpec,
  type AutomationRunSnapshot,
  type GoalEvidence,
  type GoalLeaseProof,
  type Result,
} from '@lnwjud/domain';
import { z } from 'zod';
import {
  AUTOMATION_GOAL_LEASE_CONTEXT_KEY,
  ToolRegistryAutomationRuntimeAdapter,
  type AutomationChildInvoker,
} from '../automation-runtime-adapter.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

const authoritySchema = {
  goalRevision: z.number().int().nonnegative(),
  userIntentRevision: z.number().int().nonnegative(),
};

const verificationRequirementSchema = z.object({
  id: z.string().min(1).max(256),
  title: z.string().min(1).max(512),
  kind: z.enum(['command', 'evidence', 'custom']),
  specification: z.string().min(1).max(4_096),
}).strict();

const retryPolicySchema = z.object({
  classification: z.enum([
    'safe_read',
    'idempotent_local_state',
    'durable_task_observation',
    'workspace_mutation',
    'opaque_external_mutation',
    'destructive_operation',
  ]),
  maxAttempts: z.number().int().min(1).max(100),
}).strict();

const milestoneSchema = z.object({
  id: z.string().min(1).max(256),
  title: z.string().min(1).max(512),
  dependsOn: z.array(z.string().min(1).max(256)).max(100).default([]),
  executionIntent: z.string().min(1).max(4_096),
  verificationRequirements: z.array(verificationRequirementSchema).max(50).default([]),
  retryPolicy: retryPolicySchema,
}).strict();

const shellExecutionSchema = z.object({
  provider: z.literal('shell'),
  executable: z.string().min(1).max(1_024),
  arguments: z.array(z.string().max(8_192)).max(512).default([]),
  cwd: z.string().min(1).max(4_096).optional(),
  timeoutMs: z.number().int().min(1_000).max(86_400_000).optional(),
}).strict();

const processExecutionSchema = z.object({
  provider: z.literal('process'),
  executable: z.string().min(1).max(1_024),
  args: z.array(z.string().max(8_192)).max(512).default([]),
  cwd: z.string().min(1).max(4_096).optional(),
  timeoutMs: z.number().int().min(1_000).max(86_400_000).optional(),
}).strict();

const codexExecutionSchema = z.object({
  provider: z.literal('codex'),
  instruction: z.string().min(1).max(32_768),
}).strict();

const executionSchema = z.discriminatedUnion('provider', [
  shellExecutionSchema,
  processExecutionSchema,
  codexExecutionSchema,
]);

const evidenceSchema = z.object({
  kind: z.enum(['path', 'hash', 'task', 'note']),
  value: z.string().min(1).max(2_048),
}).strict();

const commonMutationSchema = z.object({
  workspaceId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256),
  expectedRevision: z.number().int().nonnegative(),
  ...authoritySchema,
}).strict();

export interface AutomationToolRuntimeOptions {
  readonly childInvoker: AutomationChildInvoker;
}

export function automationTools(
  context: McpToolContext,
  options: AutomationToolRuntimeOptions,
): McpToolDefinition[] {
  const policy = new AutomationExecutionPolicyService();

  return [
    defineTool({
      name: 'automation_create',
      description: 'Create or replay one durable native automation run bound 1:1 to an active durable goal. The milestone DAG is persisted before execution and the default coding_guarded policy remains fail-closed for desktop/browser control, destructive workspace operations, and unauthorized publish/push/deploy actions.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        workspaceId: z.string().min(1).max(256),
        goalId: z.string().min(1).max(256),
        runId: z.string().min(1).max(256).optional(),
        policyProfile: z.literal('coding_guarded').default('coding_guarded'),
        ...authoritySchema,
        milestones: z.array(milestoneSchema).min(1).max(100),
      }).strict(),
      handler: async (input) => withAutomationErrors(async () => {
        const services = requireAutomation(context);
        assertLeaseMatchesGoal(input, input.goalId);
        const snapshot = await services.orchestrator.create({
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          goalId: input.goalId,
          workspaceId: input.workspaceId,
          policyProfile: input.policyProfile,
          authority: authority(input),
          milestones: input.milestones as readonly AutomationMilestoneSpec[],
        });
        return ok(automationView(snapshot, 'created_or_replayed'));
      }),
    }),
    defineTool({
      name: 'automation_status',
      description: 'Read the authoritative durable automation snapshot without advancing or dispatching work.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: z.object({
        workspaceId: z.string().min(1).max(256),
        runId: z.string().min(1).max(256),
      }).strict(),
      handler: async (input) => withAutomationErrors(async () => {
        const services = requireAutomation(context);
        const snapshot = await services.orchestrator.get(input.runId);
        assertWorkspace(snapshot, input.workspaceId);
        return ok(automationView(snapshot, nextAction(snapshot)));
      }),
    }),
    defineTool({
      name: 'automation_events',
      description: 'Read bounded append-only journal events for a native automation run.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: z.object({
        workspaceId: z.string().min(1).max(256),
        runId: z.string().min(1).max(256),
        limit: z.number().int().min(1).max(500).default(100),
      }).strict(),
      handler: async (input) => withAutomationErrors(async () => {
        const services = requireAutomation(context);
        const snapshot = await services.orchestrator.get(input.runId);
        assertWorkspace(snapshot, input.workspaceId);
        const events = await services.repository.listEvents(input.runId, input.limit);
        return ok({ runId: input.runId, revision: snapshot.revision, events });
      }),
    }),
    defineTool({
      name: 'automation_run',
      description: 'Advance deterministic automation state and, when the selected attempt needs execution, dispatch one explicit shell/process/codex operation through the normal ToolRegistry policy, approval, Active Project, and durable-goal fence boundaries. It never accepts browser/desktop execution providers.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: commonMutationSchema.extend({
        operationKey: z.string().min(1).max(256).default('milestone-execution'),
        idempotencyKey: z.string().min(1).max(2_048),
        deadlineMs: z.number().int().min(1_000).max(604_800_000).optional(),
        execution: executionSchema.optional(),
      }).strict(),
      handler: async (input, signal) => withAutomationErrors(async () => {
        const services = requireAutomation(context);
        let snapshot = await services.orchestrator.get(input.runId);
        assertWorkspace(snapshot, input.workspaceId);
        assertLeaseMatchesGoal(input, snapshot.goalId);
        assertExpectedRevision(snapshot, input.expectedRevision);

        const auth = authority(input);
        if (snapshot.status === 'planned' || (snapshot.currentMilestoneId === undefined && snapshot.currentAttemptId === undefined && snapshot.status === 'running')) {
          snapshot = await services.orchestrator.advance({
            runId: snapshot.id,
            expectedRevision: snapshot.revision,
            authority: auth,
          });
        }
        if (snapshot.status === 'running' && snapshot.currentAttemptId === undefined) {
          const current = snapshot.currentMilestoneId === undefined
            ? undefined
            : snapshot.milestones.find((milestone) => milestone.id === snapshot.currentMilestoneId);
          if (current?.status === 'ready' || current?.status === 'retry_ready') {
            snapshot = await services.orchestrator.startCurrentAttempt({
              runId: snapshot.id,
              expectedRevision: snapshot.revision,
              authority: auth,
            });
          }
        }

        const attempt = snapshot.currentAttemptId === undefined
          ? undefined
          : snapshot.attempts.find((candidate) => candidate.id === snapshot.currentAttemptId);
        if (attempt?.status !== 'dispatching') {
          return ok(automationView(snapshot, nextAction(snapshot)));
        }
        if (input.execution === undefined) {
          return ok({
            ...automationView(snapshot, 'execution_required'),
            executionRequired: true,
            policyProfile: snapshot.policyProfile,
          });
        }

        const userConfirmed = readUserConfirmed(input);
        const policyDecision = policy.decide({
          policyProfile: snapshot.policyProfile,
          execution: input.execution as AutomationTaskExecution,
          userConfirmed,
        });
        if (!policyDecision.allowed) {
          const denied = await services.repository.commitTransition({
            runId: snapshot.id,
            expectedRevision: snapshot.revision,
            runPatch: {
              basedOnGoalRevision: auth.goalRevision,
              basedOnUserIntentRevision: auth.userIntentRevision,
              lastRecoveryDecision: `policy_denied:${policyDecision.code}`,
            },
            event: {
              id: cryptoRandomId(),
              ...(snapshot.currentMilestoneId === undefined ? {} : { milestoneId: snapshot.currentMilestoneId }),
              ...(snapshot.currentAttemptId === undefined ? {} : { attemptId: snapshot.currentAttemptId }),
              type: 'policy_denied',
              reason: policyDecision.code,
              metadata: {
                reason: policyDecision.reason,
                provider: input.execution.provider,
                userConfirmed,
              },
            },
            now: new Date().toISOString(),
          });
          return err(appError(
            'PERMISSION_DENIED',
            `${policyDecision.reason} (automation policy ${policyDecision.code}; run ${denied.id} revision ${denied.revision})`,
          ));
        }

        const supervisor = supervisorFor(services, options.childInvoker, input, signal);
        const dispatched = await supervisor.dispatchCurrentAttempt({
          runId: snapshot.id,
          expectedRevision: snapshot.revision,
          authority: auth,
          provider: input.execution.provider,
          operationKey: input.operationKey,
          idempotencyKey: input.idempotencyKey,
          execution: input.execution as AutomationTaskExecution,
          ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
        });
        return ok({
          ...automationView(dispatched, nextAction(dispatched)),
          policyDecision,
        });
      }),
    }),
    defineTool({
      name: 'automation_observe',
      description: 'Observe the current durable task exactly once. Observation timeout or transport loss never restarts the payload; terminal results are persisted before verification or retry decisions.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: commonMutationSchema,
      handler: async (input, signal) => withAutomationErrors(async () => {
        const services = requireAutomation(context);
        const snapshot = await services.orchestrator.get(input.runId);
        assertWorkspace(snapshot, input.workspaceId);
        assertLeaseMatchesGoal(input, snapshot.goalId);
        assertExpectedRevision(snapshot, input.expectedRevision);
        const supervisor = supervisorFor(services, options.childInvoker, input, signal);
        const observed = await supervisor.observeCurrentTask({
          runId: input.runId,
          expectedRevision: input.expectedRevision,
          authority: authority(input),
        });
        return ok(automationView(observed, nextAction(observed)));
      }),
    }),
    defineTool({
      name: 'automation_recover',
      description: 'Reconcile one unresolved dispatch using durable provider evidence. If the child runtime cannot prove whether the launch happened, the run remains blocked and no blind replay occurs.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: commonMutationSchema.extend({
        operationKey: z.string().min(1).max(256),
      }).strict(),
      handler: async (input, signal) => withAutomationErrors(async () => {
        const services = requireAutomation(context);
        const snapshot = await services.orchestrator.get(input.runId);
        assertWorkspace(snapshot, input.workspaceId);
        assertLeaseMatchesGoal(input, snapshot.goalId);
        assertExpectedRevision(snapshot, input.expectedRevision);
        const supervisor = supervisorFor(services, options.childInvoker, input, signal);
        const recovered = await supervisor.recoverUnresolvedDispatch({
          runId: input.runId,
          expectedRevision: input.expectedRevision,
          authority: authority(input),
          operationKey: input.operationKey,
        });
        return ok(automationView(recovered, nextAction(recovered)));
      }),
    }),
    defineTool({
      name: 'automation_verify',
      description: 'Commit a verification result for the current milestone. pass=true completes the verified milestone and immediately selects the next deterministic ready node; pass=false records attempt failure under the milestone retry budget.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: commonMutationSchema.extend({
        pass: z.boolean(),
        evidence: z.array(evidenceSchema).max(100).default([]),
        failureCode: z.string().min(1).max(256).optional(),
        failureDetail: z.string().max(2_048).optional(),
        retryable: z.boolean().default(false),
      }).strict(),
      handler: async (input) => withAutomationErrors(async () => {
        const services = requireAutomation(context);
        const snapshot = await services.orchestrator.get(input.runId);
        assertWorkspace(snapshot, input.workspaceId);
        assertLeaseMatchesGoal(input, snapshot.goalId);
        assertExpectedRevision(snapshot, input.expectedRevision);
        const auth = authority(input);
        const result = input.pass
          ? await services.orchestrator.completeCurrentMilestone({
              runId: input.runId,
              expectedRevision: input.expectedRevision,
              authority: auth,
              evidence: input.evidence as readonly GoalEvidence[],
            })
          : await services.orchestrator.failCurrentAttempt({
              runId: input.runId,
              expectedRevision: input.expectedRevision,
              authority: auth,
              failureCode: input.failureCode ?? 'verification_failed',
              ...(input.failureDetail === undefined ? {} : { failureDetail: input.failureDetail }),
              retryable: input.retryable,
            });
        return ok(automationView(result, nextAction(result)));
      }),
    }),
    defineTool({
      name: 'automation_pause',
      description: 'Pause orchestration eligibility without cancelling or deleting the durable goal or its task bindings.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: commonMutationSchema,
      handler: async (input) => withAutomationErrors(async () => {
        const services = requireAutomation(context);
        const snapshot = await services.orchestrator.get(input.runId);
        assertWorkspace(snapshot, input.workspaceId);
        assertLeaseMatchesGoal(input, snapshot.goalId);
        assertExpectedRevision(snapshot, input.expectedRevision);
        const paused = await services.orchestrator.pause({
          runId: input.runId,
          expectedRevision: input.expectedRevision,
          authority: authority(input),
        });
        return ok(automationView(paused, 'paused'));
      }),
    }),
    defineTool({
      name: 'automation_resume',
      description: 'Resume a paused native automation run from its persisted milestone/attempt state without creating a new goal, lease, or task.',
      permission: 'EXECUTE',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: commonMutationSchema,
      handler: async (input) => withAutomationErrors(async () => {
        const services = requireAutomation(context);
        const snapshot = await services.orchestrator.get(input.runId);
        assertWorkspace(snapshot, input.workspaceId);
        assertLeaseMatchesGoal(input, snapshot.goalId);
        assertExpectedRevision(snapshot, input.expectedRevision);
        const resumed = await services.orchestrator.resume({
          runId: input.runId,
          expectedRevision: input.expectedRevision,
          authority: authority(input),
        });
        return ok(automationView(resumed, nextAction(resumed)));
      }),
    }),
  ];
}
function supervisorFor(
  services: NonNullable<McpToolContext['services']['automation']>,
  childInvoker: AutomationChildInvoker,
  input: Record<string, unknown>,
  signal: AbortSignal,
): AutomationTaskSupervisorService {
  const lease = readAutomationGoalLease(input);
  const runtime = new ToolRegistryAutomationRuntimeAdapter(childInvoker, {
    ...(lease === undefined ? {} : { goalLease: lease }),
    userConfirmed: readUserConfirmed(input),
    signal,
  });
  return new AutomationTaskSupervisorService(
    services.repository,
    services.orchestrator,
    runtime,
  );
}

function requireAutomation(
  context: McpToolContext,
): NonNullable<McpToolContext['services']['automation']> {
  if (context.services.automation === undefined) {
    throw new AutomationStateError('not_found', 'Native automation services are unavailable');
  }
  return context.services.automation;
}

function authority(input: { readonly goalRevision: number; readonly userIntentRevision: number }): AutomationAuthorityCursor {
  return {
    goalRevision: input.goalRevision,
    userIntentRevision: input.userIntentRevision,
  };
}

function assertWorkspace(snapshot: AutomationRunSnapshot, workspaceId: string): void {
  if (snapshot.workspaceId !== workspaceId) {
    throw new AutomationStateError('conflict', 'Automation run does not belong to the requested workspace');
  }
}

function assertExpectedRevision(snapshot: AutomationRunSnapshot, expectedRevision: number): void {
  if (snapshot.revision !== expectedRevision) {
    throw new AutomationStateError('conflict', 'Automation run revision changed concurrently');
  }
}

function assertLeaseMatchesGoal(input: object, goalId: string): void {
  const lease = readAutomationGoalLease(input);
  if (lease !== undefined && lease.goalId !== goalId) {
    throw new AutomationStateError('conflict', 'Automation goal lease proof belongs to another durable goal');
  }
}

function readAutomationGoalLease(input: object): GoalLeaseProof | undefined {
  const value = (input as Record<string, unknown>)[AUTOMATION_GOAL_LEASE_CONTEXT_KEY];
  if (!isRecord(value)) return undefined;
  const goalId = readString(value, 'goalId');
  const leaseToken = readString(value, 'leaseToken');
  const leaseGeneration = value.leaseGeneration;
  if (
    goalId === undefined
    || leaseToken === undefined
    || typeof leaseGeneration !== 'number'
    || !Number.isInteger(leaseGeneration)
    || leaseGeneration < 0
  ) return undefined;
  return { goalId, leaseToken, leaseGeneration };
}

function readUserConfirmed(input: object): boolean {
  return (input as Record<string, unknown>).userConfirmed === true;
}

function automationView(snapshot: AutomationRunSnapshot, next: string): Record<string, unknown> {
  return {
    run: snapshot,
    nextAction: next,
  };
}

function nextAction(snapshot: AutomationRunSnapshot): string {
  if (snapshot.status === 'paused') return 'paused';
  if (snapshot.status === 'blocked') return 'reconcile_or_replan';
  if (snapshot.status === 'waiting_task') return 'observe_task';
  if (snapshot.status === 'verifying') return 'verify_current_milestone';
  if (snapshot.status === 'completing') return 'final_acceptance_and_finish_goal';
  if (snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled') return 'terminal';
  if (snapshot.currentAttemptId !== undefined) {
    const attempt = snapshot.attempts.find((candidate) => candidate.id === snapshot.currentAttemptId);
    if (attempt?.status === 'dispatching') return 'dispatch_execution';
    if (attempt?.status === 'dispatch_unresolved') return 'recover_dispatch';
  }
  return 'run';
}

async function withAutomationErrors(
  fn: () => Promise<Result<unknown>>,
): Promise<Result<unknown>> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AutomationStateError) {
      if (error.reason === 'not_found') return err(appError('INVALID_INPUT', error.message, true));
      if (error.reason === 'corrupt') return err(appError('INTERNAL_ERROR', 'Native automation state is corrupt', true));
      return err(appError('CONFLICT', error.message, true));
    }
    return err(appError('INTERNAL_ERROR', 'Native automation operation failed', true));
  }
}

function cryptoRandomId(): string {
  return randomUUID();
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
