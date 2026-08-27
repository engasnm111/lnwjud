import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { RunBudgetGuard } from './run-budget.js';

function result(text = 'done'): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

describe('RunBudgetGuard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never changes a tool result because elapsed wall-clock time passed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'));
    const guard = new RunBudgetGuard();
    const context = { sessionId: 'run-1' };

    guard.begin(context);
    const first = result();
    expect(guard.finish(context, first)).toBe(first);

    vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z'));
    guard.begin(context);
    const afterThirtyDays = result('still working');

    expect(guard.finish(context, afterThirtyDays)).toBe(afterThirtyDays);
    expect(afterThirtyDays.content).toEqual([{ type: 'text', text: 'still working' }]);
  });

  it('does not inject handoff or background-work instructions into stateless results', () => {
    const guard = new RunBudgetGuard();
    const actual = result('operation completed');

    guard.begin(undefined);
    expect(guard.finish(undefined, actual)).toBe(actual);
    expect(actual.content).toEqual([{ type: 'text', text: 'operation completed' }]);
  });
});
