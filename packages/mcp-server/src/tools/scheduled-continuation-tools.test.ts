import { describe, expect, it, vi } from 'vitest';
import { appError, err, ok } from '@lnwjud/domain';
import { ContextEconomyRuntime } from '../context-economy.js';
import { ToolRegistry } from '../tool-registry.js';
import { scheduledContinuationTools } from './scheduled-continuation-tools.js';
import type { McpApplicationServices, McpToolContext } from './tool-types.js';

const actor = { clientId: 'chatgpt-web-client', clientName: 'ChatGPT Web', sessionId: 'session-a' };

function context(services: McpApplicationServices = {}): McpToolContext {
  return { actor, services, contextEconomy: new ContextEconomyRuntime() };
}

describe('scheduled continuation MCP tools', () => {
  it('publishes exactly six strict tools with the intended permission metadata', () => {
    const tools = scheduledContinuationTools(context());
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect([...byName.keys()]).toEqual([
      'prepare_scheduled_continuation',
      'record_scheduled_continuation_receipt',
      'claim_scheduled_continuation',
      'get_scheduled_continuation',
      'expedite_scheduled_continuation',
      'cancel_scheduled_continuation',
    ]);
    for (const name of ['prepare_scheduled_continuation', 'record_scheduled_continuation_receipt', 'claim_scheduled_continuation', 'expedite_scheduled_continuation']) {
      expect(byName.get(name)).toMatchObject({ permission: 'WRITE', annotations: { readOnlyHint: false, destructiveHint: false } });
    }
    expect(byName.get('cancel_scheduled_continuation')).toMatchObject({ permission: 'WRITE', annotations: { readOnlyHint: false, destructiveHint: true } });
    expect(byName.get('get_scheduled_continuation')).toMatchObject({ permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false } });

    const validPrepare = {
      goalId: 'goal-1', leaseToken: 'lease-secret', expectedRevision: 0, currentPhase: 'implement', summary: 'checkpoint',
      stepUpdates: [], nextAction: 'continue', blockers: [], evidence: [], activeTaskIds: [],
    };
    expect(byName.get('prepare_scheduled_continuation')?.parse(validPrepare)).toMatchObject({ ok: true, value: { successorDelayMinutes: 2, executionPreference: 'cloud' } });
    expect(byName.get('prepare_scheduled_continuation')?.parse({
      ...validPrepare,
      activeTaskIds: undefined,
      trackedTasks: [{ taskId: 'job-1', provider: 'shell', role: 'blocking_job', cancelWithGoal: true }],
    })).toMatchObject({ ok: true });
    expect(byName.get('prepare_scheduled_continuation')?.parse({ ...validPrepare, successorDelayMinutes: 2 })).toMatchObject({ ok: true, value: { successorDelayMinutes: 2 } });
    expect(byName.get('prepare_scheduled_continuation')?.parse({ ...validPrepare, successorDelayMinutes: 5 })).toMatchObject({ ok: true, value: { successorDelayMinutes: 5 } });
    expect(byName.get('prepare_scheduled_continuation')?.parse({ ...validPrepare, successorDelayMinutes: 24 })).toMatchObject({ ok: true, value: { successorDelayMinutes: 24 } });
    expect(byName.get('prepare_scheduled_continuation')?.parse({ ...validPrepare, successorDelayMinutes: 1 })).toMatchObject({ ok: false });
    expect(byName.get('prepare_scheduled_continuation')?.parse({ ...validPrepare, successorDelayMinutes: 2.5 })).toMatchObject({ ok: false });
    expect(byName.get('prepare_scheduled_continuation')?.parse({ ...validPrepare, successorDelayMinutes: 26 })).toMatchObject({ ok: false });
    expect(byName.get('prepare_scheduled_continuation')?.parse({ ...validPrepare, executionPreference: 'auto' })).toMatchObject({ ok: false });
    expect(byName.get('prepare_scheduled_continuation')?.parse({ ...validPrepare, executionPreference: 'local' })).toMatchObject({ ok: false });
    expect(byName.get('prepare_scheduled_continuation')?.parse({ ...validPrepare, delayMinutes: 2 })).toMatchObject({ ok: false });
    expect(byName.get('prepare_scheduled_continuation')?.parse({ ...validPrepare, releaseLease: true })).toMatchObject({ ok: false });

    expect(byName.get('record_scheduled_continuation_receipt')?.parse({ continuationId: 'c-1', expectedVersion: 0, outcome: 'created' })).toMatchObject({ ok: false });
    expect(byName.get('record_scheduled_continuation_receipt')?.parse({ continuationId: 'c-1', expectedVersion: 0, outcome: 'created', nativeTaskId: 'native-1' })).toMatchObject({ ok: false });
    expect(byName.get('record_scheduled_continuation_receipt')?.parse({ continuationId: 'c-1', expectedVersion: 0, outcome: 'created', nativeTaskId: 'native-1', runsOn: 'cloud' })).toMatchObject({ ok: true });
    expect(byName.get('record_scheduled_continuation_receipt')?.parse({ continuationId: 'c-1', expectedVersion: 1, outcome: 'rescheduled', nativeTaskId: 'native-1', dueAt: '2026-08-27T10:27:00.000Z' })).toMatchObject({ ok: true });
    expect(byName.get('record_scheduled_continuation_receipt')?.parse({ continuationId: 'c-1', expectedVersion: 2, outcome: 'consumed' })).toMatchObject({ ok: false });
    expect(byName.get('record_scheduled_continuation_receipt')?.parse({
      continuationId: 'c-1',
      expectedVersion: 2,
      outcome: 'consumed',
      nativeRunReceipt: {
        provider: 'chatgpt_scheduled_task',
        operation: 'run',
        nativeTaskId: 'native-1',
        state: 'consumed',
        observedAt: '2026-08-27T10:12:00.000Z',
      },
    })).toMatchObject({ ok: true });
    expect(byName.get('record_scheduled_continuation_receipt')?.parse({ continuationId: 'c-1', expectedVersion: 2, outcome: 'cancelled', nativeTaskId: 'native-1' })).toMatchObject({ ok: false });
    expect(byName.get('record_scheduled_continuation_receipt')?.parse({
      continuationId: 'c-1',
      expectedVersion: 2,
      outcome: 'cancelled',
      nativeCancellationReceipt: {
        provider: 'chatgpt_scheduled_task',
        operation: 'delete',
        nativeTaskId: 'native-1',
        state: 'deleted',
        observedAt: '2026-08-27T10:12:00.000Z',
      },
    })).toMatchObject({ ok: true });
    expect(byName.get('expedite_scheduled_continuation')?.parse({ goalId: 'g-1', continuationId: 'c-1', leaseToken: 'lease', expectedLeaseGeneration: 2, expectedGoalRevision: 3, expectedContinuationVersion: 4, reason: 'host_budget_warning' })).toMatchObject({ ok: true });
    expect(byName.get('claim_scheduled_continuation')?.parse({ continuationId: 'c-1' })).toMatchObject({ ok: true, value: { leaseSeconds: 600 } });
    expect(byName.get('claim_scheduled_continuation')?.parse({ continuationId: 'c-1', leaseSeconds: 600 })).toMatchObject({ ok: true });
    expect(byName.get('claim_scheduled_continuation')?.parse({ continuationId: 'c-1', leaseSeconds: 601 })).toMatchObject({ ok: false });
    expect(byName.get('claim_scheduled_continuation')?.parse({ continuationId: 'c-1', leaseSeconds: 3_600 })).toMatchObject({ ok: false });
    expect(byName.get('get_scheduled_continuation')?.parse({})).toMatchObject({ ok: false });
    expect(byName.get('get_scheduled_continuation')?.parse({ continuationId: 'c-1', goalId: 'g-1', latest: true })).toMatchObject({ ok: false });
    expect(byName.get('get_scheduled_continuation')?.parse({ goalId: 'g-1', latest: true })).toMatchObject({ ok: true });
    expect(byName.get('cancel_scheduled_continuation')?.parse({ continuationId: 'c-1', expectedVersion: 2 })).toMatchObject({ ok: true });
    expect(byName.get('cancel_scheduled_continuation')?.parse({ goalId: 'g-1', latest: true, expectedVersion: 2 })).toMatchObject({ ok: true });
    expect(byName.get('cancel_scheduled_continuation')?.parse({ continuationId: 'c-1', goalId: 'g-1', latest: true, expectedVersion: 2 })).toMatchObject({ ok: false });
    expect(byName.get('prepare_scheduled_continuation')?.description).toContain('adaptive');
    expect(byName.get('prepare_scheduled_continuation')?.description).toContain('2 and 25 minutes');
    expect(byName.get('claim_scheduled_continuation')?.description).toContain('120 seconds early');
    expect(byName.get('claim_scheduled_continuation')?.description).toContain('terminal_noop');
    expect(byName.get('claim_scheduled_continuation')?.description).toContain('do not delete, disable, pause, or reschedule');
    expect(byName.get('cancel_scheduled_continuation')?.description).toContain('still-pending scheduled successor');
    expect(byName.get('cancel_scheduled_continuation')?.description).toContain('pausing/disabling an already-fired current wake');
  });

  it('records continuation state without invoking process, capability, shell, or Windows scheduler backends', async () => {
    const calls = { scheduled: 0, process: 0, capability: 0 };
    const services = {
      scheduledContinuations: {
        async prepareScheduledContinuation() {
          calls.scheduled += 1;
          return ok({
            outcome: 'prepared', currentRunMayContinue: true, handoffDeadlineAt: '2026-08-27T10:02:00.000Z',
            goal: { goalId: 'g-1' }, continuation: { continuationId: 'c-1' },
            scheduleRequest: { provider: 'chatgpt_scheduled_task', occurrence: 'once', destination: 'current_chat' },
          });
        },
      },
      process: { async start() { calls.process += 1; return ok({}); } },
      capabilities: { async execute() { calls.capability += 1; return ok({}); } },
    } as unknown as McpApplicationServices;
    const prepare = scheduledContinuationTools(context(services)).find((tool) => tool.name === 'prepare_scheduled_continuation');
    if (prepare === undefined) throw new Error('prepare tool missing');
    const result = await prepare.execute({
      goalId: 'g-1', leaseToken: 'lease-secret', expectedRevision: 0, currentPhase: 'implement', summary: 'checkpoint',
      stepUpdates: [], nextAction: 'continue', blockers: [], evidence: [], activeTaskIds: [], successorDelayMinutes: 25, executionPreference: 'cloud',
    }, new AbortController().signal);
    expect(result).toMatchObject({ ok: true });
    expect(calls).toEqual({ scheduled: 1, process: 0, capability: 0 });
  });

  it('admits the current goalLease generation, strips the raw proof before handler dispatch, and closes the durable fenced call', async () => {
    const inspectWorkspaceFence = vi.fn(async () => ok({ goalId: 'goal-1', leaseGeneration: 7 }));
    const begin = vi.fn(async (_actor, _workspaceId, _callId, proof) => {
      expect(proof).toEqual({ goalId: 'goal-1', leaseToken: 'private-token', leaseGeneration: 7 });
      return ok({ goalId: 'goal-1', leaseGeneration: 7 });
    });
    const heartbeat = vi.fn(async () => undefined);
    const end = vi.fn(async () => undefined);
    const writeFile = vi.fn(async (_actor, _workspaceId, request) => {
      expect(request).not.toHaveProperty('goalLease');
      expect(JSON.stringify(request)).not.toContain('private-token');
      return ok({ path: 'file.txt', bytesWritten: 1 });
    });
    const services = {
      goalMutationFence: { inspectWorkspaceFence, begin, heartbeat, end },
      file: { writeFile },
    } as unknown as McpApplicationServices;
    const registry = new ToolRegistry(services, actor, {
      activeWorkspaceScopeProvider: async (): Promise<{ readonly workspaceId: string; readonly rootPath: string }> => ({ workspaceId: 'workspace-1', rootPath: 'E:\\project' }),
    });

    const response = await registry.invoke('write_file', {
      workspaceId: 'workspace-1', path: 'file.txt', content: 'x',
      goalLease: { goalId: 'goal-1', leaseToken: 'private-token', leaseGeneration: 7 },
    });
    expect(response.isError).not.toBe(true);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('blocks fenced workspace mutations before the underlying file/Git/process service runs', async () => {
    const inspectWorkspaceFence = vi.fn(async () => err(appError('CONFLICT', 'scheduled-continuation fence', true)));
    const writeFile = vi.fn(async () => ok({ path: 'file.txt', bytesWritten: 1 }));
    const services = {
      goalMutationFence: { inspectWorkspaceFence },
      file: { writeFile },
    } as unknown as McpApplicationServices;
    const registry = new ToolRegistry(services, actor, {
      activeWorkspaceScopeProvider: async (): Promise<{ readonly workspaceId: string; readonly rootPath: string }> => ({ workspaceId: 'workspace-1', rootPath: 'E:\\project' }),
    });

    const response = await registry.invoke('write_file', { workspaceId: 'workspace-1', path: 'file.txt', content: 'x' });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
    expect(inspectWorkspaceFence).toHaveBeenCalledWith(actor, 'workspace-1');
    expect(writeFile).not.toHaveBeenCalled();
  });
});
