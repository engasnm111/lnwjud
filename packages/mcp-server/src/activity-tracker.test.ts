import { describe, expect, it } from 'vitest';
import { ActivityTracker, summarizeToolTarget, type ActivitySinkEvent } from './activity-tracker.js';

describe('ActivityTracker', () => {
  it('tracks in-flight calls and records started/completed sink events', async () => {
    const events: ActivitySinkEvent[] = [];
    const tracker = new ActivityTracker({
      async record(event): Promise<void> {
        events.push(event);
      },
    });

    const callId = await tracker.begin('read_file', { workspaceId: 'ws-1', path: 'src\\app.ts' });
    expect(tracker.listInFlight()).toHaveLength(1);
    expect(tracker.listInFlight()[0]).toMatchObject({
      callId,
      toolName: 'read_file',
      workspaceId: 'ws-1',
      targetSummary: 'src\\app.ts',
    });

    await tracker.end(callId, 'SUCCESS', 12);
    expect(tracker.listInFlight()).toHaveLength(0);
    expect(events).toEqual([
      expect.objectContaining({ phase: 'started', resultCode: 'STARTED', toolName: 'read_file' }),
      expect.objectContaining({ phase: 'completed', resultCode: 'SUCCESS', durationMs: 12, callId }),
    ]);
  });

  it('summarizes common tool targets', () => {
    expect(summarizeToolTarget('search_text', { query: 'hello' })).toBe('hello');
    expect(summarizeToolTarget('shell', { executable: 'node', arguments: ['-e', '1'] })).toBe('node -e 1');
  });
});
