import { describe, expect, it } from 'vitest';
import { newestFirstWorkLogRows } from '../src/renderer/features/worklog/WorkLogPanel.js';

describe('Work Log ordering', () => {
  it('merges active and completed activity newest first', () => {
    const rows = newestFirstWorkLogRows([
      { id: 'done-new', timestamp: '2026-08-22T00:00:03.000Z', kind: 'result', toolName: 'new', resultCode: 'SUCCESS', errorMessage: null, targetSummary: null, durationMs: 3, workspaceId: null, sessionId: null },
      { id: 'done-old', timestamp: '2026-08-22T00:00:01.000Z', kind: 'result', toolName: 'old', resultCode: 'SUCCESS', errorMessage: null, targetSummary: null, durationMs: 1, workspaceId: null, sessionId: null },
    ], [
      { callId: 'running-mid', toolName: 'running', startedAt: '2026-08-22T00:00:02.000Z', targetSummary: null, workspaceId: null, sessionId: null },
    ]);
    expect(rows.map((row) => row.id)).toEqual(['done-new', 'running-mid', 'done-old']);
  });

  it('orders by absolute instants across a DST fall-back where local clock labels repeat', () => {
    const previousTimezone = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      const rows = newestFirstWorkLogRows([
        { id: 'first-0130', timestamp: '2026-11-01T05:30:00.000Z', kind: 'result', toolName: 'first', resultCode: 'SUCCESS', errorMessage: null, targetSummary: null, durationMs: 1, workspaceId: null, sessionId: null },
        { id: 'second-0130', timestamp: '2026-11-01T06:30:00.000Z', kind: 'result', toolName: 'second', resultCode: 'SUCCESS', errorMessage: null, targetSummary: null, durationMs: 1, workspaceId: null, sessionId: null },
      ], []);
      expect(new Date(rows[0]!.timestamp).getHours()).toBe(1);
      expect(new Date(rows[1]!.timestamp).getHours()).toBe(1);
      expect(rows.map((row) => row.id)).toEqual(['second-0130', 'first-0130']);
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });
});
