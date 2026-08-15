import { describe, expect, it, vi } from 'vitest';
import { withProgressHeartbeat, type ProgressNotifyContext } from './progress-heartbeat.js';

describe('withProgressHeartbeat', () => {
  it('runs the tool without notifying when context is missing', async () => {
    await expect(withProgressHeartbeat(undefined, 'shell', async () => 'ok')).resolves.toBe('ok');
  });

  it('emits progress after the first delay while the tool is still running', async () => {
    vi.useFakeTimers();
    const notify = vi.fn(async () => undefined);
    const context: ProgressNotifyContext = {
      mcpReq: {
        id: 7,
        _meta: { progressToken: 'tok-1' },
        notify,
      },
    };

    const pending = withProgressHeartbeat(context, 'shell', async () => {
      await new Promise((resolve) => setTimeout(resolve, 40_000));
      return 'done';
    });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(notify).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({
      method: 'notifications/progress',
      params: {
        progressToken: 'tok-1',
        progress: expect.any(Number),
        message: expect.stringContaining('shell still running'),
      },
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(notify).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBe('done');
    const callsAfterDone = notify.mock.calls.length;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(notify).toHaveBeenCalledTimes(callsAfterDone);

    vi.useRealTimers();
  });

  it('ignores notify failures so the tool still completes', async () => {
    vi.useFakeTimers();
    const context: ProgressNotifyContext = {
      mcpReq: {
        id: 1,
        notify: async () => {
          throw new Error('notify failed');
        },
      },
    };

    const pending = withProgressHeartbeat(context, 'process_start', async () => {
      await new Promise((resolve) => setTimeout(resolve, 16_000));
      return 42;
    });

    await vi.advanceTimersByTimeAsync(16_000);
    await expect(pending).resolves.toBe(42);
    vi.useRealTimers();
  });
});
