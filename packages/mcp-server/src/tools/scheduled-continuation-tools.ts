import { z } from 'zod';
import {
  MAX_SUCCESSOR_DELAY_MINUTES,
  MIN_SUCCESSOR_DELAY_MINUTES,
} from '@lnwjud/application';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';

const continuationId = z.string().min(1).max(128);
const goalId = z.string().min(1).max(128);
const leaseToken = z.string().min(1).max(256);
const evidence = z.object({
  kind: z.enum(['path', 'hash', 'task', 'note']),
  value: z.string().min(1).max(1024),
}).strict();
const stepUpdate = z.object({
  stepId: z.string().min(1).max(128),
  status: z.enum(['pending', 'in_progress', 'completed', 'blocked']),
  summary: z.string().max(1024).optional(),
}).strict();
const trackedTask = z.object({
  taskId: z.string().min(1).max(256),
  provider: z.enum(['process', 'codex', 'shell']),
  role: z.enum(['blocking_job', 'supporting_service']),
  cancelWithGoal: z.boolean(),
}).strict();
const version = z.number().int().min(0);
const nativeTaskId = z.string().min(1).max(512);
const dueAt = z.string().datetime({ offset: true });
const detail = z.string().max(1024).optional();
const nativeRunReceipt = z.object({
  provider: z.literal('chatgpt_scheduled_task'),
  operation: z.literal('run'),
  nativeTaskId,
  state: z.literal('consumed'),
  observedAt: z.string().datetime({ offset: true }),
}).strict();
const nativeCancellationReceipt = z.object({
  provider: z.literal('chatgpt_scheduled_task'),
  operation: z.literal('delete'),
  nativeTaskId,
  state: z.enum(['deleted', 'not_found']),
  observedAt: z.string().datetime({ offset: true }),
}).strict();

const prepareSchema = z.object({
  goalId,
  leaseToken,
  expectedRevision: version,
  currentPhase: z.string().min(1).max(256),
  summary: z.string().min(1).max(2048),
  stepUpdates: z.array(stepUpdate).max(100),
  nextAction: z.string().min(1).max(1024),
  blockers: z.array(z.string().min(1).max(512)).max(20),
  evidence: z.array(evidence).max(20),
  activeTaskIds: z.array(z.string().min(1).max(256)).max(50).optional(),
  trackedTasks: z.array(trackedTask).max(50).optional(),
  successorDelayMinutes: z.number().int()
    .min(MIN_SUCCESSOR_DELAY_MINUTES)
    .max(MAX_SUCCESSOR_DELAY_MINUTES)
    .optional(),
  executionPreference: z.literal('cloud').default('cloud'),
}).strict().refine((value) => value.activeTaskIds !== undefined || value.trackedTasks !== undefined, {
  message: 'activeTaskIds or trackedTasks is required',
}).refine((value) => value.activeTaskIds === undefined || value.trackedTasks === undefined || value.activeTaskIds.length === 0, {
  message: 'Use trackedTasks or activeTaskIds, not both',
});

