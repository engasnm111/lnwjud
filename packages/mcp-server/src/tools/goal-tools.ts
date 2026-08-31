import { z } from 'zod';
import {
  DEFAULT_GOAL_LEASE_SECONDS,
  MAX_GOAL_LEASE_SECONDS,
  MIN_GOAL_LEASE_SECONDS,
} from '@lnwjud/application';
import { ok } from '@lnwjud/domain';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';

const goalKey = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const goalId = z.string().min(1).max(128);
const leaseToken = z.string().min(1).max(256);
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
  currentPhase: z.string().min(1).max(256),
  summary: z.string().min(1).max(2048),
  stepUpdates: z.array(stepUpdate).max(100),
  nextAction: z.string().max(1024),
  blockers: z.array(z.string().min(1).max(512)).max(20),
  evidence: z.array(evidence).max(20),
  activeTaskIds: z.array(z.string().min(1).max(256)).max(50).optional(),
  trackedTasks: z.array(trackedTask).max(50).optional(),
  releaseLease: z.boolean().optional(),
}).strict().refine((value) => value.activeTaskIds !== undefined || value.trackedTasks !== undefined, {
  message: 'activeTaskIds or trackedTasks is required',
}).refine((value) => value.activeTaskIds === undefined || value.trackedTasks === undefined || value.activeTaskIds.length === 0, {
  message: 'Use trackedTasks or activeTaskIds, not both',
});

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

const listGoalsSchema = z.object({
  workspaceId: z.string().min(1).max(128).optional(),
  status: z.enum(['active', 'completed', 'failed', 'blocked', 'cancelled']).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();

export const GOAL_TOOL_NAMES = ['run_goal', 'get_goal', 'checkpoint_goal', 'finish_goal', 'cancel_goal', 'list_goals'] as const;

export function goalTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'run_goal',
      description: 'Immediate-return durable goal create/resume and lease acquisition. Unfinished goals default to scheduledContinuation=auto: the client must automatically load/follow the bundled lnwjud-scheduled-continuation skill, keep exactly one native one-time cloud successor after a real checkpoint, continue useful work without waiting for the user to type continue/ทำต่อ, and stop scheduling only when the goal is terminal or scheduling is explicitly disabled. Native ChatGPT task creation remains host-owned; this tool never claims that a task was created.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: runGoalSchema,
      handler: async (input) => {
        const goals = context.services.goals;
        if (goals === undefined) return missingService();
        const result = await goals.runGoal(context.actor, {
          workspaceId: input.workspaceId,
          goalKey: input.goalKey,
          leaseSeconds: input.leaseSeconds,
          ...(input.objective === undefined ? {} : { objective: input.objective }),
          ...(input.plan === undefined ? {} : { plan: input.plan }),
        });
        if (!result.ok) return result;
        const active = result.value.status === 'active';
        const scheduledContinuation = input.scheduledContinuation ?? 'auto';
        const auto = scheduledContinuation === 'auto';
        return ok({
          ...result.value,
          continuationDirective: {
            mode: scheduledContinuation,
            skillId: 'workspace-agents-skills/lnwjud-scheduled-continuation',
            nativeTaskHostRequired: true,
            userMustPromptAgain: false,
            nextRequiredAction: !active
              ? 'terminal_noop'
              : !auto
                ? 'continue_current_run_without_successor'
                : result.value.acquired
                  ? (result.value.lastCheckpoint === null ? 'checkpoint_then_ensure_one_cloud_successor' : 'ensure_one_cloud_successor_then_continue')
                  : 'do_not_mutate_retry_or_use_existing_successor',
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
      name: 'checkpoint_goal',
      description: 'Atomically checkpoint durable goal progress using the current lease and expected revision. Use trackedTasks for goal-relative blocking_job/supporting_service roles and explicit provider routing; activeTaskIds remains a legacy compatibility form. Supporting services do not block continuation liveness and are cancelled only when cancelWithGoal=true. For an active goal using the default automatic continuation contract, a successful real checkpoint is the handoff point where the client must ensure exactly one native one-time cloud successor through lnwjud-scheduled-continuation before yielding; never wait for the user to type continue/ทำต่อ.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: checkpointGoalSchema,
      handler: async (input) => context.services.goals?.checkpointGoal(context.actor, {
        goalId: input.goalId,
        leaseToken: input.leaseToken,
        expectedRevision: input.expectedRevision,
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
        ...(input.releaseLease === undefined ? {} : { releaseLease: input.releaseLease }),
      }) ?? missingService(),
    }),
    defineTool({
      name: 'finish_goal',
      description: 'Finish the local durable goal using lease/revision compare-and-swap. It must be called before any completion report, even when scheduling was disabled or the user requested no more successors. If scheduledTaskCancellation requests delete_native_task, delete that exact task through the native ChatGPT Scheduled Task host, record its native deletion receipt, and verify status=cancelled before reporting cancellation success.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: finishGoalSchema,
      handler: async (input) => context.services.goals?.finishGoal(context.actor, input) ?? missingService(),
    }),
    defineTool({
      name: 'cancel_goal',
      description: 'Cancel a durable goal independently of any scheduled successor. It records the goal as cancelled, aborts in-flight fenced MCP requests for that goal, and attempts to stop only tracked tasks whose cancelWithGoal policy is true; shared supporting services remain running by default and are reported as taskCancellations status=skipped. An explicitly bound provider that is unavailable or cannot verify termination is reported as failed, so allTasksStopped remains false until the unresolved task is inspected. Inspect requestCancellation, taskCancellations, and allRequestsStopped/allTasksStopped for unresolved work. If scheduledTaskCancellation requests delete_native_task, use cancel_scheduled_continuation separately and complete the exact native ChatGPT host deletion receipt.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: cancelGoalSchema,
      handler: async (input) => context.services.goals?.cancelGoal(context.actor, input) ?? missingService(),
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
