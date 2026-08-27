import { z } from 'zod';
import {
  DEFAULT_GOAL_LEASE_SECONDS,
  MAX_GOAL_LEASE_SECONDS,
  MIN_GOAL_LEASE_SECONDS,
} from '@lnwjud/application';
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

const runGoalSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  goalKey,
  objective: z.string().min(1).max(4096).optional(),
  plan: plan.optional(),
  leaseSeconds: z.number().int().min(MIN_GOAL_LEASE_SECONDS).max(MAX_GOAL_LEASE_SECONDS).default(DEFAULT_GOAL_LEASE_SECONDS),
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
  activeTaskIds: z.array(z.string().min(1).max(256)).max(50),
  releaseLease: z.boolean().optional(),
}).strict();

const finishGoalSchema = z.object({
  goalId,
  leaseToken,
  expectedRevision: z.number().int().min(0),
  status: z.enum(['completed', 'failed', 'blocked']),
  summary: z.string().min(1).max(2048),
  evidence: z.array(evidence).max(20),
}).strict();

const listGoalsSchema = z.object({
  workspaceId: z.string().min(1).max(128).optional(),
  status: z.enum(['active', 'completed', 'failed', 'blocked']).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();

export const GOAL_TOOL_NAMES = ['run_goal', 'get_goal', 'checkpoint_goal', 'finish_goal', 'list_goals'] as const;

export function goalTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'run_goal',
      description: 'Immediate-return durable goal create/resume and lease acquisition. It never runs a model or waits for foreground work.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: runGoalSchema,
      handler: async (input) => context.services.goals?.runGoal(context.actor, {
        workspaceId: input.workspaceId,
        goalKey: input.goalKey,
        leaseSeconds: input.leaseSeconds,
        ...(input.objective === undefined ? {} : { objective: input.objective }),
        ...(input.plan === undefined ? {} : { plan: input.plan }),
      }) ?? missingService(),
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
      description: 'Atomically checkpoint durable goal progress using the current lease and expected revision.',
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
        activeTaskIds: input.activeTaskIds,
        ...(input.releaseLease === undefined ? {} : { releaseLease: input.releaseLease }),
      }) ?? missingService(),
    }),
    defineTool({
      name: 'finish_goal',
      description: 'Finish a durable goal as completed, failed, or blocked using lease/revision compare-and-swap.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: finishGoalSchema,
      handler: async (input) => context.services.goals?.finishGoal(context.actor, input) ?? missingService(),
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
