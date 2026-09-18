import { describe, expect, it } from 'vitest';
import {
  AutomationStateError,
  validateAutomationMilestoneGraph,
  type AutomationMilestoneSpec,
} from './automation.js';

function milestone(
  id: string,
  dependsOn: readonly string[] = [],
): AutomationMilestoneSpec {
  return {
    id,
    title: id,
    dependsOn,
    executionIntent: `Execute ${id}`,
    verificationRequirements: [],
    retryPolicy: {
      classification: 'workspace_mutation',
      maxAttempts: 1,
    },
  };
}

describe('automation domain graph', () => {
  it('accepts an acyclic milestone DAG', () => {
    expect(() => validateAutomationMilestoneGraph([
      milestone('m1'),
      milestone('m2', ['m1']),
      milestone('m3', ['m1', 'm2']),
    ])).not.toThrow();
  });
  it('rejects duplicate milestone ids', () => {
    expect(() => validateAutomationMilestoneGraph([
      milestone('m1'),
      milestone('m1'),
    ])).toThrowError(expect.objectContaining({
      name: 'AutomationStateError',
      reason: 'invalid_graph',
    }));
  });

  it('rejects dependencies that are missing', () => {
    expect(() => validateAutomationMilestoneGraph([
      milestone('m1', ['missing']),
    ])).toThrowError(expect.objectContaining({
      reason: 'invalid_graph',
    }));
  });

  it('rejects milestone cycles', () => {
    let thrown: unknown;
    try {
      validateAutomationMilestoneGraph([
        milestone('m1', ['m2']),
        milestone('m2', ['m1']),
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AutomationStateError);
    expect((thrown as AutomationStateError).reason).toBe('invalid_graph');
  });
});