const receiptSchema = z.discriminatedUnion('outcome', [
  z.object({ continuationId, expectedVersion: version, outcome: z.literal('created'), nativeTaskId, dueAt, runsOn: z.literal('cloud'), detail }).strict(),
  z.object({ continuationId, expectedVersion: version, outcome: z.literal('create_failed'), nativeTaskId: nativeTaskId.optional(), runsOn: z.literal('cloud').optional(), detail }).strict(),
  z.object({ continuationId, expectedVersion: version, outcome: z.literal('create_uncertain'), nativeTaskId: nativeTaskId.optional(), runsOn: z.literal('cloud').optional(), detail }).strict(),
  z.object({ continuationId, expectedVersion: version, outcome: z.literal('rescheduled'), nativeTaskId, dueAt, runsOn: z.literal('cloud').optional(), detail }).strict(),
  z.object({ continuationId, expectedVersion: version, outcome: z.literal('reschedule_failed'), nativeTaskId, dueAt, runsOn: z.literal('cloud').optional(), detail }).strict(),
  z.object({ continuationId, expectedVersion: version, outcome: z.literal('reschedule_uncertain'), nativeTaskId, dueAt, runsOn: z.literal('cloud').optional(), detail }).strict(),
  z.object({ continuationId, expectedVersion: version, outcome: z.literal('consumed'), nativeRunReceipt, detail }).strict(),
  z.object({ continuationId, expectedVersion: version, outcome: z.literal('cancelled'), nativeCancellationReceipt, detail }).strict(),
  z.object({ continuationId, expectedVersion: version, outcome: z.literal('cancel_failed'), nativeTaskId: nativeTaskId.optional(), runsOn: z.literal('cloud').optional(), detail }).strict(),
  z.object({ continuationId, expectedVersion: version, outcome: z.literal('cancel_uncertain'), nativeTaskId: nativeTaskId.optional(), runsOn: z.literal('cloud').optional(), detail }).strict(),
]);

const claimSchema = z.object({
  continuationId,
  leaseSeconds: z.number().int().min(30).max(600).default(600),
}).strict();

const getSchema = z.union([
  z.object({ continuationId }).strict(),
  z.object({ goalId, latest: z.literal(true) }).strict(),
]);

const expediteSchema = z.object({
  goalId,
  continuationId,
  leaseToken,
  expectedLeaseGeneration: version,
  expectedGoalRevision: version,
  expectedContinuationVersion: version,
  reason: z.enum([
    'host_deadline_warning',
    'host_budget_warning',
    'tool_access_degradation',
    'turn_yield_signal',
  ]),
}).strict();

const cancelSchema = z.union([
  z.object({ continuationId, expectedVersion: version }).strict(),
  z.object({ goalId, latest: z.literal(true), expectedVersion: version }).strict(),
]);

export const SCHEDULED_CONTINUATION_TOOL_NAMES = [
  'prepare_scheduled_continuation',
  'record_scheduled_continuation_receipt',
  'claim_scheduled_continuation',
  'get_scheduled_continuation',
  'expedite_scheduled_continuation',
  'cancel_scheduled_continuation',
] as const;

