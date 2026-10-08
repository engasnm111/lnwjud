import { describe, expect, it } from 'vitest';
import type { CallTimingObservation } from '@lnwjud/domain';
import { aggregateCallTimings } from './call-timing-aggregate.js';

const event = (correlationKey: string, other: Partial<CallTimingObservation> = {}): CallTimingObservation => ({
  correlationKey, toolName: 'read_file', workspaceId: 'workspace-a', goalId: null,
  transport: 'unknown', outcome: 'success', serverMs: 0, tunnelObservedMs: null,
  completedAt: '2026-10-08T00:00:00Z', ...other,
});

describe('observed MCP call timing', () => {
  it('uses distinct sample populations and nearest-rank without inventing transport latency', () => {
    const events = [
      ...Array.from({ length: 20 }, (_, index) => event(String(index), { serverMs: index + 1,
        tunnelObservedMs: index % 2 === 0 ? (index + 1) * 2 : null })),
    ];
    const frozen = JSON.stringify(events);
    expect(aggregateCallTimings(events)).toEqual({
      completedCount: 20, incompleteCount: 0, serverSampleCount: 20,
      serverP50Ms: 10, serverP95Ms: 19, tunnelSampleCount: 10,
      tunnelP50Ms: 18, tunnelP95Ms: 38,
    });
    expect(JSON.stringify(events)).toBe(frozen);
  });
  it('does not duplicate retries or include incomplete, missing, negative and NaN timings', () => {
    const events = [
      event('zero'),
      event('zero'),
      event('failed', { outcome: 'failure', serverMs: -2, tunnelObservedMs: Number.NaN }),
      event('missing', { completedAt: null, serverMs: 100, tunnelObservedMs: 200 }),
      event('queued', { outcome: 'unknown', serverMs: 500 }),
      event('recovered', { completedAt: null, outcome: 'incomplete' }),
      event('recovered', { outcome: 'cancelled', serverMs: 8 }),
    ];
    expect(aggregateCallTimings(events)).toEqual({
      completedCount: 3, incompleteCount: 2, serverSampleCount: 2,
      serverP50Ms: 0, serverP95Ms: 8,
      tunnelSampleCount: 0, tunnelP50Ms: null, tunnelP95Ms: null,
    });
  });
});
