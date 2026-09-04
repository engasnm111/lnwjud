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
const nativeCancellationReceipt = z.discriminatedUnion('operation', [
  z.object({
    provider: z.literal('chatgpt_scheduled_task'),
    operation: z.literal('delete'),
    nativeTaskId,
    state: z.enum(['deleted', 'not_found']),
    observedAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    provider: z.literal('chatgpt_scheduled_task'),
    operation: z.literal('disable'),
    nativeTaskId,
    state: z.literal('disabled'),
    observedAt: z.string().datetime({ offset: true }),
  }).strict(),
]);

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
  z.object({ continuationId, expectedVersion: version, outcome: z.literal('created'), nativeTaskId, dueAt, runsOn: z.enum(['cloud', 'unverified']), detail }).strict(),
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
      description: 'Checkpoint durable progress and ensure exactly one live current-chat Native ChatGPT hourly recurring watchdog with cloud execution requested. New v4.53 watchdogs use occurrence=interval and intervalMinutes=60; when successorDelayMinutes is omitted the first firing is one hour from prepare, while a legacy explicit 2–25 minute value changes only the first firing and never the hourly recurrence cadence. Reuse the same confirmed native task ID across checkpoints and ordinary wakes; never create a per-wake successor or retime the recurring cadence. If an active v4.52 one-time watchdog already exists, reuse that legacy task until it becomes historical before creating the recurring watchdog, so one-time and recurring native tasks never overlap for one goal. prepared means reservation only and is not confirmed host coverage. Record native create failure or uncertainty truthfully and reconcile uncertain host state before any blind create. On an explicit host-surface lookup/dispatch failure such as Resource not found that proves the operation was not dispatched, re-resolve the current Native Scheduled Task host operation once and retry that exact native operation once; never retry ambiguous possible-success and never switch scheduler providers. Host create and cleanup remain Native ChatGPT Scheduled Task operations exposed by the current chat; never use browser/DOM automation, Windows Task Scheduler, cron, shell timers, or an lnwjud-local scheduler as a substitute.',
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
      description: 'Record Native ChatGPT host receipts for recurring v4.53 watchdogs and legacy v4.52 one-time watchdogs. created receipts require the real native task ID and host-reported absolute dueAt. A recurring interval firing never consumes or replaces the native task, so outcome=consumed is legacy one-time compatibility only. rescheduled/reschedule_* are likewise one-time compatibility paths; ordinary recurring wakes must not retime the task. cancelled is accepted only with matching native host evidence that the exact task is non-runnable: delete may report deleted/not_found and hosts without delete may report an exact disable receipt. A model assertion is never cleanup proof, and the stored native task ID is immutable for the lifetime of the watchdog.',
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
      description: 'Scheduled-wake entrypoint and the first lnwjud action before any workspace mutation. For occurrence=interval, the same native hourly task remains scheduled across firings: a live/uncertain worker returns worker_busy_noop without lease theft or host-task mutation, duplicate delivery returns already_claimed, a safely available lease returns recurring_acquired, and a still-valid stale lease with trustworthy no-worker/no-blocking-work evidence is recovered in the same hourly tick after the bounded 60-second stale-heartbeat grace rather than waiting for expiry or a second hourly firing. Ordinary recurring wakes never create a successor, never consume the native task, and never retime its cadence. terminal_noop performs no work; if terminal cleanup is pending, make the exact recurring native task non-runnable rather than resuming goal work. Historical occurrence=once rows retain the v4.52 acquired/successor_required/reschedule compatibility paths. Never count prepared as confirmed and never mutate the workspace without the acquired goal lease.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: claimSchema,
      handler: async (input) => context.services.scheduledContinuations?.claimScheduledContinuation(context.actor, input) ?? missingService(),
    }),
    defineTool({
      name: 'get_scheduled_continuation',
      description: 'Read one scheduled-continuation snapshot by continuation ID or the latest record for a goal. In v4.53, occurrence=interval identifies the single hourly recurring watchdog; its dueAt is the first scheduled firing, not a mutation handoff deadline, and its native task ID remains stable across ordinary wakes. Historical occurrence=once rows preserve legacy one-time compatibility state.',
      permission: 'READ',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: getSchema,
      handler: async (input) => context.services.scheduledContinuations?.getScheduledContinuation(context.actor, input) ?? missingService(),
    }),
    defineTool({
      name: 'expedite_scheduled_continuation',
      description: 'Legacy one-time compatibility only. For a still-pending occurrence=once watchdog and an enumerated handoff-risk signal, adaptively move that exact native task closer using the existing v4.52 rules. occurrence=interval recurring watchdogs must not use expedite_scheduled_continuation because ordinary recurring cadence is fixed at one hour and the host contract exposes no truthful immediate-run operation. Never create a replacement task through this operation.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: expediteSchema,
      handler: async (input) => context.services.scheduledContinuations?.expediteScheduledContinuation(context.actor, input) ?? missingService(),
    }),
    defineTool({
      name: 'cancel_scheduled_continuation',
      description: 'Cancel the scheduled watchdog independently of its durable goal. For v4.53 occurrence=interval, make the exact recurring Native ChatGPT task non-runnable with the strongest host operation actually exposed: prefer true delete, otherwise a host-confirmed disable. One recurring firing never consumes the task, so a past first due time is not cleanup proof. Historical occurrence=once rows retain their legacy cancellation/reconciliation behavior. Never treat a model assertion or unverified host state as cleanup proof. This does not cancel the durable goal or stop its running tasks.',
      permission: 'WRITE',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: cancelSchema,
      handler: async (input) => context.services.scheduledContinuations?.cancelScheduledContinuation(context.actor, input) ?? missingService(),
    }),
  ];
}
