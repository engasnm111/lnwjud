import { describe, expect, it, vi } from 'vitest';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { RuntimeGoalManagedTaskStateReader } from './goal-managed-task-state-reader.js';

describe('RuntimeGoalManagedTaskStateReader', () => {
  it('finds a running task across process, Codex, and durable shell providers using the goal workspace', async (): Promise<void> => {
    const process = { statusForGoalLiveness: vi.fn(async (): Promise<Result<unknown>> => err(appError('PROCESS_NOT_FOUND', 'missing'))) };
    const codex = { statusForGoalLiveness: vi.fn(async (): Promise<Result<unknown>> => ok({ state: 'running' })) };
    const shell = { statusForGoalLiveness: vi.fn(async (): Promise<Result<unknown>> => err(appError('PROCESS_NOT_FOUND', 'missing'))) };
    const reader = new RuntimeGoalManagedTaskStateReader({ process, codex, shell });

    await expect(reader.read('workspace-1', 'task-1')).resolves.toBe('running');
    expect(process.statusForGoalLiveness).toHaveBeenCalledWith('workspace-1', 'task-1');
    expect(codex.statusForGoalLiveness).toHaveBeenCalledWith('workspace-1', 'task-1');
    expect(shell.statusForGoalLiveness).toHaveBeenCalledWith('workspace-1', 'task-1');
  });

  it('returns terminal only when every other provider is authoritatively absent', async (): Promise<void> => {
    const reader = new RuntimeGoalManagedTaskStateReader({
      process: { statusForGoalLiveness: async (): Promise<Result<unknown>> => ok({ state: 'exited' }) },
      codex: { statusForGoalLiveness: async (): Promise<Result<unknown>> => err(appError('PROCESS_NOT_FOUND', 'missing')) },
      shell: { statusForGoalLiveness: async (): Promise<Result<unknown>> => err(appError('PROCESS_NOT_FOUND', 'missing')) },
    });
    await expect(reader.read('workspace-1', 'task-1')).resolves.toBe('terminal');
  });

  it('fails closed when a provider is unreachable or reports unverified termination', async (): Promise<void> => {
    const unreachable = new RuntimeGoalManagedTaskStateReader({
      process: { statusForGoalLiveness: async (): Promise<Result<unknown>> => ok({ state: 'exited' }) },
      codex: { statusForGoalLiveness: async (): Promise<Result<unknown>> => err(appError('INTERNAL_ERROR', 'unreachable', true)) },
      shell: { statusForGoalLiveness: async (): Promise<Result<unknown>> => err(appError('PROCESS_NOT_FOUND', 'missing')) },
    });
    await expect(unreachable.read('workspace-1', 'task-1')).resolves.toBe('unknown');

    const unverified = new RuntimeGoalManagedTaskStateReader({
      shell: { statusForGoalLiveness: async (): Promise<Result<unknown>> => ok({ state: 'termination_unverified' }) },
    });
    await expect(unverified.read('workspace-1', 'task-1')).resolves.toBe('unknown');
  });

  it('routes an explicit provider binding without probing unrelated registries', async (): Promise<void> => {
    const process = { statusForGoalLiveness: vi.fn(async (): Promise<Result<unknown>> => ok({ state: 'running' })) };
    const codex = { statusForGoalLiveness: vi.fn(async (): Promise<Result<unknown>> => ok({ state: 'running' })) };
    const shell = { statusForGoalLiveness: vi.fn(async (): Promise<Result<unknown>> => ok({ state: 'completed' })) };
    const reader = new RuntimeGoalManagedTaskStateReader({ process, codex, shell });

    await expect(reader.read('workspace-1', {
      taskId: 'same-id',
      provider: 'shell',
      role: 'supporting_service',
      cancelWithGoal: false,
    } as never)).resolves.toBe('terminal');
    expect(process.statusForGoalLiveness).not.toHaveBeenCalled();
    expect(codex.statusForGoalLiveness).not.toHaveBeenCalled();
    expect(shell.statusForGoalLiveness).toHaveBeenCalledWith('workspace-1', 'same-id');
  });
});
