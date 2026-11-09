import { describe, expect, it } from 'vitest';
import {
  classifyGoalEvent,
  ProductionGoalMemoryBoundary,
  type GoalCheckpointEvent,
} from '../src/main/production-goal-memory-core.js';

const goalId = 'b442ddcd-6d6b-4a71-bb1c-846e66379a60';
const event: GoalCheckpointEvent = {
  phase: 'completed',
  resultCode: 'SUCCESS',
  eventId: 'abc8f370-3050-4da9-ac64-038e2d5602e1',
  workspaceId: 'project-1',
  goalId,
  goalStatus: 'active',
  goalRevision: 3,
  toolName: 'checkpoint_goal',
  decisionRecorded: true,
};

describe('Host-verified significant decision milestone', () => {
  it('does not classify an unproven decision as a decision', () => {
    expect(classifyGoalEvent('checkpoint_goal', 'active')).toBeNull();
    expect(classifyGoalEvent('checkpoint_goal', 'active', true)).toBe('decision');
    expect(classifyGoalEvent('run_goal', 'active', true)).toBeNull();
    expect(classifyGoalEvent('checkpoint_goal', 'active', false, true)).toBe('next_step');
  });

  it('rejects decision event when persisted Host checkpoint does not attest it', async () => {
    let approvals = 0;
    let dispatches = 0;
    const boundary = new ProductionGoalMemoryBoundary({
      getSelectedScope: async () => ({ workspaceId: 'project-1', realRootPath: 'D:\\project-1' }),
      getPersistedGoal: async () => ({
        id: goalId,
        workspaceId: 'project-1',
        status: 'active',
        revision: 3,
      }),
      getAuthorizedBank: () => 'bank-1',
      requestApproval: () => { approvals++; return true; },
      journal: {
        begin: () => { dispatches++; return true; },
        markDispatched: () => { dispatches++; },
        settle: () => { dispatches++; },
      },
      fetchImpl: async () => { throw new Error('No network calls allowed for forged milestone'); },
    });
    expect(await boundary.recordGoalEvent(event)).toEqual({
      status: 'skipped',
      reason: 'committed_decision_not_verified',
    });
    expect(approvals).toBe(0);
    expect(dispatches).toBe(0);
  });

  it('rejects an unverified next-step flag without Native Approval or journal dispatch', async () => {
    let approvals = 0;
    const boundary = new ProductionGoalMemoryBoundary({
      getSelectedScope: async () => ({ workspaceId: 'project-1', realRootPath: 'D:\\project-1' }),
      getPersistedGoal: async () => ({ id: goalId, workspaceId: 'project-1', status: 'active', revision: 3 }),
      getAuthorizedBank: () => 'bank-1',
      requestApproval: () => { approvals++; return true; },
      journal: { begin: () => { throw new Error('not reached'); }, markDispatched: () => {}, settle: () => {} },
      fetchImpl: async () => { throw new Error('not reached'); },
    });
    expect(await boundary.recordGoalEvent({ ...event, decisionRecorded: false, nextStepRecorded: true }))
      .toEqual({ status: 'skipped', reason: 'committed_next_step_not_verified' });
    expect(approvals).toBe(0);
  });

  it('rejects a changed persisted revision before approving a decision', async () => {
    let approvals = 0;
    const boundary = new ProductionGoalMemoryBoundary({
      getSelectedScope: async () => ({ workspaceId: 'project-1', realRootPath: 'D:\\project-1' }),
      getPersistedGoal: async () => ({
        id: goalId,
        workspaceId: 'project-1',
        status: 'active',
        revision: 4,
        decisionRecorded: true,
      }),
      getAuthorizedBank: () => 'bank-1',
      requestApproval: () => { approvals++; return true; },
      journal: {
        begin: () => true,
        markDispatched: () => {},
        settle: () => {},
      },
      fetchImpl: async () => { throw new Error('No network calls allowed for stale milestone'); },
    });
    expect(await boundary.recordGoalEvent(event)).toEqual({
      status: 'skipped',
      reason: 'committed_goal_not_verified',
    });
    expect(approvals).toBe(0);
  });
});
