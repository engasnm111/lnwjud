import { describe, expect, it } from 'vitest';
import { measurableGoalIds } from '../src/renderer/features/resources/ResourcePanel.js';
import type { ResourceSnapshot } from '@lnwjud/ipc-contracts';

describe('Resources Goal filter', () => {
  it('lists only Goals with actual sampled CPU or memory (including measured zero)', () => {
    const snapshot = {
      workspaceId:'ws', sampledAt:'2026-10-09T00:00:00Z', stale:false, coverage:'partial', contextScope:'unavailable',
      context:{ rawContextBytes:null,contextSentBytes:null,previouslySeenBytesAvoided:null,ledgerHits:null },
      resources:[
        { goalId:'goal-unknown', taskId:'a',provider:'shell',role:'blocking_job',ownership:'unknown',canCancel:false },
        { goalId:'goal-measured-zero',taskId:'b',provider:'shell',role:'blocking_job',ownership:'owned',canCancel:true,workingSetBytes:0 },
        { goalId:'goal-measured-cpu',taskId:'c',provider:'process',role:'blocking_job',ownership:'owned',canCancel:false,cpuPercent:12.5 },
      ],
    } satisfies ResourceSnapshot;
    expect([...measurableGoalIds(snapshot)]).toEqual(['goal-measured-zero', 'goal-measured-cpu']);
    expect(measurableGoalIds(null).size).toBe(0);
  });
});
