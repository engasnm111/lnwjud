import { describe, expect, it, vi } from 'vitest';
import { ok, type AutomationRunSnapshot } from '@lnwjud/domain';
import { permissionProfiles } from '@lnwjud/permissions';
import { inspectMutationOperation } from './mutation-policy.js';
import { ToolRegistry, type McpApplicationServices } from './tool-registry.js';

const actor = { clientId: 'automation-test', clientName: 'automation-test', sessionId: 'session-1' };

const AUTOMATION_TOOLS = [
  'automation_create',
  'automation_status',
  'automation_events',
  'automation_run',
  'automation_observe',
  'automation_recover',
  'automation_verify',
  'automation_finalize',
  'automation_pause',
  'automation_resume',
] as const;

function dispatchingSnapshot(): AutomationRunSnapshot {
  return {
    id: 'run-1',
    goalId: 'goal-1',
    workspaceId: 'workspace-1',
    policyProfile: 'coding_guarded',
    revision: 3,
    status: 'running',
    basedOnGoalRevision: 5,
    basedOnUserIntentRevision: 0,
    currentMilestoneId: 'm1',
    currentAttemptId: 'attempt-1',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:03:00.000Z',
    milestones: [{
      id: 'm1',
      runId: 'run-1',
      ordinal: 0,
      title: 'Build',
      dependsOn: [],
      executionIntent: 'Build the project.',
      verificationRequirements: [],
      retryPolicy: { classification: 'workspace_mutation', maxAttempts: 1 },
      status: 'running',
      currentAttemptId: 'attempt-1',
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:03:00.000Z',
    }],
    attempts: [{
      id: 'attempt-1',
      runId: 'run-1',
      milestoneId: 'm1',
      sequence: 1,
      basedOnRunRevision: 2,
      basedOnGoalRevision: 5,
      basedOnUserIntentRevision: 0,
      status: 'dispatching',
      verificationEvidence: [],
      startedAt: '2026-09-19T00:03:00.000Z',
      updatedAt: '2026-09-19T00:03:00.000Z',
    }],
    taskBindings: [],
    dispatchReceipts: [],
  };
}

