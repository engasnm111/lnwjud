import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GoalStateError, type ScheduledContinuationRepository } from '@lnwjud/domain';
import { GoalMutationFenceService } from './goal-mutation-fence-service.js';

const actor = { clientId: 'client-a', clientName: 'Client A', sessionId: 'shared-session' };

function repository(overrides: Partial<ScheduledContinuationRepository> = {}): ScheduledContinuationRepository {
  return {
    getWorkspaceMutationFence: vi.fn(async () => null),
    beginGoalFencedMutation: vi.fn(async (request) => ({ goalId: request.goalId, leaseGeneration: request.leaseGeneration })),
    heartbeatGoalFencedMutation: vi.fn(async () => undefined),
    endGoalFencedMutation: vi.fn(async () => undefined),
    observeGoalFencedMutations: vi.fn(async () => ({ workspaceId: 'workspace-1', leaseGeneration: 3, leaseActivitySeq: 4, liveFencedCallCount: 0 })),
    prepareScheduledContinuation: vi.fn() as never,
    recordScheduledContinuationReceipt: vi.fn() as never,
    claimScheduledContinuation: vi.fn() as never,
    expediteScheduledContinuation: vi.fn() as never,
    getScheduledContinuation: vi.fn() as never,
    getLiveScheduledContinuation: vi.fn() as never,
    markGoalFinishedForScheduledContinuation: vi.fn() as never,
    ...overrides,
  };
}

describe('GoalMutationFenceService', () => {
  it('hashes the private token, preserves lease generation, and never forwards the raw token to storage', async (): Promise<void> => {
    const beginGoalFencedMutation = vi.fn(async (request): Promise<{ goalId: string; leaseGeneration: number }> => ({ goalId: request.goalId, leaseGeneration: request.leaseGeneration }));
    const repo = repository({ beginGoalFencedMutation });
    const service = new GoalMutationFenceService(repo, { now: (): Date => new Date('2026-08-27T10:00:00.000Z') });
    const result = await service.begin(actor, 'workspace-1', 'call-1', {
      goalId: 'goal-1', leaseToken: 'private-token', leaseGeneration: 7,
    });
    expect(result).toMatchObject({ ok: true, value: { goalId: 'goal-1', leaseGeneration: 7 } });
    expect(beginGoalFencedMutation).toHaveBeenCalledWith(expect.objectContaining({
      goalId: 'goal-1', workspaceId: 'workspace-1', leaseGeneration: 7,
      leaseTokenHash: createHash('sha256').update('private-token').digest('hex'),
    }));
    expect(JSON.stringify(beginGoalFencedMutation.mock.calls)).not.toContain('private-token');
  });

  it('fails closed when a stale token/generation is rejected by the CAS repository', async (): Promise<void> => {
    const repo = repository({
      beginGoalFencedMutation: vi.fn(async (): Promise<never> => { throw new GoalStateError('lease_invalid', 'stale generation'); }),
    });
    const service = new GoalMutationFenceService(repo);
    await expect(service.begin(actor, 'workspace-1', 'call-old', {
      goalId: 'goal-1', leaseToken: 'old-token', leaseGeneration: 1,
    })).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT', recoverable: true } });
  });

  it('marks liveness untrustworthy when any managed task state is unknown', async (): Promise<void> => {
    const read = vi.fn(async (_workspaceId: string, taskId: string): Promise<'running' | 'unknown'> => (
      taskId === 'running' ? 'running' : 'unknown'
    ));
    const service = new GoalMutationFenceService(repository(), {
      now: (): Date => new Date('2026-08-27T10:00:00.000Z'),
      taskStateReader: { read },
    });
    await expect(service.observe('goal-1', ['running', 'unknown'])).resolves.toMatchObject({
      trustworthy: false,
      leaseGeneration: 3,
      leaseActivitySeq: 4,
      activeTaskStates: [
        { taskId: 'running', state: 'running' },
        { taskId: 'unknown', state: 'unknown' },
      ],
    });
    expect(read).toHaveBeenNthCalledWith(1, 'workspace-1', 'running');
    expect(read).toHaveBeenNthCalledWith(2, 'workspace-1', 'unknown');
  });

  it('observes only blocking goal tasks for worker liveness', async (): Promise<void> => {
    const read = vi.fn(async (_workspaceId: string, task: { taskId: string }): Promise<'running' | 'terminal'> => (
      task.taskId === 'job-1' ? 'running' : 'terminal'
    ));
    const service = new GoalMutationFenceService(repository(), {
      taskStateReader: { read: read as never },
    });

    await expect(service.observe('goal-1', [
      { taskId: 'job-1', provider: 'shell', role: 'blocking_job', cancelWithGoal: true },
      { taskId: 'db-1', provider: 'shell', role: 'supporting_service', cancelWithGoal: false },
    ] as never)).resolves.toMatchObject({
      trustworthy: true,
      blockingTaskStates: [{ taskId: 'job-1', provider: 'shell', state: 'running' }],
    });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