export function scheduledContinuationTools(context: McpToolContext): McpToolDefinition[] {
  return [
    defineTool({
      name: 'prepare_scheduled_continuation',
      description: 'Checkpoint and reserve exactly one current-chat cloud successor. If successorDelayMinutes is omitted, the adaptive due time is calculated from the current durable-goal lease and clamped to the supported host window between 2 and 25 minutes instead of using a fixed cadence. Explicit delays between 2 and 25 minutes remain available for bounded caller intent. A prepared reservation is NOT a confirmed successor and is not handoff-ready, but a live worker with a valid goal lease may keep doing fenced work while native-task creation is retried. Record native create failure or uncertainty truthfully; before turn yield or handoff, require a created receipt with the real native task ID plus runsOn=cloud unless the goal is terminal or scheduling was explicitly disabled. Use trackedTasks for goal-relative blocking_job/supporting_service roles and explicit provider routing; activeTaskIds remains a legacy compatibility form. Supporting services do not block scheduled-claim liveness and are cancelled only when cancelWithGoal=true. This workflow never creates or deletes the native task itself.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: prepareSchema,
      handler: async (input) => context.services.scheduledContinuations?.prepareScheduledContinuation(context.actor, {
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
        ...(input.successorDelayMinutes === undefined ? {} : { successorDelayMinutes: input.successorDelayMinutes }),
        executionPreference: input.executionPreference,
      }) ?? missingService(),
    }),
    defineTool({
      name: 'record_scheduled_continuation_receipt',
      description: 'Record host-owned cloud one-time task create, same-task reschedule, consumed-run reconciliation, or cancellation receipts. Created/rescheduled receipts must include the host-reported absolute dueAt; equivalent timezone offsets are compared as the same instant, while real schedule drift is rejected. A consumed receipt requires exact native host run evidence and means only that the one-time task is no longer pending; it does not mean the goal work completed. Cancelled is accepted only with a matching native ChatGPT host deletion receipt; a model assertion is not cancellation proof. The stored native task ID is immutable across reschedules.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: receiptSchema,
      handler: async (input) => context.services.scheduledContinuations?.recordScheduledContinuationReceipt(context.actor, {
        continuationId: input.continuationId,
        expectedVersion: input.expectedVersion,
        outcome: input.outcome,
        ...('nativeTaskId' in input && input.nativeTaskId !== undefined ? { nativeTaskId: input.nativeTaskId } : {}),
        ...('dueAt' in input && input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
        ...('runsOn' in input && input.runsOn !== undefined ? { runsOn: input.runsOn } : {}),
        ...('nativeRunReceipt' in input ? { nativeRunReceipt: input.nativeRunReceipt } : {}),
        ...('nativeCancellationReceipt' in input ? { nativeCancellationReceipt: input.nativeCancellationReceipt } : {}),
        ...(input.detail === undefined ? {} : { detail: input.detail }),
      }) ?? missingService(),
    }),
    defineTool({
      name: 'claim_scheduled_continuation',
      description: 'Scheduled-wake entrypoint. Claim before workspace mutation; a confirmed cloud wake up to 120 seconds early is accepted as bounded host jitter. A one-time task that has already fired is treated as consumed transport identity and is never relied on as future coverage. On acquired, claim atomically reserves a fresh lease-aligned prepared successor and returns its scheduleRequest. On a live/uncertain worker collision, an expired lease with a running blocking job, or a wake outside the accepted early window, the firing task is retired and successor_required returns one fresh adaptive successor instead of trying to update the consumed native task. Interrupted claims reuse the same deterministic successor. Reconcile missing/uncertain native receipts before any blind create. Truthfully failed creates refresh to the current lease-aligned adaptive due time. reschedule_required is legacy compatibility only. terminal_noop returns naturally. Never count prepared as confirmed and never mutate the workspace without the acquired goal lease.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: claimSchema,
      handler: async (input) => context.services.scheduledContinuations?.claimScheduledContinuation(context.actor, input) ?? missingService(),
    }),
    defineTool({
      name: 'get_scheduled_continuation',
      description: 'Read one scheduled-continuation snapshot by continuation ID or the latest record for a goal. Healthy work keeps its calculated successor deadline; a real handoff-risk signal may adaptively expedite only a still-pending future native task.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: getSchema,
      handler: async (input) => context.services.scheduledContinuations?.getScheduledContinuation(context.actor, input) ?? missingService(),
    }),
    defineTool({
      name: 'expedite_scheduled_continuation',
      description: 'For an enumerated handoff-risk signal, adaptively move the exact still-pending cloud one-time native task closer using the current lease, host-jitter safety margin, and deterministic staggering. This is the only same-task update path; a task that has already fired must be retired and replaced by the fresh successor returned from claim.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: expediteSchema,
      handler: async (input) => context.services.scheduledContinuations?.expediteScheduledContinuation(context.actor, input) ?? missingService(),
    }),
    defineTool({
      name: 'cancel_scheduled_continuation',
      description: 'Cancel one still-pending scheduled successor independently of its goal. Identify it by continuationId or the latest record for a goal, then use the returned cancellation instruction to delete the exact pending native ChatGPT Scheduled Task and record its host receipt. Never treat pausing/disabling an already-fired current wake as deletion or completion proof. This does not cancel the durable goal or stop its running tasks.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: cancelSchema,
      handler: async (input) => context.services.scheduledContinuations?.cancelScheduledContinuation(context.actor, input) ?? missingService(),
    }),
  ];
}
