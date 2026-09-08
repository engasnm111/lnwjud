import { describe, expect, it } from 'vitest';
import {
  executeBatch,
  type BatchExecutionPlan,
  type BatchInvocation,
} from './parallel-tool-executor.js';

function call(id: string, options: Partial<BatchInvocation> = {}): BatchInvocation {
  return {
    id,
    tool: id,
    input: {},
    dependencies: [],
    parallelSafe: true,
    ...options,
  };
}

function plan(calls: readonly BatchInvocation[], parallel = true): BatchExecutionPlan {
  return { parallel, calls };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe('parallel tool executor', () => {
  it('runs independent calls in parallel, preserves input order, and keeps successful siblings after failure', async () => {
    const result = await executeBatch(
      plan([call('first'), call('failed'), call('last')]),
      async (current) => {
        if (current.id === 'failed') throw new Error('child failed');
        await delay(current.id === 'first' ? 20 : 5);
        return { id: current.id };
      },
    );

    expect(result.results.map((entry) => [entry.id, entry.status])).toEqual([
      ['first', 'succeeded'],
      ['failed', 'failed'],
      ['last', 'succeeded'],
    ]);
    expect(result.results[0]?.value).toEqual({ id: 'first' });
    expect(result.results[2]?.value).toEqual({ id: 'last' });
    expect(result.summary).toEqual({ total: 3, succeeded: 2, failed: 1, skipped: 0, timedOut: 0, cancelled: 0 });
  });

  it('honors sequential groups while allowing a parallel group to start its siblings together', async () => {
    const events: string[] = [];
    const result = await executeBatch({
      parallel: true,
      calls: [],
      groups: [
        {
          id: 'inspect',
          parallel: true,
          calls: [call('read-a'), call('read-b')],
        },
        {
          id: 'mutate',
          parallel: false,
          calls: [call('write-a', { parallelSafe: false }), call('write-b', { parallelSafe: false })],
        },
      ],
    }, async (current) => {
      events.push(`start:${current.id}`);
      await delay(5);
      events.push(`end:${current.id}`);
      return current.id;
    });

    expect(result.results.map((entry) => entry.id)).toEqual(['read-a', 'read-b', 'write-a', 'write-b']);
    expect(events.indexOf('start:write-a')).toBeGreaterThan(events.indexOf('end:read-a'));
    expect(events.indexOf('start:write-a')).toBeGreaterThan(events.indexOf('end:read-b'));
    expect(events.indexOf('start:write-b')).toBeGreaterThan(events.indexOf('end:write-a'));
  });

  it('skips calls whose dependencies failed and still runs independent calls', async () => {
    const result = await executeBatch(
      plan([
        call('root-failed'),
        call('dependent', { dependencies: ['root-failed'] }),
        call('independent'),
        call('dependent-success', { dependencies: ['independent'] }),
      ]),
      async (current) => {
        if (current.id === 'root-failed') throw new Error('dependency failed');
        return current.id;
      },
    );

    expect(result.results.map((entry) => entry.status)).toEqual(['failed', 'skipped', 'succeeded', 'succeeded']);
    expect(result.results[1]?.error?.code).toBe('DEPENDENCY_FAILED');
    expect(result.summary).toEqual({ total: 4, succeeded: 2, failed: 1, skipped: 1, timedOut: 0, cancelled: 0 });
  });

  it('times out an individual call without discarding a sibling result', async () => {
    const result = await executeBatch(
      plan([call('slow', { timeoutMs: 5 }), call('fast')]),
      async (current, signal) => {
        if (current.id === 'slow') {
          await delay(40);
          expect(signal.aborted).toBe(true);
        }
        return current.id;
      },
    );

    expect(result.results.map((entry) => entry.status)).toEqual(['timed_out', 'succeeded']);
    expect(result.results[0]?.error?.code).toBe('TIMEOUT');
    expect(result.summary.timedOut).toBe(1);
    expect(result.summary.succeeded).toBe(1);
  });

  it('cancels pending work without starting calls after the cancellation signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const started: string[] = [];
    const result = await executeBatch(
      plan([call('first'), call('second')]),
      async (current) => {
        started.push(current.id);
        return current.id;
      },
      { signal: controller.signal },
    );

    expect(started).toEqual([]);
    expect(result.results.map((entry) => entry.status)).toEqual(['cancelled', 'cancelled']);
    expect(result.summary.cancelled).toBe(2);
  });

  it('bounds parallel-safe child concurrency without losing partial results', async () => {
    let active = 0;
    let peak = 0;
    const result = await executeBatch(
      plan(Array.from({ length: 6 }, (_, index) => call(`read-${index + 1}`))),
      async (current) => {
        active += 1;
        peak = Math.max(peak, active);
        await delay(5);
        active -= 1;
        return current.id;
      },
      { maxConcurrency: 2 },
    );

    expect(result.summary.succeeded).toBe(6);
    expect(peak).toBe(2);
  });

  it('serializes mutation calls as an early compound-tool safety guard', async () => {
    let active = 0;
    let peak = 0;
    const result = await executeBatch(
      plan([
        call('mutation-a', { parallelSafe: false }),
        call('mutation-b', { parallelSafe: false }),
      ]),
      async (current) => {
        active += 1;
        peak = Math.max(peak, active);
        await delay(10);
        active -= 1;
        return current.id;
      },
    );

    expect(result.summary.succeeded).toBe(2);
    expect(peak).toBe(1);
  });
});
