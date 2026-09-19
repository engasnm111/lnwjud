import { z } from 'zod';
import {
  DEFAULT_GOAL_LEASE_SECONDS,
  MAX_GOAL_LEASE_SECONDS,
  MIN_GOAL_LEASE_SECONDS,
} from '@lnwjud/application';
import { ok } from '@lnwjud/domain';
import { rankSkillMatches, selectAutoSkillMatches } from '../skill-routing.js';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';

const goalKey = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const goalId = z.string().min(1).max(128);
const leaseToken = z.string().min(1).max(256);
const ponytailMode = z.enum(['off', 'lite', 'full', 'ultra']);
const ponytailModeOverride = z.enum(['inherit', 'off', 'lite', 'full', 'ultra']);
const stepStatus = z.enum(['pending', 'in_progress', 'completed', 'blocked']);
const evidence = z.object({
  kind: z.enum(['path', 'hash', 'task', 'note']),
  value: z.string().min(1).max(1024),
}).strict();
const plan = z.object({
  steps: z.array(z.object({
    id: z.string().min(1).max(128),
    title: z.string().min(1).max(512),
  }).strict()).max(100),
}).strict();
const stepUpdate = z.object({
  stepId: z.string().min(1).max(128),
  status: stepStatus,
  summary: z.string().max(1024).optional(),
}).strict();
const fullPlanStep = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(512),
  status: stepStatus,
  summary: z.string().max(1024).optional(),
}).strict();
const acceptanceCriterion = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(512),
}).strict();
const acceptanceUpdate = z.object({
  criterionId: z.string().min(1).max(128),
  status: z.enum(['pending', 'completed', 'blocked']),
  evidence: z.array(evidence).max(20).optional(),
}).strict();
const iterationPolicy = z.object({
  mode: z.enum(['outcome', 'iterate']),
  maxIterations: z.number().int().min(1).max(100).optional(),
  stopOnNoNewEvidence: z.boolean().optional(),
}).strict();
const deliveryState = z.enum(['reserved', 'attempted_unresolved', 'dispatched_unresolved', 'host_confirmed', 'completed', 'cancelled', 'retired']);
const trackedTask = z.object({
  taskId: z.string().min(1).max(256),
  provider: z.enum(['process', 'codex', 'shell']),
  role: z.enum(['blocking_job', 'supporting_service']),
  cancelWithGoal: z.boolean(),
}).strict();

const runGoalSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  goalKey,
  objective: z.string().min(1).max(4096).optional(),
  plan: plan.optional(),
  acceptanceCriteria: z.array(acceptanceCriterion).max(50).optional(),
  iterationPolicy: iterationPolicy.optional(),
  ponytailMode: ponytailMode.optional(),
  leaseSeconds: z.number().int().min(MIN_GOAL_LEASE_SECONDS).max(MAX_GOAL_LEASE_SECONDS).default(DEFAULT_GOAL_LEASE_SECONDS),
  scheduledContinuation: z.enum(['auto', 'off']).default('auto'),
}).strict();

const getGoalSchema = z.union([
  z.object({ goalId }).strict(),
  z.object({ workspaceId: z.string().min(1).max(128), goalKey }).strict(),
]);

const checkpointGoalSchema = z.object({
  goalId,
  leaseToken,
  expectedRevision: z.number().int().min(0),
  expectedUserIntentRevision: z.number().int().min(0).optional(),
  currentPhase: z.string().min(1).max(256),
  summary: z.string().min(1).max(2048),
  stepUpdates: z.array(stepUpdate).max(100),
  nextAction: z.string().max(1024),
  blockers: z.array(z.string().min(1).max(512)).max(20),
  evidence: z.array(evidence).max(20),
  activeTaskIds: z.array(z.string().min(1).max(256)).max(50).optional(),
  trackedTasks: z.array(trackedTask).max(50).optional(),
  ponytailMode: ponytailModeOverride.optional(),
  releaseLease: z.boolean().optional(),
}).strict().refine((value) => value.activeTaskIds !== undefined || value.trackedTasks !== undefined, {
  message: 'activeTaskIds or trackedTasks is required',
}).refine((value) => value.activeTaskIds === undefined || value.trackedTasks === undefined || value.activeTaskIds.length === 0, {
  message: 'Use trackedTasks or activeTaskIds, not both',
});

