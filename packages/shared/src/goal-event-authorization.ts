import { AsyncLocalStorage } from 'node:async_hooks';

export type GoalEventAuthorizationMode = 'standard' | 'full_bypass' | 'unknown';
const authorization = new AsyncLocalStorage<GoalEventAuthorizationMode>();

export function currentGoalEventAuthorization(): GoalEventAuthorizationMode { return authorization.getStore() ?? 'unknown'; }

export function withGoalEventAuthorization<T>(
  invocation: { readonly mode: 'standard' | 'full_bypass'; readonly applicationApproved: boolean } | undefined,
  operation: () => T,
): T {
  return authorization.run(invocation?.applicationApproved === true ? invocation.mode : 'unknown', operation);
}