describe('native automation MCP surface', () => {
  it('advertises the native automation tools as first-class ToolRegistry tools', () => {
    const registry = new ToolRegistry({} as McpApplicationServices, actor);
    const names = new Set(registry.listAll().map((tool) => tool.name));
    for (const name of AUTOMATION_TOOLS) expect(names.has(name)).toBe(true);
  });

  it('classifies wrapper mutations without treating the runtime wrapper as an opaque side effect', () => {
    expect(inspectMutationOperation('automation_create', {}, 'EXECUTE').kind).toBe('bounded_write');
    expect(inspectMutationOperation('automation_run', {}, 'EXECUTE').kind).toBe('execute');
    expect(inspectMutationOperation('automation_observe', {}, 'EXECUTE').kind).toBe('execute');
    expect(inspectMutationOperation('automation_recover', {}, 'EXECUTE').kind).toBe('execute');
    expect(inspectMutationOperation('automation_verify', {}, 'EXECUTE').kind).toBe('bounded_write');
    expect(inspectMutationOperation('automation_finalize', {}, 'EXECUTE').kind).toBe('bounded_write');
    expect(inspectMutationOperation('automation_pause', {}, 'EXECUTE').kind).toBe('bounded_write');
    expect(inspectMutationOperation('automation_resume', {}, 'EXECUTE').kind).toBe('bounded_write');
  });

  it('routes allowed shell execution back through ToolRegistry before binding the durable task handle', async (): Promise<void> => {
    const initial = dispatchingSnapshot();
    const reserved = {
      ...initial,
      revision: 4,
      updatedAt: '2026-09-19T00:04:00.000Z',
      dispatchReceipts: [{
        id: 'receipt-1',
        runId: 'run-1',
        milestoneId: 'm1',
        attemptId: 'attempt-1',
        operationKey: 'build',
        state: 'reserved' as const,
        provider: 'shell' as const,
        idempotencyKey: 'build-attempt-1',
        createdAt: '2026-09-19T00:04:00.000Z',
        updatedAt: '2026-09-19T00:04:00.000Z',
      }],
    };
    const confirmed = {
      ...reserved,
      revision: 5,
      status: 'waiting_task' as const,
      updatedAt: '2026-09-19T00:05:00.000Z',
      milestones: reserved.milestones.map((milestone) => ({
        ...milestone,
        status: 'waiting_task' as const,
      })),
      attempts: reserved.attempts.map((attempt) => ({
        ...attempt,
        status: 'waiting_task' as const,
      })),
      taskBindings: [{
        attemptId: 'attempt-1',
        provider: 'shell' as const,
        taskId: 'shell-task-1',
        role: 'blocking_job' as const,
        cancelWithGoal: true,
        boundAt: '2026-09-19T00:05:00.000Z',
      }],
      dispatchReceipts: [{
        ...reserved.dispatchReceipts[0]!,
        state: 'confirmed' as const,
        externalId: 'shell-task-1',
        updatedAt: '2026-09-19T00:05:00.000Z',
      }],
    };
    const checkpointed = {
      ...confirmed,
      revision: 6,
      basedOnGoalRevision: 6,
      updatedAt: '2026-09-19T00:06:00.000Z',
    };
    const goal = {
      goalId: 'goal-1',
      workspaceId: 'workspace-1',
      status: 'active',
      revision: 6,
      userIntentRevision: 0,
    };
    const get = vi.fn().mockResolvedValue(initial);
    const commitTransition = vi.fn()
      .mockResolvedValueOnce(reserved)
      .mockResolvedValueOnce(confirmed);
    const checkpointTaskBound = vi.fn().mockResolvedValue({ run: checkpointed, goal });
    const execute = vi.fn().mockImplementation(async () => (
      ok({ task_id: 'shell-task-1', state: 'running' })
    ));
    const services = {
      automation: {
        repository: {
          getRunById: vi.fn().mockResolvedValue(initial),
          commitTransition,
          listEvents: vi.fn().mockResolvedValue([]),
        },
        orchestrator: { get },
        goalIntegration: { checkpointTaskBound },
      },
      capabilities: { execute },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor, {
      profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
    }).invoke('automation_run', {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      expectedRevision: 3,
      goalRevision: 5,
      userIntentRevision: 0,
      goalLease: {
        goalId: 'goal-1',
        leaseToken: 'lease-token',
        leaseGeneration: 1,
      },
      operationKey: 'build',
      idempotencyKey: 'build-attempt-1',
      execution: {
        provider: 'shell',
        executable: 'pnpm.cmd',
        arguments: ['build'],
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      run: {
        revision: 6,
        status: 'waiting_task',
        taskBindings: [expect.objectContaining({ taskId: 'shell-task-1' })],
      },
      nextAction: 'observe_task',
      policyDecision: { allowed: true },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      'shell',
      expect.objectContaining({
        operation: 'run',
        executable: 'pnpm.cmd',
        arguments: ['build'],
        execution: 'background',
      }),
      expect.anything(),
      expect.objectContaining({ mode: 'full_bypass' }),
    );
    expect(commitTransition).toHaveBeenCalledTimes(2);
    expect(checkpointTaskBound).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        runId: 'run-1',
        expectedRevision: 5,
        lease: expect.objectContaining({ goalId: 'goal-1', leaseGeneration: 1 }),
      }),
    );
  });

  it('refuses real automation execution before child dispatch when no durable goal lease is supplied', async (): Promise<void> => {
    const initial = dispatchingSnapshot();
    const execute = vi.fn().mockResolvedValue(ok({ task_id: 'must-not-run' }));
    const checkpointTaskBound = vi.fn();
    const services = {
      automation: {
        repository: {
          getRunById: vi.fn().mockResolvedValue(initial),
          commitTransition: vi.fn(),
          listEvents: vi.fn().mockResolvedValue([]),
        },
        orchestrator: { get: vi.fn().mockResolvedValue(initial) },
        goalIntegration: { checkpointTaskBound },
      },
      capabilities: { execute },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor, {
      profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
    }).invoke('automation_run', {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      expectedRevision: 3,
      goalRevision: 5,
      userIntentRevision: 0,
      operationKey: 'build',
      idempotencyKey: 'build-attempt-1',
      execution: {
        provider: 'shell',
        executable: 'pnpm.cmd',
        arguments: ['build'],
      },
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      error: {
        code: 'CONFLICT',
        message: expect.stringContaining('goalLease proof is required'),
      },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(checkpointTaskBound).not.toHaveBeenCalled();
  });

  it('finalizes through durable-goal integration and returns only terminal readback state', async (): Promise<void> => {
    const completing = {
      ...dispatchingSnapshot(),
      revision: 8,
      status: 'completing' as const,
      basedOnGoalRevision: 12,
      currentMilestoneId: undefined,
      currentAttemptId: undefined,
      milestones: [{
        ...dispatchingSnapshot().milestones[0]!,
        status: 'completed' as const,
        currentAttemptId: undefined,
      }],
      attempts: [{
        ...dispatchingSnapshot().attempts[0]!,
        status: 'completed' as const,
        verificationEvidence: [{ kind: 'note' as const, value: 'verified' }],
        finishedAt: '2026-09-19T00:08:00.000Z',
      }],
    };
    const completed = {
      ...completing,
      revision: 9,
      status: 'completed' as const,
      basedOnGoalRevision: 15,
      terminalAt: '2026-09-19T00:09:00.000Z',
    };
    const goal = {
      goalId: 'goal-1',
      workspaceId: 'workspace-1',
      status: 'completed',
      revision: 15,
      userIntentRevision: 0,
    };
    const finalize = vi.fn().mockResolvedValue({
      run: completed,
      goal,
      completionState: 'completed',
    });
    const services = {
      automation: {
        repository: { listEvents: vi.fn().mockResolvedValue([]) },
        orchestrator: { get: vi.fn().mockResolvedValue(completing) },
        goalIntegration: { finalize },
      },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor, {
      profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
    }).invoke('automation_finalize', {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      expectedRevision: 8,
      goalRevision: 12,
      userIntentRevision: 0,
      goalLease: {
        goalId: 'goal-1',
        leaseToken: 'lease-token',
        leaseGeneration: 1,
      },
      summary: 'Final acceptance passed',
      finalReviewEvidence: [{ kind: 'note', value: 'final review passed' }],
      acceptance: [],
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      run: { status: 'completed', revision: 9 },
      goal: { status: 'completed', revision: 15 },
      completionState: 'completed',
      nextAction: 'terminal',
    });
    expect(finalize).toHaveBeenCalledWith(actor, expect.objectContaining({
      runId: 'run-1',
      expectedRevision: 8,
      lease: expect.objectContaining({ goalId: 'goal-1' }),
    }));
  });

  it('hard-denies desktop/browser execution even when ToolRegistry Full Bypass is active', async (): Promise<void> => {
    const snapshot = dispatchingSnapshot();
    const get = vi.fn().mockResolvedValue(snapshot);
    const commitTransition = vi.fn().mockImplementation(async (request: {
      readonly expectedRevision: number;
      readonly runPatch?: { readonly lastRecoveryDecision?: string | null };
    }) => ({
      ...snapshot,
      revision: request.expectedRevision + 1,
      lastRecoveryDecision: request.runPatch?.lastRecoveryDecision ?? snapshot.lastRecoveryDecision,
    }));
    const shellExecute = vi.fn().mockResolvedValue(ok({ task_id: 'should-not-run' }));
    const services = {
      automation: {
        repository: {
          commitTransition,
          listEvents: vi.fn().mockResolvedValue([]),
        },
        orchestrator: {
          get,
        },
      },
      capabilities: { execute: shellExecute },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor, {
      profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
    }).invoke('automation_run', {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      expectedRevision: 3,
      goalRevision: 5,
      userIntentRevision: 0,
      operationKey: 'browser-test',
      idempotencyKey: 'browser-test-attempt-1',
      execution: {
        provider: 'shell',
        executable: 'chrome.exe',
        arguments: ['https://example.com'],
      },
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      error: {
        code: 'PERMISSION_DENIED',
        message: expect.stringContaining('forbids browser'),
      },
    });
    expect(commitTransition).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({
        type: 'policy_denied',
        reason: 'browser_or_desktop_control_denied',
      }),
    }));
    expect(shellExecute).not.toHaveBeenCalled();
  });

  it('hard-denies destructive Git cleanup even with userConfirmed and Full Bypass', async (): Promise<void> => {
    const snapshot = dispatchingSnapshot();
    const get = vi.fn().mockResolvedValue(snapshot);
    const commitTransition = vi.fn().mockImplementation(async (request: {
      readonly expectedRevision: number;
      readonly runPatch?: { readonly lastRecoveryDecision?: string | null };
    }) => ({
      ...snapshot,
      revision: request.expectedRevision + 1,
      lastRecoveryDecision: request.runPatch?.lastRecoveryDecision ?? snapshot.lastRecoveryDecision,
    }));
    const services = {
      automation: {
        repository: { commitTransition, listEvents: vi.fn().mockResolvedValue([]) },
        orchestrator: { get },
      },
    } as unknown as McpApplicationServices;

    const response = await new ToolRegistry(services, actor, {
      profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
      authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
    }).invoke('automation_run', {
      workspaceId: 'workspace-1',
      runId: 'run-1',
      expectedRevision: 3,
      goalRevision: 5,
      userIntentRevision: 0,
      operationKey: 'destructive-test',
      idempotencyKey: 'destructive-test-attempt-1',
      userConfirmed: true,
      execution: {
        provider: 'shell',
        executable: 'git.exe',
        arguments: ['reset', '--hard'],
      },
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      error: { code: 'PERMISSION_DENIED' },
    });
    expect(commitTransition).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({
        reason: 'destructive_workspace_operation_denied',
      }),
    }));
  });
});
