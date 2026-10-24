import { describe, expect, it } from 'vitest';
import { evaluateGoalReadiness } from './engineering-readiness.js';

describe('completion readiness', () => {
  it('blocks unresolved applicability even when a client claims passed', () => {
    const result = evaluateGoalReadiness({ plan: { steps: [] }, acceptanceCriteria: [], blockers: [], activeTaskIds: [], engineering: {
      schemaVersion: 1, primaryTaskKind: 'feature', riskTier: 'medium', policyDigest: 'policy', deliveryScope: 'local', gates: [
        { id: 'package', title: 'Artifact', applicability: 'unresolved', status: 'passed', reason: 'Unknown artifact role', basedOnUserIntentRevision: 0, evidence: { source: 'host_observed', workspaceId: 'workspace', observedAt: '2026-10-18T00:00:00Z' } },
      ],
    } });
    expect(result.ready).toBe(false);
    expect(result.unresolvedGateIds).toEqual(['package']);
  });
  it('includes blocking findings and ignores supporting service liveness', () => {
    const result = evaluateGoalReadiness({ plan: { steps: [] }, acceptanceCriteria: [], blockers: [], activeTaskIds: [], trackedTasks: [{ taskId: 'server', provider: 'process', role: 'supporting_service', cancelWithGoal: false }], engineering: {
      schemaVersion: 1, primaryTaskKind: 'feature', riskTier: 'medium', policyDigest: 'policy', deliveryScope: 'local', gates: [], reviewFindings: [{ id: 'security', title: 'Boundary', severity: 'blocking', state: 'validated', reason: 'Unresolved boundary' }],
    } });
    expect(result.blockingFindingIds).toEqual(['security']);
    expect(result.blockingTaskIds).toEqual([]);
    expect(result.ready).toBe(false);
  });
});