const updateGoalPlanSchema = z.object({
  goalId,
  leaseToken,
  expectedRevision: z.number().int().min(0),
  expectedUserIntentRevision: z.number().int().min(0).optional(),
  steps: z.array(fullPlanStep).max(100),
  summary: z.string().max(2048).optional(),
}).strict();

const updateGoalAcceptanceSchema = z.object({
  goalId,
  leaseToken,
  expectedRevision: z.number().int().min(0),
  expectedUserIntentRevision: z.number().int().min(0).optional(),
  updates: z.array(acceptanceUpdate).max(50),
  summary: z.string().max(2048).optional(),
}).strict();

const reviseGoalIntentSchema = z.object({
  goalId,
  leaseToken,
  expectedRevision: z.number().int().min(0),
  expectedUserIntentRevision: z.number().int().min(0),
  steering: z.string().min(1).max(1024),
  nextAction: z.string().max(1024).optional(),
}).strict();

const createContextCapsuleSchema = z.object({
  goalId,
  leaseToken,
  expectedRevision: z.number().int().min(0),
  expectedUserIntentRevision: z.number().int().min(0),
  userSteering: z.array(z.string().min(1).max(1024)).max(50).optional(),
  completedWork: z.array(z.string().min(1).max(1024)).max(100).optional(),
  decisions: z.array(z.string().min(1).max(1024)).max(100).optional(),
  validation: z.array(evidence).max(20).optional(),
  changedFiles: z.array(z.string().min(1).max(1024)).max(100).optional(),
  artifacts: z.array(evidence).max(20).optional(),
}).strict();

const getContextCapsuleSchema = z.object({ capsuleId: z.string().min(1).max(128) }).strict();
const listContextCapsulesSchema = z.object({ goalId, limit: z.number().int().min(1).max(100).default(20) }).strict();
const recordDeliveryReceiptSchema = z.object({
  receiptId: z.string().min(1).max(128),
  goalId,
  channel: z.string().min(1).max(128),
  state: deliveryState,
  basedOnUserIntentRevision: z.number().int().min(0),
  externalId: z.string().min(1).max(512).optional(),
  detail: z.string().max(2048).optional(),
}).strict();
const listDeliveryReceiptsSchema = z.object({ goalId, limit: z.number().int().min(1).max(100).default(20) }).strict();
const advanceGoalIterationSchema = z.object({
  goalId,
  leaseToken,
  expectedRevision: z.number().int().min(0),
  expectedUserIntentRevision: z.number().int().min(0),
  evidenceAdded: z.boolean(),
  nextAction: z.string().min(1).max(1024),
}).strict();
const contextPressureSchema = z.object({ goalId }).strict();

const finishGoalSchema = z.object({
  goalId,
  leaseToken,
  expectedRevision: z.number().int().min(0),
  status: z.enum(['completed', 'failed', 'blocked']),
  summary: z.string().min(1).max(2048),
  evidence: z.array(evidence).max(20),
}).strict();

const cancelGoalSchema = z.object({
  goalId,
  expectedRevision: z.number().int().min(0),
  summary: z.string().min(1).max(2048),
  evidence: z.array(evidence).max(20),
}).strict();

const reconcileGoalsSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  goalIds: z.array(goalId).min(1).max(20),
  reason: z.enum(['abandoned', 'superseded']),
  summary: z.string().min(1).max(2048),
  apply: z.boolean().default(false),
  supersededByGoalId: goalId.optional(),
}).strict().refine((value) => value.reason !== 'superseded' || value.supersededByGoalId !== undefined, {
  message: 'supersededByGoalId is required when reason=superseded',
});

