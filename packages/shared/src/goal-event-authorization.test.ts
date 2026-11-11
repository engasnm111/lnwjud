import { describe, expect, it } from 'vitest';
import { currentGoalEventAuthorization, withGoalEventAuthorization } from './goal-event-authorization.js';

describe('Goal event Host authorization context', () => {
  it('keeps concurrent checked invocation modes separate through asynchronous work', async () => {
    const observe = async (): Promise<string> => { await Promise.resolve(); return currentGoalEventAuthorization(); };
    expect(currentGoalEventAuthorization()).toBe('unknown');
    expect(await Promise.all([
      withGoalEventAuthorization({ mode: 'standard', applicationApproved: true }, observe),
      withGoalEventAuthorization({ mode: 'full_bypass', applicationApproved: true }, observe),
      withGoalEventAuthorization(undefined, observe),
      withGoalEventAuthorization({ mode: 'standard', applicationApproved: false }, observe),
    ])).toEqual(['standard', 'full_bypass', 'unknown', 'unknown']);
    expect(currentGoalEventAuthorization()).toBe('unknown');
  });
});
