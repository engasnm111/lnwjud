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
});