const listGoalsSchema = z.object({
  workspaceId: z.string().min(1).max(128).optional(),
  status: z.enum(['active', 'completed', 'failed', 'blocked', 'cancelled']).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();

export const GOAL_TOOL_NAMES = [
  'run_goal', 'get_goal', 'get_goal_plan', 'update_goal_plan', 'update_goal_acceptance', 'revise_goal_intent',
  'create_context_capsule', 'get_context_capsule', 'list_context_capsules', 'context_pressure',
  'record_delivery_receipt', 'list_delivery_receipts', 'advance_goal_iteration',
  'checkpoint_goal', 'finish_goal', 'cancel_goal', 'reconcile_goals', 'list_goals',
] as const;

const MAX_GOAL_SKILL_PREFLIGHT_BYTES = 48 * 1024;
const MAX_GOAL_PROJECT_INSTRUCTIONS_BYTES = 512 * 1024;

async function loadGoalSkillPreflight(context: McpToolContext, objective: string | undefined): Promise<Readonly<Record<string, unknown>> | undefined> {
  const query = objective?.trim();
  const extensions = context.services.extensions;
  if (query === undefined || query.length === 0 || extensions === undefined) return undefined;

  const listed = await extensions.listSkills({});
  if (!listed.ok) return { status: 'unavailable', mode: 'auto', loadedSkills: [] };
  const ranked = rankSkillMatches(listed.value.skills, query, 8);
  const selected = selectAutoSkillMatches(ranked);
  if (selected.length === 0) return { status: 'no_match', mode: 'auto', loadedSkills: [] };

  const mode = selected.some((match) => match.explicit) ? 'explicit' : 'auto';
  const loadedSkills: unknown[] = [];
  let loadedBytes = 0;
  for (const match of selected) {
    const loaded = await extensions.readSkill({ skillId: match.skill.id });
    if (!loaded.ok) continue;
    const bytes = Buffer.byteLength(loaded.value.content, 'utf8');
    if (bytes > MAX_GOAL_SKILL_PREFLIGHT_BYTES || loadedBytes + bytes > MAX_GOAL_SKILL_PREFLIGHT_BYTES) continue;
    loadedSkills.push(loaded.value);
    loadedBytes += bytes;
  }
  return {
    status: loadedSkills.length > 0 ? 'loaded' : 'unavailable',
    mode,
    loadedSkills,
  };
}

async function loadGoalProjectInstructions(context: McpToolContext, workspaceId: string): Promise<Readonly<Record<string, unknown>>> {
  const file = context.services.file;
  if (file === undefined) return { status: 'unavailable', path: 'AGENTS.md' };

  const loaded = await file.readFile(context.actor, workspaceId, { path: 'AGENTS.md' });
  if (!loaded.ok) {
    return loaded.error.code === 'FILE_NOT_FOUND'
      ? { status: 'not_found', path: 'AGENTS.md' }
      : { status: 'unavailable', path: 'AGENTS.md', errorCode: loaded.error.code };
  }

  const byteLength = Buffer.byteLength(loaded.value.content, 'utf8');
  if (byteLength > MAX_GOAL_PROJECT_INSTRUCTIONS_BYTES) {
    return {
      status: 'too_large',
      path: 'AGENTS.md',
      byteLength,
      maxBytes: MAX_GOAL_PROJECT_INSTRUCTIONS_BYTES,
    };
  }

  return {
    status: 'loaded',
    path: 'AGENTS.md',
    byteLength,
    content: loaded.value.content,
  };
}

export function goalTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'run_goal',
      description: 'Immediate-return durable goal create/resume and lease acquisition. Every invocation re-reads workspace AGENTS.md when present and returns it as projectInstructionsPreflight so repository rules are available before subsequent work; the preflight is never cached. Invoke run_goal before the first mutation of any non-trivial multi-step change. For an active rolling goal whose prior worker died, stale-lease recovery still requires trustworthy runtime liveness and rotates the lease generation. Unfinished goals default to scheduledContinuation=auto: the client must load/follow the bundled lnwjud-scheduled-continuation skill and maintain exactly one Native ChatGPT hourly recurring watchdog with cloud execution requested. New v4.53 goals reuse the same native task ID across ordinary hourly wakes; checkpoints and collisions never imply per-wake successor creation or recurrence retiming. Historical v4.52 occurrence=once rows are migrated compatibly and must not overlap a new recurring watchdog. Continue useful work without waiting for the user to type continue/ทำต่อ. The leased worker is work-conserving: a milestone checkpoint is not a turn boundary, a transient tool/task-observation failure is not a handoff signal, and a safely reacquirable lease expiry should be recovered with the same goalKey so useful work continues in the same host turn. A truthful native create failure or Resource not found is scheduler transport degradation only: keep the durable goal active and continue the current leased worker rather than terminalizing the work, and never substitute another scheduler. Stop scheduling only when the goal is terminal or scheduling is explicitly disabled. Native ChatGPT task operations remain host-owned through the Scheduled Task surface exposed to the chat; this tool never claims that a task was created and never substitutes browser/DOM automation, Windows Task Scheduler, cron, or shell timers.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: runGoalSchema,
      handler: async (input) => {
        const goals = context.services.goals;
        if (goals === undefined) return missingService();
        const projectInstructionsPreflight = await loadGoalProjectInstructions(context, input.workspaceId);
        const result = await goals.runGoal(context.actor, {
          workspaceId: input.workspaceId,
          goalKey: input.goalKey,
          leaseSeconds: input.leaseSeconds,
          ...(input.objective === undefined ? {} : { objective: input.objective }),
          ...(input.plan === undefined ? {} : { plan: input.plan }),
          ...(input.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: input.acceptanceCriteria }),
          ...(input.iterationPolicy === undefined ? {} : {
            iterationPolicy: {
              mode: input.iterationPolicy.mode,
              ...(input.iterationPolicy.maxIterations === undefined ? {} : { maxIterations: input.iterationPolicy.maxIterations }),
              ...(input.iterationPolicy.stopOnNoNewEvidence === undefined ? {} : { stopOnNoNewEvidence: input.iterationPolicy.stopOnNoNewEvidence }),
            },
          }),
          ...(input.ponytailMode === undefined ? {} : { ponytailMode: input.ponytailMode }),
        });
        if (!result.ok) return result;
        const skillPreflight = await loadGoalSkillPreflight(context, input.objective);
        const active = result.value.status === 'active';
        const scheduledContinuation = input.scheduledContinuation ?? 'auto';
        const auto = scheduledContinuation === 'auto';
        const latestContinuation = active && auto && context.services.scheduledContinuations !== undefined
          ? await context.services.scheduledContinuations.getScheduledContinuation(context.actor, { goalId: result.value.goalId, latest: true })
          : undefined;
        const successor = latestContinuation?.ok ? latestContinuation.value : undefined;
        const successorConfirmed = successor?.status === 'scheduled'
          && successor.nativeTaskId !== undefined
          && (successor.confirmedRunsOn === 'cloud' || successor.confirmedRunsOn === 'unverified');
        const successorHostState = successorConfirmed
          ? successor?.confirmedRunsOn === 'cloud' ? 'confirmed_cloud' : 'confirmed_execution_unverified'
          : successor?.status === 'prepared'
            ? 'prepared_unconfirmed'
            : successor?.status === 'create_uncertain'
              ? 'confirmation_uncertain'
              : successor?.status === 'create_failed'
                ? 'create_failed_no_native_task'
                : successor === undefined
                  ? 'none'
                  : 'not_confirmed';
        return ok({
          ...result.value,
          projectInstructionsPreflight,
          ...(skillPreflight === undefined ? {} : { skillPreflight }),
          ...(!result.value.acquired && result.value.retryAfterSeconds !== undefined && result.value.retryAfterSeconds <= 60
            ? {
                leaseGuidance: `Previous worker appears inactive. The bounded stale-recovery grace expires in ${result.value.retryAfterSeconds}s. Wait ${result.value.retryAfterSeconds}s and call run_goal again to take over the lease; do not yield or treat as occupied.`,
              }
            : {}),
          continuationDirective: {
            mode: scheduledContinuation,
            skillId: 'workspace-agents-skills/lnwjud-scheduled-continuation',
            nativeTaskHostRequired: true,
            userMustPromptAgain: false,
            successorHostState,
            successorHandoffReady: successorConfirmed,
            nextRequiredAction: !active
              ? 'terminal_noop'
              : !auto
                ? 'continue_current_run_without_successor'
                : !result.value.acquired
                  ? (result.value.retryAfterSeconds !== undefined && result.value.retryAfterSeconds <= 60
                    ? 'retry_run_goal_after_stale_grace_window'
                    : 'do_not_mutate_retry_or_use_existing_successor')
                  : result.value.lastCheckpoint === null
                    ? 'checkpoint_then_ensure_one_cloud_successor'
                    : successorConfirmed
                      ? successor?.confirmedRunsOn === 'cloud'
                        ? 'continue_with_confirmed_cloud_successor'
                        : 'continue_with_confirmed_native_successor_execution_unverified'
                      : successor?.status === 'prepared'
                        ? 'continue_current_run_and_create_native_receipt_before_yield'
                        : successor?.status === 'create_uncertain'
                          ? 'continue_current_run_and_reconcile_native_receipt_before_yield'
                          : successor?.status === 'create_failed'
                            ? 'continue_current_run_scheduler_degraded_goal_stays_active'
                            : 'continue_current_run_and_prepare_cloud_successor_before_yield',
            stopOnlyWhen: 'goal_terminal_or_scheduling_explicitly_disabled',
          },
        });
      },
    }),
    defineTool({
      name: 'get_goal',
      description: 'Read the latest durable goal snapshot without changing state or returning a lease token.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: getGoalSchema,
      handler: async (input) => context.services.goals?.getGoal(context.actor, input) ?? missingService(),
    }),
    defineTool({
      name: 'get_goal_plan',
      description: 'Read the user-facing plan projection, acceptance criteria, intent revision, and bounded-iteration policy from authoritative durable goal state. This is a projection, not a second workflow engine.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: getGoalSchema,
      handler: async (input) => {
        const result = await context.services.goals?.getGoal(context.actor, input) ?? missingService();
        if (!result.ok) return result;
        return ok({
          goalId: result.value.goalId, goalKey: result.value.goalKey, revision: result.value.revision,
          userIntentRevision: result.value.userIntentRevision, currentPhase: result.value.currentPhase,
          plan: result.value.plan, acceptanceCriteria: result.value.acceptanceCriteria,
          iterationPolicy: result.value.iterationPolicy,
          ...(result.value.currentContextCapsuleId === undefined ? {} : { currentContextCapsuleId: result.value.currentContextCapsuleId }),
          nextAction: result.value.nextAction, blockers: result.value.blockers,
        });
      },
    }),
    defineTool({
      name: 'update_goal_plan',
      description: 'Atomically replace the user-facing durable goal plan through the current lease and revision fence. It only updates plan state; it does not execute plan steps by itself.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: updateGoalPlanSchema,
      handler: async (input) => context.services.goals?.updateGoalPlan(context.actor, {
        goalId: input.goalId,
        leaseToken: input.leaseToken,
        expectedRevision: input.expectedRevision,
        ...(input.expectedUserIntentRevision === undefined ? {} : { expectedUserIntentRevision: input.expectedUserIntentRevision }),
        steps: input.steps.map((step) => ({
          id: step.id,
          title: step.title,
          status: step.status,
          ...(step.summary === undefined ? {} : { summary: step.summary }),
        })),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
      }) ?? missingService(),
    }),
    defineTool({
      name: 'update_goal_acceptance',
      description: 'Update explicit durable acceptance criteria with evidence. finish_goal(status=completed) remains blocked until every criterion is completed.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: updateGoalAcceptanceSchema,
      handler: async (input) => context.services.goals?.updateGoalAcceptance(context.actor, {
        goalId: input.goalId,
        leaseToken: input.leaseToken,
        expectedRevision: input.expectedRevision,
        ...(input.expectedUserIntentRevision === undefined ? {} : { expectedUserIntentRevision: input.expectedUserIntentRevision }),
        updates: input.updates.map((update) => ({
          criterionId: update.criterionId,
          status: update.status,
          ...(update.evidence === undefined ? {} : { evidence: update.evidence }),
        })),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
      }) ?? missingService(),
    }),
    defineTool({
      name: 'revise_goal_intent',
      description: 'Record accepted newer user steering by incrementing userIntentRevision under the current lease. Older pending delivery receipts are retired so stale generated actions cannot outrank newer user instructions.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: reviseGoalIntentSchema,
      handler: async (input) => context.services.goals?.reviseGoalIntent(context.actor, {
        goalId: input.goalId,
        leaseToken: input.leaseToken,
        expectedRevision: input.expectedRevision,
        expectedUserIntentRevision: input.expectedUserIntentRevision,
        steering: input.steering,
        ...(input.nextAction === undefined ? {} : { nextAction: input.nextAction }),
      }) ?? missingService(),
    }),
    defineTool({
      name: 'create_context_capsule',
      description: 'Create and publish a bounded immutable context capsule from authoritative durable goal state for compact/resume or handoff. Stores decisions/results, not private chain-of-thought, and never opens, clicks, types into, or creates a ChatGPT browser conversation.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: createContextCapsuleSchema,
      handler: async (input) => context.services.goals?.createContextCapsule(context.actor, {
        goalId: input.goalId,
        leaseToken: input.leaseToken,
        expectedRevision: input.expectedRevision,
        expectedUserIntentRevision: input.expectedUserIntentRevision,
        ...(input.userSteering === undefined ? {} : { userSteering: input.userSteering }),
        ...(input.completedWork === undefined ? {} : { completedWork: input.completedWork }),
        ...(input.decisions === undefined ? {} : { decisions: input.decisions }),
        ...(input.validation === undefined ? {} : { validation: input.validation }),
        ...(input.changedFiles === undefined ? {} : { changedFiles: input.changedFiles }),
        ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
      }) ?? missingService(),
    }),
    defineTool({
      name: 'get_context_capsule',
      description: 'Read one immutable durable context capsule by ID.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: getContextCapsuleSchema,
      handler: async (input) => context.services.goals?.getContextCapsule(context.actor, input.capsuleId) ?? missingService(),
    }),
    defineTool({
      name: 'list_context_capsules',
      description: 'List bounded context-capsule lineage for one durable goal.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: listContextCapsulesSchema,
      handler: async (input) => context.services.goals?.listContextCapsules(context.actor, input.goalId, input.limit) ?? missingService(),
    }),
    defineTool({
      name: 'context_pressure',
      description: 'Estimate local durable-context pressure from the goal snapshot and latest capsule. This never claims exact ChatGPT/provider context usage when the host does not expose it.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: contextPressureSchema,
      handler: async (input) => {
        const goals = context.services.goals;
        if (goals === undefined) return missingService();
        const result = await goals.getGoal(context.actor, { goalId: input.goalId });
        if (!result.ok) return result;
        const capsuleResult = await goals.listContextCapsules(context.actor, input.goalId, 1);
        if (!capsuleResult.ok) return capsuleResult;
        const snapshotBytes = Buffer.byteLength(JSON.stringify(result.value), 'utf8');
        const latestCapsule = capsuleResult.value[0];
        const capsuleBytes = latestCapsule === undefined ? 0 : Buffer.byteLength(JSON.stringify(latestCapsule), 'utf8');
        const localEstimatedTokens = Math.ceil((snapshotBytes + capsuleBytes) / 4);
        const status = localEstimatedTokens >= 48_000 ? 'high' : localEstimatedTokens >= 16_000 ? 'medium' : 'low';
        return ok({
          status, confidence: 'estimated', localEstimatedTokens, snapshotBytes, capsuleBytes,
          providerContextTokens: null,
          recommendation: status === 'high' ? 'create_context_capsule_or_resume_from_latest_capsule' : status === 'medium' ? 'consider_context_capsule_at_next_milestone' : 'continue_normally',
        });
      },
    }),
    defineTool({
      name: 'record_delivery_receipt',
      description: 'Record or advance a durable dispatch receipt with explicit ambiguous-delivery states. Blind retries are rejected by lifecycle/state and newer user intent can retire stale deliveries.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: recordDeliveryReceiptSchema,
      handler: async (input) => context.services.goals?.recordDeliveryReceipt(context.actor, {
        receiptId: input.receiptId,
        goalId: input.goalId,
        channel: input.channel,
        state: input.state,
        basedOnUserIntentRevision: input.basedOnUserIntentRevision,
        ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
        ...(input.detail === undefined ? {} : { detail: input.detail }),
      }) ?? missingService(),
    }),
    defineTool({
      name: 'list_delivery_receipts',
      description: 'List bounded durable dispatch receipts for a goal.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: listDeliveryReceiptsSchema,
      handler: async (input) => context.services.goals?.listDeliveryReceipts(context.actor, input.goalId, input.limit) ?? missingService(),
    }),
    defineTool({
      name: 'advance_goal_iteration',
      description: 'Advance one bounded review/improvement iteration under the durable goal lease. It never sends browser messages or creates an autonomous ChatGPT UI loop and cannot exceed maxIterations.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: advanceGoalIterationSchema,
      handler: async (input) => context.services.goals?.advanceGoalIteration(context.actor, input) ?? missingService(),
    }),
    defineTool({
      name: 'checkpoint_goal',
      description: 'Atomically checkpoint durable goal progress using the current lease and expected revision. Use trackedTasks for goal-relative blocking_job/supporting_service roles and explicit provider routing; activeTaskIds remains a legacy compatibility form. Supporting services do not block continuation liveness and are cancelled only when cancelWithGoal=true. A checkpoint records durable progress only; it is not a turn boundary or permission to yield, and it does not create a new Scheduled Task. After an ordinary checkpoint keep useful work moving on the current lease. A transient task/status/log/result observation failure must be retried or re-resolved in the same turn, and a tracked blocking job that becomes terminal must have its terminal result inspected before handoff. Before yielding an active automatic-continuation goal, ensure exactly one confirmed Native ChatGPT hourly recurring watchdog exists with cloud execution requested. Reuse the same nativeTaskId across checkpoints and ordinary hourly wakes; never create a per-wake successor and never retime the recurring cadence merely because a checkpoint changed. Historical v4.52 one-time rows keep their compatibility behavior until they become historical, and one-time plus recurring watchdogs must never overlap for the same goal. A real native task ID is required for confirmed coverage, while execution mode may remain unverified when the host does not expose it. At the actual turn boundary, after confirmed watchdog coverage and the final durable state are recorded, use one final checkpoint with releaseLease=true and then perform no further mutation. Never wait for the user to type continue/ทำต่อ.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: checkpointGoalSchema,
      handler: async (input) => context.services.goals?.checkpointGoal(context.actor, {
        goalId: input.goalId,
        leaseToken: input.leaseToken,
        expectedRevision: input.expectedRevision,
        ...(input.expectedUserIntentRevision === undefined ? {} : { expectedUserIntentRevision: input.expectedUserIntentRevision }),
        currentPhase: input.currentPhase,
        summary: input.summary,
        stepUpdates: input.stepUpdates.map((update) => ({
          stepId: update.stepId,
          status: update.status,
          ...(update.summary === undefined ? {} : { summary: update.summary }),
        })),
        nextAction: input.nextAction,
        blockers: input.blockers,
        evidence: input.evidence,
        ...(input.activeTaskIds === undefined ? {} : { activeTaskIds: input.activeTaskIds }),
        ...(input.trackedTasks === undefined ? {} : { trackedTasks: input.trackedTasks }),
        ...(input.ponytailMode === undefined ? {} : { ponytailMode: input.ponytailMode }),
        ...(input.releaseLease === undefined ? {} : { releaseLease: input.releaseLease }),
      }) ?? missingService(),
    }),
    defineTool({
      name: 'finish_goal',
      description: 'Finish the local durable goal using lease/revision compare-and-swap. It must be called before any completion report, even when scheduling was disabled or the user requested no watchdog. status=completed is rejected while durable plan work, blockers, or blocking tasks remain. After the terminal CAS, finish_goal aborts in-flight fenced MCP requests and attempts to stop every tracked task whose cancelWithGoal policy is true; inspect requestCancellation, taskCancellations, allRequestsStopped, and allTasksStopped for unresolved work. Preferred v4.54 completion cleans any live Native ChatGPT watchdog first: call cancel_scheduled_continuation while the goal is still active, make the exact task non-runnable using host delete or confirmed disable, record truthful cleanup evidence, then call finish_goal once. Explicit user-attested manual deletion is a separate evidence class and must never be represented as host-native proof. Defensive compatibility remains: if finish_goal returns status=active with completionState=pending_native_cleanup, recover the exact cleanup locator from get_goal/get_scheduled_continuation, perform cleanup only, record evidence, and call finish_goal again without resuming workspace work. A recurring hourly run never consumes the task and outcome=consumed is not cleanup proof. Report completion only after completionState=completed and get_goal is terminal with no pending scheduled-task cleanup.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: finishGoalSchema,
      handler: async (input) => context.services.goals?.finishGoal(context.actor, input) ?? missingService(),
    }),
    defineTool({
      name: 'cancel_goal',
      description: 'Cancel a durable goal independently of any scheduled watchdog. It records the goal as cancelled, aborts in-flight fenced MCP requests for that goal, and attempts to stop only tracked tasks whose cancelWithGoal policy is true; shared supporting services remain running by default and are reported as taskCancellations status=skipped. An explicitly bound provider that is unavailable or cannot verify termination is reported as failed, so allTasksStopped remains false until the unresolved task is inspected. Inspect requestCancellation, taskCancellations, and allRequestsStopped/allTasksStopped for unresolved work. If scheduledTaskCancellation requests make_native_task_non_runnable, use cancel_scheduled_continuation separately, resolve the actual native ChatGPT cleanup operation exposed by the host, and record exact proof that the pending task is non-runnable.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: cancelGoalSchema,
      handler: async (input) => context.services.goals?.cancelGoal(context.actor, input) ?? missingService(),
    }),
    defineTool({
      name: 'reconcile_goals',
      description: 'Preview or apply exact durable-goal reconciliation after runtime liveness checks.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: reconcileGoalsSchema,
      handler: async (input) => context.services.goals?.reconcileGoals(context.actor, {
        workspaceId: input.workspaceId,
        goalIds: input.goalIds,
        reason: input.reason,
        summary: input.summary,
        apply: input.apply,
        ...(input.supersededByGoalId === undefined ? {} : { supersededByGoalId: input.supersededByGoalId }),
      }) ?? missingService(),
    }),
    defineTool({
      name: 'list_goals',
      description: 'List a bounded set of durable goals owned by the current stable MCP client, optionally filtered by workspace/status.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: listGoalsSchema,
      handler: async (input) => context.services.goals?.listGoals(context.actor, {
        limit: input.limit,
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        ...(input.status === undefined ? {} : { status: input.status }),
      }) ?? missingService(),
    }),
  ];
}
