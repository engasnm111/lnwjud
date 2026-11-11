import type { GoalStatus } from './goal-continuation.js';

export const GOAL_EVENT_CONTRACT = 'lnwjud.goal-event.v1';

export interface GoalCommitEvent {
  readonly contract: typeof GOAL_EVENT_CONTRACT;
  readonly eventId: string;
  readonly workspaceId: string;
  readonly goalId: string;
  readonly revision: number;
  readonly fromStatus: GoalStatus | null;
  readonly toStatus: GoalStatus;
  readonly committedAt: string;
  readonly origin: 'host-goal-repository';
  readonly authorizationMode: 'standard';
}

export function canonicalGoalEvent(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('GOAL_EVENT_INVALID');
  const value = input as Record<string, unknown>;
  const keys = ['contract', 'eventId', 'workspaceId', 'goalId', 'revision', 'fromStatus', 'toStatus', 'committedAt', 'origin', 'authorizationMode'];
  const statuses: readonly unknown[] = ['active', 'completed', 'failed', 'blocked', 'cancelled'];
  const identifier = (field: string): boolean => typeof value[field] === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value[field]);
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))
    || value.contract !== GOAL_EVENT_CONTRACT || !identifier('eventId') || !identifier('workspaceId') || !identifier('goalId')
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !statuses.includes(value.toStatus) || value.fromStatus !== null && !statuses.includes(value.fromStatus)
    || value.fromStatus !== null && value.fromStatus !== 'active' && !(value.fromStatus === 'blocked' && value.toStatus === 'active')
    || value.fromStatus === value.toStatus || value.fromStatus === null && (value.toStatus !== 'active' || value.revision !== 0)
    || typeof value.committedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.committedAt)
    || !Number.isFinite(Date.parse(value.committedAt)) || new Date(value.committedAt).toISOString() !== value.committedAt
    || value.origin !== 'host-goal-repository' || value.authorizationMode !== 'standard') throw new Error('GOAL_EVENT_INVALID');
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, value[key]])));
}
