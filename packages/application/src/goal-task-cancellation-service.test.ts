import { describe, expect, it } from 'vitest';
import { appError, err, ok, type GoalTaskCancellationObservation, type Result } from '@lnwjud/domain';
import { GoalTaskCancellationService, type GoalTaskCancellationProvider } from './goal-task-cancellation-service.js';

function provider(
  name: GoalTaskCancellationProvider['provider'],
  handler: (taskId: string) => Promise<Result<GoalTaskCancellationObservation>>,
): GoalTaskCancellationProvider {
  return { provider: name, cancelForGoal: async (_ownerClientId, _workspaceId, taskId) => handler(taskId) };
}

describe('GoalTaskCancellationService', () => {
  it('fans every tracked task out to every managed provider and aggregates matched outcomes', async () => {
    const calls: string[] = [];
    const service = new GoalTaskCancellationService([
      provider('process', async (taskId) => {
        calls.push(`process:${taskId}`);
        return ok(taskId === 'process-task' ? { matched: true, state: 'cancelled' } : { matched: false, state: 'not_found' });
      }),
      provider('codex', async (taskId) => {
        calls.push(`codex:${taskId}`);
        return ok(taskId === 'codex-task' ? { matched: true, state: 'already_terminal' } : { matched: false, state: 'not_found' });
      }),
      provider('shell', async (taskId) => {
        calls.push(`shell:${taskId}`);
        return ok(taskId === 'shell-task' ? { matched: true, state: 'cancelled' } : { matched: false, state: 'not_found' });
      }),
    ]);

    const result = await service.cancelForGoal('client-1', 'workspace-1', ['process-task', 'codex-task', 'shell-task']);

    expect(calls).toHaveLength(9);
    expect(result).toEqual([
      expect.objectContaining({ taskId: 'process-task', status: 'cancelled' }),
      expect.objectContaining({ taskId: 'codex-task', status: 'already_terminal' }),
      expect.objectContaining({ taskId: 'shell-task', status: 'cancelled' }),
    ]);
  });

  it('fails closed when a provider reports a permission or termination-verification failure', async () => {
    const service = new GoalTaskCancellationService([
      provider('process', async () => err(appError('PERMISSION_DENIED', 'task owner mismatch'))),
      provider('codex', async () => ok({ matched: false, state: 'not_found' })),
      provider('shell', async () => ok({ matched: true, state: 'termination_unverified', detail: 'child may still be alive' })),
    ]);

    const result = await service.cancelForGoal('client-1', 'workspace-1', ['task-1']);

    expect(result).toMatchObject([{
      taskId: 'task-1',
      status: 'failed',
      providers: [
        { provider: 'process', state: 'termination_unverified', matched: false, error: 'PERMISSION_DENIED: task owner mismatch' },
        { provider: 'codex', state: 'not_found', matched: false },
        { provider: 'shell', state: 'termination_unverified', matched: true, detail: 'child may still be alive' },
      ],
    }]);
  });

  it('reports a shared supporting service as deliberately skipped when the goal does not own its lifecycle', async () => {
    const shell = provider('shell', async () => ok({ matched: true, state: 'cancelled' }));
    const process = provider('process', async () => ok({ matched: false, state: 'not_found' }));
    const codex = provider('codex', async () => ok({ matched: false, state: 'not_found' }));
    const service = new GoalTaskCancellationService([process, codex, shell]);

    const result = await service.cancelForGoal('client-1', 'workspace-1', [{
      taskId: 'shared-db',
      provider: 'shell',
      role: 'supporting_service',
      cancelWithGoal: false,
    }] as never);

    expect(result).toEqual([{
      taskId: 'shared-db',
      provider: 'shell',
      status: 'skipped',
      providers: [],
      error: 'Task remains running because cancelWithGoal=false',
    }]);
  });

  it('fails closed when an explicitly bound cancellation provider is unavailable', async () => {
    const service = new GoalTaskCancellationService([
      provider('process', async () => ok({ matched: false, state: 'not_found' })),
    ]);

    const result = await service.cancelForGoal('client-1', 'workspace-1', [{
      taskId: 'shell-task',
      provider: 'shell',
      role: 'blocking_job',
      cancelWithGoal: true,
    }]);

    expect(result).toEqual([{
      taskId: 'shell-task',
      provider: 'shell',
      status: 'failed',
      providers: [],
      error: 'Task cancellation provider is unavailable: shell',
    }]);
  });

  it('routes an explicit provider binding to only that cancellation backend', async () => {
    const calls: string[] = [];
    const service = new GoalTaskCancellationService([
      provider('process', async (taskId) => { calls.push(`process:${taskId}`); return ok({ matched: false, state: 'not_found' }); }),
      provider('codex', async (taskId) => { calls.push(`codex:${taskId}`); return ok({ matched: false, state: 'not_found' }); }),
      provider('shell', async (taskId) => { calls.push(`shell:${taskId}`); return ok({ matched: true, state: 'cancelled' }); }),
    ]);

    const result = await service.cancelForGoal('client-1', 'workspace-1', [{
      taskId: 'same-id',
      provider: 'shell',
      role: 'supporting_service',
      cancelWithGoal: true,
    }] as never);

    expect(calls).toEqual(['shell:same-id']);
    expect(result).toMatchObject([{ taskId: 'same-id', provider: 'shell', status: 'cancelled' }]);
  });
});
