import { describe, expect, it } from 'vitest';
import type { GoalRecord } from '@lnwjud/domain';
import { hasInspectableGoalResults } from '../src/main/doctor-goal-evidence.js';

describe('Doctor Goal results selection', () => {
  function goal(input: {
    terminalSummary?: string;
    checkpointSummary?: string;
    stepStatus?: string;
    gateStatus?: string;
  } = {}): Pick<GoalRecord,'terminalSummary'|'checkpoints'|'plan'|'engineering'> {
    return {
      terminalSummary: input.terminalSummary,
      checkpoints: input.checkpointSummary === undefined ? [] : [{ summary:input.checkpointSummary }] as GoalRecord['checkpoints'],
      plan: { steps: input.stepStatus === undefined ? [] : [{ status: input.stepStatus }] } as GoalRecord['plan'],
      engineering: input.gateStatus === undefined ? undefined :
        { gates: [{ status: input.gateStatus }] } as unknown as GoalRecord['engineering'],
    };
  }

  it('hides an empty Goal even if it was labelled completed', () => {
    expect(hasInspectableGoalResults(goal())).toBe(false);
    expect(hasInspectableGoalResults(goal({terminalSummary:'   '}))).toBe(false);
    expect(hasInspectableGoalResults(goal({stepStatus:'pending',gateStatus:'pending'}))).toBe(false);
  });

  it('includes an actual checkpoint, completed step, terminal summary or observed gate', () => {
    for(const result of [
      goal({terminalSummary:'Done with evidence'}),
      goal({checkpointSummary:'Verified files'}),
      goal({stepStatus:'completed'}),
      goal({stepStatus:'blocked'}),
      goal({gateStatus:'passed'}),
      goal({gateStatus:'failed'}),
    ]) expect(hasInspectableGoalResults(result)).toBe(true);
  });
});
