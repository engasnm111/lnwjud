import { describe, expect, it } from 'vitest';
import { GoalRequestCancellationService } from './goal-request-cancellation-service.js';

describe('GoalRequestCancellationService', () => {
  it('aborts and waits for every in-flight request owned by a goal', async () => {
    const service = new GoalRequestCancellationService({ waitMs: 100 });
    const controller = new AbortController();
    let aborted = false;
    const registration = service.register('goal-1', 'call-1', controller);
    controller.signal.addEventListener('abort', () => { aborted = true; registration.release(); }, { once: true });

    const result = await service.cancelForGoal('goal-1');

    expect(aborted).toBe(true);
    expect(result).toMatchObject({ goalId: 'goal-1', requested: 1, stopped: 1, remaining: 0, timedOut: false });
    expect(result.requestIds).toEqual(['call-1']);
  });

  it('fails closed and rejects a new request after the goal has been cancelled', async () => {
    const service = new GoalRequestCancellationService({ waitMs: 10 });
    await expect(service.cancelForGoal('goal-2')).resolves.toMatchObject({ requested: 0, stopped: 0, remaining: 0 });

    const registration = service.register('goal-2', 'late-call', new AbortController());

    expect(registration.accepted).toBe(false);
    registration.release();
  });

  it('reports an unresolved request when its operation ignores abort', async () => {
    const service = new GoalRequestCancellationService({ waitMs: 1 });
    const registration = service.register('goal-3', 'call-3', new AbortController());

    const result = await service.cancelForGoal('goal-3');

    expect(result).toMatchObject({ goalId: 'goal-3', requested: 1, stopped: 0, remaining: 1, timedOut: true });
    registration.release();
  });

  it('rejects duplicate in-flight request IDs without losing the original cancellation owner', async () => {
    const service = new GoalRequestCancellationService({ waitMs: 100 });
    const originalController = new AbortController();
    const duplicateController = new AbortController();
    const original = service.register('goal-duplicate', 'same-call', originalController, 5);
    const duplicate = service.register('goal-duplicate', 'same-call', duplicateController, 5);
    expect(original.accepted).toBe(true);
    expect(duplicate.accepted).toBe(false);
    duplicate.release();
    originalController.signal.addEventListener('abort', () => original.release(), { once: true });

    const result = await service.cancelForGoal('goal-duplicate', 5);
    expect(result).toMatchObject({ requested: 1, stopped: 1, remaining: 0, timedOut: false, requestIds: ['same-call'] });
    expect(originalController.signal.aborted).toBe(true);
    expect(duplicateController.signal.aborted).toBe(false);
  });

  it('admits only a verified newer generation and keeps old requests fenced', async () => {
    const service = new GoalRequestCancellationService({ waitMs: 1 });
    const old = new AbortController();
    const pending = service.register('goal-4', 'old', old, 7);
    await service.cancelForGoal('goal-4', 7);
    expect(old.signal.aborted).toBe(true);
    expect(service.admitRecoveredGeneration('goal-4', 7)).toBe(false);
    expect(service.admitRecoveredGeneration('goal-4', 8)).toBe(true);
    expect(service.register('goal-4', 'stale', new AbortController(), 7).accepted).toBe(false);
    expect(service.register('goal-4', 'unbound', new AbortController()).accepted).toBe(false);
    const fresh = service.register('goal-4', 'new', new AbortController(), 8);
    expect(fresh.accepted).toBe(true);
    await service.cancelForGoal('goal-4', 7); // late old-generation cancellation cannot kill new work
    expect(fresh.accepted).toBe(true);
    expect(service.admitRecoveredGeneration('goal-4', 8)).toBe(false);
    await service.cancelForGoal('goal-4', 8);
    expect(service.register('goal-4', 'after-terminal', new AbortController(), 8).accepted).toBe(false);
    pending.release();
    fresh.release();
  });
});
