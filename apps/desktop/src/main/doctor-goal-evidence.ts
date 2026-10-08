import type { GoalRecord } from '@lnwjud/domain';

/** A Goal's status, objective and freshly created empty plan are not result data. */
export function hasInspectableGoalResults(goal: Pick<GoalRecord,
  'terminalSummary' | 'checkpoints' | 'plan' | 'engineering'>): boolean {
  return Boolean(goal.terminalSummary?.trim())
    || Boolean(goal.checkpoints.at(-1)?.summary?.trim())
    || goal.plan.steps.some((step) => step.status === 'completed' || step.status === 'blocked')
    || Boolean(goal.engineering?.gates.some((gate) =>
      gate.status === 'passed' || gate.status === 'failed' || gate.status === 'blocked'));
}
