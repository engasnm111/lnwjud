import { describe, expect, it } from 'vitest';
import type { EngineeringGoalMetadata, GoalRecord } from '@lnwjud/domain';
import type { McpServerListItem } from '@lnwjud/extensions';
import { watcherGoalFromRecord, watcherPluginsFromServers } from '../src/main/watcher-projection.js';

const goal = {
  id: 'goal-1', goalKey: 'release', workspaceId: 'workspace-1', objective: 'Ship the release',
  currentPhase: 'verification', nextAction: '', blockers: [], activeTaskIds: [],
  plan: { steps: [{ id: 'build', title: 'Build', status: 'completed' }] },
  acceptanceCriteria: [{ id: 'ci', title: 'CI green', status: 'completed' }],
  createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:10:00.000Z',
  checkpoints: [{ createdAt: '2026-09-27T00:09:00.000Z' }],
} as GoalRecord;

describe('Watcher goal projection', () => {
  it.each(['pending', 'failed', 'stale', 'blocked'] as const)('keeps %s Engineering proof visible as a completion blocker', (status) => {
    const engineering: EngineeringGoalMetadata = {
      schemaVersion: 1, primaryTaskKind: 'release', riskTier: 'high', policyDigest: 'policy', deliveryScope: 'release',
      gates: [{ id: 'exact_sha_ci', title: 'CI', applicability: 'required', status, reason: 'Verify this source.', basedOnUserIntentRevision: 0 }],
    };
    const snapshot = watcherGoalFromRecord({ ...goal, engineering }, 'Project');
    expect(snapshot).toMatchObject({ status: 'blocked', completionReady: false });
    expect(snapshot.blockers.join(' ')).toContain('exact_sha_ci');
  });

  it('keeps a validated blocking review finding visible after the checklist is complete', () => {
    const engineering: EngineeringGoalMetadata = {
      schemaVersion: 1, primaryTaskKind: 'bugfix', riskTier: 'medium', policyDigest: 'policy', deliveryScope: 'local', gates: [],
      reviewFindings: [{ id: 'data-loss', title: 'Data loss', severity: 'blocking', state: 'validated', reason: 'Reproduced during review.' }],
    };
    const snapshot = watcherGoalFromRecord({ ...goal, engineering }, 'Project');
    expect(snapshot).toMatchObject({ status: 'blocked', completionReady: false });
    expect(snapshot.blockers.join(' ')).toContain('data-loss');
  });

  it('marks completed durable work as ready for explicit finalization without reporting active execution', () => {
    expect(watcherGoalFromRecord(goal, 'Project')).toMatchObject({
      status: 'idle', lifecycle: 'active', completionReady: true,
      acceptanceCriteria: [{ id: 'ci', status: 'completed' }],
      lastCheckpointAt: '2026-09-27T00:09:00.000Z',
    });
  });

  it('does not mark a goal ready while criteria, blockers, or blocking tasks remain', () => {
    expect(watcherGoalFromRecord({ ...goal, acceptanceCriteria: [{ id: 'ci', title: 'CI green', status: 'pending' }] }, 'Project').completionReady).toBe(false);
    expect(watcherGoalFromRecord({ ...goal, activeTaskIds: ['task-1'] }, 'Project').completionReady).toBe(false);
    expect(watcherGoalFromRecord({ ...goal, blockers: ['waiting for review'] }, 'Project').status).toBe('blocked');
  });
});

describe('Watcher plugin projection', () => {
  it('publishes configured MCP names and connection state without launch commands or config paths', () => {
    const server = {
      name: 'My Research Plugin', source: 'C:\\private\\mcp.json', command: 'secret-command --token secret',
      enabled: true, connected: true, excluded: false, lifecycle: 'connected',
    } satisfies McpServerListItem;
    expect(watcherPluginsFromServers([server])).toEqual([{
      name: 'My Research Plugin', provider: 'mcp', enabled: true, connected: true,
      excluded: false, lifecycle: 'connected',
    }]);
  });
});
