import { describe, expect, it } from 'vitest';
import { ok } from '@lnwjud/domain';
import { ContextEconomyRuntime } from '../context-economy.js';
import { ActivityTracker, type ActivitySinkEvent } from '../activity-tracker.js';
import { ToolRegistry } from '../tool-registry.js';
import { goalTools } from './goal-tools.js';
import type { McpToolContext, McpToolDefinition } from './tool-types.js';

const actor = { clientId: 'chatgpt-web-client', clientName: 'ChatGPT Web', sessionId: 'session-a' };

function tool(context: McpToolContext, name: string): McpToolDefinition {
  const found = goalTools(context).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Missing goal tool ${name}`);
  return found;
}

describe('durable goal MCP tools', () => {
  it('publishes typed schemas and safe permission annotations', () => {
    const context = { actor, contextEconomy: new ContextEconomyRuntime(), services: {} } as McpToolContext;
    const byName = new Map(goalTools(context).map((entry) => [entry.name, entry]));
    expect([...byName.keys()]).toEqual(['run_goal', 'get_goal', 'checkpoint_goal', 'finish_goal', 'cancel_goal', 'list_goals']);
    expect(byName.get('run_goal')).toMatchObject({ permission: 'WRITE', annotations: { readOnlyHint: false, destructiveHint: false } });
    expect(byName.get('get_goal')).toMatchObject({ permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false } });
    expect(byName.get('list_goals')).toMatchObject({ permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false } });
    expect(byName.get('checkpoint_goal')).toMatchObject({ permission: 'WRITE', annotations: { readOnlyHint: false, destructiveHint: false } });
    expect(byName.get('finish_goal')).toMatchObject({ permission: 'WRITE', annotations: { readOnlyHint: false, destructiveHint: false } });
    expect(byName.get('cancel_goal')).toMatchObject({ permission: 'WRITE', annotations: { readOnlyHint: false, destructiveHint: true } });
    expect(byName.get('finish_goal')?.description).toContain('must be called before any completion report');
    expect(byName.get('finish_goal')?.description).toContain('even when scheduling was disabled');
    expect(byName.get('cancel_goal')?.description).toContain('aborts in-flight fenced MCP requests');
    expect(byName.get('cancel_goal')?.description).toContain('status=skipped');
    expect(byName.get('cancel_goal')?.description).toContain('provider that is unavailable');
    expect(byName.get('run_goal')?.description).toContain('scheduledContinuation=auto');
    expect(byName.get('run_goal')?.description).toContain('without waiting for the user to type continue/ทำต่อ');
    expect(byName.get('checkpoint_goal')?.description).toContain('exactly one native one-time cloud successor');

    expect(byName.get('run_goal')?.parse({ workspaceId: 'workspace-1', goalKey: 'stable-key' })).toMatchObject({ ok: true, value: { scheduledContinuation: 'auto' } });
    expect(byName.get('run_goal')?.parse({ workspaceId: 'workspace-1', goalKey: 'stable-key', scheduledContinuation: 'off' })).toMatchObject({ ok: true, value: { scheduledContinuation: 'off' } });
    expect(byName.get('run_goal')?.parse({ workspaceId: 'workspace-1', goalKey: 'stable-key', leaseSeconds: 5 })).toMatchObject({ ok: false });
    expect(byName.get('run_goal')?.parse({ workspaceId: 'workspace-1', goalKey: 'stable-key', leaseSeconds: 600 })).toMatchObject({ ok: true });
    expect(byName.get('run_goal')?.parse({ workspaceId: 'workspace-1', goalKey: 'stable-key', leaseSeconds: 601 })).toMatchObject({ ok: false });
    expect(byName.get('run_goal')?.parse({ workspaceId: 'workspace-1', goalKey: 'stable-key', leaseSeconds: 3_600 })).toMatchObject({ ok: false });
    expect(byName.get('checkpoint_goal')?.parse({ goalId: 'goal-1' })).toMatchObject({ ok: false });
    expect(byName.get('checkpoint_goal')?.parse({
      goalId: 'goal-1', leaseToken: 'lease-token', expectedRevision: 1, currentPhase: 'verify', summary: 'check',
      stepUpdates: [], nextAction: 'continue', blockers: [], evidence: [],
      trackedTasks: [{ taskId: 'job-1', provider: 'shell', role: 'blocking_job', cancelWithGoal: true }],
    })).toMatchObject({ ok: true });
    expect(byName.get('checkpoint_goal')?.parse({
      goalId: 'goal-1', leaseToken: 'lease-token', expectedRevision: 1, currentPhase: 'verify', summary: 'check',
      stepUpdates: [], nextAction: 'continue', blockers: [], evidence: [], activeTaskIds: ['job-1'],
      trackedTasks: [{ taskId: 'job-1', provider: 'shell', role: 'blocking_job', cancelWithGoal: true }],
    })).toMatchObject({ ok: false });
    expect(byName.get('cancel_goal')?.parse({ goalId: 'goal-1', expectedRevision: 1, summary: 'stop', evidence: [] })).toMatchObject({ ok: true });
    expect(byName.get('cancel_goal')?.parse({ goalId: 'goal-1', leaseToken: 'old-token', expectedRevision: 1, summary: 'stop', evidence: [] })).toMatchObject({ ok: false });
    expect(byName.get('get_goal')?.parse({})).toMatchObject({ ok: false });
    expect(byName.get('get_goal')?.parse({ goalId: 'goal-1', workspaceId: 'workspace-1', goalKey: 'key' })).toMatchObject({ ok: false });
  });

  it('run_goal returns immediately and never invokes process/capability execution', async () => {
    let runs = 0;
    let processStarts = 0;
    let capabilityRuns = 0;
    const context = {
      actor,
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        goals: {
          async runGoal() {
            runs += 1;
            return ok({
              goalId: 'goal-1', goalKey: 'stable-key', status: 'active', revision: 0, acquired: true,
              leaseToken: 'lease-secret', leaseExpiresAt: '2026-08-26T00:10:00.000Z', currentPhase: 'created',
              plan: { steps: [] }, completedSteps: [], pendingSteps: [], nextAction: 'Start the first short tool call.', blockers: [], activeTaskIds: [], lastCheckpoint: null,
            });
          },
        },
        process: {
          async start() { processStarts += 1; return ok({}); },
        },
        capabilities: {
          async execute() { capabilityRuns += 1; return ok({}); },
        },
      },
    } as unknown as McpToolContext;

    const startedAt = performance.now();
    const result = await tool(context, 'run_goal').execute({ workspaceId: 'workspace-1', goalKey: 'stable-key', objective: 'Do work' }, new AbortController().signal);
    const elapsedMs = performance.now() - startedAt;
    expect(result).toMatchObject({
      ok: true,
      value: {
        acquired: true,
        goalId: 'goal-1',
        continuationDirective: {
          mode: 'auto',
          skillId: 'workspace-agents-skills/lnwjud-scheduled-continuation',
          nativeTaskHostRequired: true,
          userMustPromptAgain: false,
          nextRequiredAction: 'checkpoint_then_ensure_one_cloud_successor',
        },
      },
    });
    expect(runs).toBe(1);
    expect(processStarts).toBe(0);
    expect(capabilityRuns).toBe(0);
    expect(elapsedMs).toBeLessThan(100);
    expect(tool(context, 'run_goal').description).toMatch(/Immediate-return/i);
  });

  it('lets an explicit scheduling opt-out disable only the successor directive', async () => {
    const context = {
      actor,
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        goals: {
          async runGoal() {
            return ok({
              goalId: 'goal-off', goalKey: 'stable-key', status: 'active', revision: 2, acquired: true,
              leaseToken: 'lease-secret', leaseExpiresAt: '2026-08-26T00:10:00.000Z', currentPhase: 'work',
              plan: { steps: [] }, completedSteps: [], pendingSteps: [], nextAction: 'Keep working.', blockers: [], activeTaskIds: [], lastCheckpoint: { id: 'cp-1' },
            });
          },
        },
      },
    } as unknown as McpToolContext;

    const result = await tool(context, 'run_goal').execute({ workspaceId: 'workspace-1', goalKey: 'stable-key', scheduledContinuation: 'off' }, new AbortController().signal);
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: 'active',
        continuationDirective: {
          mode: 'off',
          userMustPromptAgain: false,
          nextRequiredAction: 'continue_current_run_without_successor',
        },
      },
    });
  });

  it('passes exact pending-native-task cancellation guidance through finish_goal', async () => {
    let finishes = 0;
    const context = {
      actor,
      contextEconomy: new ContextEconomyRuntime(),
      services: {
        goals: {
          async finishGoal() {
            finishes += 1;
            return ok({
              goalId: 'goal-1',
              status: 'completed',
              scheduledTaskCancellation: {
                action: 'delete_native_task',
                continuationId: 'continuation-c',
                nativeTaskId: 'native-task-c',
                provider: 'chatgpt_scheduled_task',
                expectedContinuationVersion: 4,
                receiptRequired: true,
                reason: 'live_task_confirmed',
              },
            });
          },
        },
      },
    } as unknown as McpToolContext;

    const result = await tool(context, 'finish_goal').execute({
      goalId: 'goal-1',
      leaseToken: 'lease-token',
      expectedRevision: 3,
      status: 'completed',
      summary: 'done',
      evidence: [],
    }, new AbortController().signal);
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: 'completed',
        scheduledTaskCancellation: {
          action: 'delete_native_task',
          continuationId: 'continuation-c',
          nativeTaskId: 'native-task-c',
          provider: 'chatgpt_scheduled_task',
          expectedContinuationVersion: 4,
          receiptRequired: true,
        },
      },
    });
    expect(finishes).toBe(1);
  });

  it('never exposes leaseToken or sensitive goal text through activity records', async () => {
    const events: ActivitySinkEvent[] = [];
    const leaseToken = 'lease-token-SUPERSECRET';
    const activityTracker = new ActivityTracker({ async record(event): Promise<void> { events.push(event); } });
    const registry = new ToolRegistry({
      goals: {
        async runGoal() {
          return ok({
            goalId: 'goal-1', goalKey: 'stable-key', status: 'active', revision: 0, acquired: true,
            leaseToken, leaseExpiresAt: '2026-08-26T00:10:00.000Z', currentPhase: 'created', plan: { steps: [] },
            completedSteps: [], pendingSteps: [], nextAction: 'continue', blockers: [], activeTaskIds: [], lastCheckpoint: null,
          });
        },
        async checkpointGoal() {
          return ok({ goalId: 'goal-1', goalKey: 'stable-key', workspaceId: 'workspace-1', objective: 'safe', status: 'active', revision: 1, currentPhase: 'verify', plan: { steps: [] }, completedSteps: [], pendingSteps: [], nextAction: 'continue', blockers: [], activeTaskIds: [], lastCheckpoint: null, createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:01.000Z' });
        },
      } as never,
    }, actor, { activityTracker });

    const started = await registry.invoke('run_goal', {
      workspaceId: 'workspace-1', goalKey: 'stable-key', objective: 'token=objective-secret',
    });
    expect(started.isError).not.toBe(true);
    const checkpointed = await registry.invoke('checkpoint_goal', {
      goalId: 'goal-1', leaseToken, expectedRevision: 0, currentPhase: 'verify', summary: 'token=summary-secret', stepUpdates: [], nextAction: 'continue', blockers: [], evidence: [], activeTaskIds: [],
    });
    expect(checkpointed.isError).not.toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(leaseToken);
    expect(serialized).not.toContain('objective-secret');
    expect(serialized).not.toContain('summary-secret');
    expect(events.find((entry) => entry.toolName === 'checkpoint_goal')?.targetSummary).toContain('goal-1');
  });

  it('registers the six tools in the public registry/catalog with typed schemas', () => {
    const registry = new ToolRegistry({}, actor);
    const names = registry.list().map((entry) => entry.name);
    for (const name of ['run_goal', 'get_goal', 'checkpoint_goal', 'finish_goal', 'cancel_goal', 'list_goals']) expect(names).toContain(name);
    const runSchema = registry.describeSchema('run_goal');
    const checkpointSchema = registry.describeSchema('checkpoint_goal');
    expect(JSON.stringify(runSchema)).toContain('goalKey');
    expect(JSON.stringify(runSchema)).toContain('leaseSeconds');
    expect(JSON.stringify(runSchema)).toContain('scheduledContinuation');
    expect(JSON.stringify(checkpointSchema)).toContain('expectedRevision');
    expect(JSON.stringify(checkpointSchema)).toContain('releaseLease');
    const runJsonSchema = registry.describeInputJsonSchema('run_goal');
    expect(runJsonSchema).toMatchObject({ type: 'object' });
    expect(JSON.stringify(runJsonSchema)).toContain('goalKey');
    expect(() => structuredClone(runJsonSchema)).not.toThrow();
  });
});
