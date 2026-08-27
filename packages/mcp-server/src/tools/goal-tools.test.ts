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
    expect([...byName.keys()]).toEqual(['run_goal', 'get_goal', 'checkpoint_goal', 'finish_goal', 'list_goals']);
    expect(byName.get('run_goal')).toMatchObject({ permission: 'WRITE', annotations: { readOnlyHint: false, destructiveHint: false } });
    expect(byName.get('get_goal')).toMatchObject({ permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false } });
    expect(byName.get('list_goals')).toMatchObject({ permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false } });
    expect(byName.get('checkpoint_goal')).toMatchObject({ permission: 'WRITE', annotations: { readOnlyHint: false, destructiveHint: false } });
    expect(byName.get('finish_goal')).toMatchObject({ permission: 'WRITE', annotations: { readOnlyHint: false, destructiveHint: false } });

    expect(byName.get('run_goal')?.parse({ workspaceId: 'workspace-1', goalKey: 'stable-key' })).toMatchObject({ ok: true });
    expect(byName.get('run_goal')?.parse({ workspaceId: 'workspace-1', goalKey: 'stable-key', leaseSeconds: 5 })).toMatchObject({ ok: false });
    expect(byName.get('checkpoint_goal')?.parse({ goalId: 'goal-1' })).toMatchObject({ ok: false });
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
    expect(result).toMatchObject({ ok: true, value: { acquired: true, goalId: 'goal-1' } });
    expect(runs).toBe(1);
    expect(processStarts).toBe(0);
    expect(capabilityRuns).toBe(0);
    expect(elapsedMs).toBeLessThan(100);
    expect(tool(context, 'run_goal').description).toMatch(/Immediate-return/i);
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

  it('registers the five tools in the public registry/catalog with typed schemas', () => {
    const registry = new ToolRegistry({}, actor);
    const names = registry.list().map((entry) => entry.name);
    for (const name of ['run_goal', 'get_goal', 'checkpoint_goal', 'finish_goal', 'list_goals']) expect(names).toContain(name);
    const runSchema = registry.describeSchema('run_goal');
    const checkpointSchema = registry.describeSchema('checkpoint_goal');
    expect(JSON.stringify(runSchema)).toContain('goalKey');
    expect(JSON.stringify(runSchema)).toContain('leaseSeconds');
    expect(JSON.stringify(checkpointSchema)).toContain('expectedRevision');
    expect(JSON.stringify(checkpointSchema)).toContain('releaseLease');
  });
});
