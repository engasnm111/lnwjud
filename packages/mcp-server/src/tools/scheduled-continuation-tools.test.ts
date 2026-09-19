import { describe, expect, it, vi } from 'vitest';
import { appError, err, ok, type AutomationRunSnapshot } from '@lnwjud/domain';
import { ContextEconomyRuntime } from '../context-economy.js';
import type { McpToolResponse } from '../result-mapper.js';
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
    const parsedDefaultPrepare = byName.get('prepare_scheduled_continuation')?.parse(validPrepare);
    expect(parsedDefaultPrepare).toMatchObject({ ok: true, value: { executionPreference: 'cloud' } });
    if (parsedDefaultPrepare?.ok) expect(parsedDefaultPrepare.value).not.toHaveProperty('successorDelayMinutes');
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
    expect(byName.get('record_scheduled_continuation_receipt')?.parse({ continuationId: 'c-1', expectedVersion: 0, outcome: 'created', nativeTaskId: 'native-1', runsOn: 'cloud' })).toMatchObject({ ok: false });
    expect(byName.get('record_scheduled_continuation_receipt')?.parse({ continuationId: 'c-1', expectedVersion: 0, outcome: 'created', nativeTaskId: 'native-1', dueAt: '2026-08-27T17:25:00+07:00', runsOn: 'cloud' })).toMatchObject({ ok: true });
    expect(byName.get('record_scheduled_continuation_receipt')?.parse({ continuationId: 'c-1', expectedVersion: 0, outcome: 'created', nativeTaskId: 'native-1', dueAt: '2026-08-27T17:25:00+07:00', runsOn: 'unverified' })).toMatchObject({ ok: true });
    expect(byName.get('record_scheduled_continuation_receipt')?.parse({ continuationId: 'c-1', expectedVersion: 0, outcome: 'created', nativeTaskId: 'native-1', dueAt: '2026-08-27T17:25:00+07:00', runsOn: 'local' })).toMatchObject({ ok: false });
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
    expect(byName.get('record_scheduled_continuation_receipt')?.parse({
      continuationId: 'c-1',
      expectedVersion: 2,
      outcome: 'cancelled',
      nativeCancellationReceipt: {
        provider: 'chatgpt_scheduled_task',
        operation: 'disable',
        nativeTaskId: 'native-1',
        state: 'disabled',
        observedAt: '2026-08-27T10:12:00.000Z',
      },
    })).toMatchObject({ ok: true });
    expect(byName.get('record_scheduled_continuation_receipt')?.parse({
      continuationId: 'c-1',
      expectedVersion: 2,
      outcome: 'cancelled',
      userCancellationReceipt: {
        source: 'user_confirmation',
        nativeTaskId: 'native-1',
        action: 'deleted_in_chatgpt_scheduled_tasks_ui',
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
    expect(byName.get('prepare_scheduled_continuation')?.description).toContain('hourly recurring watchdog');
    expect(byName.get('prepare_scheduled_continuation')?.description).toContain('intervalMinutes=60');
    expect(byName.get('prepare_scheduled_continuation')?.description).toContain('legacy explicit 2–25 minute value changes only the first firing');
    expect(byName.get('prepare_scheduled_continuation')?.description).toContain('never create a per-wake successor');
    expect(byName.get('prepare_scheduled_continuation')?.description).toContain('one-time and recurring native tasks never overlap');
    expect(byName.get('claim_scheduled_continuation')?.description).toContain('worker_busy_noop');
    expect(byName.get('claim_scheduled_continuation')?.description).toContain('already_claimed');
    expect(byName.get('claim_scheduled_continuation')?.description).toContain('recurring_acquired');
    expect(byName.get('claim_scheduled_continuation')?.description).toContain('automationResume');
    expect(byName.get('claim_scheduled_continuation')?.description).toContain('Busy/duplicate claims never advance automation');
    expect(byName.get('claim_scheduled_continuation')?.description).toContain('never create a successor');
    expect(byName.get('claim_scheduled_continuation')?.description).toContain('never consume the native task');
    expect(byName.get('claim_scheduled_continuation')?.description).toContain('terminal cleanup is pending');
    expect(byName.get('claim_scheduled_continuation')?.description).toContain('Historical occurrence=once');
    expect(byName.get('claim_scheduled_continuation')?.description).toContain('Never count prepared as confirmed');
    expect(byName.get('expedite_scheduled_continuation')?.description).toContain('Legacy one-time compatibility only');
    expect(byName.get('expedite_scheduled_continuation')?.description).toContain('recurring watchdogs must not use');
    expect(byName.get('cancel_scheduled_continuation')?.description).toContain('exact recurring Native ChatGPT task non-runnable');
    expect(byName.get('cancel_scheduled_continuation')?.description).toContain('past first due time is not cleanup proof');
  });

  it('passes explicit user confirmation through for user-attested manual Scheduled Task deletion', async () => {
    const received: unknown[] = [];
    const services = {
      scheduledContinuations: {
        async recordScheduledContinuationReceipt(_actor: unknown, request: unknown) {
          received.push(request);
          return ok({ continuationId: 'c-1', status: 'cancelled' });
        },
      },
    } as unknown as McpApplicationServices;
    const registry = new ToolRegistry(services, actor);
    const response = await registry.invoke('record_scheduled_continuation_receipt', {
      continuationId: 'c-1',
      expectedVersion: 2,
      outcome: 'cancelled',
      userConfirmed: true,
      userCancellationReceipt: {
        source: 'user_confirmation',
        nativeTaskId: 'native-1',
        action: 'deleted_in_chatgpt_scheduled_tasks_ui',
        observedAt: '2026-08-27T10:12:00.000Z',
      },
    });
    expect(response.isError).not.toBe(true);
    expect(received).toEqual([expect.objectContaining({
      userConfirmed: true,
      userCancellationReceipt: expect.objectContaining({
        source: 'user_confirmation',
        nativeTaskId: 'native-1',
      }),
    })]);
  });

  it('records continuation state without invoking process, capability, shell, or Windows scheduler backends', async () => {
    const calls = { scheduled: 0, process: 0, capability: 0 };
    const services = {
      scheduledContinuations: {
        async prepareScheduledContinuation() {
          calls.scheduled += 1;
          return ok({
            outcome: 'prepared', currentRunMayContinue: true, handoffReady: false, nativeTaskConfirmationRequired: true,
            nextRequiredAction: 'create_native_task_and_record_receipt_before_yield', handoffDeadlineAt: '2026-08-27T10:02:00.000Z',
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

  it('enriches a recurring claim with persisted automation resume state without reconstructing chat context', async () => {
    const calls: string[] = [];
    const waiting: AutomationRunSnapshot = {
      id: 'run-1',
      goalId: 'goal-1',
      workspaceId: 'workspace-1',
      policyProfile: 'coding_guarded',
      revision: 4,
      status: 'waiting_task',
      basedOnGoalRevision: 2,
      basedOnUserIntentRevision: 0,
      currentMilestoneId: 'm1',
      currentAttemptId: 'attempt-1',
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:04:00.000Z',
      milestones: [{
        id: 'm1',
        runId: 'run-1',
        ordinal: 0,
        title: 'Build',
        dependsOn: [],
        executionIntent: 'Build the project.',
        verificationRequirements: [],
        retryPolicy: { classification: 'workspace_mutation', maxAttempts: 1 },
        status: 'waiting_task',
        currentAttemptId: 'attempt-1',
        createdAt: '2026-09-19T00:00:00.000Z',
        updatedAt: '2026-09-19T00:04:00.000Z',
      }],
      attempts: [{
        id: 'attempt-1',
        runId: 'run-1',
        milestoneId: 'm1',
        sequence: 1,
        basedOnRunRevision: 2,
        basedOnGoalRevision: 2,
        basedOnUserIntentRevision: 0,
        status: 'waiting_task',
        verificationEvidence: [],
        startedAt: '2026-09-19T00:02:00.000Z',
        updatedAt: '2026-09-19T00:04:00.000Z',
      }],
      taskBindings: [{
        attemptId: 'attempt-1',
        provider: 'shell',
        taskId: 'shell-task-1',
        role: 'blocking_job',
        cancelWithGoal: true,
        boundAt: '2026-09-19T00:03:00.000Z',
      }],
      dispatchReceipts: [{
        id: 'receipt-1',
        runId: 'run-1',
        milestoneId: 'm1',
        attemptId: 'attempt-1',
        operationKey: 'build',
        state: 'confirmed',
        provider: 'shell',
        idempotencyKey: 'build-attempt-1',
        externalId: 'shell-task-1',
        createdAt: '2026-09-19T00:03:00.000Z',
        updatedAt: '2026-09-19T00:03:00.000Z',
      }],
    };
    const observed: AutomationRunSnapshot = {
      ...waiting,
      revision: 5,
      updatedAt: '2026-09-19T00:05:00.000Z',
      taskBindings: [{
        ...waiting.taskBindings[0]!,
        lastObservedAt: '2026-09-19T00:05:00.000Z',
        lastState: 'running',
      }],
    };
    const scheduledContinuations = {
      async claimScheduledContinuation(): Promise<unknown> {
        calls.push('claim');
        return ok({
          outcome: 'recurring_acquired' as const,
          continuation: { continuationId: 'continuation-1', goalId: 'goal-1', occurrence: 'interval' },
          goal: {
            goalId: 'goal-1',
            status: 'active' as const,
            revision: 2,
            userIntentRevision: 0,
          },
          leaseToken: 'lease-secret',
          leaseGeneration: 7,
          acquisition: 'orphan_recovered' as const,
          runKey: '2026-09-19T01',
          currentWakeMayReturn: true as const,
          nextRequiredAction: 'continue_work_with_existing_recurring_watchdog' as const,
        });
      },
    };
    const repository = {
      async getRunByGoalId(): Promise<AutomationRunSnapshot> {
        calls.push('load-run');
        return waiting;
      },
      async getRunById(): Promise<AutomationRunSnapshot> {
        calls.push('load-run-by-id');
        return waiting;
      },
      async commitTransition(): Promise<AutomationRunSnapshot> {
        calls.push('persist-observation');
        return observed;
      },
    };
    const services = {
      scheduledContinuations,
      automation: {
        repository,
        orchestrator: {},
        goalIntegration: {
          recoverCheckpointedVerification: vi.fn(),
          reconcileTerminalReadback: vi.fn(),
        },
      },
    } as unknown as McpApplicationServices;
    const childInvoker = {
      async invoke(name: string, input: unknown): Promise<McpToolResponse> {
        calls.push(`child:${name}`);
        expect(name).toBe('task_status');
        expect(input).toEqual({ workspaceId: 'workspace-1', taskId: 'shell-task-1' });
        return {
          content: [{ type: 'text' as const, text: '{"state":"running"}' }],
          structuredContent: { state: 'running' },
        };
      },
    };
    const claimTool = scheduledContinuationTools(context(services), { childInvoker })
      .find((tool) => tool.name === 'claim_scheduled_continuation');
    if (claimTool === undefined) throw new Error('claim tool missing');

    const result = await claimTool.execute(
      { continuationId: 'continuation-1', leaseSeconds: 600 },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        outcome: 'recurring_acquired',
        automationResume: {
          outcome: 'resumed',
          action: 'observe_task',
          recoveryAttempted: 'task_observation',
          run: { id: 'run-1', revision: 5, status: 'waiting_task' },
          task: { provider: 'shell', taskId: 'shell-task-1' },
        },
      },
    });
    expect(calls[0]).toBe('claim');
    expect(calls).toContain('child:task_status');
    expect(calls).not.toContain('child:shell');
  });

  it('keeps duplicate scheduled delivery a no-op for native automation', async () => {
    const getRunByGoalId = vi.fn(async () => ({
      id: 'run-1',
      goalId: 'goal-1',
      workspaceId: 'workspace-1',
      policyProfile: 'coding_guarded',
      revision: 1,
      status: 'running',
      basedOnGoalRevision: 2,
      basedOnUserIntentRevision: 0,
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:01:00.000Z',
      milestones: [],
      attempts: [],
      taskBindings: [],
      dispatchReceipts: [],
    } as AutomationRunSnapshot));
    const childInvoker = { invoke: vi.fn() };
    const services = {
      scheduledContinuations: {
        async claimScheduledContinuation(): Promise<unknown> {
          return ok({
            outcome: 'already_claimed' as const,
            continuation: { continuationId: 'continuation-1', goalId: 'goal-1' },
            goal: {
              goalId: 'goal-1',
              status: 'active' as const,
              revision: 2,
              userIntentRevision: 0,
            },
          });
        },
      },
      automation: {
        repository: { getRunByGoalId },
        orchestrator: {},
        goalIntegration: {
          recoverCheckpointedVerification: vi.fn(),
          reconcileTerminalReadback: vi.fn(),
        },
      },
    } as unknown as McpApplicationServices;
    const claimTool = scheduledContinuationTools(context(services), { childInvoker })
      .find((tool) => tool.name === 'claim_scheduled_continuation');
    if (claimTool === undefined) throw new Error('claim tool missing');

    const result = await claimTool.execute(
      { continuationId: 'continuation-1', leaseSeconds: 600 },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        outcome: 'already_claimed',
        automationResume: {
          outcome: 'scheduled_noop',
          action: 'scheduled_noop',
        },
      },
    });
    expect(getRunByGoalId).toHaveBeenCalledTimes(1);
    expect(childInvoker.invoke).not.toHaveBeenCalled();
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
